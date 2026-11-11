/**
 * DeepSeek Fetch API（`POST /v1/tools/fetch`）：把一个网页读成 Markdown。
 *
 * 为什么必须有这个：用户把链接发进来，意思是「你看看这个」。
 * 而在这之前，链接是被当成**搜索关键词**发出去的 ——
 * `https://example.com/a` 作为 query 搜不到任何东西，界面于是显示
 * 「联网开了，但没搜到有用的网页」。用户看到的「根本没查」，其实是「根本没去」。
 *
 * 和 Search 的分工很清楚：
 * - 有链接 → Fetch，读那一页；
 * - 没链接 → Search，找相关页。
 * 两者都是按成功请求计费（$0.75 / 1000 次），失败和空结果不计费。
 */
import { fetch as expoFetch } from 'expo/fetch';
import type { AiConfig } from '../types';
import { AiError } from './chat';

/** 单页正文保留多少字。一页 Markdown 常有一两万字，全给模型只会挤掉别的东西 */
const PAGE_KEEP = 12_000;
/** 一次最多读几个链接。读多个链接是并行的，但每个都计费 */
const MAX_PAGES = 2;
/** 单个请求超时。抓页面比搜索慢，给足 */
const TIMEOUT_MS = 30_000;

export interface FetchedPage {
  url: string;
  title: string;
  /** 正文 Markdown。已按 PAGE_KEEP 截断 */
  content: string;
  /** 原文总长度，用来在提示里如实说「这是节选」 */
  totalChars: number;
}

function endpoint(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, '')}/tools/fetch`;
}

function mapStatus(status: number, detail: string, url: string): AiError {
  if (status === 401 || status === 403) {
    // 403 有两个来源：key 不对，或者目标站点拒绝。详情里带上原文才分得清
    return new AiError('auth', `读不了这个链接（${status}）${detail ? `：${detail}` : ''}`, {
      stage: '抓取网页',
      status,
      raw: `${url}\n${detail}`.trim(),
    });
  }
  if (status === 402) return new AiError('quota', 'DeepSeek 账户余额不足，读网页也用不了');
  if (status === 404) {
    /*
     * 404 在 Fetch 里的含义是「取不到可用内容」，不只是「页面不存在」：
     * 需要登录的、纯图片的、被站点策略挡的，都走这一条。
     * 所以这句话不能写「链接不存在」—— 用户会以为自己发错链接了。
     */
    return new AiError('server', '这个链接取不到内容（可能要登录、是图片页，或者站点不让抓）', {
      stage: '抓取网页',
      status,
      raw: url,
    });
  }
  if (status === 429) return new AiError('rate', '读网页太频繁，等几秒再试');
  if (status >= 500) return new AiError('server', `读网页时服务端出错（${status}），稍后重试`);
  return new AiError('server', `读网页失败 ${status}${detail ? `：${detail}` : ''}`, {
    stage: '抓取网页',
    status,
    raw: detail,
  });
}

/** 读一页。失败抛 `AiError`，由调用方决定是「整轮失败」还是「跳过这一页」 */
export async function fetchPage(config: AiConfig, url: string): Promise<FetchedPage> {
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await expoFetch(endpoint(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ url }),
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
      throw mapStatus(res.status, detail, url);
    }

    const body = await res.json();
    const content = String(body?.content ?? '').trim();
    if (!content) {
      throw new AiError('format', '这个链接读出来是空的（可能是图片页或者要登录）', {
        stage: '抓取网页',
        raw: url,
      });
    }
    return {
      url,
      title: String(body?.title ?? '').trim() || url,
      content: content.length > PAGE_KEEP ? `${content.slice(0, PAGE_KEEP)}…` : content,
      totalChars: content.length,
    };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if ((e as any)?.name === 'AbortError' || (e as any)?.name === 'TimeoutError') {
      throw new AiError('network', `读这个链接超时了（${TIMEOUT_MS / 1000} 秒）`, {
        stage: '抓取网页',
        raw: url,
      });
    }
    throw new AiError('network', '连不上，检查手机网络', { stage: '抓取网页', raw: url });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读前几个链接。
 *
 * 返回 `pages`（成功的）和 `firstError`（第一条失败原因）：
 * 两个链接一个成功一个失败时，**成功的那页照常给模型**，
 * 失败的原因照样上屏 —— 用户既拿到了内容，也知道另一个没读到。
 */
export async function fetchPages(
  config: AiConfig,
  urls: string[],
): Promise<{ pages: FetchedPage[]; firstError: string | null; skipped: number }> {
  const picked = urls.slice(0, MAX_PAGES);
  const results = await Promise.allSettled(picked.map((u) => fetchPage(config, u)));

  const pages: FetchedPage[] = [];
  let firstError: string | null = null;
  for (const r of results) {
    if (r.status === 'fulfilled') pages.push(r.value);
    else if (!firstError) {
      firstError = r.reason instanceof Error ? r.reason.message : '读网页失败';
    }
  }
  return { pages, firstError, skipped: Math.max(0, urls.length - picked.length) };
}
