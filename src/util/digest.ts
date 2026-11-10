/**
 * 「哪些月还没写总结」的计算。
 *
 * 判定口径：
 * - 只看**有碎片**的月份 —— 空月份没什么可总结的
 * - 只算**已经结束**的月份：本月写了也是半截，而且月份一结束它还会重新
 *   出现在列表里，没必要先写一份残的
 * - 已经有月总结的月份跳过（按 `type|period` 精确匹配）
 *
 * v0.15 之前这里还按「粒度配额」给日/周/月各分名额（日 6、周 2、月 2），
 * 因为纯按时间排会让一个月总结把一堆日小结全挤掉。日/周下线之后，
 * 这件事变成了「按月倒序取前几条」，两轮挑选和配额表一起删了。
 */
import type { Fragment, Note } from '../types';
import { monthKey, periodRange } from './date';

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
 * 现在只会命中 monthly 一组（和可能残留的 theme），但顺序表不删：
 * 万一某台设备的迁移没跑到，旧数据还在库里，这里的表现是「照常显示」，
 * 而不是「突然消失」——后者才更需要排查。
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
  /** 2026-10 */
  period: string;
  /** 这个月里有几条碎片 */
  count: number;
  /** 月份结束时间，用来排序 */
  at: number;
}

export interface Backlog {
  items: MissingDigest[];
  /** 实际缺多少个月（可能大于 items.length） */
  total: number;
}

export function missingDigests(
  fragments: Fragment[],
  notes: Note[],
  limit = 6,
  now = Date.now(),
): Backlog {
  // 只认月总结算「已写」。别的 type 即使 period 相同也不是同一件事 ——
  // 旧数据里可能存在 daily 的 2026-10-01，它不能把 2026-10 这个月的缺口填掉
  const covered = new Set(
    notes.filter((n) => n.type === 'monthly' && n.period).map((n) => n.period as string),
  );
  const buckets = new Map<string, MissingDigest>();

  for (const f of fragments) {
    const period = monthKey(f.createdAt);
    if (covered.has(period)) continue;
    const range = periodRange(period);
    if (!range) continue;
    // 本月还没结束就不列 —— 写出来是半截，月份一过它又会重新出现
    if (range.to > now) continue;

    const hit = buckets.get(period);
    if (hit) hit.count += 1;
    else buckets.set(period, { period, count: 1, at: range.to - 1 });
  }

  const all = Array.from(buckets.values()).sort((a, b) => b.at - a.at);
  return { items: all.slice(0, limit), total: all.length };
}
