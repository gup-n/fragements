/**
 * 阅读器与本地提取的错误。
 *
 * 单独抽出来的理由：这几个错误要跨层传 —— 提取器抛、任务服务接、界面显示。
 * 如果各层自己拼中文句子，用户会在「准备失败」和「没有文字层」之间看到两套说法，
 * 而且没法按类型做分支（比如「没文字层」应该引导去云解析，「超出上限」应该
 * 提示用外部应用打开）。所以错误码是契约，消息只是给人看的。
 *
 * 取消统一用 `AbortError`（Web 标准名字），任务层靠 `name` 判断，不要看消息文本。
 */
import { LOCAL_READER_LIMITS } from '../formats';

export type ReaderErrorCode =
  /** 原文件比阅读器上限大 */
  | 'too-large'
  /** PDF 页数超过上限 */
  | 'too-many-pages'
  /** Excel 有效单元格超过上限 */
  | 'too-many-cells'
  /** 规范正文超过上限 */
  | 'too-long'
  /** 切片数超过上限 */
  | 'too-many-chunks'
  /** PDF 有打开密码 */
  | 'encrypted'
  /** PDF 结构损坏，PDF.js 读不动 */
  | 'corrupt'
  /** PDF 能翻页但没有文字层（扫描件） */
  | 'no-text-layer'
  /** 文本不是 UTF-8 / 是二进制 */
  | 'encoding'
  /** 首版没有应用内阅读器的格式 */
  | 'unsupported'
  /** 网页版没有应用内阅读器 */
  | 'unsupported-web'
  /** 原文件不在手机上了 */
  | 'no-file'
  /** 文档运行时没挂上（App 根节点漏了 <DocumentRuntime />） */
  | 'runtime-unavailable'
  /** 提取超时 */
  | 'timeout'
  /** WebView 自己报错 */
  | 'webview';

export class ReaderError extends Error {
  readonly code: ReaderErrorCode;

  constructor(code: ReaderErrorCode, message: string) {
    super(message);
    this.name = 'ReaderError';
    this.code = code;
  }
}

/** 按字节数提示「超了哪一条」，不要只说「文件太大」 */
export function tooLargeMessage(what: string, size: number, limit: number): string {
  return `${what}有 ${formatSize(size)}，超过应用内阅读上限 ${formatSize(limit)}。原件仍在本机，可以用其它应用打开；也可以先用云解析取正文。`;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 正文超限。**不许截断后当完整结果** —— 用户会拿它去提问，
 * 而模型只会根据前一半内容回答，看起来像「原文没写」。
 */
export function bodyTooLong(chars: number): ReaderError {
  return new ReaderError(
    'too-long',
    `提取到的正文约 ${chars} 字，超过应用内阅读上限 ${LOCAL_READER_LIMITS.bodyChars} 字。` +
      '原件仍在本机，可以先用外部应用打开；这篇不能用应用内阅读和提问。',
  );
}

export function abortError(): Error {
  const e = new Error('已取消');
  e.name = 'AbortError';
  return e;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/** 把任意异常压成一句能上屏的话。不要把 `[object Object]` 漏给用户 */
export function readerMessage(e: unknown, fallback = '读取失败'): string {
  if (e instanceof ReaderError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  return fallback;
}
