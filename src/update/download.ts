/**
 * 下载 APK 并交给系统安装器。
 *
 * 两个技术选择，都不是随便挑的：
 *
 * 1. **下载用 `File.createDownloadTask`，不用 `downloadFileAsync`。**
 *    后者是一次性的 promise，没有进度回调 —— 22 MB 在弱网下要下好几分钟，
 *    界面上只有个转圈，用户会以为卡死。新 API 的 `onProgress` 直接给
 *    `bytesWritten` / `totalBytes`，进度条才有数据可画。
 *
 * 2. **安装走 content:// 而不是 file://。**
 *    Android 7 起禁止把 `file://` 交给别的应用（FileUriExposedException）。
 *    安装器是另一个进程，所以必须先经 FileProvider 转成 content URI。
 *    `expo-file-system` 在 Android 上已经注册好 `FileSystemFileProvider`，
 *    它的 paths 覆盖了 files 和 cache 两个目录，所以下载到 cache 能直接转。
 *    `getContentUriAsync` 目前只在 legacy 入口里，新 API 没有对应方法 ——
 *    这是全项目唯一一处故意混用新旧 API 的地方。
 */
import { File, Paths } from 'expo-file-system';
import { getContentUriAsync } from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import type { ReleaseInfo } from './check';
import { buildCandidates, getDownloadBase } from './mirror';

/** 固定文件名：同一时间只会有一次下载，不需要区分 */
const APK_NAME = 'fragments-update.apk';

/** FLAG_GRANT_READ_URI_PERMISSION：不给这个 flag，安装器读不到 content URI */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

export interface DownloadProgress {
  written: number;
  /** 服务器没给 Content-Length 时是 -1 */
  total: number;
}

/** 报告当前在试第几个下载源，给界面显示「加速镜像 2/5」这类提示 */
export interface DownloadSourceReport {
  /** 第几个源（从 1 开始） */
  index: number;
  total: number;
  label: string;
}

/** 下载/安装阶段的可读错误。message 直接上屏，不套「更新失败」 */
export class UpdateError extends Error {}

/** `23347200` → `22.3 MB` */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * 单源下载：删残包 → 建任务 → 下载 → 校验大小。
 *
 * 每个源都是独立的：上个源下了一半，这个源要从 0 开始，所以残包在这里删。
 * 失败抛 `UpdateError`，让上层的多源循环决定换不换源。
 */
async function downloadOne(
  url: string,
  dest: File,
  expectedSize: number,
  onProgress: (p: DownloadProgress) => void,
  onCancelReady?: (cancel: () => void) => void,
): Promise<File> {
  // 上一轮没下完的残包必须先删：createDownloadTask 对已存在的目标会报错，
  // 而且残包大小对不上时会让人以为下载成功了
  if (dest.exists) {
    try {
      dest.delete();
    } catch {
      /* 删不掉就让下面去报错，别在这里吞掉 */
    }
  }

  const task = File.createDownloadTask(url, dest, {
    onProgress: (p) => {
      onProgress({ written: p.bytesWritten, total: p.totalBytes });
    },
  });

  onCancelReady?.(() => {
    try {
      task.cancel();
    } catch {
      /* 已经结束的任务取消会抛，忽略 */
    }
  });

  let file: File | null;
  try {
    file = await task.downloadAsync();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 用户主动取消会以 AbortError / cancelled 的形式抛出来，不该当成失败弹错
    if (/abort|cancel/i.test(msg)) throw new UpdateError('已取消下载');
    throw new UpdateError(`下载失败：${msg}`);
  } finally {
    try {
      task.release();
    } catch {
      /* 同上 */
    }
  }

  if (!file) throw new UpdateError('下载被中断，请重试');

  // 装之前必须校验大小。半包能拉起安装器，但装到一半会失败，
  // 而用户看到的只是「应用未安装」，根本猜不到是下载没下全
  const actual = file.info().size ?? 0;
  if (expectedSize > 0 && actual > 0) {
    const diff = Math.abs(actual - expectedSize);
    // 允许 1 KB 误差：Release 里的 size 是上传时算的，个别 CDN 会补尾部字节
    if (diff > 1024) {
      throw new UpdateError(
        `下载不完整（${formatBytes(actual)} / 应为 ${formatBytes(expectedSize)}），请重试`,
      );
    }
  }

  return file;
}

/**
 * 下载到缓存目录，返回本地文件。
 *
 * 多源回退：自定义地址 → 加速镜像 → GitHub 官方，哪个先成功用哪个。
 * 取消（不是失败）立即中断，不换源。全部失败抛合并错误。
 *
 * `onCancelReady` 把取消句柄交出去 —— 调用方需要在界面上放一个「取消」，
 * 而取消方法只有 task 上有；每换一个源，句柄都会更新成当前源的 task。
 */
export async function downloadApk(
  release: ReleaseInfo,
  onProgress: (p: DownloadProgress) => void,
  onCancelReady?: (cancel: () => void) => void,
  onSource?: (s: DownloadSourceReport) => void,
): Promise<File> {
  const base = await getDownloadBase().catch(() => '');
  const candidates = buildCandidates(release, base);
  const dest = new File(Paths.cache, APK_NAME);

  let lastError: Error | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const src = candidates[i];
    onSource?.({ index: i + 1, total: candidates.length, label: src.label });
    // 切源时进度归零，别让上个源下了一半的数字误导进度条
    onProgress({ written: 0, total: release.apkSize });
    try {
      return await downloadOne(src.url, dest, release.apkSize, onProgress, onCancelReady);
    } catch (e) {
      // 主动取消不该换源，原样抛出
      if (/已取消下载|abort|cancel/i.test(e instanceof Error ? e.message : String(e))) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  const tail = lastError?.message ? `：${lastError.message}` : '';
  throw new UpdateError(`所有下载源都失败${tail}`);
}

/**
 * 交给系统安装器。
 *
 * 这里**一定会跳出去**：系统会弹「是否安装」的确认页，App 内无法代劳。
 * 国产 ROM 还多一层「允许安装未知应用」，没授权时 startActivity 会抛 SecurityException ——
 * 调用方要能把用户引到那个设置页。
 */
export async function installApk(file: File): Promise<void> {
  let contentUri: string;
  try {
    contentUri = await getContentUriAsync(file.uri);
  } catch (e) {
    throw new UpdateError(`无法读取安装包：${e instanceof Error ? e.message : '未知错误'}`);
  }

  try {
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: 'application/vnd.android.package-archive',
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/security|permission|denied/i.test(msg)) {
      throw new UpdateError('系统拒绝了安装请求：需要在设置里允许本应用「安装未知应用」');
    }
    throw new UpdateError(`无法拉起安装器：${msg}`);
  }
}

/** 打开「安装未知应用」的授权页（部分 ROM 支持，失败就让用户自己去设置里找） */
export async function openInstallPermissionSettings(): Promise<void> {
  await IntentLauncher.startActivityAsync(
    'android.settings.MANAGE_UNKNOWN_APP_SOURCES',
    { data: 'package:com.local.fragments' },
  );
}

/** 清掉下载残包（用户取消或装完后都该收拾干净） */
export function clearDownload(): void {
  const dest = new File(Paths.cache, APK_NAME);
  if (!dest.exists) return;
  try {
    dest.delete();
  } catch {
    /* 缓存目录，系统迟早会清 */
  }
}
