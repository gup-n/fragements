/**
 * 回收站的时间口径（纯函数，能在 node 里断言）。
 *
 * 回收站**不存「还剩几天」**，只存删除那一刻的时间戳。剩几天是算出来的 ——
 * 存下来就得有人每天去改它，而 App 不是一个每天都开的东西：
 * 用户隔两周打开一次，看到的会是「还剩 28 天」这种早就过期的数字。
 */
import type { TrashEntry, TrashKind } from '../types';

/** 保留天数。30 天是用户 2026-11-18 定的 */
export const TRASH_KEEP_DAYS = 30;

/** 只在算日期时用它，不要拿 `86400000` 散落在各处 */
export const TRASH_DAY_MS = 86_400_000;

/** 到期时刻：这一条到这时候就再也回不来了 */
export function trashExpireAt(deletedAt: number): number {
  return deletedAt + TRASH_KEEP_DAYS * TRASH_DAY_MS;
}

/**
 * 还剩几天。向上取整：删完那一刻显示 30 天，最后一天显示 1 天，
 * 过了到期时刻就是 0（负数一律夹到 0，「还剩 -3 天」没有意义）。
 */
export function trashDaysLeft(deletedAt: number, now: number): number {
  const ms = trashExpireAt(deletedAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / TRASH_DAY_MS);
}

/** 启动清理的截止时间：删除时间早于它的，物理删 */
export function purgeCutoff(now: number): number {
  return now - TRASH_KEEP_DAYS * TRASH_DAY_MS;
}

/** 该不该由这次启动清掉。`deleted_at` 恰好等于截止时间的不清（边界保守一点） */
export function isTrashExpired(deletedAt: number, now: number): boolean {
  return deletedAt < purgeCutoff(now);
}

/** 一行字：「还有 12 天」/「今天到期」。到期但还没被清掉的也说「今天到期」 */
export function trashLeftText(deletedAt: number, now: number): string {
  const days = trashDaysLeft(deletedAt, now);
  return days <= 0 ? '今天到期' : `还有 ${days} 天`;
}

/** 三类分开，每类内部按删除时间倒序（最近删的在最上面） */
export function groupTrash(entries: TrashEntry[]): Record<TrashKind, TrashEntry[]> {
  const out: Record<TrashKind, TrashEntry[]> = { fragment: [], document: [], ask_session: [] };
  for (const entry of entries) out[entry.kind].push(entry);
  const byNewest = (a: TrashEntry, b: TrashEntry) => b.deletedAt - a.deletedAt || b.id - a.id;
  out.fragment.sort(byNewest);
  out.document.sort(byNewest);
  out.ask_session.sort(byNewest);
  return out;
}

/**
 * 顶部那一句「现在这里有什么」。
 *
 * 空的时候要说清「删掉的东西会先到这里」，而不是一句「暂无内容」——
 * 用户是来找回东西的，得先知道东西在不在这儿。
 */
export function trashSummary(entries: TrashEntry[], now: number): string {
  if (!entries.length) return '删除的碎片、文档和问答会话会先到这里，30 天后自动清空。';
  const counts: Record<TrashKind, number> = { fragment: 0, document: 0, ask_session: 0 };
  for (const entry of entries) counts[entry.kind] += 1;
  const parts: string[] = [];
  if (counts.fragment) parts.push(`碎片 ${counts.fragment} 条`);
  if (counts.document) parts.push(`文档 ${counts.document} 篇`);
  if (counts.ask_session) parts.push(`会话 ${counts.ask_session} 场`);
  const soonest = Math.min(...entries.map((e) => trashDaysLeft(e.deletedAt, now)));
  const tail = soonest <= 0 ? '最早的一条今天就会被清掉。' : `最早的一条还有 ${soonest} 天。`;
  return `${parts.join('、')}，30 天后自动清空，${tail}`;
}

/** 批量操作里的一句话：「恢复 3 条」/「彻底删除 2 条」。破坏性动作必须带数量 */
export function trashActionText(verb: '恢复' | '彻底删除', count: number): string {
  return count > 0 ? `${verb}这 ${count} 条` : verb;
}

/**
 * 批量恢复 / 彻底删除的勾选状态。
 *
 * 与项目里所有破坏性操作一致：**默认不勾**。这里只是把「全选 / 反选 / 清空」
 * 三种意图收成纯函数，免得界面里三处各写一遍 Set 操作。
 */
export function toggleRef<T extends { kind: TrashKind; id: number }>(list: T[], ref: T): T[] {
  const at = list.findIndex((x) => x.kind === ref.kind && x.id === ref.id);
  if (at >= 0) return list.filter((_, i) => i !== at);
  return [...list, ref];
}

export function hasRef(list: { kind: TrashKind; id: number }[], ref: { kind: TrashKind; id: number }): boolean {
  return list.some((x) => x.kind === ref.kind && x.id === ref.id);
}
