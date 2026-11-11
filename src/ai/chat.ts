/**
 * DeepSeek 请求层：流式 + 多段超时 + 错误映射。
 *
 * 整理、周期总结、知识库问答三个功能共用这一层 ——
 * 它们的差别只在 prompt 和结果收敛，传输方式完全一样。
 *
 * v0.2.4 起从 deepseek.ts 抽出来，避免那个文件无限变大。
 */
import { fetch as expoFetch } from 'expo/fetch';
import type { AiConfig, ReasoningEffort } from '../types';
import { DEFAULT_AI_CONFIG } from '../types';
import { NoStreamError, readChatStream, type FinishReason } from './stream';
import { parseJsonLenient } from '../util/jsonRepair';

export type AiErrorCode =
  | 'nokey'
  | 'network'
  | 'auth'
  | 'quota'
  | 'rate'
  | 'server'
  | 'format'
  /** 输出被 max_tokens 或上下文长度截断 —— 和「模型没返回」是两回事，必须分开 */
  | 'truncated';

export class AiError extends Error {
  code: AiErrorCode;
  /**
   * 出错时手上的一切证据。
   *
   * 为什么必须留着：用户看到的永远是一句人话，但排查时需要的恰恰是
   * 「HTTP 几几几」「finish_reason 是什么」「模型到底吐了什么」。
   * 这些以前在 throw 的一瞬间就丢掉了，于是界面上只剩「整理失败，再试一次」，
   * 而重试一百次也不会变。
   */
  detail: AiErrorDetail;
  constructor(code: AiErrorCode, message: string, detail: AiErrorDetail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
    this.name = 'AiError';
  }
}

export interface AiErrorDetail {
  /** 哪一步失败：连接 / 请求 / 读流 / 解析 / 整理 / 改稿 */
  stage?: string;
  /** 服务端或模型返回的原文，原样贴出来 */
  raw?: string;
  /** HTTP 状态码 */
  status?: number;
  /** 模型停下的原因 */
  finish?: string | null;
}

/** 原始返回最多留这么多字。再长贴到手机上也没人读，而且会拖慢渲染 */
const RAW_KEEP = 4_000;

export function clipRaw(text: string): string {
  if (text.length <= RAW_KEEP) return text;
  return `${text.slice(0, RAW_KEEP)}\n……（后面还有 ${text.length - RAW_KEEP} 字，已省略）`;
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
/**
 * 兜底硬上限。
 *
 * 提到 12 分钟是因为输出额度从 8K 涨到了 64K —— 按思考模式常见的每秒二三十 token 算，
 * 三四十 K 的输出本来就要十几分钟，6 分钟会在正常生成途中直接掐断。
 * 真卡住的情况由上面的 idle 兜（60 秒没有新 token 就 abort），所以这里放宽不会让人干等。
 */
const HARD_LIMIT_MS = 12 * 60_000;

/**
 * 输出额度。**这个数同时限制思考链和正文**，这一点极容易搞错 ——
 * 老版 `deepseek-reasoner` 的 max_tokens 只管最终回答、思维链另算，
 * 但 V4 系列已经改成「单次输出的总长度（含思考过程）」。
 *
 * 曾经这里是 8000，结果：碎片一多、思考链一长就把额度吃光，
 * 正文一个字都没机会输出，界面表现是「思考到一半突然停住 + 模型没有返回内容」。
 * 官方思考模式的默认值就是 64K（`reasoning_effort=max` 时 128K），照它来。
 *
 * 设大不会多花钱：max_tokens 只是上限，按实际生成结算。
 */
const MAX_TOKENS = 64_000;

/** 流式过程中的增量回调，传的都是**累积全文**，UI 直接覆盖显示 */
export interface ChatProgress {
  reasoning?: string;
  content?: string;
}

/**
 * 多模态的一小块。
 *
 * DeepSeek 官方从 V4.1-Flash 起就认图片（`deepseek-flash` 就是默认模型），
 * 格式和 OpenAI 完全一致：`content` 从字符串换成 blocks 数组，
 * 图片用 `image_url` 带 data URL。**图片只能出现在 user 消息里**，
 * 放进 system / assistant 会直接 400。
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * `content` 放宽成两种形态：绝大多数调用还是纯字符串，
 * 只有「带一张图」的那一轮用 blocks。这样既不用把每个调用点都改一遍，
 * 也不会因为类型太窄而逼着调用方自己拼 any。
 */
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
};

export interface ChatOutcome {
  /** 拼完的正文 */
  content: string;
  /** 思维链全文，只用于展示 */
  reasoning: string;
  /**
   * 为什么停下。只有 `'stop'`（或第三方服务不返回这个字段时的 `null`）代表完整。
   *
   * 调用方拿它区分「模型真的没话说」和「输出被截断」——
   * 后者重试一次通常还是失败，得改参数或拆小批次，报同一句「没有返回内容」只会让人反复重试。
   */
  finishReason: FinishReason | null;
}

/**
 * 把「为什么是空的」翻成用户看得懂的一句话。
 *
 * 这是本轮 bug 的正解：原来所有空结果都报「模型没有返回内容」，
 * 但真正的原因（思考链吃光额度 / 上下文超限）连一个字的线索都没留下。
 */
export function describeFinish(reason: FinishReason | null, maxTokens: number): string {
  switch (reason) {
    case 'length':
      // 第三方兼容服务被压到 8K，而且它们基本不接受 reasoning_effort ——
      // 客户端压不下它的思考长度，只能建议换回官方地址。别让用户在那里反复重试
      if (maxTokens <= THIRD_PARTY_MAX_TOKENS) {
        return (
          `输出被截断了：这一轮撞到了 ${maxTokens.toLocaleString()} token 的上限。` +
          '当前地址不是 DeepSeek 官方接口，客户端没法控制它的思考长度，' +
          '所以调低「思考强度」不会有效果 —— 建议换回官方接口，或者把碎片分几批整理。'
        );
      }
      return (
        `输出被截断了：思考过程加正文撞到了上限（max_tokens ${maxTokens.toLocaleString()}，` +
        'DeepSeek 规定思考链和正文共用这个额度）。' +
        '把设置里的「思考强度」调低，或者把这一批拆小一点再试。'
      );
    case 'insufficient_system_resource':
      return 'DeepSeek 那边推理资源不足，生成被中途打断。这是对方服务端的临时状态，过一会儿再试。';
    case 'content_filter':
      return '输出触发了 DeepSeek 的内容过滤，被拦下了。';
    case 'aborted':
      return '生成被中断了，再试一次。';
    default:
      return '模型没有返回内容。';
  }
}

/** 每次请求的可调项。三个调用方（整理 / 周期总结 / 知识库问答）只在这些上有差别 */
export interface RequestOptions {
  /**
   * 输出上限。不传就用模型对应的默认值（DeepSeek V4 是 64K，第三方是 8K）。
   * **思维链也算在这个额度里** —— 这是最容易记错的一条。
   */
  maxTokens?: number;
  /**
   * 要不要 `response_format: json_object`。
   * 整理必须开（九类结果靠它保证格式）；**周期总结和问答必须关**，
   * 否则模型会把 markdown 塞进 JSON 字符串里，换行全变 `\n`，直接没法渲染。
   */
  json?: boolean;
  /**
   * 这一轮用多强的思考。不传就用设置页里的全局值。
   *
   * 为什么需要它：官方 `high` 并不只是「想久一点」。它在 prompt 最前面插了一段
   * 「不许走捷径，穷举所有边界情况和对抗性场景，把每个中间步骤和每个被否决的假设都写出来」。
   * 对「给三十条笔记打标签」这种机械抽取，那是纯浪费 —— 思考链能从 3K 涨到 15K，
   * 而判断标准其实已经全部写在 system prompt 里了，不需要模型自己重新推一遍。
   */
  effort?: ReasoningEffort;
}

function endpoint(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/** 从 ```json 围栏里、或从一大段文字里抠出 JSON 对象 */
/**
 * 模型的 JSON → 对象。
 *
 * 真正的宽容解析在 `util/jsonRepair.ts`（那是纯函数，能在 node 里断言）；
 * 这里只负责把失败翻译成带证据的 `AiError`。v0.18.1 之前这里只有
 * `JSON.parse` 加一次 `indexOf/lastIndexOf` 切片，于是模型少转义一个反斜杠
 * （Windows 路径 `\\server\queue` 最容易踩）就整段报废，而报错只说
 * 「不是合法 JSON，再试一次」—— 用户手上那份四五千字的原文里
 * 根本看不出哪里不对。
 */
export function parseJsonLoose(text: string): unknown {
  const result = parseJsonLenient(text);
  if (result.ok) return result.value;

  const { at, near, reason } = result.problem;
  throw new AiError('format', `模型返回的内容解析不了：${reason}（第 ${at} 字附近：${near}）`, {
    stage: '解析',
    raw: clipRaw(text),
  });
}

function mapHttpError(status: number, detail: string, raw = ''): AiError {
  const tail = detail ? `（${detail}）` : '';
  const base = { status, raw: clipRaw(raw || detail), stage: '请求' };
  if (status === 401 || status === 403) {
    return new AiError('auth', `API Key 无效或已过期${tail}`, base);
  }
  if (status === 402) {
    return new AiError('quota', `DeepSeek 账户余额不足，请先充值${tail}`, base);
  }
  if (status === 429) return new AiError('rate', `请求太频繁，等几秒再试${tail}`, base);
  if (status >= 500) {
    return new AiError('server', `DeepSeek 服务端异常（${status}），稍后重试${tail}`, base);
  }
  return new AiError('server', `请求失败 ${status}${detail ? `：${detail}` : ''}`, base);
}

/** 非 2xx 一律走这里：状态码 + 服务端原文一起带走 */
async function httpError(res: Response): Promise<AiError> {
  const d = await errorDetail(res);
  return mapHttpError(res.status, d.message, d.raw);
}
/**
 * 把错误响应体整段带回来。
 *
 * 老版本只取 `body.error.message`，遇到网关返回 HTML 或者
 * `{"code":40001,"msg":"..."}` 这类非 OpenAI 形状时，detail 恒为空 ——
 * 界面于是只剩一个状态码，而真正的原因（比如「模型名不存在」）被丢掉了。
 */
async function errorDetail(res: Response): Promise<{ message: string; raw: string }> {
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text);
      const msg = body?.error?.message ?? body?.message ?? body?.msg ?? '';
      return { message: typeof msg === 'string' ? msg : '', raw: text };
    } catch {
      // 不是 JSON：可能是网关的 HTML 报错页，原样留着比丢掉有用
      return { message: '', raw: text };
    }
  } catch {
    return { message: '', raw: '' };
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

  /** 先到点的那个阶段。报错详情里要写明是连接超时还是空闲超时 */
  get firedKey() {
    return this.fired;
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
        return '这一轮超过 12 分钟还没结束，内容多的话可以分两批';
      default:
        return '请求被中断了';
    }
  }
}

function toNetworkError(e: any, guard?: TimeoutGuard): AiError {
  const detail = {
    stage: '连接',
    raw: `${e?.name ?? 'Error'}: ${e?.message ?? ''}${guard?.firedKey ? `（超时阶段：${guard.firedKey}）` : ''}`,
  };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return new AiError('network', guard?.message() ?? '请求被中断了', detail);
  }
  return new AiError('network', '连不上 DeepSeek，检查手机网络或 Base URL 是否填对', detail);
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

/**
 * 非 DeepSeek 官方模型时的保守上限。
 *
 * 用户把 Base URL 换成第三方 OpenAI 兼容服务时，64K 这个数它多半不认 ——
 * 多数网关的上限是 4K~8K，直接报 400，整个功能瞬间不可用。
 */
const THIRD_PARTY_MAX_TOKENS = 8_000;

/**
 * 算出这次实际要用的输出额度。
 * 请求方指定的值也要被压到上限内，否则「日小结 12K」在第三方服务上同样会 400。
 */
function resolveMaxTokens(model: string, requested?: number) {
  const cap = isDeepSeekV4(model) ? MAX_TOKENS : THIRD_PARTY_MAX_TOKENS;
  return Math.min(requested ?? cap, cap);
}

function buildBody(
  config: AiConfig,
  messages: ChatMessage[],
  stream: boolean,
  maxTokens: number,
  options: RequestOptions = {},
) {
  const model = config.model || DEFAULT_AI_CONFIG.model;
  const native = isDeepSeekV4(model);
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    stream,
  };

  // 只有明确要 JSON 才加这个字段。多传一个它认不认的字段，第三方兼容服务可能直接 400
  if (options.json !== false) body.response_format = { type: 'json_object' };

  if (native) {
    body.thinking = { type: config.thinking ? 'enabled' : 'disabled' };
    if (config.thinking) body.reasoning_effort = options.effort ?? config.effort;
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
    if (!res.ok) throw await httpError(res);

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
    if (!res.ok) throw await httpError(res);

    const payload = await res.json();
    const choice = payload?.choices?.[0];
    const message = choice?.message;
    return {
      content: typeof message?.content === 'string' ? message.content : '',
      reasoning: typeof message?.reasoning_content === 'string' ? message.reasoning_content : '',
      // 非流式路径也要读，否则「回退之后错误提示变模糊」成了一条隐蔽的降级
      finishReason:
        typeof choice?.finish_reason === 'string' && choice.finish_reason
          ? (choice.finish_reason as FinishReason)
          : null,
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
 *
 * 正文一个字都没有时直接抛错，**并且按 finish_reason 说清原因**：
 * 撞额度（`length`）和模型真没话说，处理方式完全相反 ——
 * 前者重试一百次也一样，得调小思考强度或拆批次。
 */
export async function requestChat(
  config: AiConfig,
  messages: ChatMessage[],
  onProgress?: (patch: ChatProgress) => void,
  options: RequestOptions = {},
): Promise<ChatOutcome> {
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  const maxTokens = resolveMaxTokens(config.model || DEFAULT_AI_CONFIG.model, options.maxTokens);
  const body = buildBody(config, messages, true, maxTokens, options);

  let outcome: ChatOutcome;
  try {
    outcome = await postChatStream(config, body, onProgress);
  } catch (e) {
    if (!(e instanceof NoStreamError)) throw e;
    outcome = await postChatOnce(config, body);
  }

  if (!outcome.content.trim()) {
    /*
     * 空结果是最需要证据的一种失败：到底是撞了额度、被过滤，还是模型只想不说？
     * 以前这里只留一句人话，用户没法判断该重试还是该改设置。
     * 现在把「思维链尾巴 + finish_reason」一起带走，界面上可以展开看。
     */
    const raw = [
      outcome.reasoning.trim()
        ? `【思维链最后 1500 字】\n${outcome.reasoning.slice(-1500)}`
        : '【思维链】为空',
      `【正文】${outcome.content.trim() ? clipRaw(outcome.content) : '（空）'}`,
      `【finish_reason】${outcome.finishReason ?? '服务端没返回这个字段'}`,
      `【max_tokens】${maxTokens.toLocaleString()}`,
    ].join('\n\n');
    throw new AiError(
      outcome.finishReason === 'length' ? 'truncated' : 'format',
      describeFinish(outcome.finishReason, maxTokens),
      { stage: '模型输出', raw, finish: outcome.finishReason },
    );
  }
  return outcome;
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
    if (!res.ok) throw await httpError(res);
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
