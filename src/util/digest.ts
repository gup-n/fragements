/**
 * 「哪些周期还没写小结」的计算。
 *
 * 判定口径：
 * - 只看**有碎片**的周期 —— 空周期没什么可总结的
 * - 日小结**包含今天**：今天的碎片已经攒了一些，用户想写就该能写。
 *   这类还没走完的周期标 `running`，界面上要说清楚「到此刻为止」
 * - 周/月只算**已经结束**的周期：本周/本月写了也是半截，而且周期一结束
 *   就会重新出现在列表里，没必要先写一份残的
 * - 已经有小结的周期跳过（按 `type|period` 精确匹配）
 *
 * 列表排序用「按粒度配额」而不是纯按时间：月/周的周期末端始终比日靠后，
 * 纯按时间排会让一个月总结把一堆日小结全挤掉，而日小结才是日常真正常用的那个。
 */
import type { DigestKind, Fragment, Note } from '../types';
import { dayKey, monthKey, periodRange, weekKey } from './date';

/** 小结的分组顺序：粒度大的在上面，旧数据里的「主题总结」垫底 */
export const NOTE_GROUP_ORDER: Note['type'][] = ['monthly', 'weekly', 'daily', 'theme'];

export const NOTE_GROUP_LABEL: Record<Note['type'], string> = {
  monthly: '月总结',
  weekly: '周总结',
  daily: '日小结',
  theme: '主题总结',
};

export interface NoteGroup {
  kind: Note['type'];
  label: string;
  notes: Note[];
}

/**
 * 回顾页「小结」的分组。
 *
 * 以前直接按 createdAt 倒序排，于是「昨天的日小结」会压在「上周的周总结」上面 ——
 * 一眼看过去分不清哪篇是概括、哪篇是流水。改成先按粒度分组（月 → 周 → 日），
 * 组内才按时间倒序。
 *
 * 组内**不改顺序**：调用方传进来的已经是 createdAt DESC，
 * 这里再排一次只会让「哪条更新」出现两套口径。
 */
export function groupNotes(notes: Note[]): NoteGroup[] {
  const buckets = new Map<Note['type'], Note[]>();
  for (const n of notes) {
    const list = buckets.get(n.type);
    if (list) list.push(n);
    else buckets.set(n.type, [n]);
  }

  const out: NoteGroup[] = [];
  for (const kind of NOTE_GROUP_ORDER) {
    const list = buckets.get(kind);
    if (list?.length) out.push({ kind, label: NOTE_GROUP_LABEL[kind], notes: list });
  }
  return out;
}

export interface MissingDigest {
  kind: DigestKind;
  period: string;
  /** 该周期里有几条碎片 */
  count: number;
  /** 周期结束时间，用来排序和显示 */
  at: number;
  /** 这个周期还没走完（目前只有「今天」会为 true） */
  running: boolean;
}

export interface Backlog {
  items: MissingDigest[];
  /** 实际缺多少个周期（可能大于 items.length） */
  total: number;
}

const KIND_ORDER: DigestKind[] = ['daily', 'weekly', 'monthly'];
/** 每种粒度先占多少名额，剩下的名额再按时间补 */
const QUOTA: Record<DigestKind, number> = { daily: 6, weekly: 2, monthly: 2 };

export function missingDigests(
  fragments: Fragment[],
  notes: Note[],
  limit = 10,
  now = Date.now(),
): Backlog {
  const covered = new Set(notes.filter((n) => n.period).map((n) => `${n.type}|${n.period}`));
  const buckets = new Map<string, MissingDigest>();

  const bump = (kind: DigestKind, period: string) => {
    if (covered.has(`${kind}|${period}`)) return;
    const range = periodRange(period);
    if (!range) return;
    // 周/月没结束就先不列；日只保留今天这一种「进行中」
    if (kind !== 'daily' && range.to > now) return;

    const key = `${kind}|${period}`;
    const hit = buckets.get(key);
    if (hit) hit.count += 1;
    else buckets.set(key, { kind, period, count: 1, at: range.to - 1, running: range.to > now });
  };

  for (const f of fragments) {
    bump('daily', dayKey(f.createdAt));
    bump('weekly', weekKey(f.createdAt));
    bump('monthly', monthKey(f.createdAt));
  }

  const all = Array.from(buckets.values());
  const picked: MissingDigest[] = [];
  const used = new Set<string>();

  // 第一轮：每个粒度先占自己的名额
  for (const kind of KIND_ORDER) {
    const list = all
      .filter((b) => b.kind === kind)
      .sort((a, b) => b.at - a.at)
      .slice(0, QUOTA[kind]);
    for (const item of list) {
      if (picked.length >= limit) break;
      picked.push(item);
      used.add(`${item.kind}|${item.period}`);
    }
  }

  // 第二轮：还有空位就按时间补，别浪费名额
  if (picked.length < limit) {
    const rest = all
      .filter((b) => !used.has(`${b.kind}|${b.period}`))
      .sort((a, b) => b.at - a.at);
    for (const item of rest) {
      if (picked.length >= limit) break;
      picked.push(item);
    }
  }

  picked.sort((a, b) => b.at - a.at || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return { items: picked, total: all.length };
}
