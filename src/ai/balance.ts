/**
 * DeepSeek 账户余额。
 *
 * 官方有个不花 token 的接口：`GET https://api.deepseek.com/user/balance`，
 * 带同一个 Bearer Key，返回 `balance_infos[]`（分币种）。
 * 它**不在 /v1 下面** —— baseUrl 是 `https://api.deepseek.com/v1`，
 * 余额在根路径上，所以要从 baseUrl 推出 origin，不能直接拼。
 *
 * 三个必须守住的边界：
 * 1. **失败不拦任何功能**。余额查不到只影响设置页那一行字，绝不能让它
 *    把「保存」「测试连接」也挡住。
 * 2. **第三方接口不假装支持**。用户把 Base URL 换成别的网关时，那个 `/user/balance`
 *    大概率不存在，请求会 404 或者返回一坨 HTML。与其显示「查询失败」，
 *    不如直接说清「只有官方接口能查」。
 * 3. **缓存一会儿**。设置页会重渲染很多次，每渲染一次打一次网络请求既慢又没必要。
 */
import { fetch as expoFetch } from 'expo/fetch';
import type { AiConfig } from '../types';

/** 官方域名。只有它认 /user/balance */
const OFFICIAL_HOST = 'api.deepseek.com';

export interface BalanceInfo {
  /** 服务端说这个币种的余额够不够用（total_balance > 0） */
  available: boolean;
  currency: string;
  /** 总余额，字符串是官方原样返回的，别转 number —— 会丢小数位 */
  total: string;
  granted: string;
  toppedUp: string;
}

export type BalanceResult =
  | { kind: 'ok'; infos: BalanceInfo[]; at: number }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'error'; message: string; raw?: string };

/** 官方接口的根地址。末尾斜杠去掉，/v1 之类的前缀也去掉 */
export function officialOrigin(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  if (url.host.toLowerCase() !== OFFICIAL_HOST) return null;
  return `${url.protocol}//${url.host}`;
}

const TTL = 60_000;
let cache: { key: string; result: BalanceResult } | null = null;

/** 同一把 Key 一分钟内不重复请求。force 用于用户主动点刷新 */
export async function fetchBalance(config: AiConfig, force = false): Promise<BalanceResult> {
  if (!config.apiKey) return { kind: 'error', message: '还没填 API Key' };

  const origin = officialOrigin(config.baseUrl);
  if (!origin) {
    return {
      kind: 'unsupported',
      reason: '这个地址不是 DeepSeek 官方接口，查不到余额',
    };
  }

  const key = `${origin}|${config.apiKey.slice(-8)}`;
  if (
    !force &&
    cache &&
    cache.key === key &&
    cache.result.kind === 'ok' &&
    Date.now() - cache.result.at < TTL
  ) {
    return cache.result;
  }

  let result: BalanceResult;
  try {
    const res = await expoFetch(`${origin}/user/balance`, {
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
      result = {
        kind: 'error',
        message: res.status === 401 ? 'API Key 无效，查不到余额' : `查询失败 ${res.status}`,
        raw: text.slice(0, 2000),
      };
    } else {
      const body = JSON.parse(text);
      const list: unknown[] = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
      const infos: BalanceInfo[] = list.map((item: any) => ({
        available: !!body?.is_available,
        currency: String(item?.currency ?? ''),
        total: String(item?.total_balance ?? '0'),
        granted: String(item?.granted_balance ?? '0'),
        toppedUp: String(item?.topped_up_balance ?? '0'),
      }));
      result = { kind: 'ok', infos, at: Date.now() };
    }
  } catch (e) {
    result = {
      kind: 'error',
      message: '连不上 DeepSeek，检查网络',
      raw: (e as Error)?.message,
    };
  }

  // 只缓存成功结果：失败要让人一点就能重试，不能一分钟内都显示同一个错
  cache = result.kind === 'ok' ? { key, result } : null;
  return result;
}

/** 给界面用的一行字：¥12.34 · 赠金 ¥2.00 */
export function balanceLine(result: BalanceResult): string {
  if (result.kind === 'unsupported') return result.reason;
  if (result.kind === 'error') return result.message;
  if (!result.infos.length) return '余额接口没返回数据';
  const sym = (c: string) => (c === 'CNY' ? '¥' : c === 'USD' ? '$' : `${c} `);
  return result.infos
    .map((i) => `${sym(i.currency)}${i.total}${Number(i.granted) > 0 ? `（含赠金 ${sym(i.currency)}${i.granted}）` : ''}`)
    .join(' · ');
}
