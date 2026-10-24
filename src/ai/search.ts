/**
 * DeepSeek 官方 Search API（`POST /v1/tools/search`）。
 *
 * 为什么不用 Responses API 里那个内置的 `web_search`：
 * 它**只在 deepseek-v4-pro 生效**，本项目默认的 deepseek-flash 下会被静默忽略 ——
 * 不报错、只是根本没搜，然后模型一本正经地凭记忆编。这是最危险的一种失败。
 * 手动走 tools/search 至少能明确知道「搜了」还是「没搜到」。
 *
 * 计费按**成功请求**算（5 元 / 1000 次），count 不影响价格，
 * 所以一次多要几条（默认 8）比反复搜更划算。空结果不计费。
 * 限速 100 QPS，个人用不可能碰到；真正要防的是 408/429/5xx，官方不给 Retry-After，
 * 只能自己退避。
 */
import { fetch as expoFetch } from 'expo/fetch';
import type { AiConfig, WebHit } from '../types';
import { AiError } from './chat';

/** 官方限制 query 1–128 字符，超了直接 400 */
const MAX_QUERY = 128;
/** 一次要几条。count 不影响计费，多拿几条让模型有得挑 */
const DEFAULT_COUNT = 8;
/** 相关度下限。官方说 rerank_score ≥ 1.5 才算优质，1.0 以下基本是噪音 */
const MIN_SCORE = 1.0;
/** 单次请求超时。搜索是同步接口，正常一两秒就回 */
const TIMEOUT_MS = 25_000;
/** 408 / 429 / 5xx 可以重试，其余 4xx 重试多少次都一样 */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

function endpoint(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, '')}/tools/search`;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function mapStatus(status: number, detail: string): AiError {
  if (status === 401 || status === 403) {
    return new AiError('auth', `联网搜索被拒绝（${status}）${detail ? `：${detail}` : ''}`);
  }
  if (status === 402) return new AiError('quota', 'DeepSeek 账户余额不足，联网搜索也用不了');
  if (status === 429) return new AiError('rate', '搜索请求太频繁，等几秒再试');
  if (status >= 500) return new AiError('server', `搜索服务异常（${status}），稍后重试`);
  return new AiError('server', `搜索失败 ${status}${detail ? `：${detail}` : ''}`);
}

/** 服务端返回的数组可能挂在不同的键上，别死认一个 */
function pickArray(payload: any): any[] {
  for (const key of ['results', 'data', 'items', 'hits', 'web']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

/**
 * 收敛成 WebHit[]。
 *
 * 只收有 url 且有 summary 的 —— summary 是官方专门给模型读的 600–800 字，
 * 拿不到 summary 的条目进上下文只会白白占额度。不去 Fetch 正文：
 * 另计费，而且不少站点（知乎、公众号）取不到。
 */
function normalize(payload: any, limit: number): WebHit[] {
  const seen = new Set<string>();
  const out: WebHit[] = [];

  for (const r of pickArray(payload)) {
    const url = String(r?.url ?? r?.link ?? '').trim();
    const summary = String(r?.summary ?? r?.snippet ?? r?.content ?? '').trim();
    if (!url || !summary) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: String(r?.title ?? r?.name ?? url).trim() || url,
      url,
      summary,
      score: Number(r?.rerank_score ?? r?.score ?? 0) || 0,
    });
  }

  out.sort((a, b) => b.score - a.score);

  // 只有服务端给了分数才按分数筛。一个分数都没给时不能把结果全清空
  const hasScore = out.some((h) => h.score > 0);
  const kept = hasScore ? out.filter((h) => h.score === 0 || h.score >= MIN_SCORE) : out;
  return kept.slice(0, limit);
}

type Attempt = { ok: true; hits: WebHit[] } | { ok: false; error: AiError; retryable: boolean };

async function callOnce(config: AiConfig, query: string, count: number): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await expoFetch(endpoint(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      // need_content 关掉：只要 summary。开了会连正文一起回，既慢又贵
      body: JSON.stringify({ query, count, need_content: false }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.error?.message ?? '';
      } catch {
        /* 错误体不是 JSON 就算了 */
      }
      return {
        ok: false,
        error: mapStatus(res.status, detail),
        retryable: RETRYABLE.has(res.status),
      };
    }

    return { ok: true, hits: normalize(await res.json(), count) };
  } catch (e: any) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      return {
        ok: false,
        error: new AiError('network', `联网搜索超时（${TIMEOUT_MS / 1000} 秒）`),
        retryable: true,
      };
    }
    return {
      ok: false,
      error: new AiError('network', '连不上搜索服务，检查手机网络'),
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 搜一次。返回空数组是**正常结果**（确实没搜到），不是错误 ——
 * 调用方要能区分「没搜到」和「搜索失败」，前者可以照常回答，后者要如实报错。
 */
export async function searchWeb(
  config: AiConfig,
  query: string,
  count = DEFAULT_COUNT,
): Promise<WebHit[]> {
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  const q = query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
  if (!q) throw new AiError('format', '问题太短，搜不出东西');

  let last: AiError | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(400 * 2 ** (attempt - 1));
    const r = await callOnce(config, q, count);
    if (r.ok) return r.hits;
    last = r.error;
    if (!r.retryable) throw r.error;
  }
  throw last ?? new AiError('network', '联网搜索失败，再试一次');
}
