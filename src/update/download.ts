/**
 * 下载 APK 并交给系统安装器。
 *
 * 三个技术选择，都不是随便挑的：
 *
 * 1. **下载用 `createDownloadResumable`（legacy），不用新的 `File.createDownloadTask`。**
 *    新 API 没有进度回调以外的能力：不能给 Range、不能续、不能暂停。
 *    用户 2026-11-19 报「切了 10 秒别的应用，回来要重新下载」—— 那次真正的原因是
 *    进度回调**切后台就不再触发**（expo 文档明写），而这里的「15 秒没新字节就换源」
 *    巡检还在计时，于是正常跑着的后台下载被判成卡死、掐源、顺手把残包删了。
 *    现在：残包留着，续传靠 `resumeData`（就是残包的字节数，服务端按 `Range` 接着发）。
 *
 * 2. **安装走 content:// 而不是 file://。**
 *    Android 7 起禁止把 `file://` 交给别的应用（FileUriExposedException）。
 *    安装器是另一个进程，所以必须先经 FileProvider 转成 content URI。
 *    `expo-file-system` 在 Android 上已经注册好 `FileSystemFileProvider`，
 *    它的 paths 覆盖了 files 和 cache 两个目录，所以下载到 cache 能直接转。
 *    `getContentUriAsync` 目前只在 legacy 入口里，新 API 没有对应方法 ——
 *    这是全项目唯一一处故意混用新旧 API 的地方（现在又多了一处续传）。
 */
import { AppState } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { createDownloadResumable, getContentUriAsync } from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import type { ReleaseInfo } from './check';
import { buildCandidates, getDownloadBase } from './mirror';
import { percentOf, resumeOffset, stallApplies, type PartialApk } from './resume';

/** 固定文件名：同一时间只会有一次下载，不需要区分 */
const APK_NAME = 'fragments-update.apk';

/** 残包旁边那张「这半包是谁的」小卡片。和 APK 一起清，不单独留 */
const SIDECAR_NAME = 'fragments-update.json';

/** FLAG_GRANT_READ_URI_PERMISSION：不给这个 flag，安装器读不到 content URI */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

export interface DownloadProgress {
  written: number;
  /** 服务器没给 Content-Length 时是 -1 */
  total: number;
}

/** 打开更新面板时先问一句：缓存里有没有能接着用的半包 */
export interface PendingDownload {
  written: number;
  total: number;
  /** 已经下全了（上次装之前被系统杀掉的情况）：直接进「立即安装」 */
  file: File | null;
}

function apkFile(): File {
  return new File(Paths.cache, APK_NAME);
}

function sidecarFile(): File {
  return new File(Paths.cache, SIDECAR_NAME);
}

async function readSidecar(): Promise<PartialApk | null> {
  const f = sidecarFile();
  if (!f.exists) return null;
  try {
    const raw = JSON.parse(await f.text()) as Partial<PartialApk>;
    if (typeof raw.version !== 'string' || typeof raw.url !== 'string' || typeof raw.size !== 'number') {
      return null;
    }
    return { version: raw.version, url: raw.url, size: raw.size };
  } catch {
    return null;
  }
}

/** 记下这一轮是给哪个版本、哪个源下的。记不下来顶多是下次从头下，不该让下载失败 */
async function writeSidecar(info: PartialApk): Promise<void> {
  try {
    await sidecarFile().write(JSON.stringify(info));
  } catch {
    /* 见上 */
  }
}

function forgetSidecar(): void {
  const f = sidecarFile();
  if (!f.exists) return;
  try {
    f.delete();
  } catch {
    /* 缓存目录，系统迟早会清 */
  }
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

/** 单源下载的入参。参数多了之后用对象，免得调用处一长串位置参数看串 */
interface DownloadOneOptions {
  url: string;
  /** 这一版是谁 —— 残包能不能接着用要先和它比 */
  version: string;
  dest: File;
  expectedSize: number;
  onProgress: (p: DownloadProgress) => void;
  onCancelReady?: (cancel: () => void) => void;
  /** 后面还有别的源可试：慢到没指望时允许主动放弃这个源 */
  hasFallback: boolean;
  /** 续传失败后重来一次时置 true：强行从头下，避免死循环 */
  noResume?: boolean;
}

/**
 * 停滞判据：**多久没有新字节**就放弃这个源。
 *
 * 必须按「字节数变没变」判，不能按「有没有进度回调」判 —— 卡死的连接照样会
 * 按固定频率回调，只是 `bytesWritten` 不动。之前没有这条，所以镜像卡住时
 * 界面能一直停在「加速镜像 1/5」不动，用户以为死机了。
 */
const STALL_MS = 15_000;
/** 低速观察窗口：跑够这么久，平均速度才有意义 */
const SLOW_WINDOW_MS = 60_000;
/** 低于这个平均速度就算没指望（22 MB 在 25 KB/s 要下 15 分钟） */
const SLOW_BYTES_PER_SEC = 25 * 1024;
/** 进度过三成就不再因为慢而放弃，免得快到终点又从头下 */
const SLOW_GIVE_UP_MAX_RATIO = 0.3;
/** 巡检间隔 */
const WATCH_INTERVAL_MS = 3_000;

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
 * 每个源都是独立的：残包如果是**别的源**下的，这里会丢掉重下
 * （不同源不保证逐字节一致，混着接会拼出坏包）。
 * 失败抛 `UpdateError`，让上层的多源循环决定换不换源。
 *
 * 下载期间挂一个巡检：**卡住或慢到没指望就自己掐掉这个源**，让上层换下一个。
 * 但切到后台期间不判 —— 进度回调这时候本来就不触发，见 `resume.ts` 的注释。
 */
async function downloadOne(o: DownloadOneOptions): Promise<File> {
  const { url, version, dest, expectedSize, onProgress, onCancelReady, hasFallback, noResume } = o;

  const partial = dest.exists ? (dest.info().size ?? 0) : 0;
  const saved = noResume ? null : await readSidecar();
  const offset = resumeOffset(saved, { version, url, size: expectedSize }, partial);

  // 不能续的残包必须删掉：续传是往同一个文件尾部接，留着上一次的字节就成了坏包
  if (offset === 0 && dest.exists) {
    try {
      dest.delete();
    } catch {
      /* 删不掉就让下面去报错，别在这里吞掉 */
    }
  }
  // 先记下「这半包是给谁下的」，再开始下 —— 中途被杀也能靠它续上
  await writeSidecar({ version, url, size: expectedSize });

  /** 巡检读的字节数：由 onProgress 持续刷新 */
  let written = offset;

  const task = createDownloadResumable(
    url,
    dest.uri,
    {},
    (p) => {
      written = p.totalBytesWritten;
      onProgress({ written: p.totalBytesWritten, total: p.totalBytesExpectedToWrite });
    },
    // resumeData 就是残包的字节数；原生按 `Range: bytes=N-` 接着发，写入也改成追加
    offset > 0 ? String(offset) : undefined,
  );

  /** 被自己掐掉的原因。用户主动取消时保持 null，两条路径不能混 */
  let aborted: 'stall' | 'slow' | null = null;

  /**
   * 巡检掐源时的失败出口。
   *
   * 为什么要 `Promise.race` 而不是只靠 `cancel()`：`cancel()` 之后
   * `downloadAsync` 不一定立刻 reject，万一它挂着，整个更新流程就永远不返回。
   * 两条路都走，只要有一条能结束就行。
   */
  let rejectOnAbort: ((e: Error) => void) | null = null;
  const abortSignal = new Promise<never>((_, reject) => {
    rejectOnAbort = reject;
  });

  let lastGrowthAt = Date.now();
  let lastSeen = offset;
  /**
   * 平均速度只统计**前台**时间。
   *
   * 后台那段时间没有进度回调，把它算进分母，切走五分钟回来平均速度就成了几 KB/s，
   * 直接判「这个源太慢」—— 和「没有进展」是同一种误判的另一种表现。
   */
  let activeMs = 0;
  let tickAt = Date.now();
  let active = stallApplies(AppState.currentState);

  /** 回到前台：重新给一个完整观察窗口，后台那段时间两头都不算 */
  const appSub = AppState.addEventListener('change', (state) => {
    active = stallApplies(state);
    if (!active) return;
    lastGrowthAt = Date.now();
    tickAt = Date.now();
  });

  const watch = setInterval(() => {
    const now = Date.now();
    const dt = Math.max(0, now - tickAt);
    tickAt = now;
    if (active) activeMs += dt;

    // 有进展就重新计时
    if (written > lastSeen) {
      lastSeen = written;
      lastGrowthAt = now;
      return;
    }

    /*
     * 切到后台：**不判卡死，也不判慢**。
     * 原生下载还在跑，只是进度回调要等回到前台才补发 —— 拿「没有回调」当
     * 「没有进展」，就会把正常跑着的下载掐掉（用户 2026-11-19 报的就是这个：
     * 切走 10 秒回来正好撞上 15 秒的判据，于是换源并从头下）。
     */
    if (!active) {
      lastGrowthAt = now;
      return;
    }

    if (now - lastGrowthAt >= STALL_MS) {
      aborted = 'stall';
      abort();
      rejectOnAbort?.(new UpdateError(`这个源 ${STALL_MS / 1000} 秒没有进展，换下一个`));
      return;
    }

    // 没有后续源可换时，慢也让它慢慢下完 —— 掐掉只会变成「全失败」
    if (!hasFallback) return;

    if (activeMs < SLOW_WINDOW_MS) return;
    const avg = (written - offset) / (activeMs / 1000);
    const ratio = expectedSize > 0 ? written / expectedSize : 0;
    if (avg < SLOW_BYTES_PER_SEC && ratio < SLOW_GIVE_UP_MAX_RATIO) {
      aborted = 'slow';
      abort();
      rejectOnAbort?.(new UpdateError('这个源太慢，换下一个'));
    }
  }, WATCH_INTERVAL_MS);

  /** 掐掉当前请求。两条出口（巡检 / 用户取消）都走它，别在别处再写一遍 */
  function abort(): void {
    try {
      void task.cancelAsync();
    } catch {
      /* 已经结束的任务取消会抛，忽略 */
    }
  }

  onCancelReady?.(abort);

  let done: unknown;
  try {
    done = await Promise.race([task.downloadAsync(), abortSignal]);
  } catch (e) {
    // 巡检掐的：这两句文案里**不能出现 abort / cancel** ——
    // 上层拿这两个词判断「用户主动取消」，混了就会把换源当成取消而停下
    if (aborted === 'stall') throw new UpdateError(`这个源 ${STALL_MS / 1000} 秒没有进展，换下一个`);
    if (aborted === 'slow') throw new UpdateError('这个源太慢，换下一个');

    const msg = e instanceof Error ? e.message : String(e);
    // 用户主动取消会以 AbortError / cancelled 的形式抛出来，不该当成失败弹错
    if (/abort|cancel/i.test(msg)) throw new UpdateError('已取消下载');
    throw new UpdateError(`下载失败：${msg}`);
  } finally {
    clearInterval(watch);
    appSub.remove();
  }

  // 用户取消时原生 resolve(undefined)；残包留着，下次还能接着下。
  // 巡检掐掉时也可能先 resolve 成 undefined，所以先认 `aborted`
  if (!done) {
    if (aborted === 'stall') throw new UpdateError(`这个源 ${STALL_MS / 1000} 秒没有进展，换下一个`);
    if (aborted === 'slow') throw new UpdateError('这个源太慢，换下一个');
    throw new UpdateError('已取消下载');
  }

  // 装之前必须校验大小。半包能拉起安装器，但装到一半会失败，
  // 而用户看到的只是「应用未安装」，根本猜不到是下载没下全
  const actual = dest.info().size ?? 0;
  if (expectedSize > 0 && actual > 0) {
    const diff = Math.abs(actual - expectedSize);
    // 允许 1 KB 误差：Release 里的 size 是上传时算的，个别 CDN 会补尾部字节
    if (diff > 1024) {
      /*
       * 续传时对不上，最常见的原因是服务端忽略了 `Range`、直接回 200：
       * 整包被接在残包后面，文件正好大出 `offset`。这不是网络问题，
       * 换源也没用 —— 清掉重下一次，只给一次机会。
       */
      if (offset > 0 && !noResume) {
        try {
          dest.delete();
        } catch {
          /* 删不掉就让下一次自己失败 */
        }
        return downloadOne({ ...o, noResume: true });
      }
      throw new UpdateError(
        `下载不完整（${formatBytes(actual)} / 应为 ${formatBytes(expectedSize)}），请重试`,
      );
    }
  }

  return dest;
}

/**
 * 下载到缓存目录，返回本地文件。
 *
 * 多源回退：自定义地址 → GitHub 官方 → 加速镜像，哪个先成功用哪个。
 * 卡住或慢到没指望的源会被巡检掐掉，自动落到下一个。
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
  const dest = apkFile();

  /** 第一个源能不能接着上一次下。能的话进度条从这一格起，不要先跳回 0 */
  const saved = await readSidecar();
  const partial = dest.exists ? (dest.info().size ?? 0) : 0;
  const carry = resumeOffset(
    saved,
    { version: release.version, url: candidates[0]?.url ?? '', size: release.apkSize },
    partial,
  );

  let lastError: Error | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const src = candidates[i];
    onSource?.({ index: i + 1, total: candidates.length, label: src.label });
    // 切源时进度归零，别让上个源下了一半的数字误导进度条
    onProgress({ written: i === 0 ? carry : 0, total: release.apkSize });
    try {
      return await downloadOne({
        url: src.url,
        version: release.version,
        dest,
        expectedSize: release.apkSize,
        onProgress,
        onCancelReady,
        hasFallback: i < candidates.length - 1,
      });
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

/**
 * 缓存里还有没有这一版能用的包。
 *
 * 两种都能用，但要说清是哪一种：
 * - 下了一半 → 给「继续下载」，进度条直接从这一格开始；
 * - 已经下全（上次装之前被系统杀掉）→ 直接进「立即安装」，别再下一次 26 MB。
 */
export async function pendingDownload(release: ReleaseInfo): Promise<PendingDownload | null> {
  const dest = apkFile();
  if (!dest.exists) return null;
  const written = dest.info().size ?? 0;
  if (written <= 0) return null;

  const saved = await readSidecar();
  // 版本或目标大小对不上：这不是这一版的包，界面照常显示「下载更新」
  if (!saved || saved.version !== release.version || saved.size !== release.apkSize) return null;

  if (release.apkSize > 0 && Math.abs(written - release.apkSize) <= 1024) {
    return { written, total: release.apkSize, file: dest };
  }
  if (release.apkSize > 0 && written >= release.apkSize) return null;
  return { written, total: release.apkSize, file: null };
}

/** 百分比给人看，`null` 表示服务器没给总大小（见 `resume.ts`） */
export function progressPercent(p: DownloadProgress): number | null {
  return percentOf(p.written, p.total);
}

/** 清掉下载残包（装完之后收拾；用户中途关掉弹窗**不**清，留着下次续） */
export function clearDownload(): void {
  forgetSidecar();
  const dest = apkFile();
  if (!dest.exists) return;
  try {
    dest.delete();

  } catch {
    /* 缓存目录，系统迟早会清 */
  }
}
