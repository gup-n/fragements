/**
 * 下载源：自定义地址 → GitHub 官方 → 内置加速镜像（兜底）。
 *
 * **官方排在内置镜像前面**，这是实测后的顺序。镜像本身在大陆时快时慢，
 * 而「时快时慢」比「一直慢」更难受：它会让下载卡在一个既不通也不报错的
 * 连接上。所以默认走官方直连，镜像只在官方彻底失败后兜一下。
 *
 * 为什么不能干脆删掉镜像：GitHub Release 的 APK 实际从
 * `release-assets.githubusercontent.com` 下发，这个域名在某些网络下完全不通，
 * 那时镜像就是唯一的希望。留着它，但把它排到最后。
 *
 * 自定义地址给有自己服务器的用户：把和 Release 完全相同的 APK 放到可达地址，
 * 下载走内网或自己的带宽。
 */
import type { ReleaseInfo } from './check';
import { repo } from '../db/repo';

/** 下载地址设置 key（settings 表） */
const K_BASE = 'update_download_base';

/**
 * 内置 GitHub 加速镜像前缀，**只留一个**。
 *
 * 第三方、随时可能限速或失效。留多个的代价是「官方失败后要连着白等好几个」——
 * 每个源都要等停滞检测超时才放弃，三个就是三倍等待。兜底有一个够了。
 */
const BUILTIN_PROXIES = ['https://ghproxy.net/'];

export interface DownloadSource {
  url: string;
  /** 给界面显示用，如「自定义地址」「GitHub 官方」「加速镜像」 */
  label: string;
}

/** 用户自设的下载基础地址，空串 = 没设 */
export async function getDownloadBase(): Promise<string> {
  return (await repo.getSetting(K_BASE).catch(() => null)) ?? '';
}

export async function setDownloadBase(base: string): Promise<void> {
  await repo.setSetting(K_BASE, base.trim());
}

/**
 * 按优先级产出候选下载地址：
 * 1. 自定义基础地址 → `{base}/{apkName}`（apkName 是 Release 里的原始文件名）；
 * 2. GitHub 官方直连；
 * 3. 内置加速镜像，只在官方失败时兜底。
 */
export function buildCandidates(release: ReleaseInfo, base: string): DownloadSource[] {
  const out: DownloadSource[] = [];

  const b = base.trim();
  if (b) {
    const root = b.endsWith('/') ? b : `${b}/`;
    out.push({ url: `${root}${release.apkName}`, label: '自定义地址' });
  }

  out.push({ url: release.apkUrl, label: 'GitHub 官方' });

  for (const p of BUILTIN_PROXIES) {
    out.push({ url: `${p}${release.apkUrl}`, label: '加速镜像' });
  }

  return out;
}
