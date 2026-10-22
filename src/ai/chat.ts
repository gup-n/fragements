/**
 * DeepSeek 请求层：流式 + 多段超时 + 错误映射。
 *
 * 整理、周期总结、知识库问答三个功能共用这一层 ——
 * 它们的差别只在 prompt 和结果收敛，传输方式完全一样。
 *
 * v0.2.4 起从 deepseek.ts 抽出来，避免那个文件无限变大。
 */
import { fetch as expoFetch } from 'expo/fetch';
import type { AiConfig } from '../types';
import { DEFAULT_AI_CONFIG } from '../types';
import { NoStreamError, readChatStream } from './stream';

export type AiErrorCode = 'nokey' | 'network' | 'auth' | 'quota' | 'rate' | 'server' | 'format';

export class AiError extends Error {
  code: AiErrorCode;
  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'AiError';
  }
}

/**
 * 超时分四段，**不能用一个总时长**。
 * 思考模式下模型先吐思维链，整轮时间远超 90 秒，用总时长会把正常请求掐死。
 */
const CONNECT_TIMEOUT_MS = 90_000;
/** 响应头已经回来、但还没吐第一个 token。思考阶段可能停一会儿，给足 */
const FIRST_TOKEN_TIMEOUT_MS = 120_000;
/** 数据流动中，两块之间允许的最长静默 */
const IDLE_TIMEOUT_MS = 60_000;
/** 兜底硬上限 */
const HARD_LIMIT_MS = 6 * 60_000;
/** 九类输出 + 追问可能很长，给足空间；思考链不计入这个额度 */
const MAX_TOKENS = 8000;

/** 流式过程中的增量回调，传的都是**累积全文**，UI 直接覆盖显示 */
export interface ChatProgress {
  reasoning?: string;
  content?: string;
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export interface ChatOutcome {
  /** 拼完的正文 */
  content: string;
  /** 思维链全文，只用于展示 */
  reasoning: string;
}

/** 每次请求的可调项。三个调用方（整理 / 周期总结 / 知识库问答）只在这些上有差别 */
export interface RequestOptions {
  /** 输出上限，默认 8000。思考链不占这个额度 */
  maxTokens?: number;
  /**
   * 要不要 `response_format: json_object`。
   * 整理必须开（九类结果靠它保证格式）；**周期总结和问答必须关**，
   * 否则模型会把 markdown 塞进 JSON 字符串里，换行全变 `\n`，直接没法渲染。
   */
  json?: boolean;
}

function endpoint(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/** 从 ```json 围栏里、或从一大段文字里抠出 JSON 对象 */
export function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : cleaned;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        /* 落到下面抛错 */
      }
    }
    throw new AiError('format', '模型返回的不是合法 JSON，再试一次通常就好了');
  }
}

function mapHttpError(status: number, detail: string): AiError {
  if (status === 401 || status === 403) return new AiError('auth', `API Key 无效或已过期${detail ? `（${detail}）` : ''}`);
  if (status === 402) return new AiError('quota', 'DeepSeek 账户余额不足，请先充值');
  if (status === 429) return new AiError('rate', '请求太频繁，等几秒再试');
  if (status >= 500) return new AiError('server', `DeepSeek 服务端异常（${status}），稍后重试`);
  return new AiError('server', `请求失败 ${status}${detail ? `：${detail}` : ''}`);
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.error?.message ?? '';
  } catch {
    return '';
  }
}

/**
 * 多段超时守卫：每个阶段单独计时，谁先到谁 abort。
 */
class TimeoutGuard {
  private controller = new AbortController();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private fired: string | null = null;

  get signal() {
    return this.controller.signal;
  }

  arm(key: string, ms: number) {
    this.disarm(key);
    this.timers.set(
      key,
      setTimeout(() => {
        this.fired = key;
        this.controller.abort();
      }, ms),
    );
  }

  disarm(key: string) {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** 把中止原因翻成给用户看的话 */
  message(): string {
    switch (this.fired) {
      case 'connect':
        return '连接超时（90 秒），检查网络或 Base URL';
      case 'first':
        return '模型两分钟还没开始输出，内容多的话可以分两批';
      case 'idle':
        return '输出中途停住了（60 秒没有新内容），再试一次';
      case 'hard':
        return '这一轮超过 6 分钟还没结束，内容多的话可以分两批';
      default:
        return '请求被中断了';
    }
  }
}

function toNetworkError(e: any, guard?: TimeoutGuard): AiError {
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return new AiError('network', guard?.message() ?? '请求被中断了');
  }
  return new AiError('network', '连不上 DeepSeek，检查手机网络或 Base URL 是否填对');
}

/**
 * 只有 DeepSeek 的 V4 系列认 `thinking` 和 `reasoning_effort`。
 * 用户把 Base URL 换成第三方 OpenAI 兼容服务时，多传这两个字段可能直接 400，
 * 所以按模型名判断：认不出来就一个都不传。
 */
function isDeepSeekV4(model: string) {
  const name = model.toLowerCase();
  return name.startsWith('deepseek-flash') || name.startsWith('deepseek-v4');
}

function buildBody(
  config: AiConfig,
  messages: ChatMessage[],
  stream: boolean,
  options: RequestOptions = {},
) {
  const model = config.model || DEFAULT_AI_CONFIG.model;
  const native = isDeepSeekV4(model);
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: options.maxTokens ?? MAX_TOKENS,
    stream,
  };

  // 只有明确要 JSON 才加这个字段。多传一个它认不认的字段，第三方兼容服务可能直接 400
  if (options.json !== false) body.response_format = { type: 'json_object' };

  if (native) {
    body.thinking = { type: config.thinking ? 'enabled' : 'disabled' };
    if (config.thinking) body.reasoning_effort = config.effort;
  }

  // 思考模式下 temperature 不生效（传了不报错，只是被忽略）。
  // 只在「本来就没有思考」的时候设，免得看代码的人以为随机性被锁住了。
  if (!native || !config.thinking) body.temperature = 0.2;

  return body;
}

async function postChatStream(
  config: AiConfig,
  body: Record<string, unknown>,
  onProgress?: (patch: ChatProgress) => void,
): Promise<ChatOutcome> {
  const guard = new TimeoutGuard();
  guard.arm('hard', HARD_LIMIT_MS);
  guard.arm('connect', CONNECT_TIMEOUT_MS);

  try {
    let res: Response;
    try {
      res = await expoFetch(endpoint(config.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: guard.signal,
      });
    } catch (e) {
      throw toNetworkError(e, guard);
    }

    guard.disarm('connect');
    if (!res.ok) throw mapHttpError(res.status, await errorDetail(res));

    // 响应头到手之后，只要还在吐字就不算超时
    guard.arm('first', FIRST_TOKEN_TIMEOUT_MS);
    let started = false;
    const touch = () => {
      if (!started) {
        started = true;
        guard.disarm('first');
      }
      guard.arm('idle', IDLE_TIMEOUT_MS);
    };

    return await readChatStream(res, {
      onReasoning: (text) => {
        touch();
        onProgress?.({ reasoning: text });
      },
      onContent: (text) => {
        touch();
        onProgress?.({ content: text });
      },
    });
  } catch (e) {
    if (e instanceof AiError || e instanceof NoStreamError) throw e;
    throw toNetworkError(e, guard);
  } finally {
    guard.dispose();
  }
}

/** 平台不支持流式时的回退：一次性拿完整响应，代价是过程中看不到任何东西 */
async function postChatOnce(config: AiConfig, body: Record<string, unknown>): Promise<ChatOutcome> {
  const guard = new TimeoutGuard();
  guard.arm('hard', HARD_LIMIT_MS);
  guard.arm('connect', CONNECT_TIMEOUT_MS);

  try {
    const res = await expoFetch(endpoint(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ ...body, stream: false }),
      signal: guard.signal,
    });
    guard.disarm('connect');
    if (!res.ok) throw mapHttpError(res.status, await errorDetail(res));

    const payload = await res.json();
    const message = payload?.choices?.[0]?.message;
    return {
      content: typeof message?.content === 'string' ? message.content : '',
      reasoning: typeof message?.reasoning_content === 'string' ? message.reasoning_content : '',
    };
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw toNetworkError(e, guard);
  } finally {
    guard.dispose();
  }
}

/**
 * 发一次对话请求，优先流式。
 * 只有「压根拿不到流」才回退到非流式 —— 已经开始收数据再断的不能重试，重试等于重复扣费。
 */
export async function requestChat(
  config: AiConfig,
  messages: ChatMessage[],
  onProgress?: (patch: ChatProgress) => void,
  options: RequestOptions = {},
): Promise<ChatOutcome> {
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  const body = buildBody(config, messages, true, options);
  try {
    return await postChatStream(config, body, onProgress);
  } catch (e) {
    if (!(e instanceof NoStreamError)) throw e;
    return postChatOnce(config, body);
  }
}

/** 设置页的连通性测试：拉模型列表，比真实对话便宜得多 */
export async function testConnection(config: AiConfig): Promise<string> {
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  const guard = new TimeoutGuard();
  guard.arm('connect', 20_000);
  try {
    const res = await expoFetch(`${config.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: guard.signal,
    });
    if (!res.ok) throw mapHttpError(res.status, await errorDetail(res));
    const body = await res.json();
    const models: string[] = Array.isArray(body?.data) ? body.data.map((m: any) => m?.id).filter(Boolean) : [];
    return models.length ? `连接正常，可用模型：${models.slice(0, 4).join('、')}` : '连接正常';
  } catch (e: any) {
    if (e instanceof AiError) throw e;
    if (e?.name === 'AbortError') throw new AiError('network', '连接超时，检查 Base URL 和网络');
    throw new AiError('network', '连不上，检查 Base URL 和网络');
  } finally {
    guard.dispose();
  }
}
