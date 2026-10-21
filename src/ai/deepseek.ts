import type {
  AiConfig,
  Fragment,
  KnowledgeSuggestion,
  MergeSuggestion,
  OrganizeResult,
  TagSuggestion,
  TodoSuggestion,
} from '../types';
import { SYSTEM_PROMPT, buildUserContent } from './prompt';

export type AiErrorCode = 'nokey' | 'network' | 'auth' | 'quota' | 'rate' | 'server' | 'format';

export class AiError extends Error {
  code: AiErrorCode;
  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'AiError';
  }
}

const TIMEOUT_MS = 90_000;

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

/**
 * 把模型的自由输出收敛成可信结构：ID 必须存在于本次输入，
 * 日期必须合法，去重合并不得指向自己。任何不合规项直接丢弃。
 */
export function normalizeResult(raw: unknown, fragments: Fragment[]): OrganizeResult {
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

  return { tags: Array.from(tagMap.values()), todos, summary, merge: merges, knowledge };
}

function mapHttpError(status: number, detail: string): AiError {
  if (status === 401 || status === 403) return new AiError('auth', `API Key 无效或已过期${detail ? `（${detail}）` : ''}`);
  if (status === 402) return new AiError('quota', 'DeepSeek 账户余额不足，请先充值');
  if (status === 429) return new AiError('rate', '请求太频繁，等几秒再试');
  if (status >= 500) return new AiError('server', `DeepSeek 服务端异常（${status}），稍后重试`);
  return new AiError('server', `请求失败 ${status}${detail ? `：${detail}` : ''}`);
}

export interface OrganizeOptions {
  fragments: Fragment[];
  config: AiConfig;
  /** 已有主题列表，传进去让模型优先复用，避免长出一堆同义主题 */
  topics?: string[];
}

export async function organize(options: OrganizeOptions): Promise<OrganizeResult> {
  const { fragments, config, topics = [] } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  if (!fragments.length) throw new AiError('format', '没有待整理的碎片');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: any;

  try {
    res = await fetch(endpoint(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserContent(fragments, topics) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 3000,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new AiError('network', '请求超时（90 秒），检查网络或换个更快的网络');
    throw new AiError('network', '连不上 DeepSeek，检查手机网络或 BaseURL 是否填对');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message ?? '';
    } catch {
      /* 忽略 */
    }
    throw mapHttpError(res.status, detail);
  }

  const payload = await res.json();
  const content: string = payload?.choices?.[0]?.message?.content ?? '';
  if (!content) throw new AiError('format', '模型没有返回内容');

  return normalizeResult(parseJsonLoose(content), fragments);
}

/** 设置页的连通性测试：拉模型列表，比真实对话便宜得多 */
export async function testConnection(config: AiConfig): Promise<string> {
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.error?.message ?? '';
      } catch {
        /* 忽略 */
      }
      throw mapHttpError(res.status, detail);
    }
    const body = await res.json();
    const models: string[] = Array.isArray(body?.data) ? body.data.map((m: any) => m?.id).filter(Boolean) : [];
    return models.length ? `连接正常，可用模型：${models.slice(0, 4).join('、')}` : '连接正常';
  } catch (e: any) {
    if (e instanceof AiError) throw e;
    if (e?.name === 'AbortError') throw new AiError('network', '连接超时，检查 BaseURL 和网络');
    throw new AiError('network', '连不上，检查 BaseURL 和网络');
  } finally {
    clearTimeout(timer);
  }
}
