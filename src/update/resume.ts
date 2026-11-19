/**
 * 断点续传的两个判据（纯函数，不碰文件系统，断言直接调）。
 *
 * 为什么需要这一层：用户 2026-11-19 报「临时切了 10 秒别的应用，回来要重新下载」。
 * 根因不在网络 —— `expo-file-system` 的进度回调**切到后台就不再触发**，
 * 而下载代码里那个「15 秒没有新字节就换源」的巡检还在计时，
 * 于是切走 10 秒回来正好被判成卡死：掐源、换下一个、顺手把残包删了。
 *
 * 所以这里要回答两个问题：
 * 1. 现在这半包还能不能接着下（`resumeOffset`）；
 * 2. 这一刻该不该判「卡住」（`stallApplies`）。
 */

/** 残包属于谁。写在 APK 旁边的那个小 json 里 */
export interface PartialApk {
  /** 版本号：v0.31.1 的残包不能拿去续 v0.32.0 */
  version: string;
  /** 下载源：不同源的文件不保证逐字节一致，混着接会拼出坏包 */
  url: string;
  /** 这一版安装包的字节数（Release 给的） */
  size: number;
}

/**
 * 从残包续多少字节。返回 0 表示「不能续，请从头下」。
 *
 * 四个都要对上：同一个版本、同一个源、同一个目标大小、残包本身没超过目标。
 * 少一条就从头来 —— 拼一个坏包的代价（装到一半失败、用户只看到「应用未安装」）
 * 比多下一次 26 MB 大得多。
 */
export function resumeOffset(saved: PartialApk | null, want: PartialApk, partialBytes: number): number {
  if (!saved) return 0;
  if (!Number.isFinite(partialBytes) || partialBytes <= 0) return 0;
  if (saved.version !== want.version) return 0;
  if (saved.url !== want.url) return 0;
  if (saved.size !== want.size) return 0;
  if (want.size > 0 && partialBytes >= want.size) return 0;
  return Math.floor(partialBytes);
}

/**
 * 这一刻该不该判「卡住」。
 *
 * 切到后台时**一律不判**：原生下载还在跑，只是进度回调要等回到前台才补发
 * （`expo-file-system` 文档里明写的行为）。拿「没有回调」当「没有进展」，
 * 就会把正常运行的后台下载掐掉。
 */
export function stallApplies(appState: string | null | undefined): boolean {
  return appState === 'active';
}

/** 百分比取整；总量未知（-1 或 0）返回 null，界面按「已下载 x MB」显示 */
export function percentOf(written: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(written) || written <= 0) return 0;
  return Math.min(100, Math.floor((written / total) * 100));
}
