/**
 * 「问」：一个只查自己记录的问答页。
 *
 * 和 DeepSeek 手机 App 的 chat 页对齐的只有两件事：**深度思考**、**联网搜索**，
 * 两个都能开能关，状态记在本地设置里。
 *
 * 三个刻意的取舍：
 * - **不弹 Modal**（Android 红线）：退出确认用 `position:absolute` 覆盖层，
 *   返回键由 App 转发进来（见 `registerClose`），Alt 层自己也能关掉覆盖层。
 * - **来源就地展开**，不跳详情页：回答里虽然写了 `[F12]`，但纯文本点不了，
 *   所以回答下面单独列「来源」卡片，点一下展开原文 —— 比在正文里做链接可靠。
 * - **纪要存成一条碎片**，不是另开一张表：这样它天然进时间轴、下次整理会被当成
 *   一条普通碎片处理，不需要再为它写一套列表/删除逻辑。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ScrollViewInstance,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { AiConfig, Fragment, QaTurn } from '../types';
import { R, useThemedStyles, type Palette, tagColor } from '../theme';
import { repo } from '../db/repo';
import { loadAiConfig } from '../ai/config';
import { AiError } from '../ai/chat';
import { askQuestion } from '../ai/qa';
import { buildQaNote } from '../util/qaNote';
import { dayKey, formatTime } from '../util/date';
import { useKeyboardHeight } from '../util/keyboard';
import { NoteBody } from '../components/NoteBody';
import { ReasoningStream } from '../components/ReasoningStream';
import { ScreenHeader } from '../components/ScreenHeader';

interface Props {
  onClose: () => void;
  /** 存了纪要之后，通知上层刷新时间轴 */
  onSaved: () => void | Promise<void>;
  /**
   * 把「尝试关闭」注册给 App：安卓返回键由 App 统一接（它是最后注册的，
   * 天然抢不过），所以这里必须是 App 主动转发，而不是自己再挂一个监听。
   */
  registerClose: (fn: (() => void) | null) => void;
}

const THINK_KEY = 'qa.thinking';
const WEB_KEY = 'qa.web';

export function AskScreen({ onClose, onSaved, registerClose }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [turns, setTurns] = useState<QaTurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  /** 正在回答的那个问题，先上屏让用户看到自己问了什么 */
  const [pendingQ, setPendingQ] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [received, setReceived] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [webNote, setWebNote] = useState('');
  const [thinkingOn, setThinkingOn] = useState(true);
  const [webOn, setWebOn] = useState(false);
  const [sources, setSources] = useState<Record<number, Fragment>>({});
  const [openSource, setOpenSource] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const startedAtRef = useRef(Date.now());
  const scrollRef = useRef<ScrollViewInstance>(null);
  const streamRef = useRef({ lastFlush: 0 });
  const keyboardHeight = useKeyboardHeight();

  // 两个开关的默认值来自上一次使用
  useEffect(() => {
    (async () => {
      try {
        const [t, w] = await Promise.all([repo.getSetting(THINK_KEY), repo.getSetting(WEB_KEY)]);
        if (t !== null) setThinkingOn(t === '1');
        if (w !== null) setWebOn(w === '1');
      } catch {
        /* 读不到就用默认值 */
      }
    })();
  }, []);

  // 计时，让用户知道没卡住
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000)), 500);
    return () => clearInterval(timer);
  }, [busy]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, []);

  /**
   * 关闭：没有问答直接退；有问答先问要不要留纪要。
   * 覆盖层已经开着时，再按一次等于「取消」，不退页面。
   */
  const attemptClose = useCallback(() => {
    if (confirmOpen) {
      setConfirmOpen(false);
      return;
    }
    if (busy) return;
    if (!turns.length) {
      onClose();
      return;
    }
    setConfirmOpen(true);
  }, [busy, confirmOpen, onClose, turns.length]);

  useEffect(() => {
    registerClose(attemptClose);
    return () => registerClose(null);
  }, [attemptClose, registerClose]);

  async function toggleThinking() {
    const next = !thinkingOn;
    setThinkingOn(next);
    try {
      await repo.setSetting(THINK_KEY, next ? '1' : '0');
    } catch {
      /* 记不住只是下次回到默认值 */
    }
  }

  async function toggleWeb() {
    const next = !webOn;
    setWebOn(next);
    try {
      await repo.setSetting(WEB_KEY, next ? '1' : '0');
    } catch {
      /* 同上 */
    }
  }

  async function send() {
    const question = input.trim();
    if (!question || busy) return;
    setInput('');
    setPendingQ(question);
    setBusy(true);
    setError('');
    setWebNote(webOn ? '正在同时搜本地和网络…' : '');
    setReasoning('');
    setReceived(0);
    setElapsed(0);
    streamRef.current.lastFlush = 0;
    scrollToEnd();

    try {
      let config: AiConfig;
      try {
        config = await loadAiConfig();
      } catch (e) {
        throw new AiError('nokey', (e as Error)?.message || '读不到 AI 配置');
      }
      if (!config.apiKey) throw new AiError('nokey', '还没配置 API Key，先去设置页填一个');

      const run = await askQuestion({
        question,
        turns,
        // 深度思考开关只影响这一场，不动全局设置
        config: { ...config, thinking: thinkingOn },
        thinking: thinkingOn,
        useWeb: webOn,
        onProgress: (patch) => {
          const now = Date.now();
          if (now - streamRef.current.lastFlush < 120) return;
          streamRef.current.lastFlush = now;
          if (patch.reasoning !== undefined) setReasoning(patch.reasoning);
          if (patch.content !== undefined) setReceived(patch.content.length);
        },
      });

      setReasoning(run.reasoning);
      setReceived(run.answer.length);
      setTurns((prev) => [
        ...prev,
        { question, answer: run.answer, sourceIds: run.cited.map((f) => f.id) },
      ]);
      // 把本轮引用到的碎片原文留着，点「来源」时不用再查库
      setSources((prev) => {
        const next = { ...prev };
        for (const f of run.fragments) next[f.id] = f;
        return next;
      });
      setWebNote(
        run.webError
          ? `联网没搜成：${run.webError}。下面是只查你记录的结果。`
          : run.web.length
            ? `联网补了 ${run.web.length} 条网页资料`
            : webOn
              ? '联网开了，但没搜到有用的网页'
              : '',
      );
      if (run.scanned === 0 && run.fragments.length === 0) {
        setWebNote((s) => (s ? `${s}｜本地记录里没检索到相关碎片` : '本地记录里没检索到相关碎片'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '回答失败，再试一次');
    } finally {
      setPendingQ('');
      setBusy(false);
      scrollToEnd();
    }
  }

  async function saveNote() {
    if (saving) return;
    setSaving(true);
    try {
      const text = buildQaNote(turns, startedAtRef.current);
      await repo.insertFragment(text, 'app', startedAtRef.current);
      try {
        await onSaved();
      } catch {
        /* 刷新失败不影响已经写进去的碎片 */
      }
      setConfirmOpen(false);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      setConfirmOpen(false);
    } finally {
      setSaving(false);
    }
  }

  const hasContent = turns.length > 0;

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="问"
        subtitle={hasContent ? `${turns.length} 轮问答 · 只查你的记录` : '只查你自己的记录'}
        onBack={attemptClose}
        right={
          hasContent ? (
            <Pressable
              style={styles.clearBtn}
              onPress={() => {
                // 清空等于重新开一场：纪要的时间戳要用新的开始时间
                startedAtRef.current = Date.now();
                setTurns([]);
                setSources({});
              }}
            >
              <Text style={styles.clearText}>清空</Text>
            </Pressable>
          ) : null
        }
      />

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={scrollToEnd}
      >
        {!hasContent && !pendingQ && (
          <View style={styles.empty}>
            <Ionicons name="chatbubble-ellipses-outline" size={30} color={c.text3} />
            <Text style={styles.emptyTitle}>问点什么</Text>
            <Text style={styles.emptyBody}>
              它会先在你自己的碎片里找，再回答。{'\n'}
              找到了会标出来源，可以点开看原文。
            </Text>
            <View style={styles.samples}>
              {['上次换 NAS 盘是怎么做的', '这周还有什么没做完', '报销的事我记过什么'].map((q) => (
                <Pressable key={q} style={styles.sample} onPress={() => setInput(q)}>
                  <Text style={styles.sampleText}>{q}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {turns.map((t, i) => (
          <View key={`${i}-${t.question.slice(0, 8)}`}>
            <View style={styles.qRow}>
              <View style={styles.qBubble}>
                <Text style={styles.qText}>{t.question}</Text>
              </View>
            </View>

            <View style={styles.aRow}>
              <NoteBody text={t.answer} style={styles.aText} />
              {t.sourceIds.length > 0 && (
                <View style={styles.srcBlock}>
                  <Text style={styles.srcLabel}>来源 {t.sourceIds.length} 条（点开看原文）</Text>
                  {t.sourceIds.map((id) => {
                    const f = sources[id];
                    if (!f) return null;
                    const open = openSource === id;
                    return (
                      <Pressable
                        key={id}
                        onPress={() => setOpenSource(open ? null : id)}
                        style={styles.srcRow}
                      >
                        <View style={styles.srcHead}>
                          <Text style={styles.srcMeta}>
                            {dayKey(f.createdAt)} {formatTime(f.createdAt)}
                          </Text>
                          {f.tags.slice(0, 2).map((tag) => {
                            const col = tagColor(c, tag);
                            return (
                              <View key={tag} style={[styles.tagPill, { backgroundColor: col.bg }]}>
                                <Text style={[styles.tagText, { color: col.fg }]}>{tag}</Text>
                              </View>
                            );
                          })}
                        </View>
                        <Text style={styles.srcBody} numberOfLines={open ? undefined : 2}>
                          {f.content}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          </View>
        ))}

        {pendingQ ? (
          <View>
            <View style={styles.qRow}>
              <View style={styles.qBubble}>
                <Text style={styles.qText}>{pendingQ}</Text>
              </View>
            </View>
            <View style={styles.aRow}>
              {received > 0 ? (
                <Text style={styles.aText}>
                  正在读资料组织回答…（已收到 {received} 字）
                </Text>
              ) : (
                <View style={styles.thinkingRow}>
                  <ActivityIndicator size="small" color={c.text3} />
                  <Text style={styles.thinkingText}>
                    {thinkingOn ? '在想…' : '在读你的记录…'}
                  </Text>
                </View>
              )}
            </View>
          </View>
        ) : null}

        {busy && reasoning ? (
          <ReasoningStream
            title="思考过程"
            text={reasoning}
            received={received}
            elapsed={elapsed}
            thinking={thinkingOn}
            height={180}
          />
        ) : null}

        {!!webNote && !busy ? <Text style={styles.webNote}>{webNote}</Text> : null}
        {!!error ? <Text style={styles.errText}>{error}</Text> : null}
      </ScrollView>

      <View style={[styles.footer, keyboardHeight > 0 && { paddingBottom: 8 }]}>
        <View style={styles.toggleRow}>
          <Pressable style={[styles.toggle, thinkingOn && styles.toggleOn]} onPress={toggleThinking}>
            <Ionicons
              name="bulb-outline"
              size={13}
              color={thinkingOn ? c.accentText : c.text3}
            />
            <Text style={[styles.toggleText, thinkingOn && styles.toggleTextOn]}>深度思考</Text>
          </Pressable>
          <Pressable style={[styles.toggle, webOn && styles.toggleOn]} onPress={toggleWeb}>
            <Ionicons
              name="globe-outline"
              size={13}
              color={webOn ? c.accentText : c.text3}
            />
            <Text style={[styles.toggleText, webOn && styles.toggleTextOn]}>联网搜索</Text>
          </Pressable>
          {busy ? <Text style={styles.busyHint}>回答中…</Text> : null}
        </View>

        <View style={styles.inputRow}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="问点什么…"
            placeholderTextColor={c.text3}
            style={styles.input}
            multiline
            maxLength={500}
            editable={!busy}
          />
          <Pressable
            onPress={send}
            disabled={!input.trim() || busy}
            style={[styles.send, input.trim() && !busy && styles.sendOn]}
            hitSlop={6}
          >
            <Ionicons
              name="arrow-up"
              size={16}
              color={input.trim() && !busy ? c.onAccent : c.text3}
            />
          </Pressable>
        </View>
        <View style={{ height: keyboardHeight }} />
      </View>

      {confirmOpen && (
        <View style={styles.overlay}>
          <Pressable style={styles.overlayBg} onPress={() => setConfirmOpen(false)} />
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>保留这次问答？</Text>
            <Text style={styles.dialogBody}>
              会压成一条「问答纪要」碎片放进时间轴（最多保留最近 6 轮、每答取前几句）。
              存下来之后，下一次整理会把它当普通碎片处理。
            </Text>
            <Pressable
              style={[styles.dialogPrimary, saving && styles.dialogDisabled]}
              onPress={saveNote}
              disabled={saving}
            >
              <Text style={styles.dialogPrimaryText}>{saving ? '正在保存…' : '保存为碎片'}</Text>
            </Pressable>
            <Pressable style={styles.dialogGhost} onPress={onClose}>
              <Text style={styles.dialogGhostText}>不保存，直接退出</Text>
            </Pressable>
            <Pressable style={styles.dialogGhost} onPress={() => setConfirmOpen(false)}>
              <Text style={styles.dialogGhostText}>继续问</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.page },
  content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 20 },

  clearBtn: { paddingHorizontal: 8, paddingVertical: 6 },
  clearText: { fontSize: 12, color: c.text3 },

  empty: { alignItems: 'center', paddingTop: 70, gap: 8 },
  emptyTitle: { fontSize: 15, color: c.text2, fontWeight: '500', marginTop: 4 },
  emptyBody: { fontSize: 12.5, color: c.text3, textAlign: 'center', lineHeight: 20 },
  samples: { marginTop: 16, gap: 8, alignSelf: 'stretch' },
  sample: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sampleText: { fontSize: 13, color: c.text2 },

  qRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16, marginBottom: 10 },
  qBubble: {
    maxWidth: '85%',
    backgroundColor: c.accentBg,
    borderRadius: R.card,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  qText: { fontSize: 14, lineHeight: 21, color: c.accentText },

  aRow: { marginBottom: 6 },
  aText: { fontSize: 14, lineHeight: 23, color: c.text },

  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  thinkingText: { fontSize: 13, color: c.text3 },

  srcBlock: { marginTop: 12, gap: 6 },
  srcLabel: { fontSize: 11, color: c.text3 },
  srcRow: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    paddingHorizontal: 12,
    paddingVertical: 9,
    gap: 5,
  },
  srcHead: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  srcMeta: { fontSize: 10.5, color: c.text3, fontVariant: ['tabular-nums'] },
  tagPill: { borderRadius: R.pill, paddingHorizontal: 6, paddingVertical: 1 },
  tagText: { fontSize: 10, lineHeight: 14 },
  srcBody: { fontSize: 12.5, lineHeight: 19, color: c.text2 },

  webNote: { fontSize: 11, color: c.text3, lineHeight: 17, marginTop: 10 },
  errText: { fontSize: 12, color: c.danger, lineHeight: 19, marginTop: 10 },

  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
    backgroundColor: c.page,
    paddingTop: 8,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: R.pill,
    borderWidth: 0.5,
    borderColor: c.hair,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  toggleOn: { backgroundColor: c.accentBg, borderColor: c.accentBg },
  toggleText: { fontSize: 12, color: c.text3 },
  toggleTextOn: { color: c.accentText },
  busyHint: { fontSize: 11, color: c.text3, marginLeft: 'auto' },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginHorizontal: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
  },
  input: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: c.text,
    maxHeight: 96,
    paddingTop: 4,
    paddingBottom: 4,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
  },
  send: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.hairSoft,
  },
  sendOn: { backgroundColor: c.accent },

  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    padding: 24,
  },
  overlayBg: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: c.scrim,
  },
  dialog: {
    backgroundColor: c.card,
    borderRadius: R.card,
    padding: 20,
    gap: 10,
  },
  dialogTitle: { fontSize: 15, color: c.text, fontWeight: '600' },
  dialogBody: { fontSize: 12, color: c.text2, lineHeight: 19 },
  dialogPrimary: {
    backgroundColor: c.accent,
    borderRadius: R.btn,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 4,
  },
  dialogDisabled: { opacity: 0.6 },
  dialogPrimaryText: { fontSize: 14, color: c.onAccent, fontWeight: '500' },
  dialogGhost: { paddingVertical: 9, alignItems: 'center' },
  dialogGhostText: { fontSize: 13, color: c.text2 },
});
