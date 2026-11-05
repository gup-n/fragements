/**
 * 本地提取：把一份文档变成 `DocumentContentInput`（规范正文 + 切片 + 来源）。
 *
 * 这是「应用内准备资料」的唯一入口，四条底线：
 *
 * - **超限明确失败**，不静默截断（截断后的正文会被当成完整原文去回答问题）；
 * - **每片都有真实位置**（PDF 页号来自 PDF.js、Excel 行列来自工作表本身、
 *   文本行号来自 `\n`），旧 Markdown 不猜原文件位置；
 * - **扫不出文字就说没有文字层**，不把空字符串当成功；
 * - **取消抛 `AbortError`**，任务层据此区分「用户取消」和「真失败」。
 */
import type { Document, DocumentChunkInput, DocumentContentInput } from '../../types';
import { LOCAL_READER_LIMITS, documentFormat } from '../formats';
import { assertBody, assertChunkCount, contentFromText, splitByLines } from './chunk';
import { assertDecodableText } from './textDecode';
import { readWorkbook, workbookToContent } from './excelWorkbook';
import { recallWorkbook, rememberWorkbook, workbookKey } from './workbookCache';
import { extractPdfPages } from './pdfRuntime';
import { readDocBytes, readDocText, requireFileUri } from './readerFiles';
import { ReaderError, abortError, tooLargeMessage } from './errors';
import type { LocalExtractOptions } from './contract';

export type { LocalExtractOptions } from './contract';

/** 每一步之间检查取消：PDF 提取可能跑几十秒，不检查会「点了取消还在跑」 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * PDF：文字层 → 按页切片。
 *
 * 页号用 PDF.js 的物理页号（1 起），不做「第几页」的换算 —— 用户看到的页码
 * 就是他阅读器里数到的那个，反推一次只会错一次。
 */
async function extractPdf(
  doc: Document,
  options: LocalExtractOptions,
): Promise<DocumentContentInput> {
  if (doc.size > LOCAL_READER_LIMITS.pdfBytes) {
    throw new ReaderError(
      'too-large',
      tooLargeMessage('这份 PDF', doc.size, LOCAL_READER_LIMITS.pdfBytes),
    );
  }
  const uri = requireFileUri(doc.fileUri);
  const pages = await extractPdfPages(uri, options);
  throwIfAborted(options.signal);

  if (pages.pageCount > LOCAL_READER_LIMITS.pdfPages) {
    throw new ReaderError(
      'too-many-pages',
      `这份 PDF 有 ${pages.pageCount} 页，超过应用内阅读上限 ${LOCAL_READER_LIMITS.pdfPages} 页。原件仍在本机，可以用其它应用打开。`,
    );
  }

  // 扫描件：能翻页但没有可提取的文字。这里必须失败，
  // 否则库里会存下一份空正文，界面上却写着「已准备」，提问时什么也搜不到
  if (!pages.pageTexts.some((t) => t.trim())) {
    throw new ReaderError(
      'no-text-layer',
      '这份 PDF 没有文字层（通常是扫描件或图片转的 PDF）：可以翻页，但不能在应用内查找，也不能用来提问。需要正文请用 Mineru 云解析（会上传原件）。',
    );
  }

  const bodyMd = pages.pageTexts.join('\n\n');
  assertBody(bodyMd);

  const chunks: DocumentChunkInput[] = [];
  for (let i = 0; i < pages.pageTexts.length; i++) {
    const text = pages.pageTexts[i];
    if (!text.trim()) continue;
    for (const piece of splitByLines(text)) {
      chunks.push({ text: piece.text, locator: { kind: 'pdf', page: i + 1 } });
    }
  }
  assertChunkCount(chunks.length);
  options.onProgress?.(bodyMd);

  return { bodyMd, chunks, source: 'pdf', pages: pages.pageCount };
}

/** xlsx / xls / csv：SheetJS 只读，不重算公式 */
async function extractWorkbookFile(
  doc: Document,
  options: LocalExtractOptions,
): Promise<DocumentContentInput> {
  if (doc.size > LOCAL_READER_LIMITS.excelBytes) {
    throw new ReaderError(
      'too-large',
      tooLargeMessage('这个表格', doc.size, LOCAL_READER_LIMITS.excelBytes),
    );
  }
  const uri = requireFileUri(doc.fileUri);

  /*
   * 和阅读器共用同一份解析结果：用户通常是「先在这里准备，再点开看」，
   * 两次 `XLSX.read` 里没有哪一次是必要的。缓存只是加速，失败照常往上抛。
   */
  const key = workbookKey(uri, doc.size);
  let view = recallWorkbook(key);
  if (!view) {
    const buf = await readDocBytes(uri);
    throwIfAborted(options.signal);
    view = readWorkbook(buf);
    rememberWorkbook(key, view);
  }
  throwIfAborted(options.signal);

  const content = workbookToContent(view);
  options.onProgress?.(content.bodyMd);
  return content;
}

/** txt / md：本地直接读，不走云解析 */
async function extractTextFile(
  doc: Document,
  options: LocalExtractOptions,
): Promise<DocumentContentInput> {
  if (doc.size > LOCAL_READER_LIMITS.textBytes) {
    throw new ReaderError(
      'too-large',
      tooLargeMessage('这个文本文件', doc.size, LOCAL_READER_LIMITS.textBytes),
    );
  }
  const uri = requireFileUri(doc.fileUri);
  const text = await readDocText(uri);
  throwIfAborted(options.signal);
  // 编码不对就明确提示，不要把乱码当正文存进去
  assertDecodableText(text);

  const content = contentFromText(text, documentFormat(doc.ext) === 'markdown' ? 'markdown' : 'text');
  options.onProgress?.(content.bodyMd);
  return content;
}

export async function extractLocalDocument(
  document: Document,
  options: LocalExtractOptions = {},
): Promise<DocumentContentInput> {
  throwIfAborted(options.signal);
  switch (documentFormat(document.ext)) {
    case 'pdf':
      return extractPdf(document, options);
    case 'excel':
      return extractWorkbookFile(document, options);
    case 'markdown':
    case 'text':
      return extractTextFile(document, options);
    default:
      throw new ReaderError(
        'unsupported',
        `「${document.ext || '未知格式'}」还没有应用内阅读器。原件仍在本机，可以用其它应用打开，或者用云解析取正文。`,
      );
  }
}
