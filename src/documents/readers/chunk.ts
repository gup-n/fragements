/**
 * 正文切片。**整个文档模块只有这一份切片实现。**
 *
 * 两条硬要求决定了写法：
 *
 * 1. **不能漏末尾。** 常见写法是「攒满 4000 字就 flush，循环结束收工」，
 *    最后剩的一小段如果没有显式收尾就凭空消失 —— 用户在问答里问的恰好是
 *    文档最后一段时，模型只会说「资料里没有」。
 * 2. **必须基于完整文本切片。** 不能拿 `util/mdBlocks` 的展示 AST 来切：
 *    那张 AST 为了排版会把表格裁到 8 列、把 `[F12]` 当引用标记吃掉，
 *    切出来的正文和原件对不上，引用定位也会指错。
 *
 * 行号一律是 **1 起** 的真实行号（按 `\n` 数），这样 `DocumentLocator` 拿到
 * 之后能直接显示「第 120–168 行」，而不是「第 3 段」这种对不上原件的位置。
 */
import type {
  DocumentChunkInput,
  DocumentContentInput,
  DocumentContentSource,
  DocumentLocator,
} from '../../types';
import { LOCAL_READER_LIMITS } from '../formats';
import { bodyTooLong, ReaderError } from './errors';

/** 按行切出来的一片，行号是这段文本内部的相对行号（1 起） */
export interface LinePiece {
  text: string;
  lineStart: number;
  lineEnd: number;
}

/**
 * 把一个字符位置从代理对中间挪开。
 *
 * 中文 / emoji 在 JS 里按 UTF-16 存，一个 emoji 占两个 code unit。
 * 硬切在中间时两个 half 会各变成一个 `�`，正文看着像乱码，
 * 而且原字符再也拼不回来。
 */
function safeCut(s: string, at: number): number {
  if (at <= 0 || at >= s.length) return at;
  const high = s.charCodeAt(at - 1);
  // 高代理后面紧跟低代理 = 正好切在一对中间，往前让一格
  return high >= 0xd800 && high <= 0xdbff ? at - 1 : at;
}

/**
 * 按行攒片，每片不超过 `limit` 字。
 *
 * 单行超长（比如一整段没换行的日志、Excel 里塞了一整篇文章的单元格）时
 * 先把它自己的片冲掉，再对这一行硬切 —— 不硬切就只能让某一片无限大，
 * 而模型输入预算是按片算的。
 */
export function splitByLines(text: string, limit: number = LOCAL_READER_LIMITS.chunkChars): LinePiece[] {
  if (!text) return [];
  const lines = text.split('\n');
  const out: LinePiece[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  let startLine = 0;
  let lastLine = 0;

  const flush = () => {
    if (!buf.length) return;
    out.push({ text: buf.join('\n'), lineStart: startLine, lineEnd: lastLine });
    buf = [];
    bufLen = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const no = i + 1;

    if (raw.length > limit) {
      flush();
      for (let at = 0; at < raw.length; ) {
        const end = Math.max(at + 1, safeCut(raw, Math.min(raw.length, at + limit)));
        out.push({ text: raw.slice(at, end), lineStart: no, lineEnd: no });
        at = end;
      }
      lastLine = no;
      continue;
    }

    // 片的开头不要吃空行：多一个空行既浪费预算，又让「第 N 行」指到空行上
    if (buf.length && bufLen + 1 + raw.length > limit) flush();

    if (!buf.length) {
      if (!raw.trim()) {
        continue;
      }
      startLine = no;
    }
    bufLen += (buf.length ? 1 : 0) + raw.length;
    buf.push(raw);
    lastLine = no;
  }

  flush();
  return out;
}

/** 标题行。markdown 用它给切片打 `section`，问答引用里「## 报销」比「第 3 片」有用得多 */
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

export function headingOf(line: string): string | null {
  const m = HEADING_RE.exec(line);
  if (!m) return null;
  const title = m[1].trim();
  if (!title) return null;
  return title.length > 40 ? `${title.slice(0, 40)}…` : title;
}

/**
 * 纯文本 / Markdown 切片。
 *
 * `kind` 决定 locator 类型，`sectionOf` 只在 Markdown 下给 —— TXT 里的 `# 标题`
 * 只是字符，不是章节，硬当章节会让引用位置凭空多一层。
 */
export function chunkTextByLines(
  text: string,
  kind: 'text' | 'markdown',
): DocumentChunkInput[] {
  const pieces = splitByLines(text, LOCAL_READER_LIMITS.chunkChars);
  if (!pieces.length) return [];

  // 先算出「每一行开始时的所在章节」，避免每个切片都重新扫一遍前面的行
  let sectionByLine: (string | undefined)[] | null = null;
  if (kind === 'markdown') {
    const lines = text.split('\n');
    sectionByLine = new Array(lines.length + 2);
    let cur: string | undefined;
    for (let i = 0; i < lines.length; i++) {
      // 先认本行的标题再记账：切片往往就从标题行开始，那时它属于**自己**这节，
      // 记成上一节会让「## 报销」开头的片段显示成上一章的名字。
      const h = headingOf(lines[i]);
      if (h) cur = h;
      sectionByLine[i + 1] = cur;
    }
    sectionByLine[lines.length + 1] = cur;
  }

  const chunks: DocumentChunkInput[] = pieces.map((p) => {
    const locator: DocumentLocator = { kind, lineStart: p.lineStart, lineEnd: p.lineEnd };
    const section = sectionByLine?.[p.lineStart];
    if (section) locator.section = section;
    return { text: p.text, locator };
  });

  assertChunkCount(chunks.length);
  return chunks;
}

/** 片数上限。超过就明确失败 —— 4000 片已经是「整本书」的量级，再切没有意义 */
export function assertChunkCount(n: number): void {
  if (n > LOCAL_READER_LIMITS.chunks) {
    throw new ReaderError(
      'too-many-chunks',
      `正文切出了 ${n} 片，超过上限 ${LOCAL_READER_LIMITS.chunks} 片。这篇文档太大，不适合应用内提问。`,
    );
  }
}

/** 正文总字数上限。**不截断**，超了就报错，见 errors.ts 的注释 */
export function assertBody(bodyMd: string): void {
  if (bodyMd.length > LOCAL_READER_LIMITS.bodyChars) throw bodyTooLong(bodyMd.length);
}

/**
 * 纯文本 → 可入库的正文 + 切片。
 *
 * `source` 决定 locator 的口径：只有 TXT 用 `text`，Markdown / MinerU / 旧缓存正文
 * 都是 Markdown 结构（有标题、有列表），用 `markdown` 才能把章节带给引用面板。
 * 旧正文（legacy）**不猜原文件页码**，这里只给正文行号。
 */
export function contentFromText(
  text: string,
  source: DocumentContentSource = 'text',
): DocumentContentInput {
  assertBody(text);
  const kind: 'text' | 'markdown' = source === 'text' ? 'text' : 'markdown';
  return { bodyMd: text, chunks: chunkTextByLines(text, kind), source, pages: null };
}
