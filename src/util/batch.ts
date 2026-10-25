/**
 * 单批装箱。
 *
 * 「一批只能带 N 条」本身不是目的，目的是让**单轮输出量**可控：
 * 60 条的一次整理，思考链 + 九类 JSON 很容易把输出推到三四万 token，
 * 一轮跑七八分钟，中途被截断就全废。剩下的靠「继续」接着跑。
 *
 * 抽成独立文件是因为它直接决定了「剩下的 N 条」到底是不是剩下那几条 ——
 * 这一点以前是坏的：批次永远从池子头部装填，而重构不改变碎片状态，
 * 于是点几次「继续重构」拿到的都是同一批。
 */
import type { Fragment } from '../types';

/**
 * 按「条数 + 字数」双上限装箱。
 *
 * 至少收一条，否则一条超长碎片会让批次永远是空的，
 * 那个用户就永远整理不了它 —— 宁可让一条独占一批。
 */
export function packFragments(list: Fragment[], limit: number, budget: number): Fragment[] {
  const out: Fragment[] = [];
  let chars = 0;
  for (const f of list) {
    if (out.length >= limit) break;
    if (out.length && chars + f.content.length > budget) break;
    out.push(f);
    chars += f.content.length;
  }
  return out;
}

/**
 * 去掉这一次已经处理过的碎片。
 *
 * `doneIds` 是会话内游标：整理模式还有 commit 里「整批标 tagged」兜底，
 * 重构模式没有 —— 它不改碎片状态，只靠这个游标才不会原地打转。
 */
export function pendingOnly(list: Fragment[], doneIds: Set<number>): Fragment[] {
  if (!doneIds.size) return list;
  return list.filter((f) => !doneIds.has(f.id));
}
