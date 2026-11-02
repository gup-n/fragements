/**
 * MinerU 轻量 Agent 接口（免 Token，按 IP 限频）。
 *
 * 为什么要单独一层：
 * - 这是**唯一会把用户文件发到外网**的地方，调用点必须能一眼看清「发了什么、发到哪」；
 * - 「建任务 → PUT 上传 → 轮询 → 下载 Markdown」四步里每一步的失败说法都不一样，
 *   散在页面里就只剩一句「解析失败」。
 *
 * 两条不能改的实现细节：
 * 1. **上传不能自己设 Content-Type。** 接口给的是预签名地址，多一个头会让签名对不上。
 * 2. **轮询状态要映射成四个阶段**，界面上只显示「上传 / 排队 / 解析 / 下载结果」。
 *    把 `converting` 这种原样端给用户，没人看得懂。
 */
import { fetch as expoFetch } from 'expo/fetch';
import { uploadAsync, FileSystemUploadType } from 'expo-file-system/legacy';

const API_BASE = 'https://mineru.net/api/v1/agent/parse';
const CREATE_URL = `${API_BASE}/file`;

/** 轻量接口的硬限制。超了服务端也会拒，但本地先拦能省一次上传 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_LABEL = '10 MB';

/** 轮询间隔与总时长。解析大文件时 3 秒一次对服务端压力也不大 */
const POLL_INTERVAL = 3000;
const MAX_WAIT = 10 * 60 * 1000;
/** 单次 HTTP 请求超时。轮询出错会重试，建任务/上传超时就直接报错 */
const REQUEST_TIMEOUT = 30_000;
/** 轮询连续失败几次就放弃。断网时不要空转到 10 分钟 */
const MAX_POLL_FAILURES = 3;

export type MineruStage = 'uploading' | 'queued' | 'parsing' | 'downloading';

export const STAGE_LABEL: Record<MineruStage, string> = {
  uploading: '上传',
  queued: '排队',
  parsing: '解析',
  downloading: '下载结果',
};

/** 一句话进度。拼在「解析中 ·」后面会出现「解析中 · 下载结果」这种病句，所以单独给一句 */
export function stageText(stage: MineruStage): string {
  return `正在${STAGE_LABEL[stage]}`;
}

export interface MineruFile {
  name: string;
  ext: string;
  size: number;
  uri: string;
}

/**
 * 解析失败的结构化错误。
 *
 * `code` 给程序分支用（'too-large' / 'network' / 服务端数字码），
 * `message` 直接上屏。**不要抛裸字符串**：页面没法判断该不该让用户重试。
 */
export class MineruError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'MineruError';
  }
}

/** 把任意异常收成一句能读的话，页面 catch 之后直接显示 */
export function mineruMessage(e: unknown): string {
  if (e instanceof MineruError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return '解析失败，请稍后重试';
}

/**
 * 服务端错误码 → 人话。**顺序按官方文档**：
 * -30001 大小、-30002 类型、-30003 页数、-30004 参数。
 * 这几类重试都没用，必须直接告诉用户该怎么办。
 */
const SERVER_ERRORS: Record<string, string> = {
  '-30001': `文件太大，轻量解析接口最多支持 ${MAX_FILE_LABEL}`,
  '-30002': '这个格式解析不了，支持 PDF / Word / PPT / Excel / 图片和纯文本',
  '-30003': '文件页数太多，轻量解析接口最多支持 20 页',
  '-30004': '请求参数不被接受，换一个文件再试',
};

function serverMessage(code: string, fallback?: string): string {
  return SERVER_ERRORS[code] ?? (fallback || '解析服务返回了错误，请稍后重试');
}

function asErrorCode(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  return '';
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * 发一个 JSON 请求并把 `data` 取出来。
 *
 * 超时用 AbortController 自己控，不用 Promise.race —— race 之后请求还在跑，
 * 轮询会越积越多。
 */
async function requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    const aborted = e instanceof Error && /abort/i.test(e.name + e.message);
    throw new MineruError(
      'network',
      aborted ? '请求解析服务超时，请检查网络后重试' : '连不上解析服务，请检查网络后重试',
    );
  } finally {
    clearTimeout(timer);
  }

  let raw = '';
  try {
    raw = await res.text();
  } catch {
    throw new MineruError('network', '读取解析服务的响应失败，请稍后重试');
  }

  let json: Record<string, unknown> | null = null;
  try {
    json = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    throw new MineruError('server', '解析服务返回了无法识别的内容，请稍后重试');
  }

  const code = asErrorCode(json?.code);
  if (json && code && code !== '0' && code !== '200') {
    throw new MineruError(code, serverMessage(code, asText(json.msg)));
  }
  if (!res.ok) {
    if (res.status === 413) {
      throw new MineruError('too-large', `文件超过 ${MAX_FILE_LABEL}，轻量解析接口不支持`);
    }
    if (res.status === 429) {
      throw new MineruError('rate-limit', SERVER_ERRORS['-30004']);
    }
    throw new MineruError('server', `解析服务暂时不可用（HTTP ${res.status}），请稍后重试`);
  }
  if (!json) throw new MineruError('server', '解析服务返回了空响应，请稍后重试');

  const data = json.data;
  if (!data || typeof data !== 'object') {
    throw new MineruError('server', asText(json.msg) || '解析服务没有返回任务信息');
  }
  return data as Record<string, unknown>;
}

/** 建任务：拿到 task_id 和预签名上传地址 */
async function createTask(file: MineruFile): Promise<{ taskId: string; fileUrl: string }> {
  const data = await requestJson(CREATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_name: file.name,
      language: 'ch',
      enable_table: true,
      // 默认不做 OCR：扫描件识别慢且容易错，用户明确需要时再考虑开口子
      is_ocr: false,
      enable_formula: true,
    }),
  });

  const taskId = asText(data.task_id);
  const fileUrl = asText(data.file_url);
  if (!taskId || !fileUrl) {
    throw new MineruError('server', '解析服务没有返回上传地址，请稍后重试');
  }
  return { taskId, fileUrl };
}

/**
 * PUT 原文件。
 *
 * `uploadAsync` 走原生，比把几 MB 读进 JS 再 fetch 稳；`BINARY_CONTENT` 表示
 * 文件内容就是整个请求体。**不要加 Content-Type**，预签名地址对头部敏感。
 */
async function uploadFile(fileUrl: string, uri: string): Promise<void> {
  let res;
  try {
    res = await uploadAsync(fileUrl, uri, {
      httpMethod: 'PUT',
      uploadType: FileSystemUploadType.BINARY_CONTENT,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new MineruError('upload', `上传原文件失败：${msg}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new MineruError('upload', `上传原文件失败（HTTP ${res.status}），请检查网络后重试`);
  }
}

/**
 * 轮询到 `done`，返回 Markdown 的下载地址。
 *
 * 状态机：`waiting-file | uploading | pending | running | converting | done | failed`。
 * 前三个归「排队」，中间两个归「解析」。不认识的 state 一律当「还在跑」，
 * 服务端以后加了新状态也不会把任务误判成失败。
 */
async function waitForTask(
  taskId: string,
  onProgress: (stage: MineruStage) => void,
): Promise<string> {
  const deadline = Date.now() + MAX_WAIT;
  let failures = 0;
  let lastStage: MineruStage | null = null;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);
    let data: Record<string, unknown>;
    try {
      data = await requestJson(`${API_BASE}/${encodeURIComponent(taskId)}`, { method: 'GET' });
      failures = 0;
    } catch (e) {
      // 断网/超时重试几次；服务端明确报错（文件不合规、限频）就别再耗了
      if (e instanceof MineruError && e.code === 'network' && ++failures < MAX_POLL_FAILURES) {
        continue;
      }
      throw e;
    }

    const state = asText(data.state).toLowerCase();
    if (state === 'done') {
      const url = asText(data.markdown_url);
      if (!url) throw new MineruError('server', '解析完成了，但没拿到结果地址，请重新解析');
      return url;
    }
    if (state === 'failed') {
      // 失败原因在 data 里：err_code 是轻量接口的数字码，err_msg 是原文。
      // **不要退回 data.code** —— 那是业务码（0 表示请求成功），拿它当失败原因会显示错话
      const code = asErrorCode(data.err_code);
      const msg = asText(data.err_msg) || asText(data.msg);
      throw new MineruError(code || 'failed', serverMessage(code, msg || '解析失败，请稍后重试'));
    }

    const stage: MineruStage =
      state === 'running' || state === 'converting' ? 'parsing' : 'queued';
    if (stage !== lastStage) {
      lastStage = stage;
      onProgress(stage);
    }
  }

  throw new MineruError('timeout', '解析超过 10 分钟还没完成，可以稍后重试，或换个小一点的文件');
}

/** 下载解析结果。Markdown 可能很大，用 expo/fetch 拿文本 */
async function downloadMarkdown(url: string): Promise<string> {
  let res;
  try {
    res = await expoFetch(url);
  } catch {
    throw new MineruError('download', '下载解析结果失败，请检查网络后重试');
  }
  if (!res.ok) {
    throw new MineruError('download', `下载解析结果失败（HTTP ${res.status}），请稍后重试`);
  }
  let text = '';
  try {
    text = await res.text();
  } catch {
    throw new MineruError('download', '解析结果是空的，请重新解析');
  }
  if (!text.trim()) throw new MineruError('download', '解析结果是空的，请重新解析');
  return text;
}

/**
 * 上传 + 解析 + 下载，一步到位。
 *
 * 失败一律抛 `MineruError`；调用方只负责写库（保留记录，不删原文件）。
 * `onProgress` 只在阶段变化时调用，界面不用自己去重。
 */
export async function parseWithMineru(
  file: MineruFile,
  onProgress: (stage: MineruStage, detail?: string) => void,
): Promise<string> {
  if (file.size > MAX_FILE_BYTES) {
    throw new MineruError('too-large', `文件超过 ${MAX_FILE_LABEL}，轻量解析接口不支持`);
  }
  if (!file.uri) {
    throw new MineruError('no-file', '原文件已经不在手机上了，没法解析');
  }

  const { taskId, fileUrl } = await createTask(file);

  onProgress('uploading');
  await uploadFile(fileUrl, file.uri);

  onProgress('queued');
  const markdownUrl = await waitForTask(taskId, (stage) => onProgress(stage));

  onProgress('downloading');
  return downloadMarkdown(markdownUrl);
}
