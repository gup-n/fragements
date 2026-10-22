import type {
  AiConfig,
  ArchiveCardSuggestion,
  CardUpdateSuggestion,
  DropTodoSuggestion,
  Fragment,
  KnowledgeCard,
  KnowledgeSuggestion,
  MergeSuggestion,
  OrganizeResult,
  TagSuggestion,
  Todo,
  TodoDoneSuggestion,
  TodoSuggestion,
} from '../types';
import { fetch as expoFetch } from 'expo/fetch';
import { DEFAULT_AI_CONFIG } from '../types';
import { SYSTEM_PROMPT, buildRefineContent, buildUserContent } from './prompt';
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
 * 超时分四段，**不能再用一个总时长**。
 * 思考模式下模型先吐思维链，整轮时间远超原来的 90 秒，用总时长会把正常请求掐死。
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


function endpoint(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/** 从 ```json 围栏里、或从一大段文字里抠出 JSON 对象 */
function parseJsonLoose(text: string): unknown {
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

/** 日期格式 YYYY-MM-DD */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 收敛 `todo_done` / `card_update` 时需要知道哪些 id 真实存在 */
export interface NormalizeContext {
  /** 允许被标记为完成的待办 id */
  todoIds?: number[];
  /** 允许被补充内容的知识卡 id */
  cardIds?: number[];
}

/**
 * 把模型的自由输出收敛成可信结构：ID 必须存在于本次输入，
 * 日期必须合法，去重合并不得指向自己。任何不合规项直接丢弃。
 */
export function normalizeResult(
  raw: unknown,
  fragments: Fragment[],
  context: NormalizeContext = {},
): OrganizeResult {
  const valid = new Set(fragments.map((f) => f.id));
  const obj = (raw ?? {}) as Record<string, unknown>;

  const tagMap = new Map<number, TagSuggestion>();
  for (const item of Array.isArray(obj.tags) ? obj.tags : []) {
    const t = item as Record<string, unknown>;
    const id = Number(t?.id);
    if (!Number.isFinite(id) || !valid.has(id)) continue;
    const labels = (Array.isArray(t?.labels) ? t.labels : [])
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim().replace(/^#/, ''))
      .filter(Boolean)
      .slice(0, 4);
    const project = typeof t?.project === 'string' && t.project.trim() ? t.project.trim() : null;
    tagMap.set(id, { id, labels, project });
  }

  const seenTodo = new Set<string>();
  const todos: TodoSuggestion[] = [];
  for (const item of Array.isArray(obj.todos) ? obj.todos : []) {
    const t = item as Record<string, unknown>;
    const rawText = typeof t?.text === 'string' ? t.text.trim() : '';
    if (!rawText) continue;
    // 超长不整条丢弃 —— 丢掉等于让 AI 的产出凭空消失，截断保留更有用
    const text = rawText.length > 100 ? `${rawText.slice(0, 98)}…` : rawText;
    if (seenTodo.has(text)) continue;
    seenTodo.add(text);
    const due = typeof t?.due === 'string' && DATE_RE.test(t.due.trim()) ? t.due.trim() : null;
    const rawId = Number(t?.id);
    const id = Number.isFinite(rawId) && valid.has(rawId) ? rawId : null;
    todos.push({ text, due, id });
  }

  const merges: MergeSuggestion[] = [];
  for (const item of Array.isArray(obj.merge) ? obj.merge : []) {
    const m = item as Record<string, unknown>;
    const keep = Number(m?.keep_id);
    if (!Number.isFinite(keep) || !valid.has(keep)) continue;
    const drops = (Array.isArray(m?.drop_ids) ? m.drop_ids : [])
      .map(Number)
      .filter((n) => Number.isFinite(n) && valid.has(n) && n !== keep);
    if (!drops.length) continue;
    merges.push({
      keep_id: keep,
      drop_ids: Array.from(new Set(drops)),
      reason: typeof m?.reason === 'string' && m.reason.trim() ? m.reason.trim() : null,
    });
  }

  const summaryRaw = obj.summary as Record<string, unknown> | undefined;
  const bodyMd = typeof summaryRaw?.body_md === 'string' ? summaryRaw.body_md.trim() : '';
  const summary = bodyMd ? { body_md: bodyMd } : null;

  const byId = new Map(fragments.map((f) => [f.id, f]));
  const knowledge: KnowledgeSuggestion[] = [];
  for (const item of Array.isArray(obj.knowledge) ? obj.knowledge : []) {
    const k = item as Record<string, unknown>;
    const title = typeof k?.title === 'string' ? k.title.trim() : '';
    if (!title) continue;
    const topicRaw = typeof k?.topic === 'string' ? k.topic.trim() : '';
    const topic = (topicRaw || '未归类').slice(0, 20);
    const gist = typeof k?.gist === 'string' ? k.gist.trim() : '';
    const sourceIds = Array.from(
      new Set(
        (Array.isArray(k?.source_ids) ? k.source_ids : [])
          .map(Number)
          .filter((n) => Number.isFinite(n) && valid.has(n)),
      ),
    );

    // body 一律用碎片原文拼接，不用模型给的内容——
    // "原文保真"这条承诺必须由代码保证，不能寄希望于模型不说谎。
    const verbatim = sourceIds
      .map((id) => byId.get(id)?.content.trim())
      .filter(Boolean)
      .join('\n\n');
    const body = verbatim || (typeof k?.body === 'string' ? k.body.trim() : '');
    if (!body) continue;

    knowledge.push({ topic, title: title.slice(0, 60), gist, body, source_ids: sourceIds });
  }

  // 标记已有待办完成：只认「真实存在过的待办 id」，并且同一条只处理一次
  const validTodoIds = new Set(context.todoIds ?? []);
  const todoDone: TodoDoneSuggestion[] = [];
  const seenDone = new Set<number>();
  for (const item of Array.isArray(obj.todo_done) ? obj.todo_done : []) {
    const d = item as Record<string, unknown>;
    const todoId = Number(d?.todo_id);
    if (!Number.isFinite(todoId) || !validTodoIds.has(todoId) || seenDone.has(todoId)) continue;
    seenDone.add(todoId);
    todoDone.push({
      todo_id: todoId,
      reason: typeof d?.reason === 'string' && d.reason.trim() ? d.reason.trim() : null,
    });
  }

  // 补充已有知识卡：必须指向真实卡片，且至少要带上一条本轮碎片，否则这条建议没有意义
  const validCardIds = new Set(context.cardIds ?? []);
  const cardUpdate: CardUpdateSuggestion[] = [];
  const seenCard = new Set<number>();
  for (const item of Array.isArray(obj.card_update) ? obj.card_update : []) {
    const c = item as Record<string, unknown>;
    const cardId = Number(c?.card_id);
    if (!Number.isFinite(cardId) || !validCardIds.has(cardId) || seenCard.has(cardId)) continue;
    const addIds = Array.from(
      new Set(
        (Array.isArray(c?.add_source_ids) ? c.add_source_ids : [])
          .map(Number)
          .filter((n) => Number.isFinite(n) && valid.has(n)),
      ),
    );
    if (!addIds.length) continue;
    seenCard.add(cardId);
    cardUpdate.push({
      card_id: cardId,
      add_source_ids: addIds,
      title: typeof c?.title === 'string' && c.title.trim() ? c.title.trim().slice(0, 60) : null,
      gist: typeof c?.gist === 'string' && c.gist.trim() ? c.gist.trim() : null,
      reason: typeof c?.reason === 'string' && c.reason.trim() ? c.reason.trim() : null,
    });
  }

  // 建议归档的旧卡：必须真实存在，且不能和「补充到这张卡」自相矛盾
  const archiveCards: ArchiveCardSuggestion[] = [];
  const seenArchive = new Set<number>();
  for (const item of Array.isArray(obj.archive_cards) ? obj.archive_cards : []) {
    const a = item as Record<string, unknown>;
    const cardId = Number(a?.card_id);
    if (!Number.isFinite(cardId) || !validCardIds.has(cardId) || seenArchive.has(cardId)) continue;
    // 同一张卡又要补充又要归档，说明模型自己没想清楚，这条归档建议丢掉
    if (seenCard.has(cardId)) continue;
    seenArchive.add(cardId);
    archiveCards.push({
      card_id: cardId,
      reason: typeof a?.reason === 'string' && a.reason.trim() ? a.reason.trim() : null,
    });
  }

  // 建议删掉的待办
  const dropTodos: DropTodoSuggestion[] = [];
  const seenDrop = new Set<number>();
  for (const item of Array.isArray(obj.drop_todos) ? obj.drop_todos : []) {
    const d = item as Record<string, unknown>;
    const todoId = Number(d?.todo_id);
    if (!Number.isFinite(todoId) || !validTodoIds.has(todoId) || seenDrop.has(todoId)) continue;
    // 又要标完成又要删，同一条待办不能既生又死
    if (seenDone.has(todoId)) continue;
    seenDrop.add(todoId);
    dropTodos.push({
      todo_id: todoId,
      reason: typeof d?.reason === 'string' && d.reason.trim() ? d.reason.trim() : null,
    });
  }

  return {
    tags: Array.from(tagMap.values()),
    todos,
    summary,
    merge: merges,
    knowledge,
    todo_done: todoDone,
    card_update: cardUpdate,
    archive_cards: archiveCards,
    drop_todos: dropTodos,
  };
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

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

interface ChatOutcome {
  /** 拼完的正文，随后交给 parseJsonLoose */
  content: string;
  /** 思维链全文，只用于展示 */
  reasoning: string;
}

/**
 * 多段超时守卫：每个阶段单独计时，谁先到谁 abort。
 * 原来只有一个 90 秒总时长，开了思考模式之后正常请求都可能超过它。
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
        return '模型两分钟还没开始输出，碎片多的话可以分两批';
      case 'idle':
        return '输出中途停住了（60 秒没有新内容），再试一次';
      case 'hard':
        return '这一轮超过 6 分钟还没结束，碎片多的话可以分两批';
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
 *
 * `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用，
 * 配置里若还留着会在 loadAiConfig 里被映射成 `deepseek-flash`。
 */
function isDeepSeekV4(model: string) {
  const name = model.toLowerCase();
  return name.startsWith('deepseek-flash') || name.startsWith('deepseek-v4');
}

function buildBody(config: AiConfig, messages: ChatMessage[], stream: boolean) {
  const model = config.model || DEFAULT_AI_CONFIG.model;
  const native = isDeepSeekV4(model);
  const body: Record<string, unknown> = {
    model,
    messages,
    response_format: { type: 'json_object' },
    max_tokens: MAX_TOKENS,
    stream,
  };

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
  onProgress?: (patch: OrganizeProgress) => void,
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

/** 流式过程中的增量回调，传的都是**累积全文**，UI 直接覆盖显示 */
export interface OrganizeProgress {
  reasoning?: string;
  content?: string;
}

export interface OrganizeOptions {
  fragments: Fragment[];
  config: AiConfig;
  /** 已有主题列表，传进去让模型优先复用，避免长出一堆同义主题 */
  topics?: string[];
  /** 已有知识卡，用于「把新碎片补进老卡」 */
  cards?: KnowledgeCard[];
  /** 已有待办，用于「标记已完成」；内部只取未完成的 */
  todos?: Todo[];
  /** 上一轮模型的原始输出。多轮追问时原样回传，模型才知道自己上次说了什么 */
  previousRaw?: string;
  /** 这一轮用户的追问。为空表示首轮 */
  instruction?: string;
  /** organize = 整理未读；refactor = 把已整理过的重新过一遍并和旧结果对照 */
  mode?: 'organize' | 'refactor';
  /** 流式进度。只用于界面展示，不参与任何解析 */
  onProgress?: (patch: OrganizeProgress) => void;
}

export interface OrganizeOutcome {
  result: OrganizeResult;
  /** 模型原始输出（正文），留着给下一轮追问回传 */
  raw: string;
  /** 思维链，仅用于展示。模型没开思考时为空串 */
  reasoning: string;
}

export async function organize(options: OrganizeOptions): Promise<OrganizeOutcome> {
  const {
    fragments,
    config,
    topics = [],
    cards = [],
    todos = [],
    previousRaw,
    instruction,
    mode = 'organize',
    onProgress,
  } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  if (!fragments.length) throw new AiError('format', '没有待整理的碎片');

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserContent({ fragments, topics, cards, todos, mode }) },
  ];
  if (previousRaw) messages.push({ role: 'assistant', content: previousRaw });
  if (instruction) messages.push({ role: 'user', content: buildRefineContent(instruction) });

  const body = buildBody(config, messages, true);

  let outcome: ChatOutcome;
  try {
    outcome = await postChatStream(config, body, onProgress);
  } catch (e) {
    // 只有「压根拿不到流」才回退。已经开始收数据再断的不能重试 —— 重试等于重复扣费
    if (!(e instanceof NoStreamError)) throw e;
    outcome = await postChatOnce(config, body);
  }

  if (!outcome.content.trim()) throw new AiError('format', '模型没有返回内容');

  const result = normalizeResult(parseJsonLoose(outcome.content), fragments, {
    todoIds: todos.filter((t) => !t.done).map((t) => t.id),
    cardIds: cards.map((c) => c.id),
  });
  return { result, raw: outcome.content, reasoning: outcome.reasoning };
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

