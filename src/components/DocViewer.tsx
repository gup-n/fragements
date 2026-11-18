/**
 * 文档阅读覆盖层。只持有id并刷新当前记录；准备任务属于documents/jobs。
 * 阅读、准备、问答索引相互独立。打开页面不提取、不上传；云解析每次重新确认。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { DocProposal, DocTag, Document, DocumentMeta } from '../types';
import { R, SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { BusyIndicator as ActivityIndicator } from './BusyIndicator';
import { ScreenHeader } from './ScreenHeader';
import type { IoniconName } from './IconButton';
import { useKeyboardHeight } from '../util/keyboard';
import { repo } from '../db/repo';
import { openOriginal } from '../db/docFiles';
import { MAX_FILE_LABEL, PRO_MAX_FILE_LABEL, PRO_MAX_PAGES, getMineruToken } from '../ai/mineru';
import { planForDoc, localReaderLimitNote, sizeText } from '../util/docSupport';
import { isDocumentReady, notReadyReason, supportsLocalDocument } from '../documents/formats';
import {
  cancelDocumentJob, dismissDocumentJob, isJobRunning, jobPhaseText,
  prepareDocumentCloud, prepareDocumentLocal, useDocumentJob,
} from '../documents/jobs';
import { DocumentReader } from '../documents/readers';
import { DocEditor } from './DocEditor';
import { ProposalSheet } from './ProposalSheet';
import { proposeRewrite, proposeTags } from '../documents/proposals';
import { normalizeTagName } from '../util/docTags';
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
  /* ---- v0.28：编辑、标签、AI 提案 ---- */
  const [editorOpen, setEditorOpen] = useState(false);
  const [tagSheet, setTagSheet] = useState(false);
  const [allTags, setAllTags] = useState<DocTag[]>([]);
  const [proposal, setProposal] = useState<DocProposal | null>(null);
  /** 正在等模型的那个动作。null = 没在等 */
  const [aiBusy, setAiBusy] = useState<'polish' | 'condense' | 'tag' | null>(null);
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
    setEditorOpen(false);
    setTagSheet(false);
    setProposal(null);
    setAiBusy(null);
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
    if (proposal) { setProposal(null); return; }
    if (editorOpen) { setEditorOpen(false); return; }
    if (tagSheet) { setTagSheet(false); return; }
    if (cloudAsk) { setCloudAsk(false); return; }
    if (armedDelete) { setArmedDelete(false); return; }
    if (actionsOpen) { setActionsOpen(false); return; }
    onClose();
  }, [armedDelete, cloudAsk, actionsOpen, editorOpen, onClose, proposal, tagSheet]);
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
    /*
     * v0.28 起删除只是**移到回收站**：不删原件、不删正文。
     * 30 天内恢复要能打开原件、要能看到图。真删在设置的回收站里做。
     */
    try {
      await repo.deleteDocument(doc.id);
      await repo.clearAskSessionDocuments(doc.id);
      dismissDocumentJob(doc.id);
      onChanged();
      onClose();
    } catch (e) {
      if (alive.current) {
        setMsg({ kind: 'err', text: `没删成：${e instanceof Error ? e.message : '未知原因'}` });
        setBusy('idle');
      }
    }
  }

  /** 打开标签面板前先把全部标签读出来 */
  async function openTags() {
    setArmedDelete(false);
    setMsg(null);
    try {
      setAllTags(await repo.listDocTags());
      setTagSheet(true);
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : '读取标签失败' });
    }
  }

  /**
   * 让 AI 出建议。
   *
   * 这里**不写库**：接口回来之后只弹审批面板，用户点了才算数。
   * 出错时错误原样显示 —— 「优化失败」这四个字帮不上任何忙。
   */
  async function runAi(mode: 'polish' | 'condense' | 'tag') {
    if (!doc || aiBusy || running) return;
    setArmedDelete(false);
    setMsg(null);
    setAiBusy(mode);
    try {
      const next = mode === 'tag' ? await proposeTags(doc.id) : await proposeRewrite(doc.id, mode);
      if (alive.current) setProposal(next);
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: e instanceof Error ? e.message : '没有拿到建议' });
    } finally {
      if (alive.current) setAiBusy(null);
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

        {/*
          标签在正文上方：它是「这篇属于哪一类」，先看清楚再读。
          平铺（用户 2026-11-18 定），一排芯片，没有层级。
        */}
        <View style={styles.tagRow}>
          {doc.tags.map((tag) => (
            <View key={tag.id} style={styles.docTagChip}>
              <Text style={styles.docTagChipText}>{tag.name}</Text>
            </View>
          ))}
          <Pressable
            style={({ pressed }) => [styles.tagEdit, pressed && { opacity: 0.7 }]}
            onPress={() => void openTags()}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            accessibilityRole="button"
            accessibilityLabel={doc.tags.length ? '改这篇的标签' : '给这篇加标签'}
          >
            <Ionicons name="pricetag-outline" size={13} color={c.text2} />
            <Text style={styles.tagEditText}>{doc.tags.length ? '改标签' : '加标签'}</Text>
          </Pressable>
        </View>

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

              {/*
                用户权限最高：任何一篇都能自己改（含导入的原件与 AI 产出的那篇）。
                改的是这一篇本身；AI 那条路一律「新建一篇」，两条路不能混。
              */}
              <View style={styles.actions}>
                <Action label="编辑正文" icon="create-outline" onPress={() => { setActionsOpen(false); setEditorOpen(true); }} disabled={busy !== 'idle'} />
                <Action label="改标签" icon="pricetags-outline" onPress={() => void openTags()} disabled={busy !== 'idle'} />
              </View>

              <Text style={styles.operationTitle}>让 AI 出一版</Text>
              <Text style={styles.operationHint}>
                建议先给你看，你点了才存。存下来是一篇新文档，这一篇一个字都不会变。
              </Text>
              <View style={styles.actions}>
                <Action
                  label={aiBusy === 'polish' ? '正在生成…' : '优化'}
                  icon="sparkles-outline"
                  onPress={() => void runAi('polish')}
                  busy={aiBusy === 'polish'}
                  disabled={busy !== 'idle' || !!aiBusy || !doc.bodyMd.trim()}
                />
                <Action
                  label={aiBusy === 'condense' ? '正在生成…' : '精简'}
                  icon="contract-outline"
                  onPress={() => void runAi('condense')}
                  busy={aiBusy === 'condense'}
                  disabled={busy !== 'idle' || !!aiBusy || !doc.bodyMd.trim()}
                />
                <Action
                  label={aiBusy === 'tag' ? '正在生成…' : '打标签'}
                  icon="pricetags-outline"
                  onPress={() => void runAi('tag')}
                  busy={aiBusy === 'tag'}
                  disabled={busy !== 'idle' || !!aiBusy}
                />
              </View>

              {armedDelete ? <Text style={styles.deleteWarning}>确认把「{doc.name}」移到回收站？30 天内可以在「设置 → 数据 → 回收站」里恢复，彻底删除之前原件和正文都还在。</Text> : null}
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

      {editorOpen ? (
        <DocEditor
          docId={doc.id}
          onClose={() => setEditorOpen(false)}
          onSaved={() => {
            setEditorOpen(false);
            setMsg({ kind: 'ok', text: '已保存' });
            void load();
            onChanged();
          }}
        />
      ) : null}

      {tagSheet ? (
        <DocTagSheet
          allTags={allTags}
          current={doc.tags}
          onCancel={() => setTagSheet(false)}
          onApply={async (ids) => {
            setTagSheet(false);
            try {
              await repo.setDocumentTags(doc.id, ids);
              await load();
              onChanged();
              setMsg({ kind: 'ok', text: '标签已更新' });
            } catch (e) {
              setMsg({ kind: 'err', text: e instanceof Error ? e.message : '标签没改成' });
            }
          }}
        />
      ) : null}

      {proposal ? (
        <ProposalSheet
          proposal={proposal}
          original={doc}
          onDone={(decision) => {
            setProposal(null);
            if (decision.kind === 'saved') {
              setMsg({
                kind: 'ok',
                text: decision.docId
                  ? '已存为新文档，原稿没有改动'
                  : `已挂上标签：${decision.tags.join('、') || '（无）'}`,
              });
              void load();
              onChanged();
            } else if (decision.kind === 'rejected') {
              setMsg({ kind: 'ok', text: '已放弃，库里什么都没改' });
            }
          }}
        />
      ) : null}
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

/**
 * 改这一篇的标签。
 *
 * 打勾即生效的那一版（`setDocumentTags` 是整体替换）：
 * 用户看得见每一个勾，所以「替换」在这里没有歧义；
 * 批量改标签那边就不能这么做 —— 那些文档原有的标签他看不见。
 *
 * 新建标签也在这里：「想给这篇加一个还没有的标签」是最常见的一步，
 * 让用户退回文档列表去建反而绕。
 */
function DocTagSheet({
  allTags,
  current,
  onCancel,
  onApply,
}: {
  allTags: DocTag[];
  current: DocTag[];
  onCancel: () => void;
  onApply: (ids: number[]) => void;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [tags, setTags] = useState<DocTag[]>(allTags);
  const [picked, setPicked] = useState<number[]>(current.map((t) => t.id));
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const live = useRef(onCancel);
  live.current = onCancel;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { live.current(); return true; });
    return () => sub.remove();
  }, []);

  async function create() {
    const clean = normalizeTagName(name);
    if (!clean || busy) return;
    setBusy(true);
    setErr('');
    try {
      const tag = await repo.createDocTag(clean, 'approved');
      setTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]));
      setPicked((prev) => (prev.includes(tag.id) ? prev : [...prev, tag.id]));
      setName('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '建标签失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <Pressable style={styles.backdrop} onPress={onCancel} accessible={false} />
      <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.sheetTitle} accessibilityRole="header">标签</Text>
        <Text style={styles.sheetHint}>一篇可以有多个标签；取消打勾就是摘掉。</Text>

        {tags.length ? (
          <View style={styles.tagPickWrap}>
            {tags.map((tag) => {
              const on = picked.includes(tag.id);
              return (
                <Pressable
                  key={tag.id}
                  style={[styles.chip, on && styles.chipOn]}
                  onPress={() => setPicked((prev) => (on ? prev.filter((id) => id !== tag.id) : [...prev, tag.id]))}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={tag.name}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{tag.name}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Text style={styles.sheetHint}>还没有任何标签，在下面建一个。</Text>
        )}

        <View style={styles.tagInputRow}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="新标签名"
            placeholderTextColor={c.text3}
            style={styles.tagInput}
            accessibilityLabel="新标签名"
            selectionColor={c.selection}
            returnKeyType="done"
            onSubmitEditing={() => void create()}
            maxLength={12}
          />
          <Pressable
            style={({ pressed }) => [styles.tagAddBtn, pressed && { opacity: 0.8 }]}
            onPress={() => void create()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="新建并勾上这个标签"
          >
            <Text style={styles.tagAddBtnText}>{busy ? '…' : '新建'}</Text>
          </Pressable>
        </View>

        {err ? <Text style={styles.failText}>{err}</Text> : null}

        <View style={styles.sheetActions}>
          <Action label="取消" onPress={onCancel} />
          <Action label={`保存 ${picked.length} 个标签`} tone="primary" onPress={() => onApply(picked)} />
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
  tagRow: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6,
    paddingHorizontal: metrics.pagePadding, paddingBottom: SPACE.xs,
  },
  docTagChip: { backgroundColor: c.accentBg, borderRadius: R.pill, paddingHorizontal: SPACE.sm, paddingVertical: 2 },
  docTagChipText: { ...TYPE.caption, color: c.accentText },
  tagEdit: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 28, paddingHorizontal: 6 },
  tagEditText: { ...TYPE.caption, color: c.text2 },
  tagPickWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs, marginTop: SPACE.sm },
  chip: { minHeight: 32, paddingHorizontal: SPACE.sm, borderRadius: R.pill, backgroundColor: c.hairSoft, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: c.accentBg },
  chipText: { ...TYPE.label, color: c.text2 },
  chipTextOn: { color: c.accentText, fontWeight: '600' },
  tagInputRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginTop: SPACE.sm },
  tagInput: {
    flex: 1, minHeight: metrics.controlHeight, paddingHorizontal: SPACE.md, borderRadius: metrics.buttonRadius,
    backgroundColor: c.hairSoft, ...TYPE.compact, color: c.text,
  },
  tagAddBtn: {
    minHeight: metrics.controlHeight, paddingHorizontal: SPACE.md, borderRadius: metrics.buttonRadius,
    backgroundColor: c.hairSoft, alignItems: 'center', justifyContent: 'center',
  },
  tagAddBtnText: { ...TYPE.label, color: c.text },
  stateContent: { flexGrow: 1, padding: SPACE.md },
  stateBox: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: SPACE.xl, gap: SPACE.sm },
  stateTitle: { ...TYPE.heading, color: c.text, textAlign: 'center' },
  stateHint: { ...TYPE.compact, color: c.text2, textAlign: 'center', maxWidth: 360 },
  failText: { ...TYPE.compact, color: c.danger },
  warnLine: { ...TYPE.compact, color: c.amberText, backgroundColor: c.amberBg, paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.sm },
  footer: { paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.sm, gap: SPACE.sm, borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair, backgroundColor: c.page },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'stretch', gap: SPACE.xs },
  /** 操作按钮：浅灰底、无边框。原来再套一圈 hair，一排三个就是三个白框 */
  actionBtn: {
    flexGrow: 1, flexBasis: 80, minHeight: metrics.controlHeight, minWidth: 80,
    paddingHorizontal: SPACE.xs, paddingVertical: SPACE.sm, borderRadius: metrics.buttonRadius,
    backgroundColor: c.hairSoft,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs,
  },
  actionText: { flexShrink: 1, ...TYPE.label, color: c.text, textAlign: 'center' },
  primaryBtn: { flexGrow: 1.4, backgroundColor: c.accent },
  /** 主按钮和次要按钮同字号：原来主按钮用 body（16），一排里只有它大一圈 */
  primaryActionText: { ...TYPE.label },
  dangerBtn: { backgroundColor: c.dangerBg },
  btnDisabled: { backgroundColor: c.hairSoft },
  /**
   * 「文档操作」展开态。原来用 `borderColor: c.focus`（墨水主题是纯黑），
   * 展开就变成一个黑框。现在只换底色。
   */
  actionSelected: { backgroundColor: c.accentBg },
  disclosureBtn: { backgroundColor: c.page },
  pressed: { opacity: 0.75 },
  msg: { ...TYPE.compact, color: c.text2 },
  taskRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs },
  taskText: { flex: 2, minWidth: 140, ...TYPE.compact, color: c.text2 },
  operations: { maxHeight: 240, flexGrow: 0 },
  operationContent: { gap: SPACE.sm, paddingBottom: SPACE.sm },
  operationTitle: { ...TYPE.title, color: c.text },
  operationHint: { ...TYPE.compact, color: c.text2 },
  deleteWarning: { ...TYPE.compact, color: c.danger, padding: SPACE.md, backgroundColor: c.dangerBg, borderRadius: metrics.buttonRadius },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', padding: metrics.pagePadding },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.scrim },
  sheet: { flexGrow: 0, maxHeight: '100%', backgroundColor: c.card, borderRadius: metrics.cardRadius },
  sheetContent: { padding: SPACE.lg, gap: SPACE.sm },
  sheetTitle: { ...TYPE.heading, color: c.text },
  fileName: { ...TYPE.title, color: c.text, marginTop: SPACE.xxs },
  fileMeta: { ...TYPE.meta, color: c.text2 },
  privacy: { ...TYPE.compact, color: c.amberText, backgroundColor: c.amberBg, padding: SPACE.md, borderRadius: metrics.buttonRadius },
  sheetHint: { marginTop: SPACE.xs, ...TYPE.label, color: c.text2 },
  option: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm, minHeight: metrics.controlHeight, padding: SPACE.md, borderRadius: metrics.buttonRadius, backgroundColor: c.hairSoft },
  /** 选中换底色，不换描边 —— 否则切换通道时那一行会跳 2px */
  optionOn: { backgroundColor: c.accentBg },
  optionBody: { flex: 1, minWidth: 0 },
  optionTitle: { ...TYPE.title, color: c.text },
  optionHint: { marginTop: SPACE.xxs, ...TYPE.compact, color: c.text2 },
  sheetActions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.sm },
});
