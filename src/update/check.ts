/**
 * 检查有没有新版本。
 *
 * 数据源只有一个：GitHub Release 的 latest。
 * **不能用 Actions 的 artifact** —— 那个接口要登录，手机端匿名访问会被 403，
 * 这也是 CI 日志当初下不下来的同一个限制。
 *
 * 三条克制：
 * - 启动自动检查有 6 小时节流。未认证的 GitHub API 是 60 次/小时/IP，
 *   一家人共用出口 IP，开几次 App 就见底了。
 * - 任何失败都返回结构化错误，不抛异常。更新检查失败绝不该影响启动。
 * - 解析不了的版本号一律当「相同」，宁可漏报也不每天弹一次假更新。
 */
import { APP_VERSION } from '../version';
import { repo } from '../db/repo';
import { compareVersion } from '../util/semver';

const OWNER = 'gup-n';
const REPO = 'fragements';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

/** 自动检查的节流窗口（前端手动检查不受限） */
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
/** 单次请求超时 */
const TIMEOUT_MS = 15_000;

const K_LAST_CHECK = 'update_checked_at';
const K_SKIP = 'update_skip_version';
const K_AUTO = 'update_auto_check';

export interface ReleaseInfo {
  /** 去掉 v 前缀的版本号，如 `0.8.4` */
  version: string;
  /** 原始 tag，如 `v0.8.4` */
  tag: string;
  /** Release 说明（通常是 CHANGELOG 里那一版的内容） */
  notes: string;
  apkUrl: string;
  apkName: string;
  /** 字节数；接口没给就是 0 */
  apkSize: number;
}

export type CheckResult =
  /** 有新版本。skipped = 用户之前勾过「不再提示这个版本」 */
  | { kind: 'update'; release: ReleaseInfo; skipped: boolean }
  | { kind: 'latest'; current: string }
  /** 仓库还没发过 Release */
  | { kind: 'none' }
  /** 节流窗口内，这次没发请求 */
  | { kind: 'throttled' }
  | { kind: 'error'; message: string };

/**
 * 请求 latest release。
 * 返回 null 表示 404（还没有 Release）；抛错表示网络/限流等真问题。
 */
async function fetchLatest(): Promise<ReleaseInfo | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'fragments-app',
      },
      signal: ctrl.signal,
    });
  } catch (e) {
    const aborted = (e as Error)?.name === 'AbortError';
    throw new Error(aborted ? '连接 GitHub 超时，稍后再试' : '连不上 GitHub，检查手机网络');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) {
    const left = res.headers.get('x-ratelimit-remaining');
    throw new Error(
      left === '0'
        ? 'GitHub 接口调用太频繁（每小时限 60 次），过一会儿再试'
        : 'GitHub 拒绝了这次请求，过一会儿再试',
    );
  }
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);

  const data = (await res.json()) as {
    tag_name?: string;
    body?: string;
    assets?: { name?: string; browser_download_url?: string; size?: number }[];
  };

  const tag = (data.tag_name ?? '').trim();
  if (!tag) throw new Error('Release 里没有版本号');

  const apk = (data.assets ?? []).find((a) => (a.name ?? '').toLowerCase().endsWith('.apk'));
  if (!apk?.browser_download_url) throw new Error('这个版本没有附带 APK');

  return {
    version: tag.replace(/^[vV]/, ''),
    tag,
    notes: (data.body ?? '').trim(),
    apkUrl: apk.browser_download_url,
    apkName: apk.name ?? 'fragments.apk',
    apkSize: apk.size ?? 0,
  };
}

/** 启动时的自动检查。6 小时内重复调用只会返回 throttled，不发请求 */
export async function checkForUpdate(opts: { force?: boolean } = {}): Promise<CheckResult> {
  const force = opts.force === true;

  if (!force) {
    const last = await repo.getSetting(K_LAST_CHECK).catch(() => null);
    const at = last ? Number(last) : 0;
    if (Number.isFinite(at) && Date.now() - at < CHECK_INTERVAL) {
      return { kind: 'throttled' };
    }
  }

  let release: ReleaseInfo | null;
  try {
    release = await fetchLatest();
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : '检查更新失败' };
  }

  // 只有真的问到结果才记时间。失败不记，否则一次断网就要等六小时才会再试
  await repo.setSetting(K_LAST_CHECK, String(Date.now())).catch(() => undefined);

  if (!release) return { kind: 'none' };

  if (compareVersion(release.version, APP_VERSION) <= 0) {
    return { kind: 'latest', current: APP_VERSION };
  }

  const skip = await repo.getSetting(K_SKIP).catch(() => null);
  return { kind: 'update', release, skipped: skip === release.version };
}

/** 启动时是否自动检查（默认开） */
export async function getAutoCheck(): Promise<boolean> {
  const v = await repo.getSetting(K_AUTO).catch(() => null);
  // 没存过视为开：这个功能的价值就在于「用户不用想起来去点」
  return v === null ? true : v === '1';
}

export async function setAutoCheck(on: boolean): Promise<void> {
  await repo.setSetting(K_AUTO, on ? '1' : '0');
}

/** 用户勾了「不再提示这个版本」。传 null 表示清掉 */
export async function setSkipVersion(version: string | null): Promise<void> {
  await repo.setSetting(K_SKIP, version ?? '');
}

export async function getSkipVersion(): Promise<string> {
  return (await repo.getSetting(K_SKIP).catch(() => null)) ?? '';
}
