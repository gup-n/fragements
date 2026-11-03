/**
 * 文档格式与就绪判定。**只有这一份**。
 *
 * 这里要守住一条容易走偏的边界：**能打开 ≠ 有可检索文本**。
 * 一个 PDF 能翻页不代表能搜、能问；`isDocumentReady` 只认「正文有了、
 * 版本对得上、切片建好了」这一种状态。列表、阅读器、问答三处都读它，
 * 各写一份的话迟早出现「界面说能问、发出去才发现没索引」。
 *
 * 与 `util/docSupport.ts` 的分工：
 * - `docSupport` 管「发到 MinerU 走哪条通道」（云端能力与额度）；
 * - 这里管「本地能读到什么程度」（阅读与检索能力）。
 * 两者不共用判据，也不互相兜底 —— 云解析能解不等于本地能读原版式。
 */
import type { DocumentLocator, DocumentMeta } from '../types';

export type DocumentFormat = 'pdf' | 'excel' | 'markdown' | 'text' | 'other';

const EXCEL = new Set(['xlsx', 'xls', 'xlsm', 'csv']);
const MARKDOWN = new Set(['md', 'markdown']);
const TEXT = new Set(['txt']);

export function documentFormat(ext: string): DocumentFormat {
  const e = ext.toLowerCase().replace(/^\./, '').trim();
  if (e === 'pdf') return 'pdf';
  if (EXCEL.has(e)) return 'excel';
  if (MARKDOWN.has(e)) return 'markdown';
  if (TEXT.has(e)) return 'text';
  return 'other';
}

/**
 * 首版有应用内阅读器的格式。Word 明确**不在**其中：docx 的本地提取
 * 收益低（样式/表复杂）、风险高（解析错就显示错），首版保留原件打开
 * 与主动云解析这两条既有路径。
 */
export function supportsLocalDocument(ext: string): boolean {
  return documentFormat(ext) !== 'other';
}

/**
 * 资源界限。**这些是本地读取的上限，不是云解析的配额** ——
 * 别把 10 MB / 20 页搬过来，那是 MinerU 的限制。
 *
 * 超限时原件照样保存、照样能用外部应用打开，只是不给应用内阅读器：
 * 手机内存撑不住整份解码，硬上会 OOM 崩掉整个 App。必须明确告诉用户
 * 超了哪一条，不许静默截断后当作完整结果显示。
 */
export const LOCAL_READER_LIMITS = {
  /** PDF 原文件大小。48 MiB 是实测能整份解码的保守值 */
  pdfBytes: 48 * 1024 * 1024,
  /** PDF 页数。再多就不是「翻」而是「搜」了，超过就得另想办法 */
  pdfPages: 300,
  /** Excel 原文件大小 */
  excelBytes: 12 * 1024 * 1024,
  /** Excel 实际迭代的单元格数（不是 !ref 声明的范围，那是稀疏的） */
  excelCells: 100_000,
  /** 纯文本原文件大小。4 MiB 的 UTF-8 中文约 130 万字 */
  textBytes: 4 * 1024 * 1024,
  /** 规范正文总字数上限，超出即视为该文档不可整体装入 */
  bodyChars: 2_000_000,
  /** 单个切片字数 */
  chunkChars: 4_000,
  /** 单篇文档最多切片数 */
  chunks: 4_000,
} as const;

/**
 * 这篇文档能不能被「问」用。
 *
 * 四个条件缺一不可：
 * 1. 不是 parsing / failed —— 正在准备或已经失败的正文不能拿去回答；
 * 2. 有正文（charCount > 0）—— 「已保存原件」不等于「有可读内容」；
 * 3. 内容版本有效（> 0）—— 0 表示从没提取成功过；
 * 4. 索引版本与内容版本一致 —— 否则问的是上一版内容，引用会指错地方。
 */
export function isDocumentReady(doc: DocumentMeta): boolean {
  if (doc.state === 'parsing' || doc.state === 'failed' || doc.state === 'stored') return false;
  if (doc.charCount <= 0) return false;
  if (doc.contentRevision <= 0) return false;
  if (doc.indexedRevision !== doc.contentRevision) return false;
  return doc.chunkCount > 0;
}

/** 为什么还不能问。界面直接用这句话，不要在页面里另写一套判断 */
export function notReadyReason(doc: DocumentMeta): string {
  if (doc.state === 'parsing') return '正在准备正文';
  if (doc.state === 'failed') return doc.error ? `上次准备失败：${doc.error}` : '上次准备失败';
  if (doc.state === 'stored' || doc.charCount <= 0) return '还没有正文，需要在本地准备';
  if (doc.contentRevision <= 0) return '还没有正文，需要在本地准备';
  if (doc.indexedRevision !== doc.contentRevision) return '正文更新过，索引还没跟上';
  if (doc.chunkCount <= 0) return '没有可检索的片段';
  return '还不能提问';
}

/**
 * 位置的显示文案。**没有位置就不猜**：旧数据只存了 Markdown 正文，
 * 反推不出 PDF 页码，硬算出来的页码会把用户带到错误的地方。
 */
export function locatorLabel(locator?: DocumentLocator): string {
  if (!locator) return '正文';
  switch (locator.kind) {
    case 'pdf':
      return locator.page ? `第 ${locator.page} 页` : '正文';
    case 'sheet': {
      const sheet = locator.sheet ? `「${locator.sheet}」` : '';
      if (locator.cellRange) return `${sheet}${locator.cellRange}`.trim() || '表格';
      if (locator.rowStart && locator.rowEnd) {
        return `${sheet}第 ${locator.rowStart}–${locator.rowEnd} 行`;
      }
      return sheet ? `${sheet}` : '表格';
    }
    case 'text':
    case 'markdown': {
      const range =
        locator.lineStart && locator.lineEnd
          ? `第 ${locator.lineStart}–${locator.lineEnd} 行`
          : locator.lineStart
            ? `第 ${locator.lineStart} 行`
            : '';
      if (locator.section && range) return `${locator.section} · ${range}`;
      if (locator.section) return locator.section;
      if (range) return range;
      return '正文';
    }
    default:
      return '正文';
  }
}
