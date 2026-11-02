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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Linking,
  Pressable,
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
  type DownloadProgress,
  type DownloadSourceReport,
} from '../update/download';
import { clearNotify, initNotify, notifyProgress, notifyReady } from '../update/notify';
import { APP_VERSION } from '../version';
import { R, useThemedStyles, type Palette } from '../theme';
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

  // 组件卸载（用户关掉弹窗）时把残包清掉，免得 22 MB 一直躺在缓存里
  useEffect(() => {
    return () => {
      if (phase !== 'ready') {
        clearDownload();
        clearNotify();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      // 通知栏：一秒一次。后台时 JS 挂起，这个更新自然就停了 ——
      // 通知会停在切走那一刻的数字，回到应用后立刻接上
      if (now - notifyAtRef.current > 1000) {
        notifyAtRef.current = now;
        const pct = p.total > 0 ? Math.round((p.written / p.total) * 100) : null;
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
    setPhase('downloading');
    setError('');
    setProgress({ written: 0, total: release.apkSize });
    setSpeed(0);
    setSource(null);
    rateRef.current = { at: 0, bytes: 0, ema: 0 };
    notifyAtRef.current = 0;
    pushRef.current = 0;

    // 通知失败不影响下载：没授权就静默跳过
    initNotify().then((ok) => {
      if (ok) notifyProgress(release.version, formatBytes(0), 0);
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
        setPhase('prompt');
        setProgress({ written: 0, total: release.apkSize });
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

  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.written / progress.total) * 100)) : 0;
  const unknownTotal = progress.total <= 0;
  /** 权限问题要额外给一个「去授权」入口，否则用户卡在这不知道怎么办 */
  const needPermission = /未知应用|授权/.test(error);
  const brief = noteBrief(release.notes);

  return (
    <View style={styles.overlay}>
      <Pressable
        style={styles.backdrop}
        onPress={phase === 'downloading' ? undefined : dismiss}
      />

      <View style={styles.card}>
        <View style={styles.head}>
          <View style={styles.iconWrap}>
            <Ionicons name="cloud-download-outline" size={17} color={c.accentText} />
          </View>
          <View style={styles.headText}>
            <Text style={styles.title}>
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
                ? `当前 ${versionLabel(APP_VERSION)} · 安装包 ${formatBytes(release.apkSize)}`
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
              <Pressable style={styles.linkBtn} onPress={openNotes} hitSlop={4}>
                <Ionicons name="open-outline" size={13} color={c.accentText} />
                <Text style={styles.linkText}>查看更新说明</Text>
              </Pressable>
              {linkErr ? <Text style={styles.linkErr}>{linkErr}</Text> : null}
            </View>

            <Pressable style={styles.skipRow} onPress={() => setSkip((v) => !v)}>
              <View style={[styles.checkBox, skip && styles.checkBoxOn]}>
                {skip ? <Ionicons name="checkmark" size={11} color={c.onAccent} /> : null}
              </View>
              <Text style={styles.skipText}>不再提示 {versionLabel(release.version)}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'downloading' ? (
          <View style={styles.progressBox}>
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
            <Text style={styles.errText}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.footer}>
          {phase === 'prompt' ? (
            <>
              <Pressable style={styles.ghostBtn} onPress={dismiss}>
                <Text style={styles.ghostText}>以后再说</Text>
              </Pressable>
              <Pressable style={styles.primaryBtn} onPress={startDownload}>
                <Text style={styles.primaryText}>下载更新</Text>
              </Pressable>
            </>
          ) : phase === 'downloading' ? (
            <Pressable style={styles.ghostBtn} onPress={() => cancelRef.current?.()}>
              <Text style={styles.ghostText}>取消下载</Text>
            </Pressable>
          ) : phase === 'ready' ? (
            <>
              <Pressable style={styles.ghostBtn} onPress={() => setPhase('prompt')}>
                <Text style={styles.ghostText}>返回</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryBtn, installing && styles.btnDisabled]}
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
              <Pressable style={styles.ghostBtn} onPress={dismiss}>
                <Text style={styles.ghostText}>关闭</Text>
              </Pressable>
              {needPermission ? (
                <Pressable
                  style={styles.primaryBtn}
                  onPress={() => {
                    openInstallPermissionSettings().catch(() => undefined);
                  }}
                >
                  <Text style={styles.primaryText}>去授权</Text>
                </Pressable>
              ) : (
                <Pressable style={styles.primaryBtn} onPress={startDownload}>
                  <Text style={styles.primaryText}>重试</Text>
                </Pressable>
              )}
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: c.scrim,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: c.card,
    borderRadius: R.card + 4,
    borderWidth: 0.5,
    borderColor: c.hair,
    padding: 18,
  },

  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: c.accentBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headText: { flex: 1 },
  title: { fontSize: 15.5, color: c.text, fontWeight: '600' },
  sub: { fontSize: 11.5, color: c.text3, marginTop: 4, lineHeight: 17 },

  notesBox: { marginTop: 14, alignItems: 'flex-start' },
  notesBrief: { fontSize: 12, color: c.text2, lineHeight: 19 },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 2,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: c.hair,
  },
  linkText: { fontSize: 12.5, color: c.accentText },
  linkErr: { fontSize: 11.5, color: c.danger, marginTop: 6 },

  skipRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  checkBox: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.text3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxOn: { backgroundColor: c.accent, borderColor: c.accent },
  skipText: { fontSize: 12, color: c.text2 },

  progressBox: { marginTop: 16 },
  bar: {
    height: 8,
    borderRadius: 4,
    backgroundColor: c.hairSoft,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 4, backgroundColor: c.accent },
  progressText: {
    fontSize: 11.5,
    color: c.text3,
    marginTop: 8,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },

  errBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 14,
    padding: 11,
    borderRadius: R.btn,
    backgroundColor: c.hairSoft,
  },
  errText: { flex: 1, fontSize: 12, color: c.danger, lineHeight: 18 },

  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 18 },
  primaryBtn: {
    backgroundColor: c.accent,
    borderRadius: R.btn,
    paddingHorizontal: 20,
    paddingVertical: 11,
    minWidth: 104,
    alignItems: 'center',
  },
  primaryText: { fontSize: 14, color: c.onAccent, fontWeight: '500' },
  ghostBtn: {
    borderRadius: R.btn,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderWidth: 0.5,
    borderColor: c.hair,
    backgroundColor: c.card,
  },
  ghostText: { fontSize: 14, color: c.text2 },
  btnDisabled: { opacity: 0.5 },
});
