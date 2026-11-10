/**
 * 问答引用的小工具。v0.16 起它只剩一件事：判断一条回答里**真正引用了哪些编号**。
 *
 * 以前这个文件负责把整场会话压成一条「问答纪要」碎片（`buildQaNote` / `buildQaFragment`）。
 * 那条链路在 v0.16 删掉了 —— 整理出来的东西应该是文档，不是塞回时间轴的新碎片。
 * 留下来的 `citedKeys` 服务于「问」的引用渲染：界面上的小标、来源列表都从它来。
 */
import { collectCitations } from './mdBlocks';

/**
 * 一次回答里**真正被引用**的编号集合。
 *
 * 走 `collectCitations` 而不是 `answer.includes(...)`：模型在代码块或行内代码里
 * 写 `[F12]` 是举例，不是在引用资料，字面包含判断会把这类也当成引用。
 * 编号还得在本轮真的发出去的材料里存在 —— 模型自己编的 `[D999]` 没有对应条目，
 * 后面按编号建引用时自然落空。
 */
export function citedKeys(answer: string): Set<string> {
  return new Set(collectCitations(answer).map((ref) => `${ref.kind}${ref.id}`));
}
