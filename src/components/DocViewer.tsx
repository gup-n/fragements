/**
 * 文档阅读覆盖层。只持有id并刷新当前记录；准备任务属于documents/jobs。
 * 阅读、准备、问答索引相互独立。打开页面不提取、不上传；云解析每次重新确认。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Keyboard, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Document, DocumentMeta } from '../types';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { BusyIndicator as ActivityIndicator } from './BusyIndicator';
import { ScreenHeader } from './ScreenHeader';
import type { IoniconName } from './IconButton';
import { useKeyboardHeight } from '../util/keyboard';
import { repo } from '../db/repo';
import { deleteOriginal, openOriginal } from '../db/docFiles';
import { dropViewCache } from '../documents/readers/viewCache';
import { MAX_FILE_LABEL, PRO_MAX_FILE_LABEL, PRO_MAX_PAGES, getMineruToken } from '../ai/mineru';
import { planForDoc, localReaderLimitNote, sizeText } from '../util/docSupport';
import { isDocumentReady, notReadyReason, supportsLocalDocument } from '../documents/formats';
import {
  cancelDocumentJob, dismissDocumentJob, isJobRunning, jobPhaseText,
  prepareDocumentCloud, prepareDocumentLocal, useDocumentJob,
} from '../documents/jobs';
import { DocumentReader } from '../documents/readers';
import { documentReadMode } from '../documents/readers/readerAvailability';

interface Props {
  docId: number;
  reloadKey: number;
  onClose: () => void;
  onChanged: () => void;
  onAsk: (documentIds: number[]) => void;
}

type Busy = 'idle' | 'opening' | 'deleting';

function statusLine(doc: Document, jobText: string): string {
  if (jobText) return jobText;
  if (isDocumentReady(doc)) return `可问 · ${doc.charCount} 字`;
  return notReadyReason(doc);
}

export function DocViewer({ docId, reloadKey, onClose, onChanged, onAsk }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [doc, setDoc] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<Busy>('idle');
  const [armedDelete, setArmedDelete] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [cloudAsk, setCloudAsk] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [token, setToken] = useState('');
  const keyboardHeight = useKeyboardHeight();
  const alive = useRef(true);
  const loadRequest = useRef(0);
  const job = useDocumentJob(docId);
  const running = isJobRunning(job);
  const jobKey = job ? `${job.runId}:${job.phase}` : '';

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const next = await repo.findDocument(docId);
      if (!alive.current || request !== loadRequest.current) return;
      setDoc(next);
      setLoadError('');
    } catch (e) {
      if (alive.current && request === loadRequest.current) {
        setLoadError(e instanceof Error ? e.message : '读取文档失败');
      }
    } finally {
      if (alive.current && request === loadRequest.current) setLoading(false);
    }
  }, [docId]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; loadRequest.current += 1; };
  }, []);
  useEffect(() => {
    setLoading(true);
    setDoc(null);
    setCloudAsk(false);
    setActionsOpen(false);
    setArmedDelete(false);
    setMsg(null);
  }, [docId]);
  useEffect(() => { void load(); }, [load, reloadKey]);
  useEffect(() => {
    getMineruToken().then((t) => { if (alive.current) setToken(t); }).catch(() => undefined);
  }, []);

  const loadRef = useRef(load);
  loadRef.current = load;
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  useEffect(() => {
    if (!job || isJobRunning(job)) return;
    void loadRef.current();
    changedRef.current();
  }, [jobKey]);

  const attemptClose = useCallback(() => {
    if (cloudAsk) { setCloudAsk(false); return; }
    if (armedDelete) { setArmedDelete(false); return; }
    if (actionsOpen) { setActionsOpen(false); return; }
    onClose();
  }, [armedDelete, cloudAsk, actionsOpen, onClose]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { attemptClose(); return true; });
    return () => sub.remove();
  }, [attemptClose]);

  async function open() {
    if (!doc || busy !== 'idle') return;
    if (!doc.fileUri) { setMsg({ kind: 'err', text: '原文件已不在手机上，只能看已保留的正文' }); return; }
    setArmedDelete(false);
    setMsg(null);
    setBusy('opening');
    try { await openOriginal(doc.fileUri, doc.ext); }
    catch (e) { if (alive.current) setMsg({ kind: 'err', text: e instanceof Error ? e.message : '打不开原文件' }); }
    finally { if (alive.current) setBusy('idle'); }
  }

  function startLocal() {
    if (!doc || running || busy !== 'idle') return;
    setArmedDelete(false);
    setMsg(null);
    void prepareDocumentLocal(doc.id);
  }
  function askCloud() {
    if (!doc || running || busy !== 'idle') return;
    Keyboard.dismiss();
    setArmedDelete(false);
    setCloudAsk(true);
  }
  function startCloud(channel: 'lite' | 'pro') {
    if (!doc || running || busy !== 'idle') return;
    setCloudAsk(false);
    setArmedDelete(false);
    setMsg(null);
    void prepareDocumentCloud(doc.id, { channel });
  }
  function stop() { if (doc) cancelDocumentJob(doc.id); }

  async function remove() {
    if (!doc || busy !== 'idle') return;
    if (!armedDelete) { setArmedDelete(true); return; }
    setBusy('deleting');
    setMsg(null);
    cancelDocumentJob(doc.id);
    // 原件仍先删除；失败保留记录以便重试，不丢掉URI。
    const cleaned = await deleteOriginal(doc.fileUri);
    if (cleaned) await dropViewCache(doc.fileUri);
    if (!cleaned) {
      if (alive.current) {
        setMsg({ kind: 'err', text: '原文件没删掉（可能被其它应用占用），记录先留着，可以重试' });
        setBusy('idle');
      }
      return;
    }
    try {
      await repo.deleteDocument(doc.id);
      await repo.clearAskSessionDocuments(doc.id);
      dismissDocumentJob(doc.id);
      onChanged();
      onClose();
    } catch (e) {
      if (alive.current) {
        setMsg({ kind: 'err', text: `删除未完成：${e instanceof Error ? e.message : '未知原因'}。原文件已经删了` });
        setBusy('idle');
      }
    }
  }

  if (loading || !doc) {
    return (
      <View style={styles.root} accessibilityViewIsModal>
        <ScreenHeader title="文档" backIcon="close" backLabel="关闭文档" onBack={onClose} />
        <View style={styles.stateBox}>
          {loading ? <><ActivityIndicator color={c.text2} /><Text style={styles.stateHint}>正在读取文档…</Text></> : (
            <>
              <Text style={styles.stateTitle}>{loadError ? '文档暂时读取失败' : '这条记录已经不在了'}</Text>
              <Text style={styles.stateHint}>{loadError || '可能刚在列表里删掉了。'}</Text>
              {loadError ? <View style={styles.actions}><Action label="重新读取" icon="refresh-outline" onPress={() => void load()} /></View> : null}
            </>
          )}
        </View>
      </View>
    );
  }

  const ready = isDocumentReady(doc);
  const canLocal = supportsLocalDocument(doc.ext);
  const limitNote = localReaderLimitNote(doc);
  const canRead = documentReadMode(doc, limitNote) !== 'unavailable';
  const jobText = job ? jobPhaseText(job) : '';
  const fileDocument = doc.origin !== 'knowledge';
  const canPrepareLocal = fileDocument && !!doc.fileUri && canLocal && !limitNote;
  const plan = planForDoc(doc.ext, doc.size, !!token.trim());
  const primaryLabel = ready ? '问这份' : running ? '取消准备' : canPrepareLocal ? '本地准备' : fileDocument ? '云解析' : '暂不可问';
  const primaryIcon: IoniconName = ready ? 'chatbubble-ellipses-outline' : running ? 'close-outline' : canPrepareLocal ? 'phone-portrait-outline' : 'cloud-outline';

  return (
    <View style={[styles.root, { paddingBottom: keyboardHeight }]} accessibilityViewIsModal>
      <View style={styles.main} importantForAccessibility={cloudAsk ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={cloudAsk}>
        <ScreenHeader
          title={doc.name}
          subtitle={fileDocument ? `${doc.ext ? doc.ext.toUpperCase() : '未知格式'} · ${sizeText(doc.size)}` : '整理生成的文档'}
          backIcon="close" backLabel="关闭文档" onBack={attemptClose}
        />
        <Text style={styles.documentStatus} accessibilityLiveRegion="polite">{statusLine(doc, jobText)}</Text>
        {loadError ? <Text style={styles.warnLine}>刷新失败：{loadError}。仍显示上次读取的内容。</Text> : null}
        {canRead ? (
          <View style={styles.readerWrap}>
            {doc.error ? <Text style={styles.warnLine}>准备提示：{doc.error}</Text> : null}
            <DocumentReader document={doc} embedded />
          </View>
        ) : (
          <ScrollView style={styles.readerWrap} contentContainerStyle={styles.stateContent}>
            <View style={styles.stateBox}>
              {running ? <ActivityIndicator color={c.accent} /> : <Ionicons name={doc.state === 'failed' ? 'alert-circle-outline' : 'document-text-outline'} size={28} color={doc.state === 'failed' ? c.danger : c.text2} />}
              <Text style={styles.stateTitle}>{running ? jobText || '正在准备' : doc.state === 'failed' ? '这次没准备成' : '暂无应用内可读内容'}</Text>
              {doc.error ? <Text style={styles.failText}>{doc.error}</Text> : null}
              <Text style={styles.stateHint}>
                {running
                  ? '可以离开这一页，任务会继续。取消不能撤回已上传的字节。'
                  : !doc.fileUri && fileDocument
                    ? '原文件已不在手机上。可以重新导入原件，已有正文不会被自动覆盖。'
                    : limitNote || (canLocal
                      ? '原件保留在本机。本地准备只提取正文与索引，不会上传。'
                      : '这种格式需用外部应用打开；需要正文时，再自行确认是否上传到 mineru.net 解析。')}
              </Text>
            </View>
          </ScrollView>
        )}

        <View style={styles.footer}>
          {msg ? <Text style={[styles.msg, msg.kind === 'err' && styles.failText]} accessibilityLiveRegion="polite">{msg.kind === 'err' ? '提示：' : '已完成：'}{msg.text}</Text> : null}
          {running && ready ? (
            <View style={styles.taskRow}>
              <ActivityIndicator size="small" color={c.text2} />
              <Text style={styles.taskText}>{jobText} · 仍可阅读已有内容</Text>
              <Action label="取消准备" icon="close-outline" onPress={stop} />
            </View>
          ) : null}

          {actionsOpen ? (
            <ScrollView style={styles.operations} contentContainerStyle={styles.operationContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.operationTitle}>文档操作</Text>
              <Text style={styles.operationHint}>{fileDocument ? '本地准备不上传；云解析每次都会先确认文件、接收方与通道。' : '这是整理生成的文档，没有原文件副本。'}</Text>
              {fileDocument ? (
                <View style={styles.actions}>
                  <Action label={ready ? '重新准备' : '本地准备'} icon="phone-portrait-outline" onPress={startLocal} disabled={busy !== 'idle' || running || !canPrepareLocal} />
                  <Action label="云解析" icon="cloud-outline" onPress={askCloud} disabled={busy !== 'idle' || running || !doc.fileUri} />
                </View>
              ) : null}
              {limitNote ? <Text style={styles.operationHint}>{limitNote}</Text> : null}
              {armedDelete ? <Text style={styles.deleteWarning}>确认删除「{doc.name}」？App 内的原件副本、正文和索引会删除，无法在这里撤回。手机上原来的文件不受影响。</Text> : null}
              <View style={styles.actions}>
                {armedDelete ? <Action label="取消删除" onPress={() => setArmedDelete(false)} disabled={busy !== 'idle'} /> : null}
                <Action label={armedDelete ? '确认删除' : '删除文档'} icon="trash-outline" onPress={() => void remove()} tone="danger" busy={busy === 'deleting'} disabled={busy !== 'idle'} />
              </View>
            </ScrollView>
          ) : null}

          <View style={styles.actions}>
            <Action
              label={primaryLabel} icon={primaryIcon} tone="primary"
              disabled={busy !== 'idle' || (!ready && !running && !canPrepareLocal && (!fileDocument || !doc.fileUri))}
              onPress={ready ? () => onAsk([doc.id]) : running ? stop : canPrepareLocal ? startLocal : askCloud}
            />
            {fileDocument ? <Action label="打开原件" icon="open-outline" onPress={() => void open()} busy={busy === 'opening'} disabled={busy !== 'idle' || !doc.fileUri} /> : null}
            <Pressable
              style={({ pressed }) => [styles.actionBtn, styles.disclosureBtn, actionsOpen && styles.actionSelected, pressed && styles.pressed]}
              onPress={() => { setActionsOpen((v) => !v); setArmedDelete(false); }}
              accessibilityRole="button" accessibilityLabel="文档操作" accessibilityState={{ expanded: actionsOpen }}
            >
              <Text style={styles.actionText}>文档操作</Text>
              <Ionicons name={actionsOpen ? 'chevron-up' : 'chevron-down'} size={16} color={c.text2} />
            </Pressable>
          </View>
        </View>
      </View>
      {cloudAsk ? <CloudConfirmSheet doc={doc} defaultChannel={plan.channel === 'pro' ? 'pro' : 'lite'} hasToken={!!token.trim()} onCancel={() => setCloudAsk(false)} onConfirm={startCloud} /> : null}
    </View>
  );
}

function Action({ label, icon, onPress, disabled = false, busy = false, tone = 'plain' }: {
  label: string; icon?: IoniconName; onPress: () => void; disabled?: boolean; busy?: boolean;
  tone?: 'plain' | 'primary' | 'danger';
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  const color = disabled ? c.text3 : tone === 'primary' ? c.onAccent : tone === 'danger' ? c.danger : c.text;
  return (
    <Pressable
      onPress={onPress} disabled={disabled} accessibilityRole="button"
      accessibilityLabel={busy ? `${label}，处理中` : label} accessibilityState={{ disabled, busy }}
      style={({ pressed }) => [styles.actionBtn, tone === 'primary' && styles.primaryBtn, tone === 'danger' && styles.dangerBtn, disabled && styles.btnDisabled, pressed && styles.pressed]}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : icon ? <Ionicons name={icon} size={16} color={color} accessible={false} /> : null}
      <Text style={[styles.actionText, tone === 'primary' && styles.primaryActionText, { color }]}>{label}</Text>
    </Pressable>
  );
}

/** 列表/阅读器共用的逐次上传确认；选择通道并不上传，点开始才会提交。 */
export function CloudConfirmSheet({ doc, defaultChannel, hasToken, onCancel, onConfirm }: {
  doc: DocumentMeta;
  defaultChannel: 'lite' | 'pro';
  hasToken: boolean;
  onCancel: () => void;
  onConfirm: (channel: 'lite' | 'pro') => void;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  const litePlan = planForDoc(doc.ext, doc.size, false);
  const proPlan = planForDoc(doc.ext, doc.size, true);
  const liteOff = litePlan.channel !== 'lite' || (doc.pages ?? 0) > 20;
  const proBlocked = !hasToken || (proPlan.channel !== 'lite' && proPlan.channel !== 'pro') || (doc.pages ?? 0) > PRO_MAX_PAGES;
  const [channel, setChannel] = useState<'lite' | 'pro'>(!liteOff && (defaultChannel === 'lite' || proBlocked) ? 'lite' : 'pro');
  const cancelRef = useRef(onCancel);
  const submitted = useRef(false);
  cancelRef.current = onCancel;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { cancelRef.current(); return true; });
    return () => sub.remove();
  }, []);
  const blocked = channel === 'lite' ? liteOff : proBlocked;

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <Pressable style={styles.backdrop} onPress={onCancel} accessible={false} />
      <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.sheetTitle} accessibilityRole="header">上传到 mineru.net 解析？</Text>
        <Text style={styles.fileName}>{doc.name}</Text>
        <Text style={styles.fileMeta}>{sizeText(doc.size)} · {doc.ext ? doc.ext.toUpperCase() : '未知格式'}{doc.pages ? ` · ${doc.pages} 页` : ''}</Text>
        <Text style={styles.privacy}>
          会发送整份原文件到 mineru.net（第三方服务），手机上的副本仍保留。开始后可以取消，但已经上传的字节无法撤回。
        </Text>
        <Text style={styles.sheetHint}>选择解析通道</Text>
        <Pressable
          style={[styles.option, channel === 'lite' && styles.optionOn]}
          onPress={() => setChannel('lite')} disabled={liteOff} accessibilityRole="radio"
          accessibilityState={{ checked: channel === 'lite', selected: channel === 'lite', disabled: liteOff }}
        >
          <Ionicons name={channel === 'lite' ? 'radio-button-on' : 'radio-button-off'} size={20} color={c.text2} />
          <View style={styles.optionBody}>
            <Text style={styles.optionTitle}>轻量接口 · 免 Token{channel === 'lite' ? ' · 已选' : ''}</Text>
            <Text style={styles.optionHint}>{liteOff ? '当前文件的格式、大小或页数不适用。' : '可用。'}上限 {MAX_FILE_LABEL} / 20 页。</Text>
          </View>
        </Pressable>
        <Pressable
          style={[styles.option, channel === 'pro' && styles.optionOn]}
          onPress={() => setChannel('pro')} disabled={proBlocked} accessibilityRole="radio"
          accessibilityState={{ checked: channel === 'pro', selected: channel === 'pro', disabled: proBlocked }}
        >
          <Ionicons name={channel === 'pro' ? 'radio-button-on' : 'radio-button-off'} size={20} color={c.text2} />
          <View style={styles.optionBody}>
            <Text style={styles.optionTitle}>精准接口 · 需要 Token{channel === 'pro' ? ' · 已选' : ''}</Text>
            <Text style={styles.optionHint}>
              {!hasToken ? '尚未填写 MinerU Token，请先到设置填写。' : proBlocked ? proPlan.reason || '当前格式或页数不适用。' : '可用，消耗每天1000页额度。'}
              上限 {PRO_MAX_FILE_LABEL} / {PRO_MAX_PAGES} 页。
            </Text>
          </View>
        </Pressable>
        <View style={styles.sheetActions}>
          <Action label="取消" onPress={onCancel} />
          <Action label="确认上传并解析" icon="cloud-upload-outline" tone="primary" disabled={blocked} onPress={() => {
            if (blocked || submitted.current) return;
            submitted.current = true;
            onConfirm(channel);
          }} />
        </View>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.page },
  main: { flex: 1 },
  readerWrap: { flex: 1 },
  documentStatus: { ...TYPE.label, color: c.text2, paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.xs, paddingBottom: SPACE.xxs },
  stateContent: { flexGrow: 1, padding: SPACE.md },
  stateBox: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: SPACE.xl, gap: SPACE.sm },
  stateTitle: { ...TYPE.heading, color: c.text, textAlign: 'center' },
  stateHint: { ...TYPE.body, color: c.text2, textAlign: 'center', maxWidth: 360 },
  failText: { ...TYPE.body, color: c.danger },
  warnLine: { ...TYPE.body, color: c.amberText, backgroundColor: c.amberBg, paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.sm },
  footer: { paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.sm, gap: SPACE.sm, borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair, backgroundColor: c.page },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'stretch', gap: SPACE.xs },
  actionBtn: {
    flexGrow: 1, flexBasis: 80, minHeight: metrics.controlHeight, minWidth: 80,
    paddingHorizontal: SPACE.xs, paddingVertical: SPACE.sm, borderRadius: metrics.buttonRadius,
    borderWidth: surfaceStroke(metrics), borderColor: c.hair, backgroundColor: c.card,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs,
  },
  actionText: { flexShrink: 1, ...TYPE.label, color: c.text, textAlign: 'center' },
  primaryBtn: { flexGrow: 1.4, backgroundColor: c.accent, borderColor: c.accent },
  primaryActionText: { ...TYPE.body, fontWeight: '600' },
  dangerBtn: { backgroundColor: c.dangerBg, borderColor: c.danger, borderWidth: metrics.strokeWidth },
  btnDisabled: { backgroundColor: c.hairSoft, borderColor: c.hair },
  actionSelected: { borderColor: c.focus, borderWidth: metrics.strokeWidth, backgroundColor: c.hairSoft },
  disclosureBtn: { backgroundColor: c.page },
  pressed: { opacity: 0.75 },
  msg: { ...TYPE.body, color: c.text2 },
  taskRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs },
  taskText: { flex: 2, minWidth: 140, ...TYPE.body, color: c.text2 },
  operations: { maxHeight: 240, flexGrow: 0 },
  operationContent: { gap: SPACE.sm, paddingBottom: SPACE.sm },
  operationTitle: { ...TYPE.title, color: c.text },
  operationHint: { ...TYPE.body, color: c.text2 },
  deleteWarning: { ...TYPE.body, color: c.danger, padding: SPACE.md, backgroundColor: c.dangerBg, borderWidth: metrics.strokeWidth, borderColor: c.danger, borderRadius: metrics.buttonRadius },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', padding: metrics.pagePadding },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.scrim },
  sheet: { flexGrow: 0, maxHeight: '100%', backgroundColor: c.card, borderRadius: metrics.cardRadius, borderWidth: surfaceStroke(metrics), borderColor: c.hair },
  sheetContent: { padding: SPACE.lg, gap: SPACE.sm },
  sheetTitle: { ...TYPE.heading, color: c.text },
  fileName: { ...TYPE.title, color: c.text, marginTop: SPACE.xxs },
  fileMeta: { ...TYPE.meta, color: c.text2 },
  privacy: { ...TYPE.body, color: c.amberText, backgroundColor: c.amberBg, padding: SPACE.md, borderRadius: metrics.buttonRadius },
  sheetHint: { marginTop: SPACE.xs, ...TYPE.label, color: c.text2 },
  option: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm, minHeight: metrics.controlHeight, padding: SPACE.md, borderRadius: metrics.buttonRadius, borderWidth: surfaceStroke(metrics), borderColor: c.hair },
  optionOn: { borderColor: c.focus, borderWidth: metrics.strokeWidth, backgroundColor: c.accentBg },
  optionBody: { flex: 1, minWidth: 0 },
  optionTitle: { ...TYPE.title, color: c.text },
  optionHint: { marginTop: SPACE.xs, ...TYPE.body, color: c.text2 },
  sheetActions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.sm },
});
