/**
 * 文档格式的支持矩阵。**只有这一份**。
 *
 * 上传前预判、上传时的提示、失败后给不给「用精准接口重试」，
 * 三处都必须走同一个 `planForDoc`。分开写的话迟早出现
 * 「上传时说支持、解析时说不支持」这种自相矛盾。
 *
 * 事实来源是 MinerU 官方文档：
 * - 轻量 `/api/v1/agent/parse`：pdf、图片、docx、pptx、**xlsx**（不含 xls/csv），≤10 MB / ≤20 页
 * - 精准 `/api/v4`：在上面基础上多认 doc、ppt、xls，≤200 MB / ≤200 页
 * - 两个都不认：csv、html
 */
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

/** 界面上「支持哪些格式」的一句话说明，别在页面里再拼一遍 */
export const SUPPORT_HINT = `PDF / 图片 / docx / pptx / xlsx（≤${MAX_FILE_LABEL}），txt / md 本地直读`;

/**
 * 按通道把文件解析成 Markdown。**上传、重试、失败重解都走这里**。
 *
 * 有这条统一入口，才不会出现「首次上传走轻量、点重试却走了精准」这种
 * 两套判据打架的情况。传进来的必须是**已经存到手机上的副本**，不是选择器给的临时 URI。
 */
export async function parseDocFile(
  file: MineruFile,
  token: string,
  onStage: (stage: MineruStage) => void,
  opts?: {
    /**
     * 有 Token 时优先走精准接口。
     *
     * 「重试」要开这个：上次失败可能就是因为页数超了轻量的 20 页上限，
     * 而页数在本地看不出来（要解 PDF 才知道），只看文件大小的话会再撞一次同一堵墙。
     */
    preferPro?: boolean;
  },
): Promise<string> {
  const plan = planForDoc(file.ext, file.size, !!token.trim());
  if (plan.channel === 'local') {
    throw new MineruError('local', '这个文件应当本地直读，不需要解析');
  }
  if (plan.channel === 'none') {
    throw new MineruError('unsupported', plan.reason);
  }
  if (plan.channel === 'pro' || (opts?.preferPro && token.trim())) {
    return parseWithMineruPro(file, token, onStage);
  }
  return parseWithMineru(file, onStage);
}
