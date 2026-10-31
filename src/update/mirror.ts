/**
 * 下载源：自定义地址 → 内置加速镜像 → GitHub 官方，多源回退。
 *
 * 为什么要有这一层：GitHub Release 的 APK 实际从
 * `release-assets.githubusercontent.com` / `objects.githubusercontent.com` 下发，
 * 这两个域名在大陆直连极慢，而且很多 VPN 是「分流模式」，不会把 CDN 域名也
 * 塞进隧道 —— 所以「更新检查能成功（github.com 通）、下载却卡住」。
 * 回退链让下载先走快源，失败再退一级，最后一站永远是官方（保证至少有源可下）。
 *
 * 自定义地址适合有 NAS / 自建的用户：把和 Release 完全相同的 APK 放到自己
 * 可达的地址（局域网 / Tailscale / DDNS），下载走内网或自己的带宽。
 */
import type { ReleaseInfo } from './check';
import { repo } from '../db/repo';

/** 下载地址设置 key（settings 表） */
const K_BASE = 'update_download_base';

/**
 * 内置 GitHub 加速镜像前缀。第三方、可能限速或失效，顺序即优先级。
 * 格式是 `{前缀}https://github.com/...`（在原始 URL 前直接拼域名）。
 */
const BUILTIN_PROXIES = [
  'https://ghproxy.net/',
  'https://ghfast.top/',
  'https://mirror.ghproxy.com/',
];

export interface DownloadSource {
  url: string;
  /** 给界面显示用，如「自定义地址」「加速镜像」「GitHub 官方」 */
  label: string;
}

/** 用户自设的下载基础地址（NAS / 自建），空串 = 没设 */
export async function getDownloadBase(): Promise<string> {
  return (await repo.getSetting(K_BASE).catch(() => null)) ?? '';
}

export async function setDownloadBase(base: string): Promise<void> {
  await repo.setSetting(K_BASE, base.trim());
}

/**
 * 按优先级产出候选下载地址：
 * 1. 自定义基础地址 → `{base}/{apkName}`（apkName 是 Release 里的原始文件名）；
 * 2. 内置加速镜像 → `{proxy}{apkUrl}`；
 * 3. GitHub 官方（永远兜底，保证至少有一个源）。
 */
export function buildCandidates(release: ReleaseInfo, base: string): DownloadSource[] {
  const out: DownloadSource[] = [];

  const b = base.trim();
  if (b) {
    const root = b.endsWith('/') ? b : `${b}/`;
    out.push({ url: `${root}${release.apkName}`, label: '自定义地址' });
  }

  for (const p of BUILTIN_PROXIES) {
    out.push({ url: `${p}${release.apkUrl}`, label: '加速镜像' });
  }

  out.push({ url: release.apkUrl, label: 'GitHub 官方' });
  return out;
}
