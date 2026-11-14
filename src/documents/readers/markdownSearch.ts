/** 搜索按实际 Markdown 渲染片段计数；所有字面匹配仍只走 findHits。 */
import { countHits } from '../../util/highlight';
import { parseBlocks, type Block, type Seg } from '../../util/mdBlocks';

export function segmentHitCount(segs: Seg[], query: string): number {
  return segs.reduce((sum, seg) => sum + (seg.cite ? 0 : countHits(seg.text, query)), 0);
}

export function blockHitCount(block: Block, query: string): number {
  if (!query.trim()) return 0;
  if (block.kind === 'table') {
    return segmentHitCount(block.head.flat(), query)
      + block.rows.reduce((sum, row) => sum + segmentHitCount(row.flat(), query), 0);
  }
  if (block.kind === 'code') return countHits(block.text, query);
  if (block.kind === 'hr' || block.kind === 'image') return 0;
  return segmentHitCount(block.segs, query);
}

/** 第i处 → 第几个实际块。literalCitations 必须与 NoteBody 的开关一致。 */
export function markdownHitBlocks(text: string, query: string, literalCitations = false, limit = 999): number[] {
  if (!query.trim()) return [];
  const out: number[] = [];
  for (const [index, block] of parseBlocks(text, { literalCitations }).entries()) {
    const count = blockHitCount(block, query);
    for (let n = 0; n < count && out.length < limit; n++) out.push(index);
    if (out.length >= limit) break;
  }
  return out;
}
