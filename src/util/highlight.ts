/**
 * 搜索命中的位置计算。
 *
 * 只有这一份实现，理由很具体：时间轴上的「3 处」徽标和详情页的正文高亮
 * 必须是同一个口径 —— 徽标说 3 处、正文只描出 2 段，用户会以为自己看漏了。
 * 所以计数不另写循环，直接数 `findHits` 返回了几段。
 *
 * 不用正则拼用户输入：搜索词里一个 `(` 或 `[` 就能让 `new RegExp` 直接抛错，
 * 而这里跑在渲染路径上，抛一次就是整页白屏。`indexOf` 没有这个问题。
 */

export interface Hit {
  start: number;
  end: number;
}

/**
 * 单个文本的命中上限。
 *
 * 99 足够覆盖一条长碎片里的重复词，又不至于让渲染层为一个字母
 * 切出几千个片段（安卓上每一段都是真实的 View 树，会明显卡顿）。
 */
const DEFAULT_LIMIT = 99;

/**
 * 找出 `query` 在 `text` 里出现的所有位置。
 *
 * - 忽略大小写：两边都 `toLowerCase()`。不做 `ß` → `ss`、emoji 组合序列这类归一 ——
 *   归一化会改变字符长度，偏移量就和原文对不上，高亮会描错位置。
 * - 无重叠、连续推进：`aaaa` 里搜 `aa` 是两处，不是三处。
 * - 查询词去首尾空白后为空 → 没有命中。
 */
export function findHits(text: string, query: string, limit: number = DEFAULT_LIMIT): Hit[] {
  const needle = query.trim().toLowerCase();
  if (!needle || !text) return [];

  const hay = text.toLowerCase();
  const out: Hit[] = [];
  let from = 0;

  while (out.length < limit) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length;
    out.push({ start: at, end });
    from = end;
  }

  return out;
}

/** 命中个数。走 findHits，不另写一份循环 —— 两个口径分开写迟早会对不上 */
export function countHits(text: string, query: string): number {
  return findHits(text, query).length;
}
