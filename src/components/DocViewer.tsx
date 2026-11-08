/**
 * 文档阅读器。
 *
 * 是覆盖层（`position:absolute`），不是 `Modal` —— 后者带 `FLAG_LAYOUT_NO_LIMITS`，
 * 会画到状态栏下，而且收不到键盘事件。返回键自己接。
 *
 * **只存 id，不存文档快照。** 内容会被任务服务改：订阅任务状态 + 上层给 `reloadKey`，
 * 这里重新查库。存对象的话，准备完了界面上还停在「正在准备」（v0.4.2 栽过）。
 *
 * v0.12 起这里不再自己跑流水线：
 * - 本地准备 / 云解析都只是「向任务服务下单」，进度靠订阅；
 * - 离开阅读器任务照跑，再进来还能看到进度；
 * - 删除先取消任务，再删原件和记录 —— 原件删不掉要说出来，能重试。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Document, DocumentMeta } from '../types';
import { R, useThemedStyles, type Palette } from '../theme';
import { repo } from '../db/repo';
import { deleteOriginal, openOriginal } from '../db/docFiles';
import { dropViewCache } from '../documents/readers/viewCache';
import {
  MAX_FILE_LABEL,
  PRO_MAX_FILE_LABEL,
  PRO_MAX_PAGES,
  getMineruToken,
} from '../ai/mineru';
import { planForDoc, localReaderLimitNote, sizeText } from '../util/docSupport';
import { isDocumentReady, notReadyReason, supportsLocalDocument } from '../documents/formats';
import {
  cancelDocumentJob,
  dismissDocumentJob,
  isJobRunning,
  jobPhaseText,
  prepareDocumentCloud,
  prepareDocumentLocal,
  useDocumentJob,
} from '../documents/jobs';
import { DocumentReader } from '../documents/readers';
import { IconButton } from './IconButton';

interface Props {
  docId: number;
  /** 上层每次写完库 +1，这里据此重新取一次 */
  reloadKey: number;
  onClose: () => void;
  /** 任务结束 / 删除之后让上层刷新列表 */
  onChanged: () => void;
  /** 单篇直接问。范围转换（id → QaScope）不在这里做 */
  onAsk: (documentIds: number[]) => void;
}

type Busy = 'idle' | 'opening' | 'deleting';

/** 头部第二行与空状态共用的一句话，避免两处各写一套判断 */
function statusLine(doc: Document, jobText: string): string {
  if (jobText) return jobText;
  if (isDocumentReady(doc)) return `可问 · ${doc.charCount} 字`;
  return notReadyReason(doc);
}

export function DocViewer({ docId, reloadKey, onClose, onChanged, onAsk }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [doc, setDoc] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Busy>('idle');
  const [armedDelete, setArmedDelete] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /** 云解析确认卡。**必须先弹卡再上传**，重试也一样 */
  const [cloudAsk, setCloudAsk] = useState(false);
  const [token, setToken] = useState('');
  const alive = useRef(true);

  const job = useDocumentJob(docId);
  const running = isJobRunning(job);
  const jobKey = job ? `${job.runId}:${job.phase}` : '';

  const load = useCallback(async () => {
    const next = await repo.findDocument(docId);
    if (!alive.current) return;
    setDoc(next);
    setLoading(false);
  }, [docId]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // reloadKey 变化 = 上层刚写过库（导入完成 / 删除），重新取一次
  useEffect(() => {
    load().catch(() => {
      if (alive.current) setLoading(false);
    });
  }, [load, reloadKey]);

  useEffect(() => {
    getMineruToken()
      .then((t) => {
        if (alive.current) setToken(t);
      })
      .catch(() => undefined);
  }, []);

  /*
   * 任务结束时重新取库：任务服务只写库，不会把新正文推给组件。
   * 依赖只放 jobKey —— load / onChanged 是每次渲染新建的函数，放进依赖会让
   * 「load → setDoc → 重渲染 → 依赖变了 → 再 load」转成死循环。
   */
  const loadRef = useRef(load);
  loadRef.current = load;
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  useEffect(() => {
    if (!job || isJobRunning(job)) return;
    loadRef.current().catch(() => undefined);
    changedRef.current();
  }, [jobKey]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (cloudAsk) {
        setCloudAsk(false);
        return true;
      }
      // 已经点过一次删除时，返回键先撤掉那一步，别把整页关掉
      if (armedDelete) {
        setArmedDelete(false);
        return true;
      }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [armedDelete, cloudAsk, onClose]);

  async function open() {
    if (!doc || busy !== 'idle') return;
    if (!doc.fileUri) {
      setMsg({ kind: 'err', text: '原文件已不在手机上，只能看已解析的正文' });
      return;
    }
    setArmedDelete(false);
    setMsg(null);
    setBusy('opening');
    try {
      await openOriginal(doc.fileUri, doc.ext);
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : '打不开原文件' });
    } finally {
      if (alive.current) setBusy('idle');
    }
  }

  function startLocal() {
    if (!doc || running) return;
    setArmedDelete(false);
    setMsg(null);
    void prepareDocumentLocal(doc.id);
  }

  function startCloud(channel: 'lite' | 'pro') {
    if (!doc || running) return;
    setCloudAsk(false);
    setArmedDelete(false);
    setMsg(null);
    void prepareDocumentCloud(doc.id, { channel });
  }

  function stop() {
    if (!doc) return;
    cancelDocumentJob(doc.id);
  }

  async function remove() {
    if (!doc || busy !== 'idle') return;
    if (!armedDelete) {
      setArmedDelete(true);
      return;
    }

    setBusy('deleting');
    setMsg(null);
    // 先停任务：迟到的解析结果不能写回一条正在被删的记录，也不能再传下一段
    cancelDocumentJob(doc.id);

    // 先删原件，再删记录：反过来一旦文件删不掉，记录已经没了，URI 也就丢了
    const cleaned = await deleteOriginal(doc.fileUri);
    if (cleaned) {
      // 原件没了，派生出来的解析缓存也没有意义了 —— 几 MB 的 JSON 不能留下
      await dropViewCache(doc.fileUri);
    }
    if (!cleaned) {
      if (alive.current) {
        setMsg({
          kind: 'err',
          text: '原文件没删掉（可能被别的应用占用），记录先留着，可以再删一次',
        });
        setBusy('idle');
      }
      return;
    }

    try {
      await repo.deleteDocument(doc.id);
      dismissDocumentJob(doc.id);
      onChanged();
      onClose();
    } catch (e) {
      if (alive.current) {
        setMsg({
          kind: 'err',
          text: `记录没删掉：${e instanceof Error ? e.message : '未知原因'}。原文件已经删了`,
        });
        setBusy('idle');
      }
    }
  }

  if (loading) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color={c.text3} />
      </View>
    );
  }

  if (!doc) {
    return (
      <View style={styles.root}>
        <View style={styles.topBar}>
          <IconButton name="close" size={22} color={c.text2} onPress={onClose} accessibilityLabel="关闭" />
          <View style={styles.topCenter}>
            <Text style={styles.topTitle}>文档</Text>
          </View>
          <View style={styles.topSide} />
        </View>
        <View style={styles.stateBox}>
          <Text style={styles.stateTitle}>这条记录已经不在了</Text>
          <Text style={styles.stateHint}>可能刚在列表里删掉了。</Text>
        </View>
      </View>
    );
  }

  const ready = isDocumentReady(doc);
  const canLocal = supportsLocalDocument(doc.ext);
  const limitNote = localReaderLimitNote(doc);
  const jobText = job ? jobPhaseText(job) : '';
  const hasBody = !!doc.bodyMd.trim();
  const plan = planForDoc(doc.ext, doc.size, !!token);

  return (
    <View style={styles.root}>
      <View style={styles.topBar}>
        <IconButton name="close" size={22} color={c.text2} onPress={onClose} accessibilityLabel="关闭" />
        <View style={styles.topCenter}>
          <Text style={styles.topTitle} numberOfLines={1}>
            {doc.name}
          </Text>
          <Text style={styles.topSub} numberOfLines={1}>
            {statusLine(doc, jobText)}
          </Text>
        </View>
        <View style={styles.topSide} />
      </View>

      {/*
        就绪文档交给真正的阅读器：PDF 有文本层与跨页查找、表格能切工作表、
        文本有行号定位。**不能把它塞进 ScrollView** —— 阅读器内部是 FlatList /
        WebView，外面再套一层滚动容器会同时毁掉虚拟化，并且手势互相抢。

        占位期用的 NoteBody 只按 Markdown 读，表格会裁列、PDF 只有转出来的文字，
        查找也只在已渲染的块里，用户「看到的不等于原件」。
      */}
      {ready && hasBody ? (
        <View style={styles.readerWrap}>
          {doc.error ? (
            <Text style={[styles.warnLine, styles.warnBanner]}>{doc.error}</Text>
          ) : null}
          <DocumentReader document={doc} embedded />
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
        {running ? (
          <View style={styles.stateBox}>
            <ActivityIndicator color={c.accent} />
            <Text style={styles.stateTitle}>{jobText || '正在准备'}</Text>
            <Text style={styles.stateHint}>
              可以离开这一页，任务会在后台继续，完成后列表会更新。取消不会撤回已经上传的字节。
            </Text>
            <Pressable
              style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.7 }]}
              onPress={stop}
            >
              <Text style={styles.secondaryText}>取消准备</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.stateBox}>
            {doc.state === 'failed' ? (
              <View style={styles.failIcon}>
                <Ionicons name="alert-circle-outline" size={24} color={c.danger} />
              </View>
            ) : (
              <Ionicons name="document-text-outline" size={26} color={c.text3} />
            )}
            <Text style={styles.stateTitle}>
              {doc.state === 'failed' ? '这次没准备成' : '还没有可读正文'}
            </Text>
            {doc.state === 'failed' && doc.error ? (
              <Text style={styles.failText}>{doc.error}</Text>
            ) : null}
            <Text style={styles.stateHint}>
              {limitNote
                ? limitNote
                : canLocal
                  ? '「本地准备」只在这台手机上提取，不会上传。原件一直保留，随时能用外部应用打开。'
                  : '这种格式本机读不了，需要你确认后上传到 mineru.net 解析；也可以直接用外部应用打开。'}
            </Text>
            {doc.state !== 'failed' && doc.error ? (
              <Text style={styles.failText}>{doc.error}</Text>
            ) : null}
          </View>
        )}
        </ScrollView>
      )}

      <View style={styles.footer}>
        {msg ? (
          <Text style={[styles.msg, msg.kind === 'err' ? styles.msgErr : styles.msgOk]}>
            {msg.text}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <Pressable
            style={({ pressed }) => [styles.actionBtn, styles.primaryBtn, !ready && styles.btnDisabled, pressed && { opacity: 0.85 }]}
            onPress={() => onAsk([doc.id])}
            disabled={!ready}
            accessibilityRole="button"
            accessibilityLabel={ready ? '问这份文档' : '这篇还不能问'}
          >
            <Ionicons name="chatbubble-ellipses-outline" size={16} color={ready ? c.onAccent : c.text3} />
            <Text style={[styles.actionText, styles.primaryText, !ready && styles.textDisabled]}>问这份</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.actionBtn, pressed && { backgroundColor: c.hairSoft }]}
            onPress={open}
            disabled={busy !== 'idle'}
          >
            {busy === 'opening' ? (
              <ActivityIndicator size="small" color={c.text2} />
            ) : (
              <>
                <Ionicons name="open-outline" size={16} color={c.text} />
                <Text style={styles.actionText}>打开原文件</Text>
              </>
            )}
          </Pressable>
        </View>

        <View style={styles.actions}>
          {running ? (
            // 正在跑的文档也能从这里停：就绪文档显示的是旧正文，进度条不在正文区，
            // 只在进度页放「取消」的话，这种情况就没地方取消
            <Pressable
              style={({ pressed }) => [styles.actionBtn, pressed && { backgroundColor: c.hairSoft }]}
              onPress={stop}
            >
              <Ionicons name="close-outline" size={16} color={c.text} />
              <Text style={styles.actionText}>取消准备</Text>
            </Pressable>
          ) : (
            <Pressable
              style={({ pressed }) => [styles.actionBtn, pressed && { backgroundColor: c.hairSoft }]}
              onPress={startLocal}
              disabled={busy !== 'idle' || !canLocal || !!limitNote}
            >
              <Ionicons
                name="phone-portrait-outline"
                size={16}
                color={!canLocal || limitNote ? c.text3 : c.text}
              />
              <Text style={[styles.actionText, (!canLocal || !!limitNote) && styles.textDisabled]}>
                {ready ? '重新准备' : '本地准备'}
              </Text>
            </Pressable>
          )}

          <Pressable
            style={({ pressed }) => [styles.actionBtn, pressed && { backgroundColor: c.hairSoft }]}
            onPress={() => setCloudAsk(true)}
            disabled={busy !== 'idle' || running}
          >
            <Ionicons name="cloud-outline" size={16} color={running ? c.text3 : c.text} />
            <Text style={[styles.actionText, running && styles.textDisabled]}>云解析</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              styles.actionBtn,
              styles.dangerBtn,
              armedDelete && styles.dangerBtnArmed,
              pressed && { opacity: 0.75 },
            ]}
            onPress={remove}
            disabled={busy !== 'idle'}
          >
            {busy === 'deleting' ? (
              <ActivityIndicator size="small" color={armedDelete ? c.onAccent : c.danger} />
            ) : (
              <>
                <Ionicons
                  name="trash-outline"
                  size={16}
                  color={armedDelete ? c.onAccent : c.danger}
                />
                <Text style={[styles.actionText, styles.dangerText, armedDelete && styles.dangerTextArmed]}>
                  {armedDelete ? '再点确认' : '删除'}
                </Text>
              </>
            )}
          </Pressable>
        </View>
      </View>

      {cloudAsk ? (
        <CloudConfirmSheet
          doc={doc}
          defaultChannel={plan.channel === 'pro' ? 'pro' : 'lite'}
          hasToken={!!token.trim()}
          onCancel={() => setCloudAsk(false)}
          onConfirm={startCloud}
        />
      ) : null}
    </View>
  );
}

/**
 * 云解析确认卡。**上传必须经过这一张卡，重试也一样**。
 *
 * 这一层不是形式主义：点下去文件就会离开手机。用户有权在**发出去之前**
 * 看清「发给谁、走哪条通道、各自的上限」，而不是事后从隐私政策里找答案。
 *
 * 放在这个文件里而不是 DocsScreen：阅读器和列表都要用，反向引用会成环。
 */
export function CloudConfirmSheet({
  doc,
  defaultChannel,
  hasToken,
  onCancel,
  onConfirm,
}: {
  doc: DocumentMeta;
  /** 只是建议高亮，用户可以改 */
  defaultChannel: 'lite' | 'pro';
  hasToken: boolean;
  onCancel: () => void;
  onConfirm: (channel: 'lite' | 'pro') => void;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  /*
   * 轻量通道能不能走，由 `planForDoc` 判（格式 + 大小），不在这里重复写后缀表：
   * `.doc` / 超大文件在轻量接口上本来就会被拒，让用户点下去再失败是最差的做法。
   * 传 `false` 是故意的 —— 这里问的是「不填 Token 时它会给你哪条通道」。
   */
  const liteOk = planForDoc(doc.ext, doc.size, false).channel === 'lite';
  const [channel, setChannel] = useState<'lite' | 'pro'>(liteOk ? defaultChannel : 'pro');

  /*
   * 返回键先关这张卡，不要顺手把阅读器也关掉。
   * 用 ref 拿最新的 onCancel：直接进依赖数组的话，上层每次渲染都会新注册一遍
   * BackHandler（无害但白白抖动），写成 ref 就只注册一次。
   */
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      cancelRef.current();
      return true;
    });
    return () => sub.remove();
  }, []);

  const liteOff = !liteOk;
  const proBlocked = !hasToken;

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <View style={styles.sheetIcon}>
            <Ionicons name="cloud-upload-outline" size={17} color={c.accentText} />
          </View>
          <Text style={styles.sheetTitle}>上传到 mineru.net 解析？</Text>
        </View>

        <Text style={styles.fileName} numberOfLines={2}>
          {doc.name}
        </Text>
        <Text style={styles.fileMeta}>
          {sizeText(doc.size)} · {doc.ext ? doc.ext.toUpperCase() : '未知格式'}
        </Text>

        <View style={[styles.privacy, styles.privacyWarn]}>
          <Ionicons name="cloud-outline" size={14} color={c.amberText} />
          <Text style={[styles.privacyText, { color: c.amberText }]}>
            这篇文档会发送到 mineru.net（第三方服务）。原文件仍然保留在手机上。开始之后可以取消，
            但已经上传的字节撤不回来。
          </Text>
        </View>

        <Text style={styles.sheetHint}>选一条通道：</Text>

        <Pressable
          style={({ pressed }) => [
            styles.option,
            channel === 'lite' && styles.optionOn,
            liteOff && styles.optionOff,
            pressed && { opacity: 0.8 },
          ]}
          onPress={() => setChannel('lite')}
          disabled={liteOff}
          accessibilityRole="radio"
          accessibilityState={{ selected: channel === 'lite', disabled: liteOff }}
        >
          <Ionicons
            name={channel === 'lite' ? 'radio-button-on' : 'radio-button-off'}
            size={17}
            color={liteOff ? c.text3 : channel === 'lite' ? c.accent : c.text3}
          />
          <View style={styles.optionBody}>
            <Text style={[styles.optionTitle, liteOff && styles.textDisabled]}>轻量接口（免 Token）</Text>
            <Text style={styles.optionHint}>
              {liteOff
                ? `这个格式或大小轻量接口放不下（≤ ${MAX_FILE_LABEL} / 20 页）`
                : `≤ ${MAX_FILE_LABEL}、20 页，免费`}
            </Text>
          </View>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.option,
            channel === 'pro' && styles.optionOn,
            proBlocked && styles.optionOff,
            pressed && { opacity: 0.8 },
          ]}
          onPress={() => setChannel('pro')}
          disabled={proBlocked}
          accessibilityRole="radio"
          accessibilityState={{ selected: channel === 'pro', disabled: proBlocked }}
        >
          <Ionicons
            name={channel === 'pro' ? 'radio-button-on' : 'radio-button-off'}
            size={17}
            color={proBlocked ? c.text3 : channel === 'pro' ? c.accent : c.text3}
          />
          <View style={styles.optionBody}>
            <Text style={[styles.optionTitle, proBlocked && styles.textDisabled]}>精准接口（需要 Token）</Text>
            <Text style={styles.optionHint}>
              {proBlocked
                ? '还没填 MinerU Token，去设置里填了才能用'
                : `≤ ${PRO_MAX_FILE_LABEL}、${PRO_MAX_PAGES} 页，消耗每天 1000 页额度`}
            </Text>
          </View>
        </Pressable>

        <View style={styles.sheetActions}>
          <Pressable
            style={({ pressed }) => [styles.cancelBtn, pressed && { backgroundColor: c.hairSoft }]}
            onPress={onCancel}
          >
            <Text style={styles.cancelText}>取消</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.startBtn, pressed && { opacity: 0.85 }]}
            onPress={() => onConfirm(channel)}
            disabled={channel === 'lite' ? liteOff : proBlocked}
          >
            <Text style={styles.startText}>开始解析</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: c.page,
  },
  center: { alignItems: 'center', justifyContent: 'center' },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  topCenter: { flex: 1, alignItems: 'center', paddingHorizontal: 6 },
  topTitle: { fontSize: 13.5, color: c.text, fontWeight: '600', maxWidth: '100%' },
  topSub: { fontSize: 11, color: c.text3, marginTop: 2 },
  /** 和左侧 36px 的关闭钮等宽，标题才会真正居中 */
  topSide: { width: 36 },

  scroll: { flex: 1 },
  content: { paddingHorizontal: 22, paddingTop: 22, paddingBottom: 40 },
  body: { fontSize: 17, lineHeight: 30, color: c.text, letterSpacing: 0.2 },
  /** 阅读器要占满剩余高度，否则 PDF / 表格会塌成一条 */
  readerWrap: { flex: 1 },
  /** footer 与阅读器之间的告警条：自己带左右留白，正文区的 padding 管不到这里 */
  warnBanner: { marginHorizontal: 22, marginTop: 14 },
  warnLine: {
    marginBottom: 12,
    fontSize: 12,
    lineHeight: 18,
    color: c.amberText,
    backgroundColor: c.amberBg,
    borderRadius: R.btn,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },

  stateBox: { alignItems: 'center', paddingTop: 46, paddingHorizontal: 8, gap: 8 },
  failIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: c.dangerBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stateTitle: { fontSize: 15, color: c.text, fontWeight: '600', marginTop: 4 },
  stateHint: {
    fontSize: 12.5,
    lineHeight: 19,
    color: c.text3,
    textAlign: 'center',
    maxWidth: 300,
  },
  failText: { fontSize: 13, lineHeight: 20, color: c.danger, textAlign: 'center', maxWidth: 300 },
  secondaryBtn: {
    marginTop: 10,
    minWidth: 120,
    height: 40,
    paddingHorizontal: 16,
    borderRadius: R.btn,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hair,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { fontSize: 13, color: c.text2 },

  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
    backgroundColor: c.page,
    gap: 8,
  },
  actions: { flexDirection: 'row', gap: 10 },
  actionBtn: {
    flex: 1,
    height: 42,
    borderRadius: R.btn,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hair,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  primaryBtn: { backgroundColor: c.accent, borderColor: c.accent, flex: 1.2 },
  primaryText: { color: c.onAccent, fontWeight: '600' },
  btnDisabled: { backgroundColor: c.hairSoft, borderColor: c.hair },
  textDisabled: { color: c.text3 },
  actionText: { fontSize: 13, color: c.text },
  dangerBtn: { backgroundColor: c.dangerBg, borderColor: c.dangerBg },
  dangerBtnArmed: { backgroundColor: c.danger, borderColor: c.danger },
  dangerText: { color: c.danger },
  dangerTextArmed: { color: c.onAccent },

  msg: { fontSize: 12, lineHeight: 18, textAlign: 'center' },
  msgOk: { color: c.tealText },
  msgErr: { color: c.danger },

  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: c.scrim,
  },
  sheet: { backgroundColor: c.card, borderRadius: R.card + 4, padding: 18 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sheetIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: c.accentBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetTitle: { fontSize: 16, fontWeight: '600', color: c.text, flex: 1 },
  fileName: { marginTop: 12, fontSize: 13, lineHeight: 19, color: c.text, fontWeight: '500' },
  fileMeta: { marginTop: 3, fontSize: 11.5, color: c.text3 },
  privacy: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 14,
    borderRadius: R.btn,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  privacyWarn: { backgroundColor: c.amberBg },
  privacyText: { flex: 1, fontSize: 12, lineHeight: 18 },
  sheetHint: { marginTop: 12, fontSize: 12, lineHeight: 18, color: c.text3 },

  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 8,
    borderRadius: R.btn,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hair,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  optionOn: { borderColor: c.accent, backgroundColor: c.accentBg },
  optionOff: { opacity: 0.6 },
  optionBody: { flex: 1, minWidth: 0 },
  optionTitle: { fontSize: 13, color: c.text, fontWeight: '500' },
  optionHint: { marginTop: 2, fontSize: 11.5, lineHeight: 17, color: c.text3 },

  sheetActions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  cancelBtn: {
    flex: 1,
    height: 42,
    borderRadius: R.btn,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hair,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: { fontSize: 14, color: c.text2 },
  startBtn: {
    flex: 1.4,
    height: 42,
    borderRadius: R.btn,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startText: { fontSize: 14, fontWeight: '600', color: c.onAccent },
});
