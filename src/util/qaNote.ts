/**
 * 把一次问答会话整理成一条可以进时间轴的碎片。
 *
 * v0.8.9 起**不再按字数截断**。原来的规则是「最近 6 轮、每答前 3 句、最多 300 字」，
 * 用户的实际感受是「按字数大小直接截」：答案断在半句，读起来像残稿。
 * 现在保留全部问答，用 Markdown 分节，交给时间轴的 `NoteBody` 渲染。
 *
 * 三件仍然要做的事：
 * - **去掉回答里的 `[F12]` / `[N3]` / `[T5]` / `[W1]`**：碎片脱离会话后这些编号
 *   没有意义，留着只是特殊字符。代码块里的标记不动，那可能是示例。
 * - **末尾附「参考来源」清单**：只列 label，不复制正文。需要回查时知道当时引了哪些东西。
 * - **时间戳用会话开始时间**：这条碎片应该落在「你真正开始提问的那一刻」。
 */
import type { QaTurn } from '../types';
import { dayKey, formatTime } from './date';

/**
 * 去掉正文里的引用标记，但保留代码围栏里的内容。
 * `split` 带捕获组后，奇数下标就是代码块，正好跳过。
 */
export function stripCiteMarkers(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/[ \t]*\[[FNTW]\d{1,6}\]/g, '')))
    .join('')
    .replace(/[ \t]+([，。；：！？、])/g, '$1')
    .trim();
}

/** 跨轮收集引用来源，按 kind+id 去重，保持首次出现顺序 */
export function collectSources(turns: QaTurn[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const turn of turns) {
    for (const cite of turn.citations ?? []) {
      const key = `${cite.kind}${cite.id}`;
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
