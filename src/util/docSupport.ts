/**
 * 文档格式的支持矩阵。**只有这一份**。
 *
 * 它管两件事，v0.12 起分得更清楚：
 * - 云通道判据：发到 MinerU 该走轻量还是精准（`planForDoc`），确认卡、重试都读它；
 * - 「哪些格式本机能读」的界面文案（`SUPPORT_HINT` 两段）。
 *
 * **本地读取能力不走这里**，走 `src/documents/formats.ts` 的 `isDocumentReady` /
 * `LOCAL_READER_LIMITS`：云解析能解不等于本机能读原版式，两套判据不互相兜底。
 *
 * 事实来源是 MinerU 官方文档：
 * - 轻量 `/api/v1/agent/parse`：pdf、图片、docx、pptx、**xlsx**（不含 xls/csv），≤10 MB / ≤20 页
 * - 精准 `/api/v4`：在上面基础上多认 doc、ppt、xls，≤200 MB / ≤200 页
 * - 两个都不认：csv、html
 */
import { documentFormat, LOCAL_READER_LIMITS } from '../documents/formats';
import type { DocumentMeta } from '../types';
import {
  MAX_FILE_BYTES,
  MAX_FILE_LABEL,
  MineruError,
  PRO_MAX_FILE_BYTES,
  PRO_MAX_FILE_LABEL,
  parseWithMineru,
  parseWithMineruPro,
  type MineruFile,
  type MineruStage,
} from '../ai/mineru';

/** 本地直读，不发到任何服务器 */
const LOCAL_TEXT = new Set(['txt', 'md', 'markdown']);

/** 轻量接口（免 Token）认的：PDF、图片、新版 Office */
const LITE_OK = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'jp2',
  'webp',
  'gif',
  'bmp',
  'docx',
  'pptx',
  'xlsx',
]);

/** 只有精准接口认的：旧版 Office 三件套 */
const PRO_ONLY = new Set(['doc', 'ppt', 'xls']);

/** 明确不支持的，单独列出来是为了给「怎么办」而不是一句「不支持」 */
const NEVER = new Set(['csv', 'html', 'htm']);

export type DocChannel = 'local' | 'lite' | 'pro';

export interface DocPlan {
  /** 'none' 表示这个文件进不来 */
  channel: DocChannel | 'none';
  /** channel === 'none' 时给用户看的一句话；其余情况为空 */
  reason: string;
  /** true 表示「去设置里填个 Token 就能解」，界面要引导过去 */
  needsToken: boolean;
}

export function isLocalText(ext: string): boolean {
  return LOCAL_TEXT.has(norm(ext));
}

function norm(ext: string): string {
  return ext.toLowerCase().replace(/^\./, '').trim();
}

/**
 * 判断一个文件该走哪条通道。
 *
 * `hasToken` 传当前有没有填 Token —— 同一个文件，填不填 Token 结论不同，
 * 所以这个函数必须收它，不能自己偷偷去读设置（那样就没法在上传前预判了）。
 */
export function planForDoc(ext: string, size: number, hasToken: boolean): DocPlan {
  const e = norm(ext);

  if (!e) {
    return { channel: 'none', reason: '认不出这个文件的格式，换个文件或给它加个后缀名', needsToken: false };
  }

  if (LOCAL_TEXT.has(e)) {
    return { channel: 'local', reason: '', needsToken: false };
  }

  // 超过精准接口的上限就没救了，先统一拦，免得后面的分支各写一遍
  if (size > PRO_MAX_FILE_BYTES) {
    return {
      channel: 'none',
      reason: `超过 ${PRO_MAX_FILE_LABEL}，两个解析接口都放不下`,
      needsToken: false,
    };
  }

  if (PRO_ONLY.has(e)) {
    return hasToken
      ? { channel: 'pro', reason: '', needsToken: false }
      : {
        channel: 'none',
        reason: `.${e} 只有精准解析能读，去设置里填个 MinerU Token 就能上传`,
        needsToken: true,
      };
  }

  if (LITE_OK.has(e)) {
    if (size <= MAX_FILE_BYTES) return { channel: 'lite', reason: '', needsToken: false };
    return hasToken
      ? { channel: 'pro', reason: '', needsToken: false }
      : {
        channel: 'none',
        reason: `超过 ${MAX_FILE_LABEL}（轻量接口上限），填个 MinerU Token 可以解到 ${PRO_MAX_FILE_LABEL}`,
        needsToken: true,
      };
  }

  if (NEVER.has(e)) {
    return {
      channel: 'none',
      reason: `.${e} 两个解析接口都不认，可以先另存为 txt 或 xlsx 再传`,
      needsToken: false,
    };
  }

  return { channel: 'none', reason: `.${e} 不在支持列表里，换成 PDF / Word / PPT / Excel / 图片再试`, needsToken: false };
}

/**
 * 界面上「支持哪些格式」的说明。
 *
 * **必须分成「本地能读」和「需要云解析」两段**：v0.12 起导入只保存原件，
 * 一个 docx 保存成功不等于能读、能问。合成一句「支持 PDF / Word / PPT」的话，
 * 用户会以为放进来就能搜索，直到点开才发现是空的。
 */
export const LOCAL_SUPPORT_HINT = '本机可读：PDF、Excel（xlsx / xls）、txt、md';

export const CLOUD_SUPPORT_HINT = `需要云解析：Word、PPT、图片（≤${MAX_FILE_LABEL}，要上传到 mineru.net）`;

export const SUPPORT_HINT = `${LOCAL_SUPPORT_HINT}；${CLOUD_SUPPORT_HINT}`;

/**
 * 按通道把文件解析成 Markdown。**上传、重试都走这里**。
 *
 * 有这条统一入口，才不会出现「首次上传走轻量、点重试却走了精准」这种
 * 两套判据打架的情况。传进来的必须是**已经存到手机上的副本**，不是选择器给的临时 URI。
 *
 * v0.12 起多两个开关：
 * - `channel`：确认卡上用户明确选了哪条通道（弹卡时就写清了上限与接收方）。
 *   不传则按 `planForDoc` 的默认建议走 —— 这是「界面上给的建议」，不是替用户决定。
 * - `signal`：取消。一路传到 HTTP 层，取消后抛 code='cancelled'。
 */
export async function parseDocFile(
  file: MineruFile,
  token: string,
  onStage: (stage: MineruStage, detail?: string) => void,
  opts?: {
    /** 用户在确认卡上选的通道。'pro' 必须已经有 Token */
    channel?: 'lite' | 'pro';
    /** 用户取消 */
    signal?: AbortSignal;
  },
): Promise<string> {
  const plan = planForDoc(file.ext, file.size, !!token.trim());
  if (plan.channel === 'local') {
    throw new MineruError('local', '这个文件应当本地直读，不需要解析');
  }
  const channel = opts?.channel ?? plan.channel;
  if (channel === 'none') {
    throw new MineruError('unsupported', plan.reason);
  }
  if (channel === 'pro') {
    return parseWithMineruPro(file, token, onStage, opts?.signal);
  }
  return parseWithMineru(file, onStage, opts?.signal);
}

function mbText(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/**
 * 文件大小文案。**0 不写成「0 B」** —— 那多半是没读到，不是空文件，
 * 写成 0 B 会让用户以为文件坏了。列表、确认卡、阅读器共用这一份。
 */
export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '大小未知';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 原件超出本机阅读器上限时给一句话。**非 null 就表示「别费劲本地准备了」**。
 *
 * 硬读会 OOM，把整个 App 带崩比读不了更糟。原件照样保留，能交给外部应用打开，
 * 也可以用云解析 —— 但这两条都得用户自己选，不能在这里偷偷上传。
 */
export function localReaderLimitNote(doc: Pick<DocumentMeta, 'ext' | 'size'>): string | null {
  const fmt = documentFormat(doc.ext);
  if (fmt === 'pdf' && doc.size > LOCAL_READER_LIMITS.pdfBytes) {
    return `PDF 超过 ${mbText(LOCAL_READER_LIMITS.pdfBytes)}，本机阅读器带不动，可以打开原文件或用云端解析`;
  }
  if (fmt === 'excel' && doc.size > LOCAL_READER_LIMITS.excelBytes) {
    return `表格超过 ${mbText(LOCAL_READER_LIMITS.excelBytes)}，本机阅读器带不动，可以打开原文件`;
  }
  if ((fmt === 'text' || fmt === 'markdown') && doc.size > LOCAL_READER_LIMITS.textBytes) {
    return `文本超过 ${mbText(LOCAL_READER_LIMITS.textBytes)}，本机阅读器带不动，可以打开原文件`;
  }
  return null;
}
