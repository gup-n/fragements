/**
 * 文档阅读器。
 *
 * 是覆盖层（`position:absolute`），不是 `Modal` —— 后者带 `FLAG_LAYOUT_NO_LIMITS`，
 * 会画到状态栏下，而且收不到键盘事件。返回键自己接。
 *
 * **只存 id，不存文档快照。** 解析是在别处跑的：上层写完库会给 `reloadKey` +1，
 * 这里重新查一次；存对象的话，解析完了界面上还停在「解析中」（v0.4.2 栽过）。
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
import type { Document } from '../types';
import { R, useThemedStyles, type Palette } from '../theme';
import { repo } from '../db/repo';
import { deleteOriginal, openOriginal, readPlainText } from '../db/docFiles';
import {
  mineruMessage,
  parseWithMineru,
  stageText,
  type MineruStage,
} from '../ai/mineru';
import { NoteBody } from './NoteBody';
import { IconButton } from './IconButton';

interface Props {
  docId: number;
  /** 上层内存里这篇文档正在跑的阶段。undefined = 没有活跃任务 */
  parsingStage?: MineruStage;
  /** 上层每次写完库 +1，这里据此重新取一次 */
  reloadKey: number;
  onClose: () => void;
  /** 解析重试/删除之后让上层刷新列表 */
  onChanged: () => void;
  /**
   * 把重试的阶段同步给上层。
   *
   * 重试的进度本来只活在这个组件里，但用户可以中途关掉阅读器 ——
   * 关掉之后列表还得显示「正在解析」，再点进来也不能把它误判成「上次没跑完」
   * 又发起一次上传。所以阶段要交给上层保管，结束时传 null 清掉。
   */
  onStage: (stage: MineruStage | null) => void;
}

type Busy = 'idle' | 'opening' | 'retrying' | 'deleting';

function isPlainText(ext: string): boolean {
  return ext === 'txt' || ext === 'md' || ext === 'markdown';
}

/** 头部第二行。解析中的阶段跟着上层实时变，不需要轮询 */
function statusLine(doc: Document, stage?: MineruStage): string {
  if (doc.state === 'parsing') return stage ? stageText(stage) : '解析中 · 上次没跑完';
  if (doc.state === 'failed') return '解析失败';
  if (doc.state === 'local') return `本地文本 · ${doc.charCount} 字`;
  return `已解析 · ${doc.charCount} 字`;
}

export function DocViewer({
  docId,
  parsingStage,
  reloadKey,
  onClose,
  onChanged,
  onStage,
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [doc, setDoc] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Busy>('idle');
  /** 重试时自己记阶段，别让界面在「解析中」和空正文之间闪 */
  const [stage, setStage] = useState<MineruStage | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const next = await repo.findDocument(docId);
    if (!alive.current) return;
    setDoc(next);
    setLoading(false);
  }, [docId]);

  // reloadKey 变化 = 上层刚写过库（导入完成 / 重试完成），重新取一次
  useEffect(() => {
    load().catch(() => {
      if (alive.current) setLoading(false);
    });
  }, [load, reloadKey]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // 已经点过一次删除时，返回键先撤掉那一步，别把整页关掉
      if (armedDelete) {
        setArmedDelete(false);
        return true;
      }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [armedDelete, onClose]);

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

  /**
   * 重新解析。txt / md 不必再上云，重新读一遍本地文本就行 ——
   * 把纯文本也发出去解析，既慢又白白泄露一次内容。
   */
  async function retry() {
    if (!doc || busy !== 'idle') return;
    if (!doc.fileUri) {
      setMsg({
        kind: 'err',
        text: '原文件不在了，没法重新解析。可以删掉这条记录后重新上传。',
      });
      return;
    }

    setArmedDelete(false);
    setMsg(null);
    setStage(null);
    setBusy('retrying');
    const plain = isPlainText(doc.ext);
    // 建任务也要几秒；先把阶段亮起来，否则这期间关掉再进来会被当成「上次没跑完」
    if (!plain) onStage('uploading');

    try {
      /*
       * 先把库里的状态改回 `parsing`。
       *
       * 不这么做的话，重试期间列表仍然显示「解析失败」，用户关掉阅读器再点进来
       * 还能再发起一次上传 —— 同一个文件在服务端跑两遍。
       */
      await repo.updateDocument(doc.id, { state: 'parsing', error: null });
      if (alive.current) {
        setDoc((d) => (d ? { ...d, state: 'parsing' as const, error: null } : d));
      }
      onChanged();

      let body: string;
      let nextState: Document['state'] = 'done';
      if (plain) {
        body = await readPlainText(doc.fileUri);
        nextState = 'local';
      } else {
        body = await parseWithMineru(
          { name: doc.name, ext: doc.ext, size: doc.size, uri: doc.fileUri },
          (s) => {
            if (alive.current) setStage(s);
            onStage(s);
          },
        );
      }
      if (!body.trim()) throw new Error('解析结果是空的，请稍后重试');

      await repo.updateDocument(doc.id, {
        bodyMd: body,
        state: nextState,
        pages: null,
        error: null,
      });
      if (alive.current) setMsg({ kind: 'ok', text: '已解析完成' });
      onChanged();
    } catch (e) {
      const text = plain ? (e instanceof Error ? e.message : '读取失败') : mineruMessage(e);
      // 失败也要落库：保留记录和原文件，用户可以再试一次，或者自己删掉
      await repo.updateDocument(doc.id, { state: 'failed', error: text }).catch(() => undefined);
      if (alive.current) setMsg({ kind: 'err', text });
      onChanged();
    } finally {
      // 先清上层：组件可能已经卸载了，父页面还活着，进度必须收掉
      onStage(null);
      if (alive.current) {
        setBusy('idle');
        setStage(null);
      }
      await load().catch(() => undefined);
    }
  }

  async function remove() {
    if (!doc || busy !== 'idle') return;
    if (!armedDelete) {
      setArmedDelete(true);
      return;
    }

    setBusy('deleting');
    setMsg(null);
    try {
      await repo.deleteDocument(doc.id);
      // repo 不碰文件系统，原文件由这里收拾；删不掉也不拦着关页面
      await deleteOriginal(doc.fileUri);
      onChanged();
      onClose();
    } catch (e) {
      if (alive.current) {
        setMsg({ kind: 'err', text: e instanceof Error ? e.message : '删除失败' });
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

  const retrying = busy === 'retrying';
  const activeStage = retrying ? stage ?? undefined : parsingStage;
  const staleParsing = doc.state === 'parsing' && !activeStage && !retrying;
  const hasBody = (doc.state === 'done' || doc.state === 'local') && !!doc.bodyMd.trim();

  return (
    <View style={styles.root}>
      <View style={styles.topBar}>
        <IconButton name="close" size={22} color={c.text2} onPress={onClose} accessibilityLabel="关闭" />
        <View style={styles.topCenter}>
          <Text style={styles.topTitle} numberOfLines={1}>
            {doc.name}
          </Text>
          <Text style={styles.topSub} numberOfLines={1}>
            {retrying ? '正在重新解析' : statusLine(doc, activeStage)}
          </Text>
        </View>
        <View style={styles.topSide} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {hasBody ? (
          <NoteBody text={doc.bodyMd} style={styles.body} variant="reading" selectable />
        ) : doc.state === 'parsing' ? (
          <View style={styles.stateBox}>
            {retrying || activeStage ? (
              <ActivityIndicator color={c.accent} />
            ) : (
              <Ionicons name="hourglass-outline" size={26} color={c.text3} />
            )}
            <Text style={styles.stateTitle}>
              {retrying ? '正在准备重新解析…' : activeStage ? `${stageText(activeStage)}…` : '正在解析'}
            </Text>
            <Text style={styles.stateHint}>
              {activeStage
                ? '可以离开这一页，解析会在后台继续，完成后列表会更新。'
                : '这次解析没有跑完（可能中途退出了 App）。原文件还在，可以重新解析。'}
            </Text>
            {staleParsing ? (
              <Pressable
                style={({ pressed }) => [styles.retryBtn, pressed && { opacity: 0.8 }]}
                onPress={retry}
                disabled={busy !== 'idle'}
              >
                <Text style={styles.retryText}>重新解析</Text>
              </Pressable>
            ) : null}
          </View>
        ) : doc.state === 'failed' ? (
          <View style={styles.stateBox}>
            <View style={styles.failIcon}>
              <Ionicons name="alert-circle-outline" size={24} color={c.danger} />
            </View>
            <Text style={styles.stateTitle}>这次没解析成</Text>
            <Text style={styles.failText}>{doc.error || '原因不明，可以直接重试'}</Text>
            <Text style={styles.stateHint}>原文件还留在手机上，重试不用重新选文件。</Text>
            <Pressable
              style={({ pressed }) => [styles.retryBtn, pressed && { opacity: 0.8 }]}
              onPress={retry}
              disabled={busy !== 'idle'}
            >
              {retrying ? (
                <ActivityIndicator size="small" color={c.onAccent} />
              ) : (
                <Text style={styles.retryText}>重新解析</Text>
              )}
            </Pressable>
          </View>
        ) : (
          <View style={styles.stateBox}>
            <Text style={styles.stateTitle}>这篇没有正文</Text>
            <Text style={styles.stateHint}>解析结果为空。可以重新解析，或者删掉重传。</Text>
            <Pressable
              style={({ pressed }) => [styles.retryBtn, pressed && { opacity: 0.8 }]}
              onPress={retry}
              disabled={busy !== 'idle'}
            >
              <Text style={styles.retryText}>重新解析</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      <View style={styles.footer}>
        {msg ? (
          <Text style={[styles.msg, msg.kind === 'err' ? styles.msgErr : styles.msgOk]}>
            {msg.text}
          </Text>
        ) : null}

        <View style={styles.actions}>
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
                  {armedDelete ? '再点一次确认删除' : '删除'}
                </Text>
              </>
            )}
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
    maxWidth: 290,
  },
  failText: { fontSize: 13, lineHeight: 20, color: c.danger, textAlign: 'center', maxWidth: 300 },
  retryBtn: {
    marginTop: 10,
    minWidth: 120,
    height: 40,
    paddingHorizontal: 18,
    borderRadius: R.btn,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: { fontSize: 13.5, color: c.onAccent, fontWeight: '600' },

  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
    backgroundColor: c.page,
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
  actionText: { fontSize: 13, color: c.text },
  dangerBtn: { backgroundColor: c.dangerBg, borderColor: c.dangerBg },
  dangerBtnArmed: { backgroundColor: c.danger, borderColor: c.danger },
  dangerText: { color: c.danger },
  dangerTextArmed: { color: c.onAccent },

  msg: { fontSize: 12, lineHeight: 18, marginBottom: 8, textAlign: 'center' },
  msgOk: { color: c.tealText },
  msgErr: { color: c.danger },
});
