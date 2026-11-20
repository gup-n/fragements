import { useHeadingFocus } from './useHeadingFocus';
import { BusyIndicator as ActivityIndicator } from './BusyIndicator';
/**
 * 更新弹窗。四个状态：发现新版 → 下载中 → 待安装 → 失败。
 *
 * 为什么不用 Modal：项目红线（见 AGENTS.md），Android 上 Modal 的返回键
 * 和状态栏处理都有坑。这里用 absolute 覆盖层 + 自己接 BackHandler。
 *
 * 下载中**故意拦返回键**。22 MB 的包下到一半被返回键打断，用户看到的
 * 是弹窗消失、什么也没发生 —— 比让他多点一次「取消」更糟。
 *
 * 更新说明只给一行摘要 + 一个跳 GitHub 的按钮，不再把 Release 正文铺进弹窗。
 * 弹窗的职责是「要不要装」，不是「读一篇变更记录」；正文在 GitHub 上本来就有，
 * 在这里再排一遍只会把按钮挤到很下面。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { File } from 'expo-file-system';
import type { ReleaseInfo } from '../update/check';
import {
  UpdateError,
  clearDownload,
  downloadApk,
  formatBytes,
  installApk,
  openInstallPermissionSettings,
  pendingDownload,
  progressPercent,
  type DownloadProgress,
  type DownloadSourceReport,
  type PendingDownload,
} from '../update/download';
import { clearNotify, initNotify, notifyProgress, notifyReady } from '../update/notify';
import { APP_VERSION } from '../version';
import { SPACE, TYPE, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { versionLabel } from '../util/semver';

type Phase = 'prompt' | 'downloading' | 'ready' | 'error';

/**
 * 摘要上限。超过这个长度就一个字都不显示 ——
 * 截断会在半句话上断开（「改成多源回退，下载依次试：1. 自定义地址…」），
 * 读起来比没有摘要更像 bug。链接反正就在下面一行。
 */
const BRIEF_MAX = 120;

/** 把极简版 Release 说明压成一行；压不进一行就返回空串 */
function noteBrief(notes: string): string {
  const lines = notes
    .split('\n')
    .map((l) => l.replace(/^[-*]\s+/, '').trim())
    // 极简版第一行是版本号，弹窗标题里已经有了
    .filter((l) => l && !/^v?\d+(\.\d+)+$/i.test(l));
  const one = lines.join(' · ');
  return one.length > 0 && one.length <= BRIEF_MAX ? one : '';
}

interface Props {
  release: ReleaseInfo;
  onClose: () => void;
  /** 用户勾了「不再提示这个版本」 */
  onSkipVersion: () => void;
}

export function UpdateSheet({ release, onClose, onSkipVersion }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [phase, setPhase] = useState<Phase>('prompt');
  const [progress, setProgress] = useState<DownloadProgress>({
    written: 0,
    total: release.apkSize,
  });
  /** 瞬时速度（字节/秒），用移动平均平滑过 */
  const [speed, setSpeed] = useState(0);
  /** 当前在试第几个下载源（自定义地址 / 加速镜像 / GitHub 官方） */
  const [source, setSource] = useState<DownloadSourceReport | null>(null);
  const [error, setError] = useState('');
  const [skip, setSkip] = useState(false);
  const [installing, setInstalling] = useState(false);
  /** 跳转失败的原因。手机上没有浏览器 / 链接被拦时 openURL 会 reject，不能当没点过 */
  const [linkErr, setLinkErr] = useState('');
  /**
   * 缓存里能接着用的那个包（打开面板时问一次）。
   *
   * 有它就把按钮改成「继续下载」并显示已下多少 —— 用户 2026-11-19 报的
   * 「切了 10 秒别的应用，回来要重新下载」，一半原因就在这里没人问过缓存。
   */
  const [resume, setResume] = useState<PendingDownload | null>(null);

  const cancelRef = useRef<(() => void) | null>(null);
  const fileRef = useRef<File | null>(null);
  /**
   * 测速用的上一次采样。
   *
   * 进度回调一秒能来几十次，直接拿相邻两次算会得到剧烈跳动的数字
   * （尤其是 TCP 拥塞窗口刚放开的时候）。所以：
   * - 两次采样至少隔 300ms 才算一次，太密的抖动没有参考价值
   * - 用指数移动平均（新值占 30%），数字才读得下去
   */
  const rateRef = useRef({ at: 0, bytes: 0, ema: 0 });
  /** 通知栏最多一秒刷一次：更密会让通知栏不停闪，而且没有信息增量 */
  const notifyAtRef = useRef(0);
  /** 进度条上次真正 setState 的时刻，节流用 */
  const pushRef = useRef(0);

  const dismiss = useCallback(() => {
    if (skip) onSkipVersion();
    onClose();
  }, [skip, onSkipVersion, onClose]);

  /** 更新说明在 GitHub 上读，App 内不再排一遍正文 */
  const openNotes = useCallback(() => {
    setLinkErr('');
    Linking.openURL(release.htmlUrl).catch(() => setLinkErr('打不开链接'));
  }, [release.htmlUrl]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phase === 'downloading') return true; // 下载中拦下，别让返回把半包丢在这
      dismiss();
      return true;
    });
    return () => sub.remove();
  }, [phase, dismiss]);

  /*
   * 关掉弹窗**不再删残包**（v0.32 改）。
   *
   * 原来这里一卸载就 `clearDownload()`：26 MB 是省下了，代价是用户切一下应用、
   * 或者顺手关掉弹窗，回来就得从头下。残包和旁边那张 sidecar 现在一直留到装完
   * （`install()` 成功后清），下次打开面板还会被 `pendingDownload` 认出来。
   */
  useEffect(() => {
    return () => {
      clearNotify();
    };
  }, []);

  /** 打开面板先问一句：缓存里有没有这一版能接着用的包 */
  useEffect(() => {
    let alive = true;
    pendingDownload(release)
      .then((p) => {
        if (!alive || !p) return;
        setResume(p);
        setProgress({ written: p.written, total: p.total });
        // 上次已经下全，只是没来得及装：别再下一次 26 MB
        if (p.file) {
          fileRef.current = p.file;
          setPhase('ready');
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [release]);

  /** 收到一次进度：更新条，顺便算速度 */
  const onProgress = useCallback(
    (p: DownloadProgress) => {
      const now = Date.now();

      /**
       * 进度必须节流。
       *
       * 原生下载任务的回调非常密（每读一个数据块就回调一次），每次都 setState 会把
       * JS 线程压满 —— 表现就是「下载时界面卡」，进度条一顿一顿，甚至按不动取消。
       * 250ms 一次人眼已经看不出差别，还能把线程留给渲染。
       *
       * 两个点必须立刻生效，不能等节流窗口：
       * - `written === 0`：换源了，进度要马上归零，否则还显示上个源的进度；
       * - 跑满：最后一次回调要是被节流吞掉，进度条就永远停在 99%。
       */
      const done = p.total > 0 && p.written >= p.total;
      if (p.written === 0 || done || now - pushRef.current >= 250) {
        pushRef.current = now;
        setProgress(p);
      }

      // 通知栏：一秒一次。切到后台时进度回调不再触发（原生下载还在跑），
      // 通知停在切走那一刻的数字，回到前台后补发的回调会立刻把它接上
      if (now - notifyAtRef.current > 1000) {
        notifyAtRef.current = now;
        const pct = progressPercent({ written: p.written, total: p.total });
        const size = `${formatBytes(p.written)}${p.total > 0 ? ` / ${formatBytes(p.total)}` : ''}`;
        notifyProgress(release.version, size, pct);
      }

      const r = rateRef.current;
      if (r.at === 0) {
        r.at = now;
        r.bytes = p.written;
        return;
      }
      const dt = now - r.at;
      const db = p.written - r.bytes;
      if (dt < 300 || db < 0) return;

      const inst = (db / dt) * 1000;
      r.ema = r.ema > 0 ? r.ema * 0.7 + inst * 0.3 : inst;
      r.at = now;
      r.bytes = p.written;
      setSpeed(r.ema);
    },
    [release.version],
  );

  async function startDownload() {
    /*
     * 按磁盘上**现在**的大小起进度，不用挂载时那一次的结果：
     * 上一次跑过之后残包可能又长大了，拿旧数字会先退回去再跳上来。
     */
    const known = await pendingDownload(release).catch(() => null);
    if (known) setResume(known);

    // 已经下全了：直接进「立即安装」，别再下一次 26 MB
    if (known?.file) {
      fileRef.current = known.file;
      setPhase('ready');
      return;
    }

    setPhase('downloading');
    setError('');
    setProgress(known ? { written: known.written, total: known.total } : { written: 0, total: release.apkSize });
    setSpeed(0);
    setSource(null);
    rateRef.current = { at: 0, bytes: 0, ema: 0 };
    notifyAtRef.current = 0;
    pushRef.current = 0;

    // 通知失败不影响下载：没授权就静默跳过
    initNotify().then((ok) => {
      if (ok) notifyProgress(release.version, formatBytes(known?.written ?? 0), known ? progressPercent(known) : 0);
    });
    try {
      const file = await downloadApk(
        release,
        onProgress,
        (cancel) => {
          cancelRef.current = cancel;
        },
        (s) => {
          setSource(s);
          // 换源时把速度统计清零，别把上个源的瞬时速度带过来
          rateRef.current = { at: 0, bytes: 0, ema: 0 };
          setSpeed(0);
        },
      );
      fileRef.current = file;
      setPhase('ready');
      notifyReady(release.version);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '下载失败';
      // 主动取消不是错误，退回初始态让用户重新决定
      if (msg === '已取消下载') {
        // 取消不清残包：重新问一次磁盘，按钮上就能写「继续下载（62%）」
        const left = await pendingDownload(release).catch(() => null);
        setResume(left);
        setPhase('prompt');
        setProgress(left ? { written: left.written, total: left.total } : { written: 0, total: release.apkSize });
        setSpeed(0);
        clearNotify();
        return;
      }
      setError(msg);
      setPhase('error');
      clearNotify();
    } finally {
      cancelRef.current = null;
    }
  }

  async function install() {
    const file = fileRef.current;
    if (!file || installing) return;
    setInstalling(true);
    setError('');
    try {
      await installApk(file);
      // 系统安装器已经接管，这里静默收起
      clearNotify();
      clearDownload();
      onClose();
    } catch (e) {
      setError(e instanceof UpdateError ? e.message : '安装失败');
      setPhase('error');
    } finally {
      setInstalling(false);
    }
  }

  const headingRef = useHeadingFocus(`更新-${phase}`);
  const pct = progressPercent(progress) ?? 0;
  const unknownTotal = progress.total <= 0;
  /** 权限问题要额外给一个「去授权」入口，否则用户卡在这不知道怎么办 */
  const needPermission = /未知应用|授权/.test(error);
  const brief = noteBrief(release.notes);

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <Pressable
        style={[styles.backdrop, styles.touchTarget]}
        onPress={phase === 'downloading' ? undefined : dismiss}
      />

      <ScrollView style={styles.card} contentContainerStyle={styles.cardContent} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <View style={styles.iconWrap}>
            <Ionicons name="cloud-download-outline" size={17} color={c.accentText} />
          </View>
          <View style={styles.headText}>
            <Text ref={headingRef} accessible accessibilityRole="header" style={styles.title}>
              {phase === 'prompt'
                ? `发现新版本 ${versionLabel(release.version)}`
                : phase === 'downloading'
                  ? '正在下载'
                  : phase === 'ready'
                    ? '下载完成'
                    : '更新失败'}
            </Text>
            <Text style={styles.sub}>
              {phase === 'prompt'
                ? resume
                  ? resume.file
                    ? `当前 ${versionLabel(APP_VERSION)} · 上次已经下好，直接装就行`
                    : `当前 ${versionLabel(APP_VERSION)} · 已下载 ${formatBytes(resume.written)} / ${formatBytes(resume.total)}`
                  : `当前 ${versionLabel(APP_VERSION)} · 安装包 ${formatBytes(release.apkSize)}`
                : phase === 'downloading'
                  ? [
                    source && source.total > 1
                      ? `${source.label} ${source.index}/${source.total}`
                      : source?.label,
                    `${formatBytes(progress.written)}${unknownTotal ? '' : ` / ${formatBytes(progress.total)}`}`,
                    speed > 0 ? `${formatBytes(speed)}/s` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                  : phase === 'ready'
                    ? `${formatBytes(release.apkSize)} · 点「立即安装」后系统会弹确认页`
                    : '下面是可以处理的具体原因'}
            </Text>
          </View>
        </View>

        {phase === 'prompt' ? (
          <>
            <View style={styles.notesBox}>
              {brief ? <Text style={styles.notesBrief}>{brief}</Text> : null}
              {/* 有残包就说清「接着下」这件事，别让人以为又要从头等一遍 */}
              {resume && !resume.file ? (
                <Text style={styles.resumeHint}>
                  已下的部分留着：切到别的应用、或者关掉这个弹窗再打开，都从这里接着下。
                </Text>
              ) : null}
              <Pressable style={[styles.linkBtn, styles.touchTarget]} onPress={openNotes}>
                <Ionicons name="open-outline" size={13} color={c.accentText} />
                <Text style={styles.linkText}>查看更新说明</Text>
              </Pressable>
              {linkErr ? <Text style={styles.linkErr}>{linkErr}</Text> : null}
            </View>

            <Pressable style={[styles.skipRow, styles.touchTarget]} onPress={() => setSkip((v) => !v)} accessibilityRole="checkbox" accessibilityLabel="不再提示这个版本" accessibilityState={{ checked: skip }}>
              <View style={[styles.checkBox, skip && styles.checkBoxOn]}>
                {skip ? <Ionicons name="checkmark" size={11} color={c.onAccent} /> : null}
              </View>
              <Text style={styles.skipText}>不再提示 {versionLabel(release.version)}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'downloading' ? (
          <View style={styles.progressBox} accessibilityRole="progressbar" accessibilityLabel="更新下载进度" accessibilityValue={unknownTotal ? { text: `已下载 ${formatBytes(progress.written)}` } : { min: 0, max: 100, now: pct }}>
            <View style={styles.bar}>
              <View
                style={[
                  styles.barFill,
                  // 拿不到总大小就画一条不满的条，配合下面「已下载 x MB」说明进行中
                  { width: unknownTotal ? '35%' : `${Math.max(pct, 2)}%` },
                ]}
              />
            </View>
            <Text style={styles.progressText}>
              {unknownTotal ? '服务器没给总大小，按已下载量显示' : `${pct}%`}
            </Text>
          </View>
        ) : null}

        {phase === 'error' ? (
          <View style={styles.errBox}>
            <Ionicons name="alert-circle-outline" size={15} color={c.danger} />
            <Text style={styles.errText} accessibilityLiveRegion="polite">{error}</Text>
          </View>
        ) : null}

        <View style={styles.footer}>
          {phase === 'prompt' ? (
            <>
              <Pressable style={[styles.ghostBtn, styles.touchTarget]} onPress={dismiss}>
                <Text style={styles.ghostText}>以后再说</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryBtn, styles.touchTarget]}
                onPress={resume?.file ? install : startDownload}
                disabled={installing}
              >
                <Text style={styles.primaryText}>
                  {resume?.file
                    ? '立即安装'
                    : resume
                      ? `继续下载（${progressPercent(resume) ?? 0}%）`
                      : '下载更新'}
                </Text>
              </Pressable>
            </>
          ) : phase === 'downloading' ? (
            <Pressable style={[styles.ghostBtn, styles.touchTarget]} onPress={() => cancelRef.current?.()}>
              <Text style={styles.ghostText}>取消下载</Text>
            </Pressable>
          ) : phase === 'ready' ? (
            <>
              <Pressable style={[styles.ghostBtn, styles.touchTarget]} onPress={() => setPhase('prompt')}>
                <Text style={styles.ghostText}>返回</Text>
              </Pressable>
              <Pressable
                style={[[styles.primaryBtn, installing && styles.btnDisabled], styles.touchTarget]}
                onPress={install}
                disabled={installing}
              >
                {installing ? (
                  <ActivityIndicator size="small" color={c.onAccent} />
                ) : (
                  <Text style={styles.primaryText}>立即安装</Text>
                )}
              </Pressable>
            </>
          ) : (
            <>
              <Pressable style={[styles.ghostBtn, styles.touchTarget]} onPress={dismiss}>
                <Text style={styles.ghostText}>关闭</Text>
              </Pressable>
              {needPermission ? (
                <Pressable
                  style={[styles.primaryBtn, styles.touchTarget]}
                  onPress={() => {
                    openInstallPermissionSettings().catch(() => undefined);
                  }}
                >
                  <Text style={styles.primaryText}>去授权</Text>
                </Pressable>
              ) : (
                <Pressable style={[styles.primaryBtn, styles.touchTarget]} onPress={startDownload}>
                  <Text style={styles.primaryText}>{progress.written > 0 ? '继续下载' : '重试'}</Text>
                </Pressable>
              )}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * 全部走共享 token。
 *
 * 这份文件原来每个字号都是就地写的，其中 `15.5` 和 `12.5` 是半个像素的字号 ——
 * 安卓上会被取整，行高跟着错位；边框则一律用 `metrics.strokeWidth`，
 * 比页面别处（surfaceStroke）粗一倍。
 */
const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  touchTarget: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACE.lg, paddingVertical: SPACE.md,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: c.scrim,
  },
  cardContent: { padding: SPACE.lg },
  /** 弹层：白卡 + 大圆角，底下是 scrim，边界已经很清楚，不描边 */
  card: { flexGrow: 0, maxHeight: '100%',
    width: '100%',
    maxWidth: 420,
    backgroundColor: c.card,
    borderRadius: metrics.cardRadius,
  },

  head: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.xs },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.accentBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headText: { flex: 1, minWidth: 0 },
  title: { ...TYPE.body, fontWeight: '600', color: c.text },
  sub: { ...TYPE.meta, color: c.text3, marginTop: SPACE.xxs },

  notesBox: { marginTop: SPACE.sm, alignItems: 'flex-start' },
  notesBrief: { ...TYPE.meta, color: c.text2 },
  /** 续传那句话说清「不会再等一遍」，不抢摘要的位置，比它淡一档 */
  resumeHint: { ...TYPE.meta, color: c.text3, marginTop: SPACE.xxs },
  /** 链接/次要动作：浅灰底、无边框 */
  linkBtn: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.xxs,
    marginTop: 2,
    paddingHorizontal: SPACE.sm,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.hairSoft,
  },
  linkText: { ...TYPE.meta, color: c.accentText },
  linkErr: { ...TYPE.meta, color: c.danger, marginTop: SPACE.xxs },

  skipRow: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginTop: SPACE.sm },
  /** 复选框：4 的圆角才读成「方框」，原来 16×16 配 8 的圆角是圆形 */
  checkBox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: metrics.strokeWidth,
    borderColor: c.text3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxOn: { backgroundColor: c.accent, borderColor: c.accent },
  skipText: { ...TYPE.meta, color: c.text2 },

  progressBox: { marginTop: SPACE.md },
  bar: {
    height: 8,
    borderRadius: 4,
    backgroundColor: c.hairSoft,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 4, backgroundColor: c.accent },
  progressText: {
    ...TYPE.meta,
    color: c.text3,
    marginTop: SPACE.xs,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },

  errBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACE.xs,
    marginTop: SPACE.sm,
    padding: SPACE.xs,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.dangerBg,
  },
  errText: { flex: 1, ...TYPE.meta, color: c.danger },

  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE.xs, marginTop: SPACE.md },
  primaryBtn: { minHeight: metrics.controlHeight,
    backgroundColor: c.accent,
    borderRadius: metrics.buttonRadius,
    paddingHorizontal: SPACE.lg,
    minWidth: 104,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { ...TYPE.label, color: c.onAccent },
  ghostBtn: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    borderRadius: metrics.buttonRadius,
    paddingHorizontal: SPACE.md,
    backgroundColor: c.hairSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostText: { ...TYPE.label, fontWeight: '400', color: c.text2 },
  btnDisabled: { opacity: 0.5 },
});
