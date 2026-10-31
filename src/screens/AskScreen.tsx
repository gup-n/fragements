/**
 * 「问」：只查自己记录的问答页。
 *
 * v0.8.8 起它同时是「会话管理器」：
 * - 每轮答完自动把整场会话写进 `ask_sessions`，退出不再问「要不要留纪要」；
 * - 左上角从「返回」变成「历史会话」，左滑也能打开；
 * - 右上角「+」开新会话，「×」退出；
 * - 回答里的 `[F12]` 不再直接显示，渲染成可点的小标，点开是一个底部小面板。
 *
 * 三个仍然成立的取舍：
 * - **不弹 Modal**（Android 红线）：所有层都是 `position:absolute` 覆盖层，
 *   返回键由 App 转发进 `attemptClose`，按层逐级关闭。
 * - **历史会话与会话内容是两份数据**：会话是原始问答，碎片是用户主动「整理为碎片」
 *   才写进去的纪要。这样聊天记录不会污染时间轴，想沉淀时再沉淀。
 * - **引用快照随会话一起存**：重开历史时不用再查库，待办删了、小结换了也还能看到
 *   当时引用的是什么。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  PanResponder,
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
import type { AiConfig, AskSession, Fragment, QaCitation, QaTurn } from '../types';
import { R, useThemedStyles, type Palette } from '../theme';
import { repo } from '../db/repo';
import { loadAiConfig } from '../ai/config';
import { AiError } from '../ai/chat';
import { askQuestion } from '../ai/qa';
import { buildQaNote } from '../util/qaNote';
import { dayKey, formatTime } from '../util/date';
import { useKeyboardHeight } from '../util/keyboard';
import { collectCitations, type CiteRef } from '../util/mdBlocks';
import { NoteBody } from '../components/NoteBody';
import { ReasoningStream } from '../components/ReasoningStream';
import { ScreenHeader } from '../components/ScreenHeader';
import { IconButton } from '../components/IconButton';
import { CitationSheet } from '../components/CitationSheet';
import { Toast } from '../components/Toast';

interface Props {
  onClose: () => void;
  /** 存了纪要 / 整理了会话之后，通知上层刷新时间轴 */
  onSaved: () => void | Promise<void>;
  /**
   * 把「尝试关闭」注册给 App：安卓返回键由 App 统一接（它是最后注册的，
   * 天然抢不过），所以这里必须是 App 主动转发，而不是自己再挂一个监听。
   */
  registerClose: (fn: (() => void) | null) => void;
  /** 从时间轴左滑进来时带上的那条碎片 */
  contextFragment?: Fragment | null;
}

const THINK_KEY = 'qa.thinking';
const WEB_KEY = 'qa.web';

function citeKey(kind: string, id: number) {
  return `${kind}${id}`;
}

/** 历史列表的预览：把 Markdown 外壳剥掉，只留能读的一行 */
function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*>`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 引用编号按「在回答里第一次出现的顺序」排。
 * 这样正文里的小标是 1、2、3，底下的来源列表也是 1、2、3，对得上。
 */
function orderedCitations(turn: QaTurn): QaCitation[] {
  const all = turn.citations ?? [];
  if (!all.length) return [];
  const byKey = new Map(all.map((c) => [citeKey(c.kind, c.id), c]));
  const out: QaCitation[] = [];
  const seen = new Set<string>();
  for (const ref of collectCitations(turn.answer)) {
    const k = citeKey(ref.kind, ref.id);
    if (seen.has(k)) continue;
    const c = byKey.get(k);
    if (!c) continue;
    seen.add(k);
    out.push(c);
  }
  // 模型没在正文里写、但 citations 里有的（理论上不会），附在最后，别让来源丢掉
  for (const c of all) {
    const k = citeKey(c.kind, c.id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** 一条回答 + 它的引用列表。单独抽出来是为了让 useMemo 有地方挂 */
function TurnAnswer({
  turn,
  onCite,
}: {
  turn: QaTurn;
  onCite: (cite: QaCitation) => void;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  const cites = useMemo(() => orderedCitations(turn), [turn]);
  const labels = useMemo(
    () => new Map(cites.map((cite, i) => [citeKey(cite.kind, cite.id), String(i + 1)])),
    [cites],
  );
  const byKey = useMemo(
    () => new Map(cites.map((cite) => [citeKey(cite.kind, cite.id), cite])),
    [cites],
  );
  const [sourcesOpen, setSourcesOpen] = useState(false);

  const citeLabel = useCallback(
    (ref: CiteRef) => labels.get(citeKey(ref.kind, ref.id)) ?? null,
    [labels],
  );
  const openCite = useCallback(
    (ref: CiteRef) => {
      const cite = byKey.get(citeKey(ref.kind, ref.id));
      if (cite) onCite(cite);
    },
    [byKey, onCite],
  );

  return (
    <View style={styles.aRow}>
      <NoteBody text={turn.answer} style={styles.aText} citeLabel={citeLabel} onCite={openCite} />

      {cites.length > 0 ? (
        <View style={styles.srcBlock}>
          <Pressable
            style={styles.srcToggle}
            onPress={() => setSourcesOpen((v) => !v)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={sourcesOpen ? '收起引用来源' : '展开引用来源'}
          >
            <Ionicons name="link-outline" size={13} color={c.text3} />
            <Text style={styles.srcLabel}>参考 {cites.length} 条</Text>
            <Ionicons
              name={sourcesOpen ? 'chevron-up' : 'chevron-down'}
              size={12}
              color={c.text3}
            />
          </Pressable>

          {sourcesOpen
            ? cites.map((cite, i) => (
                <Pressable
                  key={citeKey(cite.kind, cite.id)}
                  style={styles.srcRow}
                  onPress={() => onCite(cite)}
                >
                  <Text style={styles.srcIndex}>{i + 1}</Text>
                  <Text style={styles.srcTitle} numberOfLines={1}>
                    {cite.label}
                  </Text>
                  <Ionicons name="chevron-forward" size={12} color={c.text3} />
                </Pressable>
              ))
            : null}
        </View>
      ) : null}
    </View>
  );
}

export function AskScreen({ onClose, onSaved, registerClose, contextFragment }: Props) {
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
  /** 从某条碎片进来时带着它；可以点 × 去掉 */
  const [context, setContext] = useState<Fragment | null>(contextFragment ?? null);
  /** 点开的引用小面板 */
  const [cite, setCite] = useState<QaCitation | null>(null);

  /* ---- 当前会话 ---- */
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const sessionIdRef = useRef<number | null>(null);
  /**
   * 会话代次。新建 / 切换会话时 +1。
   * 保存是异步的：上一场还没写完就点了「+」，回来不能把旧标题、旧 id 写到新会话上。
   */
  const sessionGenRef = useRef(0);
  /** 有没有「还没成功落库」的新轮次。退出时只补这一种，避免每次关闭都把会话顶到最前 */
  const dirtyRef = useRef(false);
  const startedAtRef = useRef(Date.now());

  /* ---- 历史会话 ---- */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sessions, setSessions] = useState<AskSession[]>([]);
  const [actionSession, setActionSession] = useState<AskSession | null>(null);
  const [deleteSession, setDeleteSession] = useState<AskSession | null>(null);
  const [working, setWorking] = useState<'' | 'archive' | 'convert' | 'delete'>('');

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollRef = useRef<ScrollViewInstance>(null);
  const streamRef = useRef({ lastFlush: 0 });
  const keyboardHeight = useKeyboardHeight();

  /** PanResponder 只建一次，必须通过 ref 读最新的 busy/覆盖层状态 */
  const busyRef = useRef(busy);
  const historyRef = useRef(historyOpen);
  /** 任一层覆盖物开着时都不接管左滑，否则会在操作面板底下打开历史 */
  const overlayRef = useRef(false);
  busyRef.current = busy;
  historyRef.current = historyOpen;
  overlayRef.current = historyOpen || !!actionSession || !!deleteSession || !!cite;

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

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

  // 从时间轴带进来的上下文。正常情况下 AskScreen 会重新挂载；
  // 这里仍然跟着 prop 走，避免上层换了一条碎片而页面没换。
  useEffect(() => {
    setContext(contextFragment ?? null);
  }, [contextFragment?.id]);

  // 计时，让用户知道没卡住
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(
      () => setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000)),
      500,
    );
    return () => clearInterval(timer);
  }, [busy]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      setSessions(await repo.listAskSessions(true));
    } catch {
      setSessions([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const openHistory = useCallback(() => {
    if (busyRef.current) return;
    setActionSession(null);
    setDeleteSession(null);
    setHistoryOpen(true);
    void loadHistory();
  }, [loadHistory]);

  /**
   * 把当前会话写进历史。
   *
   * 每答完一轮就写，而不是等退出时才写：进程被杀、切走、闪退都不会丢。
   * 失败只静默 —— 保存历史不该拦着用户看答案。
   */
  const persistSession = useCallback(
    async (list: QaTurn[], titleHint?: string | null) => {
      if (!list.length) return;
      const gen = sessionGenRef.current;
      const id = sessionIdRef.current;
      const rawTitle = (titleHint ?? sessionTitle ?? list[0]?.question ?? '新会话')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 32);
      const title = rawTitle || '新会话';
      try {
        const nextId = await repo.saveAskSession({
          id: id ?? undefined,
          title,
          turns: list,
          createdAt: startedAtRef.current,
        });
        // 保存期间用户可能已经新建/切换会话，那就只落库，不再改当前界面状态
        if (sessionGenRef.current !== gen) return;
        if (id === null) {
          sessionIdRef.current = nextId;
          setSessionId(nextId);
        }
        setSessionTitle(title);
        dirtyRef.current = false;
      } catch {
        /* 会话保存失败不拦问答 */
      }
    },
    [sessionTitle],
  );

  /**
   * 关闭：按层逐级退。先关引用面板，再关操作层/历史，最后退页面。
   * 会话已经每轮自动存过，这里不再问「要不要留纪要」。
   */
  const attemptClose = useCallback(() => {
    if (cite) {
      setCite(null);
      return;
    }
    if (deleteSession) {
      setDeleteSession(null);
      return;
    }
    if (actionSession) {
      setActionSession(null);
      return;
    }
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    if (busy) return;
    if (dirtyRef.current) void persistSession(turns);
    onClose();
  }, [actionSession, busy, cite, deleteSession, historyOpen, onClose, persistSession, turns]);

  useEffect(() => {
    registerClose(attemptClose);
    return () => registerClose(null);
  }, [attemptClose, registerClose]);

  /**
   * 左滑打开历史。
   *
   * 用 capture 阶段抢横向手势：ScrollView 会先接竖直滚动，但横向滑它不接，
   * 父层不 capture 的话这个手势会被吞掉。阈值 28px、且横向明显大于纵向才接管。
   */
  const openHistoryRef = useRef(openHistory);
  openHistoryRef.current = openHistory;
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) =>
        !busyRef.current &&
        !overlayRef.current &&
        g.dx < -28 &&
        Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
      onPanResponderMove: () => undefined,
      onPanResponderRelease: () => {
        if (!busyRef.current && !overlayRef.current) openHistoryRef.current();
      },
      onPanResponderTerminate: () => undefined,
    }),
  ).current;

  /** 新建一场。旧会话已经自动存好，这里只重置当前视图 */
  function newSession() {
    if (busy) return;
    void persistSession(turns);
    // 先让上一场的保存拿到旧代次，再切代次；否则它回来会改到新会话上
    sessionGenRef.current += 1;
    dirtyRef.current = false;
    setTurns([]);
    setSessionId(null);
    sessionIdRef.current = null;
    setSessionTitle(null);
    startedAtRef.current = Date.now();
    setInput('');
    setError('');
    setWebNote('');
    setPendingQ('');
    setReasoning('');
    setReceived(0);
    setElapsed(0);
    setCite(null);
    setHistoryOpen(false);
    setActionSession(null);
    setDeleteSession(null);
    setContext(null);
  }

  /** 打开一个历史会话 */
  function loadSession(s: AskSession) {
    if (busy) return;
    sessionGenRef.current += 1;
    dirtyRef.current = false;
    setTurns(s.turns);
    setSessionId(s.id);
    sessionIdRef.current = s.id;
    setSessionTitle(s.title);
    startedAtRef.current = s.createdAt;
    setHistoryOpen(false);
    setActionSession(null);
    setDeleteSession(null);
    setCite(null);
    setInput('');
    setError('');
    setWebNote('');
    setPendingQ('');
    setReasoning('');
    setReceived(0);
    setElapsed(0);
    setContext(null);
  }

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
        config: { ...config, thinking: thinkingOn },
        thinking: thinkingOn,
        useWeb: webOn,
        contextIds: context ? [context.id] : [],
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
      const turn: QaTurn = {
        question,
        answer: run.answer,
        sourceIds: run.cited.map((f) => f.id),
        citations: run.citations,
      };
      const next = [...turns, turn];
      setTurns(next);
      dirtyRef.current = true;
      void persistSession(next);

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

  async function archiveSession(s: AskSession) {
    if (working) return;
    setWorking('archive');
    try {
      await repo.setAskSessionArchived(s.id, !s.archived);
      await loadHistory();
      setActionSession(null);
      showToast(s.archived ? '已取消归档' : '已归档');
    } catch {
      showToast('操作失败，再试一次');
    } finally {
      setWorking('');
    }
  }

  /**
   * 整理为碎片：走 `buildQaNote`，和旧的「退出存纪要」是同一份压缩规则
   * （最近 6 轮、每答前几句）。这样时间轴里不会突然多出一篇几千字的原始聊天记录。
   */
  async function convertSession(s: AskSession) {
    if (working) return;
    if (s.fragmentId) {
      showToast('这条会话已经整理过');
      return;
    }
    setWorking('convert');
    try {
      const text = buildQaNote(s.turns, s.createdAt);
      const fragmentId = await repo.insertFragment(text, 'app', s.createdAt);
      await repo.markAskSessionConverted(s.id, fragmentId);
      try {
        await onSaved();
      } catch {
        /* 刷新失败不影响已经写进去的碎片 */
      }
      await loadHistory();
      setActionSession(null);
      showToast('已存为一条碎片');
    } catch {
      showToast('整理失败，再试一次');
    } finally {
      setWorking('');
    }
  }

  async function confirmDeleteSession() {
    if (!deleteSession || working) return;
    setWorking('delete');
    try {
      const id = deleteSession.id;
      await repo.deleteAskSession(id);
      if (sessionIdRef.current === id) {
        sessionGenRef.current += 1;
        dirtyRef.current = false;
        setTurns([]);
        setSessionId(null);
        sessionIdRef.current = null;
        setSessionTitle(null);
        startedAtRef.current = Date.now();
      }
      setDeleteSession(null);
      await loadHistory();
      showToast('会话已删除');
    } catch {
      showToast('删除失败，再试一次');
    } finally {
      setWorking('');
    }
  }

  const hasContent = turns.length > 0;

  /** 按「今天 / 昨天 / 更早」分组，归档的单独放最后 */
  const history = useMemo(() => {
    const active = sessions.filter((s) => !s.archived);
    const archived = sessions.filter((s) => s.archived);
    const today = dayKey(Date.now());
    const yesterday = dayKey(Date.now() - 86_400_000);
    const map = new Map<string, AskSession[]>();
    for (const s of active) {
      const key = dayKey(s.updatedAt);
      const label = key === today ? '今天' : key === yesterday ? '昨天' : '更早';
      const list = map.get(label) ?? [];
      list.push(s);
      map.set(label, list);
    }
    return { groups: Array.from(map.entries()), archived };
  }, [sessions]);

  /** 历史行。没有 hooks，可以放在组件里当普通函数 */
  function historyRow(s: AskSession) {
    const last = s.turns[s.turns.length - 1];
    return (
      <View key={s.id} style={styles.histRow}>
        <Pressable
          style={styles.histMain}
          onPress={() => loadSession(s)}
          accessibilityRole="button"
          accessibilityLabel={`打开会话 ${s.title}`}
        >
          <View style={styles.histTop}>
            <Text style={styles.histTitle} numberOfLines={1}>
              {s.title}
            </Text>
            {s.fragmentId ? <Text style={styles.histBadge}>已整理</Text> : null}
            {s.archived ? <Text style={styles.histArchived}>已归档</Text> : null}
          </View>
          <Text style={styles.histMeta}>
            {dayKey(s.updatedAt)} {formatTime(s.updatedAt)} · {s.turns.length} 轮
          </Text>
          {last ? (
            <Text style={styles.histPreview} numberOfLines={2}>
              {plainPreview(last.answer)}
            </Text>
          ) : null}
        </Pressable>
        <IconButton
          name="ellipsis-horizontal"
          size={18}
          tone="soft"
          diameter={30}
          onPress={() => setActionSession(s)}
          accessibilityLabel={`管理会话 ${s.title}`}
        />
      </View>
    );
  }

  return (
    <View style={styles.root} {...pan.panHandlers}>
      <ScreenHeader
        title="问"
        subtitle={hasContent ? `${turns.length} 轮问答` : undefined}
        onBack={openHistory}
        backIcon="time-outline"
        backLabel="历史会话"
        right={
          <View style={styles.headerRight}>
            <IconButton
              name="add"
              size={21}
              tone="soft"
              onPress={newSession}
              accessibilityLabel="新建会话"
            />
            <IconButton
              name="close"
              size={20}
              tone="soft"
              onPress={attemptClose}
              disabled={busy}
              accessibilityLabel="关闭"
            />
          </View>
        }
      />

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[styles.content, !hasContent && !pendingQ && styles.contentEmpty]}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={scrollToEnd}
      >
        {!hasContent && !pendingQ ? (
          <View style={styles.empty}>
            <Ionicons name="chatbubble-ellipses-outline" size={30} color={c.text3} />
            <Text style={styles.emptyTitle}>问点什么</Text>
            <Text style={styles.emptyBody}>
              它会先在你自己的碎片里找，再回答。{'\n'}
              找到的来源会标在回答里，点一下就能看原文。
            </Text>
          </View>
        ) : null}

        {turns.map((t, i) => (
          <View key={`${i}-${t.question.slice(0, 8)}`}>
            <View style={styles.qRow}>
              <View style={styles.qBubble}>
                <Text style={styles.qText}>{t.question}</Text>
              </View>
            </View>
            <TurnAnswer turn={t} onCite={setCite} />
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
                <Text style={styles.aText}>正在读资料组织回答…（已收到 {received} 字）</Text>
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
        {context ? (
          <View style={styles.contextBar}>
            <Ionicons name="link-outline" size={13} color={c.accentText} />
            <Text style={styles.contextText} numberOfLines={1}>
              围绕这条记录：{context.content.replace(/\s+/g, ' ')}
            </Text>
            <Pressable
              onPress={() => setContext(null)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="移除这条上下文"
            >
              <Ionicons name="close" size={13} color={c.text3} />
            </Pressable>
          </View>
        ) : null}

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

      {/* ---------------- 历史会话 ---------------- */}
      {historyOpen ? (
        <View style={styles.historyPage}>
          <ScreenHeader
            title="历史会话"
            subtitle={`${sessions.filter((s) => !s.archived).length} 个会话`}
            onBack={() => setHistoryOpen(false)}
            right={
              <IconButton
                name="add"
                size={21}
                tone="soft"
                onPress={newSession}
                accessibilityLabel="新建会话"
              />
            }
          />

          {historyLoading ? (
            <View style={styles.historyLoading}>
              <ActivityIndicator size="small" color={c.text3} />
              <Text style={styles.thinkingText}>正在读历史…</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.historyContent}>
              {history.groups.length === 0 && history.archived.length === 0 ? (
                <View style={styles.historyEmpty}>
                  <Ionicons name="time-outline" size={28} color={c.text3} />
                  <Text style={styles.emptyTitle}>还没有历史会话</Text>
                  <Text style={styles.emptyBody}>问过的问题会自动留在这里，下次回来接着聊。</Text>
                </View>
              ) : null}

              {history.groups.map(([label, list]) => (
                <View key={label}>
                  <Text style={styles.histGroupTitle}>{label}</Text>
                  {list.map(historyRow)}
                </View>
              ))}

              {history.archived.length > 0 ? (
                <View>
                  <Text style={styles.histGroupTitle}>已归档 · {history.archived.length}</Text>
                  {history.archived.map(historyRow)}
                </View>
              ) : null}
            </ScrollView>
          )}
        </View>
      ) : null}

      {/* ---------------- 会话操作 ---------------- */}
      {actionSession ? (
        <View style={styles.sheetOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setActionSession(null)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle} numberOfLines={2}>
              {actionSession.title}
            </Text>
            <Text style={styles.sheetSub}>
              {actionSession.turns.length} 轮 · {dayKey(actionSession.createdAt)}
            </Text>

            <Pressable
              style={styles.sheetAction}
              onPress={() => archiveSession(actionSession)}
              disabled={working !== ''}
            >
              <Ionicons
                name={actionSession.archived ? 'arrow-undo-outline' : 'archive-outline'}
                size={18}
                color={c.text2}
              />
              <Text style={styles.sheetActionText}>
                {actionSession.archived ? '取消归档' : '归档'}
              </Text>
            </Pressable>

            <Pressable
              style={styles.sheetAction}
              onPress={() => convertSession(actionSession)}
              disabled={!!actionSession.fragmentId || working !== ''}
            >
              <Ionicons
                name="document-text-outline"
                size={18}
                color={actionSession.fragmentId ? c.text3 : c.text2}
              />
              <Text
                style={[
                  styles.sheetActionText,
                  !!actionSession.fragmentId && { color: c.text3 },
                ]}
              >
                {actionSession.fragmentId ? '已整理为碎片' : '整理为碎片'}
              </Text>
            </Pressable>

            <Pressable
              style={styles.sheetAction}
              onPress={() => {
                setDeleteSession(actionSession);
                setActionSession(null);
              }}
              disabled={working !== ''}
            >
              <Ionicons name="trash-outline" size={18} color={c.danger} />
              <Text style={[styles.sheetActionText, { color: c.danger }]}>删除会话</Text>
            </Pressable>

            <Pressable style={styles.sheetCancel} onPress={() => setActionSession(null)}>
              <Text style={styles.sheetCancelText}>取消</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* ---------------- 删除确认 ---------------- */}
      {deleteSession ? (
        <View style={styles.dialogOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setDeleteSession(null)} />
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>删除这个会话？</Text>
            <Text style={styles.dialogBody}>
              「{deleteSession.title}」的问答记录会从历史里移除，无法恢复。
              已经整理成碎片的副本不受影响。
            </Text>
            <View style={styles.dialogActions}>
              <Pressable onPress={() => setDeleteSession(null)} hitSlop={8}>
                <Text style={styles.muted}>取消</Text>
              </Pressable>
              <Pressable onPress={confirmDeleteSession} disabled={working === 'delete'} hitSlop={8}>
                <Text style={styles.danger}>
                  {working === 'delete' ? '删除中…' : '删除'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {cite ? <CitationSheet cite={cite} onClose={() => setCite(null)} /> : null}
      <Toast text={toast} bottom={keyboardHeight + 110} />
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.page },
  content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 20 },
  /** 没内容时把「问点什么」放在可视区中间，而不是贴着顶部 */
  contentEmpty: { flexGrow: 1, justifyContent: 'center', paddingBottom: 90 },

  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  empty: { alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 15, color: c.text2, fontWeight: '500', marginTop: 4 },
  emptyBody: { fontSize: 12.5, color: c.text3, textAlign: 'center', lineHeight: 20 },

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
  srcToggle: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  srcLabel: { fontSize: 11, color: c.text3 },
  srcRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  srcIndex: {
    width: 18,
    fontSize: 11,
    lineHeight: 16,
    color: c.accentText,
    fontWeight: '600',
    textAlign: 'center',
  },
  srcTitle: { flex: 1, fontSize: 12.5, color: c.text2 },

  webNote: { fontSize: 11, color: c.text3, lineHeight: 17, marginTop: 10 },
  errText: { fontSize: 12, color: c.danger, lineHeight: 19, marginTop: 10 },

  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
    backgroundColor: c.page,
    paddingTop: 8,
  },
  contextBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: R.btn,
    backgroundColor: c.accentBg,
  },
  contextText: { flex: 1, fontSize: 11.5, color: c.accentText },

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

  /* ---- 历史会话 ---- */
  historyPage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: c.page,
  },
  historyContent: { paddingHorizontal: 16, paddingBottom: 40 },
  historyLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingTop: 40,
  },
  historyEmpty: { alignItems: 'center', gap: 8, paddingTop: 70 },
  histGroupTitle: {
    fontSize: 11.5,
    color: c.text3,
    fontWeight: '600',
    letterSpacing: 0.4,
    marginTop: 18,
    marginBottom: 7,
    marginLeft: 4,
  },
  histRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 9,
    marginBottom: 8,
  },
  histMain: { flex: 1, paddingRight: 4 },
  histTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  histTitle: { flexShrink: 1, fontSize: 13.5, color: c.text, fontWeight: '500' },
  histBadge: {
    fontSize: 10,
    lineHeight: 14,
    color: c.tealText,
    backgroundColor: c.tealBg,
    borderRadius: R.pill,
    paddingHorizontal: 5,
    overflow: 'hidden',
  },
  histArchived: { fontSize: 10, color: c.text3 },
  histMeta: { fontSize: 10.5, color: c.text3, marginTop: 3, fontVariant: ['tabular-nums'] },
  histPreview: { fontSize: 11.5, lineHeight: 17, color: c.text3, marginTop: 4 },

  /* ---- 底部操作面板 ---- */
  sheetOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    backgroundColor: c.scrim,
  },
  sheet: {
    backgroundColor: c.card,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 24,
  },
  sheetTitle: { fontSize: 14.5, color: c.text, fontWeight: '600' },
  sheetSub: { fontSize: 11, color: c.text3, marginTop: 3, marginBottom: 8 },
  sheetAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  sheetActionText: { fontSize: 13.5, color: c.text },
  sheetCancel: { paddingVertical: 11, alignItems: 'center', marginTop: 4 },
  sheetCancelText: { fontSize: 13, color: c.text2 },

  /* ---- 删除确认 ---- */
  dialogOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: c.scrim,
  },
  dialog: {
    backgroundColor: c.card,
    borderRadius: R.card,
    padding: 20,
    gap: 10,
  },
  dialogTitle: { fontSize: 15, color: c.text, fontWeight: '600' },
  dialogBody: { fontSize: 12.5, color: c.text2, lineHeight: 20 },
  dialogActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 22,
    marginTop: 8,
  },
  danger: { fontSize: 13, color: c.danger },
  muted: { fontSize: 13, color: c.text2 },
});
