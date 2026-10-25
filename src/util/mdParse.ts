/**
 * 解析 Markdown 回碎片。
 *
 * 首要目标是**读得懂自己导出的文件**（`### 2026-10-25 周六` + `- 21:40 正文 #标签`），
 * 次要目标是把常见的手写笔记也尽量读进来，因为用户可能是从别的工具搬过来的。
 *
 * 这里只做「文本 → 待写入列表」，不碰数据库、不判重。判重是 `db/importMd.ts` 的事：
 * 解析层不该知道库里已经有什么，否则没法单测，也没法先给用户看预览。
 *
 * 三条刻意的取舍：
 * 1. **不追求完整还原数据库**。导出文件是给人看的同时顺手能读，`status`、`project`、
 *    合并关系都没写进文件，所以导回来一律按「有标签=已整理、没标签=待整理」推断。
 * 2. **多行正文会变一行**。导出时换行被压成空格，这是导出层的既成事实，导入改不了。
 * 3. **日期不存在时内容不丢**。`### 2026-13-99` 这种笔误没法定位到哪一天，
 *    条目会落到 `fallbackDay` 并在结果里计数，由上层提示用户；
 *    但**未来日期照收**——把它挪到今天会把内容混进今天的记录里，
 *    而排在时间轴最上面至少一眼能看见、能自己处理。
 */

import { dayKey, formatTime } from './date';
import { normText } from './text';

export interface ParsedFragment {
  createdAt: number;
  content: string;
  tags: string[];
  /** 在源文件里的行号（1 起），报错时能指回去 */
  line: number;
  hasTime: boolean;
  hasDate: boolean;
}

export interface ParseResult {
  items: ParsedFragment[];
  /** 有列表项但读不到日期，被记在 `fallbackDay` 的条数 */
  withoutDate: number;
  /** 文件里明确写了日期、但日期不存在的行（2026-13-99 之类） */
  badDates: { line: number; raw: string }[];
  /** 标了「（已合并）」而跳过的行数 */
  mergedSkipped: number;
  /** 落在「待办 / 标签索引」等段落里被忽略的行数 */
  sectionSkipped: number;
}

/** 纯日期：2026-10-25 / 2026/10/25 / 2026.10.25 / 2026年10月25日 */
const BARE_DATE = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/;

/**
 * 宽松版：只要**开头**像日期就认，后面跟不跟文字都行。
 *
 * 存在的理由是两个真实的坏输入：
 * - `### 2026-13-99` —— 严格版匹配不上，会被当成普通标题静默忽略，
 *   后面的条目全部落到「今天」，用户根本不知道自己的日期没被读到。
 * - `### 2026-10-25 复盘` —— 日期后面跟了标题文字，按那天算才符合直觉。
 */
const LOOSE_DATE = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/;

/** 列表项：- xxx / * xxx / + xxx */
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;

/** 行首时间：21:40 / 9:05 / 21:40:30，后面必须有空白才认 */
const TIME_PREFIX = /^(\d{1,2}):(\d{2})(?::\d{2})?\s+/;

/** 导出时给已合并条目加的尾巴 */
const MERGED_MARK = /[（(]已合并[)）]\s*$/;

/** 标签名里出现这些字符，基本可以断定是代码而不是标签（#include <stdio.h>） */
const CODE_CHARS = /[<>{}[\]/=\\;`"']/;

function stripWeekday(s: string): string {
  return s
    .replace(/[（(]\s*(?:周|星期)?[一二三四五六日天]\s*[)）]\s*$/, '')
    .replace(/\s+(?:周|星期)[一二三四五六日天]\s*$/, '')
    .trim();
}

/**
 * 真日期才返回时间戳。形状对但日子不存在的（2 月 30 日）返回 null ——
 * 只校验 `\d{4}-\d{2}-\d{2}` 的话，`2026-13-99` 会一路走进库里。
 */
function dateMs(y: number, m: number, d: number): number | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  dt.setHours(0, 0, 0, 0);
  return dt.getTime();
}

type Heading =
  | { kind: 'date'; ms: number }
  | { kind: 'badDate'; raw: string }
  | { kind: 'skip' }
  | { kind: 'timeline' }
  | { kind: 'other' };

function classifyHeading(text: string): Heading {
  const body = text.trim();
  if (!body) return { kind: 'other' };

  const direct = BARE_DATE.exec(body) ?? BARE_DATE.exec(stripWeekday(body));
  if (direct) {
    const ms = dateMs(Number(direct[1]), Number(direct[2]), Number(direct[3]));
    return ms === null ? { kind: 'badDate', raw: body } : { kind: 'date', ms };
  }

  const loose = LOOSE_DATE.exec(body);
  if (loose) {
    const ms = dateMs(Number(loose[1]), Number(loose[2]), Number(loose[3]));
    return ms === null ? { kind: 'badDate', raw: body } : { kind: 'date', ms };
  }

  if (/待办|标签索引|小结|知识库/.test(body)) return { kind: 'skip' };
  if (/时间轴/.test(body)) return { kind: 'timeline' };
  return { kind: 'other' };
}

/**
 * 从行尾依次剥标签。只认「前面是空白或行首」的 `#`，
 * 所以 `C#` 和 `#include <x>` 里的井号不会被当成标签。
 */
export function splitTrailingTags(body: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  let s = body.replace(/\s+$/, '');

  // 最多剥 6 个，防手滑写一整行井号把循环拖死
  for (let guard = 0; guard < 6; guard++) {
    const m = s.match(/(?:^|\s)#([^\s#]+)$/);
    if (!m) break;

    // 尾巴上的标点是句子的一部分，不属于标签名
    const name = m[1].replace(/[.。,，;；:：!！?？、)）\]】}》>'"”’]+$/, '');
    if (!name || CODE_CHARS.test(name)) break;

    // m[0] 含前置的那个空格，切的时候连空格一起切
    const at = s.length - m[0].length;

    tags.unshift(name);
    s = s.slice(0, at).replace(/\s+$/, '');
  }

  return { text: s, tags };
}

/**
 * 判重指纹。导入层拿它和库里现有碎片对齐 —— 两边必须调**同一个函数**，
 * 各写一份的下场是「明明重复了却导进来两份」。
 */
export function fragmentKey(createdAt: number, content: string): string {
  return `${dayKey(createdAt)}|${formatTime(createdAt)}|${normText(content)}`;
}

/**
 * 这个文件看起来是不是二进制（选错文件了）。
 *
 * 两种信号：NUL 字节（文本文件不会有），和大量 `\uFFFD`（用 UTF-8 去解
 * GBK 文件时的产物）。后者在中文环境里很常见 —— 记事本另存为 ANSI 就会这样，
 * 提前拦下比让用户对着一个空结果发呆好。
 */
export function looksBinary(text: string): boolean {
  if (!text) return true;
  const head = text.slice(0, 4000);
  let bad = 0;
  for (let i = 0; i < head.length; i++) {
    const code = head.charCodeAt(i);
    if (code === 0) return true;
    if (head[i] === '\uFFFD') bad++;
  }
  return bad > head.length * 0.1;
}

/**
 * @param text 文件全文
 * @param fallbackDay 文件里读不到日期时，这些条目记到哪一天（毫秒时间戳）
 */
export function parseMarkdown(text: string, fallbackDay: number): ParseResult {
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const items: ParsedFragment[] = [];
  const badDates: { line: number; raw: string }[] = [];
  let withoutDate = 0;
  let mergedSkipped = 0;
  let sectionSkipped = 0;

  /** 当前所属日期；null 表示文件里还没出现日期标题 */
  let currentDay: number | null = null;
  let skipping = false;
  /** 当天已经用掉的最大时间（毫秒，相对当天 0 点），给没写时间的条目续位 */
  let dayCursor = 0;

  const fallback = (() => {
    const d = new Date(fallbackDay);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    const headingMatch = raw.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (headingMatch) {
      const h = classifyHeading(headingMatch[1]);
      if (h.kind === 'date') {
        currentDay = h.ms;
        dayCursor = 0;
        skipping = false;
      } else if (h.kind === 'badDate') {
        badDates.push({ line: lineNo, raw: h.raw });
        currentDay = null;
        skipping = false;
      } else if (h.kind === 'skip') {
        skipping = true;
      } else if (h.kind === 'timeline') {
        skipping = false;
      }
      // other：不动 currentDay / skipping，`# 碎片导出 · 2026-10-25` 就是这一类
      continue;
    }

    const bullet = raw.match(BULLET);
    if (!bullet) continue;

    if (skipping) {
      sectionSkipped++;
      continue;
    }

    // 待办清单 `- [ ] xxx` 属于「## 待办」段落；万一标题丢了也别当成碎片
    if (/^\[[ xX]\]\s/.test(bullet[1])) {
      sectionSkipped++;
      continue;
    }

    let body = bullet[1].trim();
    if (!body) continue;

    const { text: noTags, tags } = splitTrailingTags(body);
    body = noTags;

    if (MERGED_MARK.test(body)) {
      mergedSkipped++;
      continue;
    }

    let hasTime = false;
    let timeMs = 0;
    const timeMatch = body.match(TIME_PREFIX);
    if (timeMatch) {
      const hh = Number(timeMatch[1]);
      const mm = Number(timeMatch[2]);
      if (hh < 24 && mm < 60) {
        hasTime = true;
        timeMs = (hh * 60 + mm) * 60000;
        body = body.slice(timeMatch[0].length).trim();
      }
    }

    if (!body) continue;

    const day = currentDay ?? fallback;
    const hasDate = currentDay !== null;
    if (!hasDate) withoutDate++;

    let createdAt: number;
    if (hasTime) {
      createdAt = day + timeMs;
      if (timeMs >= dayCursor) dayCursor = timeMs + 60000;
    } else {
      // 没写时间的排在当天已知时间之后，一条一分钟，保证顺序稳定
      if (dayCursor === 0) dayCursor = 8 * 3600000;
      createdAt = day + dayCursor;
      dayCursor += 60000;
    }

    items.push({ createdAt, content: body, tags, line: lineNo, hasTime, hasDate });
  }

  // 文件里的顺序不等于时间顺序（手写笔记经常乱），按时间排好再交给上层
  items.sort((a, b) => a.createdAt - b.createdAt || a.line - b.line);

  return { items, withoutDate, badDates, mergedSkipped, sectionSkipped };
}
