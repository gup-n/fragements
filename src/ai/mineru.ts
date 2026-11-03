/**
 * MinerU 解析。两条通道，不是重复实现：
 *
 * - **轻量 Agent 接口**（`/api/v1/agent/parse`）：免 Token、按 IP 限频，
 *   但只吃 ≤10 MB / ≤20 页。默认走这条，因为不花用户一分钱也不用配置。
 * - **精准接口**（`/api/v4`）：要 Token，≤200 MB / ≤200 页，每天 1000 页额度，
 *   还支持轻量不认的 `.doc` / `.ppt` / `.xls`。只在「轻量放不下」时才走。
 *
 * 为什么不干脆都用精准的：它消耗每日额度，而轻量完全免费。能用免费的先用。
 *
 * 为什么要单独一层：
 * - 这是**唯一会把用户文件发到外网**的地方，调用点必须能一眼看清「发了什么、发到哪」；
 * - 「建任务 → PUT 上传 → 轮询 → 下载结果」四步里每一步的失败说法都不一样，
 *   散在页面里就只剩一句「解析失败」。
 *
 * 三条不能改的实现细节：
 * 1. **上传不能自己设 Content-Type。** 接口给的是预签名地址，多一个头会让签名对不上。
 * 2. **轮询状态要映射成四个阶段**，界面上只显示「上传 / 排队 / 解析 / 下载结果」。
 *    把 `converting` 这种原样端给用户，没人看得懂。
 * 3. **精准接口返回的是 zip**，只有里面那个 `full.md` 有用。解压时按文件名过滤，
 *    不要把整包解开 —— 200 MB 的文档连中间产物一起解会直接把内存吃穿。
 *
 * 取消（v0.12）：两条通道都收 `AbortSignal`，一路传到 fetch / 上传任务 / 下载。
 * 取消抛 `MineruError('cancelled')`，用 `isCancelled` 判定。**它不等于失败** ——
 * 上层要把文档状态还原，而不是写一条 failed 记录。
 */
import { fetch as expoFetch } from 'expo/fetch';
import { createUploadTask, FileSystemUploadType } from 'expo-file-system/legacy';
import { strFromU8, unzipSync } from 'fflate';
import { repo } from '../db/repo';

const API_BASE = 'https://mineru.net/api/v1/agent/parse';
const CREATE_URL = `${API_BASE}/file`;

/** 轻量接口的硬限制。超了服务端也会拒，但本地先拦能省一次上传 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_LABEL = '10 MB';

/** 精准接口（/api/v4）：Token、200 MB、200 页 */
const PRO_API_BASE = 'https://mineru.net/api/v4';
export const PRO_MAX_FILE_BYTES = 200 * 1024 * 1024;
export const PRO_MAX_FILE_LABEL = '200 MB';
export const PRO_MAX_PAGES = 200;

/** 轮询间隔与总时长。解析大文件时 3 秒一次对服务端压力也不大 */
const POLL_INTERVAL = 3000;
const MAX_WAIT = 10 * 60 * 1000;
/** 精准接口处理 200 页要排队更久，给它 20 分钟 */
const PRO_MAX_WAIT = 20 * 60 * 1000;
/** 单次 HTTP 请求超时。轮询出错会重试，建任务/上传超时就直接报错 */
const REQUEST_TIMEOUT = 30_000;
/** 轮询连续失败几次就放弃。断网时不要空转到 10 分钟 */
const MAX_POLL_FAILURES = 3;

/** MinerU Token 的 settings key。空 = 只有轻量通道可用 */
const K_TOKEN = 'mineru_token';

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

/** 用户填的精准接口 Token，空串表示没填 */
export async function getMineruToken(): Promise<string> {
  return ((await repo.getSetting(K_TOKEN).catch(() => null)) ?? '').trim();
}

export async function setMineruToken(token: string): Promise<void> {
  await repo.setSetting(K_TOKEN, token.trim());
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
 * 取消是用户主动动作，不是失败。
 *
 * 单独一个 code 是为了让上层能分开处理：失败要落 `failed` 并把原因写进库，
 * 取消必须把状态还原成任务开始前的样子。**不要声称取消能撤回已经上传的字节** ——
 * 上传走的是预签名地址，取消只能让本机停止后续步骤。
 */
export function isCancelled(e: unknown): boolean {
  return e instanceof MineruError && e.code === 'cancelled';
}

function cancelled(): MineruError {
  return new MineruError('cancelled', '已取消这次准备');
}

/**
 * 把外部 signal 接到内部回调上。
 *
 * 不用 `signal.onabort =` 直接赋值：那样会覆盖别的订阅者（任务服务和超时共用同一个
 * signal 时就少一路通知）。部分运行时的 AbortSignal 没有事件接口，这时退回轮询。
 */
function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    fn();
    return () => {};
  }
  if (typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', fn);
    return () => signal.removeEventListener('abort', fn);
  }
  return () => {};
}

/**
 * 服务端错误码 → 人话。**顺序按官方文档**：
 * -30001 大小、-30002 类型、-30003 页数、-30004 参数。
 * 这几类重试都没用，必须直接告诉用户该怎么办。
 */
const SERVER_ERRORS: Record<string, string> = {
  // 这两条必须带上「怎么办」：撞到上限时只说「最多 10 MB」等于把用户堵死，
  // 而填个 Token 就能解到 200 MB —— 出路要写在错误里，不能指望用户自己想到
  '-30001': `文件太大，轻量解析接口最多支持 ${MAX_FILE_LABEL}（填 MinerU Token 可解到 ${PRO_MAX_FILE_LABEL}）`,
  '-30002': '这个格式解析不了，支持 PDF / Word / PPT / Excel / 图片和纯文本',
  '-30003': `文件页数太多，轻量解析接口最多支持 20 页（填 MinerU Token 可解到 ${PRO_MAX_PAGES} 页）`,
  '-30004': '请求参数不被接受，换一个文件再试',
};

/**
 * 精准接口的错误码。和轻量接口**不是一套**，混用会显示文不对题的提示。
 *
 * -60018 / -60019 是额度类：重试没用，只能等明天，必须说清楚。
 */
const PRO_SERVER_ERRORS: Record<string, string> = {
  '-30001': `文件太大，精准接口最多支持 ${PRO_MAX_FILE_LABEL}`,
  '-30002': '这个格式解析不了',
  '-30003': `文件页数太多，精准接口最多支持 ${PRO_MAX_PAGES} 页`,
  '-30004': '请求参数不被接受，换一个文件再试',
  '-60018': '今天的解析额度用完了（每天 1000 页），明天再试',
  '-60019': 'HTML 解析额度不足，明天再试',
};

function serverMessage(
  code: string,
  fallback?: string,
  table: Record<string, string> = SERVER_ERRORS,
): string {
  return table[code] ?? (fallback || '解析服务返回了错误，请稍后重试');
}

function asErrorCode(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  return '';
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 可取消的等待。
 *
 * 按 250ms 切片而不是一次 `setTimeout(ms)`：轮询间隔是 3 秒，一口气睡满的话
 * 用户点了取消还要再等三秒界面才有反应，看起来像「取消没生效」。
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw cancelled();
    const left = deadline - Date.now();
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, left))));
  }
  if (signal?.aborted) throw cancelled();
}

/**
 * 发一个 JSON 请求并把 `data` 取出来。
 *
 * 超时用 AbortController 自己控，不用 Promise.race —— race 之后请求还在跑，
 * 轮询会越积越多。`signal` 是用户的取消：一路挂到 fetch 上，
 * 否则点了取消，在途的 30 秒请求还会把连接占满。
 */
async function requestJson(
  url: string,
  init: RequestInit,
  table: Record<string, string> = SERVER_ERRORS,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (signal?.aborted) throw cancelled();

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, REQUEST_TIMEOUT);
  const off = onAbort(signal, () => ctrl.abort());

  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (signal?.aborted) throw cancelled();
    const aborted = e instanceof Error && /abort/i.test(e.name + e.message);
    throw new MineruError(
      'network',
      aborted || timedOut ? '请求解析服务超时，请检查网络后重试' : '连不上解析服务，请检查网络后重试',
    );
  } finally {
    clearTimeout(timer);
    off();
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
    throw new MineruError(code, serverMessage(code, asText(json.msg), table));
  }
  if (!res.ok) {
    if (res.status === 413) {
      throw new MineruError('too-large', `文件超过 ${MAX_FILE_LABEL}，轻量解析接口不支持`);
    }
    if (res.status === 429) {
      throw new MineruError('rate-limit', '请求太密了，等一分钟再试');
    }
    if (res.status === 401 || res.status === 403) {
      throw new MineruError('bad-token', 'Token 无效或已过期，去 MinerU 网站重新复制一个');
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
async function createTask(file: MineruFile, signal?: AbortSignal): Promise<{ taskId: string; fileUrl: string }> {
  const data = await requestJson(
    CREATE_URL,
    {
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
    },
    SERVER_ERRORS,
    signal,
  );

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
 * 用 `createUploadTask` 而不是 `uploadAsync`：前者能 `cancelAsync()`，
 * 几十 MB 的文件传到一半用户点取消时，只有这条路能真的停手。
 * `BINARY_CONTENT` 表示文件内容就是整个请求体。**不要加 Content-Type**，
 * 预签名地址对头部敏感。
 */
async function uploadFile(fileUrl: string, uri: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw cancelled();

  const task = createUploadTask(fileUrl, uri, {
    httpMethod: 'PUT',
    uploadType: FileSystemUploadType.BINARY_CONTENT,
  });
  const off = onAbort(signal, () => {
    task.cancelAsync().catch(() => undefined);
  });

  let res;
  try {
    res = await task.uploadAsync();
  } catch (e) {
    if (signal?.aborted) throw cancelled();
    const msg = e instanceof Error ? e.message : String(e);
    throw new MineruError('upload', `上传原文件失败：${msg}`);
  } finally {
    off();
  }
  if (signal?.aborted) throw cancelled();
  // 取消时 uploadAsync 可能返回 null
  if (!res) throw new MineruError('upload', '上传原文件失败，请检查网络后重试');
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
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + MAX_WAIT;
  let failures = 0;
  let lastStage: MineruStage | null = null;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL, signal);
    let data: Record<string, unknown>;
    try {
      data = await requestJson(
        `${API_BASE}/${encodeURIComponent(taskId)}`,
        { method: 'GET' },
        SERVER_ERRORS,
        signal,
      );
      failures = 0;
    } catch (e) {
      // 断网/超时重试几次；服务端明确报错（文件不合规、限频）就别再耗了。
      // 取消不进这一支：code 是 'cancelled'，直接往上抛
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
async function downloadMarkdown(url: string, signal?: AbortSignal): Promise<string> {
  let res;
  try {
    res = await expoFetch(url, { signal });
  } catch {
    if (signal?.aborted) throw cancelled();
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
 * `signal` 是用户取消：每一步都接，取消后抛 code='cancelled'。
 */
export async function parseWithMineru(
  file: MineruFile,
  onProgress: (stage: MineruStage, detail?: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (file.size > MAX_FILE_BYTES) {
    throw new MineruError('too-large', `文件超过 ${MAX_FILE_LABEL}，轻量解析接口不支持`);
  }
  if (!file.uri) {
    throw new MineruError('no-file', '原文件已经不在手机上了，没法解析');
  }

  const { taskId, fileUrl } = await createTask(file, signal);

  onProgress('uploading');
  await uploadFile(fileUrl, file.uri, signal);

  onProgress('queued');
  const markdownUrl = await waitForTask(taskId, (stage) => onProgress(stage), signal);

  onProgress('downloading');
  return downloadMarkdown(markdownUrl, signal);
}

/* ------------------------------------------------------------------ *
 * 精准接口（/api/v4）：要 Token，换 200 MB / 200 页和 .doc/.ppt/.xls
 * ------------------------------------------------------------------ */

/** 建任务：拿 batch_id 和预签名上传地址 */
async function createProTask(
  file: MineruFile,
  token: string,
  signal?: AbortSignal,
): Promise<{ batchId: string; fileUrl: string }> {
  const data = await requestJson(
    `${PRO_API_BASE}/file-urls/batch`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        // data_id 只能用字母数字和 _ - .，且 ≤128 字符
        files: [{ name: file.name, data_id: `frag-${Date.now()}` }],
        // pipeline 比 vlm 便宜也够用；vlm 更适合复杂版式，但慢
        model_version: 'pipeline',
        language: 'ch',
        enable_table: true,
        enable_formula: true,
      }),
    },
    PRO_SERVER_ERRORS,
    signal,
  );

  const batchId = asText(data.batch_id);
  const urls = Array.isArray(data.file_urls) ? data.file_urls : [];
  const fileUrl = asText(urls[0]);
  if (!batchId || !fileUrl) {
    throw new MineruError('server', '解析服务没有返回上传地址，请稍后重试');
  }
  return { batchId, fileUrl };
}

/**
 * 轮询批量任务到 `done`，返回结果 zip 的地址。
 *
 * 这里比轻量接口多一步：解析中能读到 `extract_progress`，所以能把
 * 「第 3 / 20 页」显示出来。大文档要跑几分钟，没这个数字用户会以为卡死。
 */
async function waitForProTask(
  batchId: string,
  token: string,
  onProgress: (stage: MineruStage, detail?: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + PRO_MAX_WAIT;
  let failures = 0;
  let lastStage: MineruStage | null = null;
  let lastDetail = '';

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL, signal);

    let data: Record<string, unknown>;
    try {
      data = await requestJson(
        `${PRO_API_BASE}/extract-results/batch/${encodeURIComponent(batchId)}`,
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        PRO_SERVER_ERRORS,
        signal,
      );
      failures = 0;
    } catch (e) {
      if (e instanceof MineruError && e.code === 'network' && ++failures < MAX_POLL_FAILURES) {
        continue;
      }
      throw e;
    }

    const list = Array.isArray(data.extract_result) ? data.extract_result : [];
    const item = list.find((x) => x && typeof x === 'object') as
      | Record<string, unknown>
      | undefined;
    // 刚传完时列表可能还是空的，继续等，别当失败
    if (!item) continue;

    const state = asText(item.state).toLowerCase();

    if (state === 'done') {
      const url = asText(item.full_zip_url);
      if (!url) throw new MineruError('server', '解析完成了，但没拿到结果地址，请重新解析');
      return url;
    }
    if (state === 'failed') {
      const msg = asText(item.err_msg);
      throw new MineruError('failed', msg || '解析失败，请稍后重试');
    }

    const prog = item.extract_progress;
    const box = prog && typeof prog === 'object' ? (prog as Record<string, unknown>) : null;
    const total = Number(box?.total_pages ?? 0);
    const donePages = Number(box?.extracted_pages ?? 0);
    const detail = total > 0 ? `第 ${Math.min(donePages + 1, total)} / ${total} 页` : '';

    const stage: MineruStage = state === 'running' ? 'parsing' : 'queued';
    if (stage !== lastStage || detail !== lastDetail) {
      lastStage = stage;
      lastDetail = detail;
      onProgress(stage, detail || undefined);
    }
  }

  throw new MineruError('timeout', '解析超过 20 分钟还没完成，可以稍后重试，或换个小一点的文件');
}

/**
 * 下载结果 zip，只取出里面的 `full.md`。
 *
 * 用 `filter` 只解一个文件是必须的：包里还有 `layout.json`、`*_content_list.json`、
 * 抽出来的图片，200 MB 的文档这些中间产物加起来比原文件还大，全解开就是内存雪崩。
 */
async function downloadZipMarkdown(url: string, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await expoFetch(url, { signal });
  } catch {
    if (signal?.aborted) throw cancelled();
    throw new MineruError('download', '下载解析结果失败，请检查网络后重试');
  }
  if (!res.ok) {
    throw new MineruError('download', `下载解析结果失败（HTTP ${res.status}），请稍后重试`);
  }

  let buf: Uint8Array;
  try {
    buf = new Uint8Array(await res.arrayBuffer());
  } catch {
    throw new MineruError('download', '读取解析结果失败，请重新解析');
  }

  const isFullMd = (name: string) => /(^|\/)full\.md$/i.test(name);

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf, { filter: (f) => isFullMd(f.name) });
  } catch {
    throw new MineruError('download', '解析结果压缩包读不出来，请重新解析');
  }

  const key = Object.keys(files).find(isFullMd);
  if (!key) throw new MineruError('download', '压缩包里没有 Markdown 结果，请重新解析');

  const md = strFromU8(files[key]);
  if (!md.trim()) throw new MineruError('download', '解析结果是空的，请重新解析');
  return md;
}

/**
 * 精准通道：上传 + 解析 + 下载，一步到位。
 *
 * 只在轻量接口放不下时才该被调用（超 10 MB、超 20 页、或者 .doc/.ppt/.xls）。
 * 它消耗每日 1000 页额度，能走轻量就别走这里。
 */
export async function parseWithMineruPro(
  file: MineruFile,
  token: string,
  onProgress: (stage: MineruStage, detail?: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const t = token.trim();
  if (!t) throw new MineruError('no-token', '还没填 MinerU Token，填了才能用精准解析');
  if (file.size > PRO_MAX_FILE_BYTES) {
    throw new MineruError('too-large', `文件超过 ${PRO_MAX_FILE_LABEL}，精准接口也放不下`);
  }
  if (!file.uri) {
    throw new MineruError('no-file', '原文件已经不在手机上了，没法解析');
  }

  const { batchId, fileUrl } = await createProTask(file, t, signal);

  onProgress('uploading');
  await uploadFile(fileUrl, file.uri, signal);

  onProgress('queued');
  const zipUrl = await waitForProTask(batchId, t, onProgress, signal);

  onProgress('downloading');
  return downloadZipMarkdown(zipUrl, signal);
}
