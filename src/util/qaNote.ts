/**
 * 把一次问答会话整理成一条可以进时间轴的碎片。
 *
 * v0.8.9 起**不再按字数截断**。原来的规则是「最近 6 轮、每答前 3 句、最多 300 字」，
 * 用户的实际感受是「按字数大小直接截」：答案断在半句，读起来像残稿。
 * 现在保留全部问答，用 Markdown 分节，交给时间轴的 `NoteBody` 渲染。
 *
 * 三件仍然要做的事：
 * - **去掉回答里的 `[F12]` / `[N3]` / `[T5]` / `[W1]` / `[D3]`**：碎片脱离会话后这些编号
 *   没有意义，留着只是特殊字符。代码块里的标记不动，那可能是示例。
 * - **末尾附「参考来源」清单**：只列 label，不复制正文。需要回查时知道当时引了哪些东西。
 * - **时间戳用会话开始时间**：这条碎片应该落在「你真正开始提问的那一刻」。
 */
import type { QaCitation, QaTurn } from '../types';
import { dayKey, formatTime } from './date';
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

/**
 * 去掉正文里的引用标记，但保留代码围栏里的内容。
 * `split` 带捕获组后，奇数下标就是代码块，正好跳过。
 */
export function stripCiteMarkers(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/[ \t]*\[[FNTWD]\d{1,6}\]/g, '')))
    .join('')
    .replace(/[ \t]+([，。；：！？、])/g, '$1')
    .trim();
}

/**
 * 来源去重的键。
 *
 * D 的 `id` 只是**本轮别名**：第 1 轮的 D1 和第 2 轮的 D1 可能是两份完全不同的文档，
 * 按 `kind+id` 去重会把它们并成一条来源。文档要按 documentId+chunkId 认。
 */
function sourceKey(cite: QaCitation): string {
  if (cite.kind === 'D' && cite.documentId !== undefined && cite.chunkId !== undefined) {
    return `D:${cite.documentId}:${cite.chunkId}`;
  }
  return `${cite.kind}${cite.id}`;
}

/** 跨轮收集引用来源，按 stable key 去重，保持首次出现顺序 */
export function collectSources(turns: QaTurn[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const turn of turns) {
    for (const cite of turn.citations ?? []) {
      const key = sourceKey(cite);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cite.kind === 'W' && cite.url ? `${cite.label}（${cite.url}）` : cite.label);
    }
  }
  return out;
}

function sourceSection(turns: QaTurn[]): string {
  const sources = collectSources(turns);
  return sources.length
    ? `\n\n---\n\n**参考来源**\n${sources.map((s) => `- ${s}`).join('\n')}`
    : '';
}

function headOf(turns: QaTurn[], startedAt: number): string {
  return `## 问答纪要 · ${dayKey(startedAt)} ${formatTime(startedAt)} · ${turns.length} 轮`;
}

/**
 * 完整转录（兜底用）。
 *
 * 主路径是 `buildQaFragment` + AI 提炼；这里保留全文，给「AI 失败 / 没配 Key」
 * 时一个不截断的出口。空会话返回空串，调用方要挡住。
 */
export function buildQaNote(turns: QaTurn[], startedAt: number): string {
  const kept = turns.filter((t) => t.question.trim() && t.answer.trim());
  if (!kept.length) return '';

  const body = kept
    .map((t, i) => {
      const question = t.question.trim();
      const answer = stripCiteMarkers(t.answer);
      return `### 问 ${i + 1}\n${question}\n\n### 答 ${i + 1}\n${answer}`;
    })
    .join('\n\n');

  return `${headOf(kept, startedAt)}\n\n${body}${sourceSection(kept)}`;
}

/**
 * 主路径：把 AI 提炼的摘要装进碎片头部和参考来源。
 *
 * 摘要本身由 `ai/qaSummary.ts` 生成；这里只做确定性的包装，
 * 保证格式、轮数和来源清单不依赖模型。
 */
export function buildQaFragment(turns: QaTurn[], startedAt: number, summary: string): string {
  const kept = turns.filter((t) => t.question.trim() && t.answer.trim());
  const body = stripCiteMarkers(summary).trim();
  if (!kept.length || !body) return '';
  return `${headOf(kept, startedAt)}\n\n${body}${sourceSection(kept)}`;
}
