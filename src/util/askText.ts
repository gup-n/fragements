/**
 * 「问」页的纯文本工具：引用编号、历史预览、读了多少。
 *
 * 这三件事**没有状态、没有 ref、不碰 UI**，放在 2000 多行的 `AskScreen.tsx` 里
 * 只让那个文件更难读，也让人以为它们和页面生命周期有关。搬出来后：
 * 改「引用怎么排」不用滚过整个页面，测也不需要挂渲染树。
 */
import type { DocumentCoverage, QaCitation, QaTurn } from '../types';
import { collectCitations } from './mdBlocks';

/** 引用的稳定 key：`碎片`/`小结`/`待办`/`网页` 四类 id 会重号，必须带类型 */
export function citeKey(kind: string, id: number): string {
  return `${kind}${id}`;
}

/** 历史列表的预览：把 Markdown 外壳剥掉，只留能读的一行 */
export function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*>`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 「读了多少」的一行话。只报事实，不粉饰：
 * 用户看到 2/10 就知道答案是基于部分片段来的。
 */
export function coverageLine(coverage: DocumentCoverage[]): string {
  const read = coverage.filter((c) => c.includedChunks > 0);
  const missing = coverage.filter((c) => c.includedChunks === 0);
  const parts = read.map((c) => `《${c.name}》${c.includedChunks}/${c.totalChunks} 段`);
  const body = `${parts.slice(0, 3).join(' · ')}${parts.length > 3 ? ` 等 ${parts.length} 份` : ''}`;
  // 全部读完就别说「部分」，把话说准才有用
  const partial = read.some((c) => c.includedChunks < c.totalChunks);
  const head = !read.length
    ? '没有读到可用的片段'
    : partial
      ? `基于部分片段：${body}`
      : `读到的片段：${body}`;
  const absent = missing.length ? `；${missing.map((c) => `《${c.name}》`).join('')}里没找到相关内容` : '';
  return `${head}${absent}`;
}

/**
 * 引用编号按「在回答里第一次出现的顺序」排。
 * 这样正文里的小标是 1、2、3，底下的来源列表也是 1、2、3，对得上。
 */
export function orderedCitations(turn: QaTurn): QaCitation[] {
  const all = turn.citations ?? [];
  if (!all.length) return [];
  const byKey = new Map(all.map((c) => [citeKey(c.kind, c.id), c]));
  const out: QaCitation[] = [];
  const seen = new Set<string>();
  for (const ref of collectCitations(turn.answer)) {
    const k = citeKey(ref.kind, ref.id);
    if (seen.has(k)) continue;
    const c = byKey.get(k);
    if (!c) continue;
    seen.add(k);
    out.push(c);
  }
  // 模型没在正文里写、但 citations 里有的（理论上不会），附在最后，别让来源丢掉
  for (const c of all) {
    const k = citeKey(c.kind, c.id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}
