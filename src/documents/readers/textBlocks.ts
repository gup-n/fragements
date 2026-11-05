/**
 * 正文分块：把一整篇文本切成可虚拟化的 ~1 KB 片段。
 *
 * 为什么从 `TextReader.tsx` 里搬出来：这段逻辑现在有两个使用者 ——
 * 本机 txt/md，以及云解析出来的 Word/PPT 快照（同一份 Markdown 走同一个阅读器）。
 * 它是**纯字符串处理**，搬成 `.ts` 就能在 node 里断言「切完拼回去一个字不少」，
 * 而这件事靠手点真机是验不出来的：少一段只有用户恰好读到那里才发现。
 *
 * 两条不能切的位置：
 * - **代码围栏内部**：切开会留下半个 ```，后面全被当成代码；
 * - **表格行之间**：GFM 表格要求连续，切开就成了两段竖线。
 */

export interface Block {
  text: string;
  /** 在整篇文本里的起始偏移（TXT 用来把命中映射回块） */
  start: number;
  lineStart: number;
  lineEnd: number;
}

/** 收块阈值：软阈值到了就在段落边界收，硬阈值到了不管在哪都收 */
const MAX = 1200;
const SOFT = 320;

/**
 * 切成可虚拟化的块。
 *
 * 为什么不按行：4 MB 文本可能有十几万行，一行一个 FlatList item，光 key 就够卡。
 * 也不能切得太碎：块多到几千个时滚动同步会抖。目标 ~1 KB 一块。
 */
export function buildBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let buf: string[] = [];
  let size = 0;
  let startLine = 0;
  let endLine = 0;
  let startOffset = 0;
  let offset = 0;
  let inFence = false;

  const push = () => {
    if (!buf.length) return;
    blocks.push({ text: buf.join('\n'), start: startOffset, lineStart: startLine, lineEnd: endLine });
    buf = [];
    size = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineOffset = offset;
    offset += raw.length + 1;

    if (/^\s*```/.test(raw)) inFence = !inFence;

    if (!buf.length) {
      if (!raw.trim()) continue;
      startLine = i + 1;
      startOffset = lineOffset;
    }

    buf.push(raw);
    size += raw.length + 1;
    endLine = i + 1;

    if (inFence || size < SOFT) continue;
    const next = lines[i + 1] ?? '';
    if (raw.includes('|') && next.includes('|')) continue;
    if (size >= MAX || !next.trim()) push();
  }

  push();
  return blocks;
}

/** 命中偏移落在哪一块。块按 start 升序，二分即可 */
export function blockAt(blocks: Block[], offset: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].start <= offset) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
