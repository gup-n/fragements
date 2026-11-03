/**
 * 阅读器对外的小契约。单独一个文件是为了打断 `extract ⇄ runtime` 的循环依赖：
 * 两边都要 `LocalExtractOptions`，放进任一侧都成环。
 */
export interface LocalExtractOptions {
  /** 取消。任务层用 `e.name === 'AbortError'` 判断取消，不要看消息 */
  signal?: AbortSignal;
  /**
   * 提取进度。
   *
   * PDF 下这是**已提取部分的累计正文**（不是增量），最多回调 6 次 ——
   * 每页都回一次等于把整份正文按页数重复过桥。完整结果只在返回值里。
   */
  onProgress?: (text: string) => void;
}

/** PDF 每页文本，保持真实页序（索引 0 = 第 1 页） */
export interface PdfPages {
  pageTexts: string[];
  pageCount: number;
}
