/**
 * 「问」：问答页。两种范围共用一套界面 ——
 * - `records`：查自己的碎片、小结、待办（v0.7 起的老能力）；
 * - `documents`：**只**查用户在文档页勾中的那几份文档，不碰记录、不联网。
 *
 * v0.12 起范围是会话契约：一场会话锁定一个范围，换集合必须新开会话。
 * 界面上必须一直看得到「这次只问了什么」—— 隐私边界不能只写在代码里。
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
  Animated,
  Linking,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type {
  AiConfig,
  AskSession,
  DocumentCoverage,
  Fragment,
  QaCitation,
  QaScope,
  QaTurn,
} from '../types';
import { useTheme, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { BusyIndicator as ActivityIndicator } from '../components/BusyIndicator';
import { useOrganize, type StartDraftOptions } from '../organize/useOrganize';
import { hasUnsavedWorkspace, remainingIds } from '../organize/workspace';
import { repo } from '../db/repo';
import { loadAiConfig } from '../ai/config';
import { AiError, type AiErrorDetail } from '../ai/chat';
import { askQuestion } from '../ai/qa';
import { docProblem, type DraftMode } from '../util/knowledgeDoc';
import { planDraftInput, routeAsk, showsDraftAsk, TASK_SEED } from '../util/askIntent';
import { KnowledgeDraftCard } from '../components/KnowledgeDraft';
import { AgentError, errorDetailOf } from '../components/AgentError';
import { DraftDocPage } from '../components/DraftDocPage';
import { SummarySheet } from '../components/SummarySheet';
import { DocViewer } from '../components/DocViewer';
import { normalizeQaScope } from '../util/qaScope';
import { dayKey, formatTime } from '../util/date';
import { useKeyboardHeight } from '../util/keyboard';
import { collectCitations, type CiteRef } from '../util/mdBlocks';
import { NoteBody } from '../components/NoteBody';
import { ReasoningFold } from '../components/ReasoningFold';
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
  /** 从时间轴右滑进来时带上的那条碎片 */
  contextFragment?: Fragment | null;
  /**
   * 打开这一页时用户明确选定的范围。不传 = 记录模式。
   * **只用于新会话**：历史会话以它自己保存的范围为准，不能被这里覆盖。
   */
  initialScope?: QaScope;
}

/** 一次失败的全部信息：一句人话 + 可展开的原始证据 */
interface ErrInfo {
  message: string;
  code?: string;
  detail?: AiErrorDetail;
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
 * 解析打开页面时带进来的范围。
 *
 * 带了个读不懂的范围时**不能退回 records**：那是把「只问这两份文档」
 * 悄悄换成「查全库」，方向正好反了（范围变大＝泄露）。所以这里把错误
 * 记下来，由界面挡住发送，让用户回去重选。
 */
function readPageScope(initial?: QaScope): { scope: QaScope; error: string | null } {
  if (!initial) return { scope: { kind: 'records' }, error: null };
  try {
    return { scope: normalizeQaScope(initial), error: null };
  } catch {
    return {
      scope: { kind: 'records' },
      error: '这次没拿到有效的文档范围，先回文档页重新选一份再问',
    };
  }
}

/**
 * 「读了多少」的一行话。只报事实，不粉饰：
 * 用户看到 2/10 就知道答案是基于部分片段来的。
 */
function coverageLine(coverage: DocumentCoverage[]): string {
  const read = coverage.filter((c) => c.includedChunks > 0);
  const missing = coverage.filter((c) => c.includedChunks === 0);
  const parts = read.map((c) => `《${c.name}》${c.includedChunks}/${c.totalChunks} 段`);
  const body = `${parts.slice(0, 3).join(' · ')}${parts.length > 3 ? ` 等 ${parts.length} 份` : ''}`;
  // 全部读完就别说「部分」，把话说准才有用
  const partial = read.some((c) => c.includedChunks < c.totalChunks);
  const head = !read.length
    ? '没有读到可用的片段'
    : partial
      ? `基于部分片段：${body}`
      : `读到的片段：${body}`;
  const absent = missing.length ? `；${missing.map((c) => `《${c.name}》`).join('')}里没找到相关内容` : '';
  return `${head}${absent}`;
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
  /** 打不开链接的原因。就近写在那一块下面，不弹框 */
  const [linkErr, setLinkErr] = useState('');

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

      {turn.documentCoverage?.length ? (
        <Text style={styles.covText}>{coverageLine(turn.documentCoverage)}</Text>
      ) : null}

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

      {/*
        网页来源：**不依赖模型有没有写 [W 编号]**。
        它只在自己真的搜过网时出现，点一下直接开浏览器 ——
        用户说的「网页链接没法点」就是这里缺了一块：内容进了回答，链接却没落地。
      */}
      {turn.webSources?.length ? (
        <View style={styles.webBlock}>
          <Text style={styles.webTitle}>网页来源</Text>
          {turn.webSources.map((w) => (
            <Pressable
              key={w.url}
              style={({ pressed }) => [styles.webRow, pressed && { opacity: 0.6 }]}
              onPress={() => {
                setLinkErr('');
                Linking.openURL(w.url).catch(() =>
                  setLinkErr(`打不开这个链接：${w.url}`),
                );
              }}
              accessibilityRole="link"
              accessibilityLabel={`打开网页 ${w.title}`}
            >
              <Ionicons name="globe-outline" size={12} color={c.text3} />
              <Text style={styles.webRowText} numberOfLines={1}>
                {w.title}
              </Text>
              <Ionicons name="open-outline" size={12} color={c.text3} />
            </Pressable>
          ))}
          {linkErr ? <Text style={styles.webErr}>{linkErr}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

export function AskScreen({
  onClose,
  onSaved,
  registerClose,
  contextFragment,
  initialScope,
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const { reduceMotion } = useTheme();
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;
  /**
   * 这一页的范围（进入页面时明确选定的那个）。新开会话回到它，
   * 而不是继承刚才翻到的那场历史会话 —— 那会变成「悄悄换范围」。
   */
  const [pageScope] = useState(() => readPageScope(initialScope));
  const [scope, setScope] = useState<QaScope>(pageScope.scope);
  /** 范围读不出来时的说明。非空就挡住发送，别拿错的边界去查 */
  const [scopeProblem, setScopeProblem] = useState<string | null>(pageScope.error);
  /** 文档名只用于显示范围；读不到不影响提问 */
  const [docNames, setDocNames] = useState<string[]>([]);
  const [turns, setTurns] = useState<QaTurn[]>([]);
  const [input, setInput] = useState('');
  /** 最后一句话。失败卡上的「重试」用它，否则输入框已清空就重发不出去 */
  const [lastQ, setLastQ] = useState('');
  const [busy, setBusy] = useState(false);
  /** 正在回答的那个问题，先上屏让用户看到自己问了什么 */
  const [pendingQ, setPendingQ] = useState('');
  const [reasoning, setReasoning] = useState('');
  /** 刚答完的那一轮默认展开思考过程；历史加载的轮次不自动展开 */
  const [openReasoningKey, setOpenReasoningKey] = useState<string | null>(null);
  const [received, setReceived] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  /**
   * 问答失败时的完整信息。
   *
   * 原来这里只是一个字符串，于是「模型名不存在」「余额不足」这类
   * 重试也不会好的错误，在界面上和「网络抖了一下」长得一模一样。
   */
  const [error, setError] = useState<ErrInfo | null>(null);
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
   * 当前轮次，供异步路径（整理写完历史）读取。
   *
   * 整理是跑在 `startDraft` 的闭包里的：等模型回来时，`turns` 可能还是几分钟前
   * 那一份。用它去拼「已有轮次 + 这次整理」，会把期间问过的一轮悄悄抹掉。
   */
  const turnsRef = useRef<QaTurn[]>([]);
  turnsRef.current = turns;
  /**
   * 当前范围，供 `persistSession` 这类不在渲染闭包里的路径读取。
   * 每帧同步一次：保存必须用「产生这些轮次的那个范围」，
   * 不能等异步回来时再读 state（那时可能已经是新会话的范围了）。
   */
  const scopeRef = useRef<QaScope>(scope);
  scopeRef.current = scope;
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
  /** 一场会话整理出的多篇文档，点「已写入 N 篇」时列出来 */
  const [sessionDocs, setSessionDocs] = useState<AskSession | null>(null);
  /** 文档 id → 标题。只在打开那个列表时查一次 */
  const [docTitles, setDocTitles] = useState<Map<number, string>>(new Map());
  const [working, setWorking] = useState<'' | 'archive' | 'delete'>('');

  /* 整理拥有独立、可恢复的工作区，页面不再复制它的授权与进度状态。 */
  const organize = useOrganize({
    context, scope,
    getOwner: () => ({ id: sessionIdRef.current, title: sessionTitle || '', turns: turnsRef.current, scope: scopeRef.current, createdAt: startedAtRef.current }),
    getSessionGeneration: () => sessionGenRef.current,
    onSessionUpdated: (owner, previousId) => {
      if (sessionIdRef.current !== previousId) return;
      sessionIdRef.current = owner.id; setSessionId(owner.id);
      setSessionTitle(owner.title); setTurns(owner.turns); turnsRef.current = owner.turns;
      dirtyRef.current = false;
    },
    onRestoreOwner: (owner) => {
      sessionGenRef.current += 1; dirtyRef.current = false;
      sessionIdRef.current = owner.id; setSessionId(owner.id);
      setSessionTitle(owner.title || null); startedAtRef.current = owner.createdAt;
      setTurns(owner.turns); turnsRef.current = owner.turns;
      setScope(owner.scope); setScopeProblem(null); setContext(null); setHistoryOpen(false);
    },
    onSaved,
    onHistoryChanged: () => loadHistory(),
    showToast: (message) => showToast(message),
  });
  const draft = organize.workspace?.draft ?? null;
  const draftBusy = organize.busy;
  const savingDraft = organize.saving;
  const draftErr = organize.error;
  const draftSteps = organize.workspace?.steps ?? [];
  const draftNote = organize.workspace?.note ?? '';
  const draftAsk = organize.workspace?.draftAsk ?? '';
  const draftRecv = organize.received;
  const draftElapsed = organize.elapsed;
  const draftReasoning = organize.reasoning;
  const allowDoc = organize.workspace?.allowDoc ?? true;
  const allowTodos = organize.workspace?.allowTodos ?? true;
  const savedDocs = organize.workspace?.receipt.documents ?? [];
  const leftover = organize.workspace ? remainingIds(organize.workspace).length : 0;
  const setDraft = organize.changeDraft;
  const setAllowDoc = organize.setAllowDoc;
  const setAllowTodos = organize.setAllowTodos;
  const [draftDoc, setDraftDoc] = useState<{ key: string; mode: 'read' | 'edit' } | null>(null);
  const [newHint, setNewHint] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState(false);

  /** 文档阅读器（从历史会话跳进来，或写完直接看） */
  const [openDocId, setOpenDocId] = useState<number | null>(null);
  const [docReload, setDocReload] = useState(0);
  /** 月小结面板 */
  const [summaryOpen, setSummaryOpen] = useState(false);

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
  busyRef.current = busy || draftBusy || savingDraft;
  historyRef.current = historyOpen;
  overlayRef.current =
    historyOpen ||
    draftDoc !== null ||
    !!actionSession ||
    !!deleteSession ||
    !!sessionDocs ||
    !!cite ||
    !!draft ||
    summaryOpen ||
    openDocId !== null;

  const newHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 顶部闪一条「已在新对话中」。
   *
   * 1.6 秒：够读完这行字，又不至于一直杵在那里挡视线。
   * 半透明黑 + 白字，和底部的 Toast 刻意不同 —— 一个在说「你做了什么」，
   * 一个在说「什么都没发生」，位置和质感都该区分开。
   */
  const flashNewHint = useCallback(() => {
    setNewHint(true);
    if (newHintTimer.current) clearTimeout(newHintTimer.current);
    newHintTimer.current = setTimeout(() => setNewHint(false), 1600);
  }, []);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (newHintTimer.current) clearTimeout(newHintTimer.current);
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

  // 文档范围要能看到具体是哪几份。名字只用于显示，读不到就退成编号
  useEffect(() => {
    if (scope.kind !== 'documents') {
      setDocNames([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const all = await repo.listDocuments();
        if (!alive) return;
        const byId = new Map(all.map((d) => [d.id, d.name]));
        setDocNames(scope.documentIds.map((id) => byId.get(id) ?? `文档 ${id}`));
      } catch {
        /* 名字读不到不影响提问，范围仍然靠 id 生效 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [scope]);

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
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: !reduceMotionRef.current }));
  }, []);

  /**
   * 是不是已经贴着底。
   *
   * 键盘弹起会**缩短可视区**（底部那一块让给了输入区），滚动偏移不变，
   * 于是最后几条回答就沉到键盘底下 —— 用户看到的是「键盘挡住了 AI 的记录」。
   * 但也不能一弹键盘就无条件滚到底：正在往上翻旧对话的人会被拽回来。
   * 所以只在「本来就在底部附近」时才跟。
   */
  const atBottomRef = useRef(true);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const gap = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    atBottomRef.current = gap < 80;
  }, []);

  useEffect(() => {
    if (keyboardHeight <= 0) return;
    // 等一帧让 footer 的高度先落定，否则按旧的可视区算，滚不到真正的底
    const timer = setTimeout(() => {
      if (atBottomRef.current) scrollToEnd();
    }, 80);
    return () => clearTimeout(timer);
  }, [keyboardHeight, scrollToEnd]);

  /**
   * 点历史行上的「已写入」徽标。
   *
   * 一篇就直接打开，多篇先列出来 —— 原来这里直接打开 document_id，
   * 多篇之后那个字段只代表第一篇，点进去看到的是「A」，而用户以为整理出的是 B。
   */
  async function openSessionDocs(s: AskSession) {
    const ids = s.documentIds.length ? s.documentIds : s.documentId ? [s.documentId] : [];
    if (!ids.length) return;
    if (ids.length === 1) {
      setDocReload((n) => n + 1);
      setOpenDocId(ids[0]);
      return;
    }
    setSessionDocs(s);
    try {
      const all = await repo.listDocuments();
      const byId = new Map(all.map((d) => [d.id, d.name]));
      setDocTitles(byId);
    } catch {
      /* 读不到标题就显示编号，仍然能点进去 */
    }
  }

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
      // 范围在调用的一瞬间取定：await 之后 state 可能已经换了新会话
      const sessionScope = scopeRef.current;
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
          scope: sessionScope,
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
    if (organize.isLocked()) { showToast('先暂停整理，或等待写入完成'); return; }
    if (discardConfirm) { setDiscardConfirm(false); return; }
    if (draftDoc !== null) { setDraftDoc(null); return; }
    if (openDocId !== null) { setOpenDocId(null); return; }
    if (summaryOpen) { setSummaryOpen(false); return; }
    if (cite) { setCite(null); return; }
    if (sessionDocs) { setSessionDocs(null); return; }
    if (deleteSession) { setDeleteSession(null); return; }
    if (actionSession) { setActionSession(null); return; }
    if (historyOpen) { setHistoryOpen(false); return; }
    if (busy) return;
    void (async () => {
      if (!(await organize.suspend())) return;
      if (dirtyRef.current) void persistSession(turnsRef.current);
      onClose();
    })();
  }, [organize, showToast, discardConfirm, draftDoc, openDocId, summaryOpen, cite, sessionDocs,
      deleteSession, actionSession, historyOpen, busy, persistSession, onClose]);

  useEffect(() => {
    registerClose(attemptClose);
    return () => registerClose(null);
  }, [attemptClose, registerClose]);

  const { width: screenW } = useWindowDimensions();
  const widthRef = useRef(screenW);
  widthRef.current = screenW;

  /** PanResponder 只建一次，里面读的是 ref 上的最新 openHistory */
  const openHistoryRef = useRef(openHistory);
  openHistoryRef.current = openHistory;

  /**
   * 历史会话的抽屉：0 = 完全收起，1 = 完全展开。
   *
   * 用户 2026-11-11 的原话是「左滑右滑搞错了，从左往右滑动，问的界面自然而然的
   * 打开历史会话界面，以及我要的仿真效果没有实现」。两件事：
   * - 方向反了：把「左滑」改成「从左往右滑」（手指往右拖）；
   * - 没有仿真：上一版是「滑够 28px 就整块跳出来」，中间没有过渡。
   * 所以这里用动画值，不是布尔值 —— 手指拖多少，抽屉就跟出来多少；
   * 问答页同时往右让出一点，像推一页纸，而不是切一张图。
   */
  const historyAnim = useRef(new Animated.Value(0)).current;
  const [historyMounted, setHistoryMounted] = useState(false);
  /** 正在拖的时候不要被「按状态补动画」的 effect 抢走 */
  const draggingRef = useRef(false);

  const dragProgress = (dx: number) =>
    Math.max(0, Math.min(1, dx / Math.max(1, widthRef.current)));

  const springTo = useCallback(
    (to: number, done?: () => void) => {
      if (reduceMotionRef.current) { historyAnim.setValue(to); done?.(); return; }
      Animated.spring(historyAnim, {
        toValue: to,
        useNativeDriver: false,
        speed: 18,
        bounciness: 0,
      }).start(done);
    },
    [historyAnim],
  );

  /**
   * 状态变化 → 补齐动画。
   *
   * 只有 `historyOpen` 变了才跑：拖动过程中改动的是动画值本身，不是状态，
   * 所以不会出现「手指还按着，页面自己滑走」。
   */
  useEffect(() => {
    if (draggingRef.current) return;
    if (historyOpen) {
      setHistoryMounted(true);
      springTo(1);
      return;
    }
    Animated.timing(historyAnim, {
      toValue: 0,
      duration: reduceMotionRef.current ? 0 : 180,
      useNativeDriver: false,
    }).start(({ finished }) => {
      // 关到一半又被打开：别把正在展开的抽屉卸掉，会闪一下
      if (finished && !historyRef.current) setHistoryMounted(false);
    });
  }, [historyAnim, historyOpen, springTo]);

  /**
   * 问答页上「从左往右」滑 → 把历史拉出来。
   *
   * 阈值只用来决定「要不要接管这个手势」（12px，且横向明显大于纵向），
   * 真正开不开，看松手时拖到了多宽。
   */
  const openPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) =>
        !busyRef.current && !overlayRef.current && g.dx > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderGrant: () => {
        draggingRef.current = true;
        // 手指一动就挂上，否则拖到一半什么都没有，就不是仿真了
        setHistoryMounted(true);
      },
      onPanResponderMove: (_, g) => historyAnim.setValue(dragProgress(g.dx)),
      onPanResponderRelease: (_, g) => {
        draggingRef.current = false;
        if (dragProgress(g.dx) > 0.3 || g.vx > 0.35) {
          openHistoryRef.current();
          return;
        }
        Animated.timing(historyAnim, {
          toValue: 0,
          duration: reduceMotionRef.current ? 0 : 160,
          useNativeDriver: false,
        }).start(() => {
          if (!historyRef.current) setHistoryMounted(false);
        });
      },
      onPanResponderTerminate: () => {
        draggingRef.current = false;
        Animated.timing(historyAnim, {
          toValue: 0,
          duration: reduceMotionRef.current ? 0 : 160,
          useNativeDriver: false,
        }).start(() => {
          if (!historyRef.current) setHistoryMounted(false);
        });
      },
    }),
  ).current;

  /** 历史页上还叠着别的面板时，拖动不该把历史一起关掉 */
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = !!actionSession || !!deleteSession || !!sessionDocs;

  /**
   * 历史页上「从右往左」滑 → 退回去。
   *
   * 和打开是同一对手势（推出来、推回去），全程跟着手指，松手时才决定去留。
   * 阈值不放在进入条件里：进入看 12px，去留看拖过的比例和速度。
   */
  const closePan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) =>
        historyRef.current &&
        !sheetOpenRef.current &&
        g.dx < -12 &&
        Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderGrant: () => {
        draggingRef.current = true;
      },
      onPanResponderMove: (_, g) =>
        historyAnim.setValue(Math.max(0, 1 - dragProgress(-g.dx))),
      onPanResponderRelease: (_, g) => {
        draggingRef.current = false;
        const left = 1 - dragProgress(-g.dx);
        if (left < 0.72 || g.vx < -0.35) {
          setHistoryOpen(false);
          return;
        }
        springTo(1);
      },
      onPanResponderTerminate: () => {
        draggingRef.current = false;
        springTo(1);
      },
    }),
  ).current;
  async function newSession(): Promise<boolean> {
    if (busy || organize.isLocked()) return false;
    if (!(await organize.suspend())) return false;
    if (!turnsRef.current.length && sessionIdRef.current === null) flashNewHint();
    if (dirtyRef.current) void persistSession(turnsRef.current);
    sessionGenRef.current += 1; dirtyRef.current = false;
    setTurns([]); turnsRef.current = [];
    setSessionId(null); sessionIdRef.current = null;
    setSessionTitle(null); startedAtRef.current = Date.now();
    setInput(''); setError(null); setWebNote(''); setPendingQ('');
    setReasoning(''); setOpenReasoningKey(null); setReceived(0); setElapsed(0);
    setCite(null); setHistoryOpen(false); setDraftDoc(null);
    setActionSession(null); setDeleteSession(null); setSessionDocs(null);
    setContext(null); setScope(pageScope.scope); setScopeProblem(pageScope.error);
    return true;
  }
  async function loadSession(s: AskSession) {
    if (busy || organize.isLocked()) return;
    if (s.scopeBroken) { showToast('这场会话的范围读不出来，不能继续问'); return; }
    let nextScope: QaScope;
    try { nextScope = normalizeQaScope(s.scope, true); }
    catch { showToast('这场会话的范围读不出来，不能继续问'); return; }
    if (!(await organize.suspend())) return;
    if (dirtyRef.current) void persistSession(turnsRef.current);
    sessionGenRef.current += 1; dirtyRef.current = false;
    setTurns(s.turns); turnsRef.current = s.turns;
    setSessionId(s.id); sessionIdRef.current = s.id;
    setSessionTitle(s.title); startedAtRef.current = s.createdAt;
    setScope(nextScope); setScopeProblem(null); setHistoryOpen(false);
    setActionSession(null); setDeleteSession(null); setCite(null); setDraftDoc(null);
    setInput(''); setError(null); setWebNote(''); setPendingQ('');
    setReasoning(''); setOpenReasoningKey(null); setReceived(0); setElapsed(0);
    setContext(null); setTimeout(scrollToEnd, 120);
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

  async function send(raw?: string) {
    const question = (raw ?? input).trim();
    if (!question || busy || organize.isLocked()) return;
    if (scopeProblem) {
      // 边界不清楚就不发：宁可让用户回去重选，也不要拿错的范围去查
      setError({ message: scopeProblem });
      return;
    }

    /*
     * 草稿开着的时候，这一句话默认是「改哪里」——「把第二段并进第一段」这种话
     * 任何意图分类器都会判成问答，所以不能靠分类器分流。
     *
     * 但有一条例外：用户明确又要「整理」/「整理待办」。那不是改稿，是要新的一轮。
     * 以前这种话会被塞进改稿，模型拿着草稿改不出新东西，用户看到的就是
     * 「第二次说话没反应」。所以这里分流：
     * - 草稿里**没有还没写入的内容** → 直接开新一轮（丢掉它不会失去任何东西）；
     * - 有没写入的 → 不吞这句话、也不偷偷替换草稿，而是说清下一步该按哪里。
     */
    if (draft) {
      const protectedWork = organize.workspace !== null && hasUnsavedWorkspace(organize.workspace);
      const plan = planDraftInput(question, protectedWork ? 1 : 0);
      if (plan.kind === 'blocked') {
        // 输入不清空：那句话还在，处理完草稿可以直接再发
        showToast('还有未保存内容或未处理材料。请先处理，或点「放弃草稿」明确确认，再开新任务');
        return;
      }
      if (plan.kind === 'new') {
        if (!(await discardDraft())) return;
        await startDraft(plan.mode, { instruction: question });
        return;
      }
      void reviseCurrent(question);
      return;
    }

    const intent = routeAsk(question);
    if (intent.task === 'digest') {
      setInput('');
      setSummaryOpen(true);
      return;
    }
    if (intent.task === 'organize' || intent.task === 'todos') {
      setInput('');
      await startDraft(intent.task === 'todos' ? 'todos' : 'knowledge', {
        instruction: question,
      });
      return;
    }

    const docMode = scope.kind === 'documents';
    setInput('');
    setLastQ(question);
    setPendingQ(question);
    setBusy(true);
    setError(null);
    setWebNote(docMode ? '正在读选定的文档…' : webOn ? '正在同时搜本地和网络…' : '');
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
        // 整理轮不参与问答上下文：它不是用户问过的问题，塞进去会让模型答偏
        turns: turns.filter((t) => t.kind !== 'organize'),
        config: { ...config, thinking: thinkingOn },
        thinking: thinkingOn,
        // 文档模式不联网：来源必须是用户选的那几份
        useWeb: !docMode && webOn,
        contextIds: !docMode && context ? [context.id] : [],
        scope,
        onStage: (text) => setWebNote(text),
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
        /*
         * 网页来源单独存一份：模型没写 [W] 标记时，引用列表里一条网页都没有，
         * 用户就找不到可以点的链接了。这里把这一轮真搜到的页面留下来，
         * 只留标题和 url（正文在 citations 的快照里）。
         */
        webSources: run.web.length
          ? run.web.slice(0, 8).map((h) => ({ title: h.title || h.url, url: h.url }))
          : undefined,
        reasoning: run.reasoning,
        truncated: run.truncated,
        documentCoverage: run.documentCoverage,
      };
      const next = [...turns, turn];
      setTurns(next);
      // 这一轮的思维链默认摊开：否则用户看到的还是「闪一下就没了」
      setOpenReasoningKey(`${turns.length}-${question.slice(0, 8)}`);
      dirtyRef.current = true;
      void persistSession(next);

      // 这一轮顺手读了图里的字（已经写进库），时间轴那份数据要跟上，别再说「还没读」
      if (run.imageReads) {
        try {
          await onSaved();
        } catch {
          /* 刷新失败不影响这一轮的回答 */
        }
      }

      if (docMode) {
        const read = (run.documentCoverage ?? []).reduce((n, x) => n + x.includedChunks, 0);
        const all = (run.documentCoverage ?? []).reduce((n, x) => n + x.totalChunks, 0);
        setWebNote(
          read === 0
            ? '这几份文档里没找到和问题相关的内容'
            : run.truncated
              ? `只读了部分片段（${read} / ${all} 段），答案基于这些片段`
              : '',
        );
      } else {
        /*
         * 联网的提示要能分清三件事（原来全说成「没搜到有用的网页」）：
         * 读了链接 / 搜到了网页 / 联网出错。用户看到的「根本没查」，
         * 就是第三件事被说成了第二件。
         */
        setWebNote(
          run.webError
            ? `联网没成：${run.webError}。下面只查了你的记录。`
            : run.web.length
              ? run.web[0].kind === 'page'
                ? `读了 ${run.web.length} 个链接，答案有引用网页内容`
                : `联网补了 ${run.web.length} 条网页资料`
              : webOn
                ? '联网开了，但没搜到有用的网页'
                : '',
        );
        /*
         * 图是这次提问才读的（上传时不再解析），所以「答之前多等的那几秒」
         * 必须有出处。和联网提示并在一行，比再开一行更省位置。
         */
        if (run.imageReads || run.imageReadFailed) {
          const bits = [
            run.imageReads ? `顺手看了 ${run.imageReads} 张图里的字` : '',
            run.imageReadFailed ? `${run.imageReadFailed} 张没读出来` : '',
          ].filter(Boolean);
          setWebNote((s) => (s ? `${s}｜${bits.join('，')}` : bits.join('，')));
        }
        if (run.scanned === 0 && run.fragments.length === 0) {
          setWebNote((s) => (s ? `${s}｜本地记录里没检索到相关碎片` : '本地记录里没检索到相关碎片'));
        }
      }
    } catch (e) {
      setError(errorDetailOf(e));
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
  async function startDraft(mode: DraftMode, opts: StartDraftOptions = {}) {
    if (busy) return;
    setInput('');
    await organize.start(mode, opts);
  }
  async function reviseCurrent(instruction: string) {
    setInput('');
    await organize.revise(instruction);
  }
  async function discardDraft() {
    const discarded = await organize.discard();
    if (discarded) setDraftDoc(null);
    return discarded;
  }
  async function approveDraft(key: string | null) {
    await organize.approve(key);
  }




  /**
   * 从历史会话重新整理。
   *
   * 优先用当初那批碎片（`sourceIds`），它们被删了才退回会话原文 ——
   * 用会话原文重整理，等于把「AI 当时的回答」再提炼一遍，第二轮会越来越空。
   */
  async function reorganize(s: AskSession) {
    setActionSession(null);
    if (draft || draftBusy) {
      showToast('先把当前草稿处理掉');
      return;
    }
    let fragments: Fragment[] = [];
    if (s.sourceIds.length) {
      try {
        fragments = await repo.findFragmentsByIds(s.sourceIds);
      } catch {
        /* 查不到就退回会话原文，至少还能整理出点东西 */
      }
    }
    if (fragments.length) {
      await startDraft('knowledge', { fragments, session: s });
      return;
    }
    if (!s.turns.length) {
      showToast('这场会话没有可整理的内容');
      return;
    }
    await startDraft('knowledge', { turns: s.turns, session: s });
  }

  async function confirmDeleteSession() {
    if (!deleteSession || working || organize.isLocked()) return;
    if (organize.workspace?.request.owner.id === deleteSession.id || organize.recovery?.request.owner.id === deleteSession.id) { showToast('先保存或放弃这场会话的本地草稿，再删除会话'); return; }
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
        // 会话没了，范围跟着回到这一页的默认值，别留着上一场文档集合的残影
        setScope(pageScope.scope);
        setScopeProblem(pageScope.error);
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
  /** 草稿整页正在看的那一篇。草稿被改（或丢弃）时它会变成 undefined，整页自动关掉 */
  const draftDocCurrent = draft && draftDoc ? draft.docs.find((d) => d.key === draftDoc.key) ?? null : null;
  const docMode = scope.kind === 'documents';
  /** 范围必须一直看得见：隐私边界不能只写在代码里 */
  const scopeLine = docMode
    ? `只问这 ${scope.documentIds.length} 份文档${docNames.length ? `：${docNames.join('、')}` : ''}`
    : '范围：你的碎片、小结与待办';
  /** 能不能发出去：有字、不在忙、范围明确 */
  const canSend = !!input.trim() && !busy && !draftBusy && !savingDraft && !scopeProblem;

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
            {s.documentIds.length || s.documentId ? (
              <Pressable
                onPress={() => void openSessionDocs(s)}
                style={styles.controlButton}
                hitSlop={6}
                accessibilityLabel="打开这场会话整理出的文档"
              >
                <Text style={styles.histBadge}>
                  {s.documentIds.length > 1 ? `已写入 ${s.documentIds.length} 篇` : '已写入文档'}
                </Text>
              </Pressable>
            ) : s.fragmentId ? (
              <Text style={styles.histBadge}>已整理</Text>
            ) : null}
            {s.scope?.kind === 'documents' ? (
              <Text style={styles.histScope}>文档 {s.scope.documentIds.length} 份</Text>
            ) : null}
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

  /*
   * 抽屉跟手时，问答页往右让出一点、压暗一点 —— 这是「仿真」的另一半。
   * 用 useMemo 固定插值节点：每帧新建一个节点会让原生动画重新挂一次，看起来是一跳。
   */
  const { contentX, historyX, dimOpacity } = useMemo(
    () => ({
      contentX: historyAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0, reduceMotion ? 0 : screenW * 0.16],
      }),
      historyX: historyAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [-screenW, 0],
      }),
      dimOpacity: historyAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0, 0.3],
      }),
    }),
    [historyAnim, screenW, reduceMotion],
  );

  return (
    <View style={styles.root} {...openPan.panHandlers}>
      <Animated.View style={[styles.flex, { transform: [{ translateX: contentX }] }]}>
        {/* 已经在新对话里再点「+」：按钮没坏，只是没什么可新建的 */}
        {newHint ? (
          <View style={styles.newHint} pointerEvents="none">
            <Text style={styles.newHintText}>已在新对话中</Text>
          </View>
        ) : null}
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
                disabled={busy || draftBusy || savingDraft}
                accessibilityLabel="新建会话"
              />
              <IconButton
                name="close"
                size={20}
                tone="soft"
                onPress={attemptClose}
                disabled={busy || draftBusy || savingDraft}
                accessibilityLabel="保留草稿并关闭"
              />
            </View>
          }
        />
        {/* 范围常驻在标题下面：一旦滚走，用户就不记得这次到底问了什么 */}
        <View style={styles.scopeBar}>
          <Ionicons
            name={docMode ? 'documents-outline' : 'albums-outline'}
            size={13}
            color={c.text3}
          />
          <Text style={styles.scopeText} numberOfLines={2}>
            {scopeLine}
          </Text>
          {docMode ? <Text style={styles.scopeTag}>不联网</Text> : null}
        </View>
        {scopeProblem ? <Text style={styles.scopeWarn}>{scopeProblem}</Text> : null}

        <ScrollView
          ref={scrollRef}
          contentContainerStyle={[styles.content, !hasContent && !pendingQ && styles.contentEmpty]}
          keyboardShouldPersistTaps="handled"
          onScroll={onScroll}
          scrollEventThrottle={64}
          onContentSizeChange={() => {
            // 只在「正在生成」时跟到底。展开内容、弹键盘也会改高度，
            // 无条件滚到底就是用户说的「打开和编辑自动跳转底部」
            if (busy || pendingQ) scrollToEnd();
          }}
        >
          {organize.recovery && !draft ? (
            <View style={styles.recovery}>
              <Text style={styles.recoveryTitle}>有一份本地整理草稿</Text>
              <Text style={styles.recoveryText}>{organize.recovery.request.source.kind === 'session' ? '会话：' + organize.recovery.request.source.title : '来源快照：' + organize.recovery.request.source.ids.length + ' 条碎片'} · {organize.recovery.draft.docs.length} 篇文档</Text>
              <Text style={styles.recoveryText}>恢复会回到原会话范围，只恢复本地内容，不自动发送模型请求。</Text>
              <View style={styles.recoveryActions}>
                <Pressable style={styles.controlButton} onPress={organize.restore} disabled={busy || savingDraft} accessibilityRole="button"><Text style={styles.ghostBtnText}>恢复草稿</Text></Pressable>
                <Pressable style={styles.controlButton} onPress={() => setDiscardConfirm(true)} disabled={busy || savingDraft} accessibilityRole="button"><Text style={styles.danger}>放弃草稿</Text></Pressable>
              </View>
            </View>
          ) : null}
          {organize.storageError ? <AgentError title="本地草稿未保存" message={organize.storageError} onRetry={() => void (draft ? organize.saveLocal() : organize.reloadRecovery())} /> : null}
          {draftBusy ? (
            <Pressable style={styles.controlButton} onPress={() => void organize.pause()} accessibilityRole="button" accessibilityLabel="暂停后续整理并保留当前材料">
              <Text style={styles.ghostBtnText}>暂停整理 · 保留材料和进度</Text>
            </Pressable>
          ) : null}
          {!hasContent && !pendingQ && !draft && !organize.recovery ? (
            <View style={styles.empty}>
              <Ionicons name="chatbubble-ellipses-outline" size={30} color={c.text3} />
              <Text style={styles.emptyTitle}>{docMode ? '就这几份文档提问' : '问、或者让它整理'}</Text>
              <Text style={styles.emptyBody}>
                {docMode
                  ? '它只会在你选的这几份文档里找答案。\n找到的片段会标在回答里，点一下能看到原文和位置。'
                  : '提问会先在你的碎片里找依据，再把答案写出来。\n整理只提炼能复用的知识，按主题拆成几篇，写之前先给你看。'}
              </Text>

              {!docMode ? (
                <View style={styles.hints}>
                  <Pressable
                    style={styles.hint}
                    onPress={() => void startDraft('knowledge', { instruction: TASK_SEED.organize })}
                    disabled={draftBusy || busy}
                  >
                    <Ionicons name="sparkles-outline" size={16} color={c.accentText} />
                    <View style={styles.hintBody}>
                      <Text style={styles.hintTitle}>整理碎片</Text>
                      <Text style={styles.hintText}>只收做法、结论和参数，按主题拆成几篇</Text>
                    </View>
                  </Pressable>

                  <Pressable
                    style={styles.hint}
                    onPress={() => void startDraft('todos', { instruction: TASK_SEED.todos })}
                    disabled={draftBusy || busy}
                  >
                    <Ionicons name="checkbox-outline" size={16} color={c.accentText} />
                    <View style={styles.hintBody}>
                      <Text style={styles.hintTitle}>整理待办</Text>
                      <Text style={styles.hintText}>抽成两层的待办，已经有的不重复</Text>
                    </View>
                  </Pressable>

                  <Pressable
                    style={styles.hint}
                    onPress={() => setSummaryOpen(true)}
                    disabled={draftBusy || busy}
                  >
                    <Ionicons name="calendar-outline" size={16} color={c.accentText} />
                    <View style={styles.hintBody}>
                      <Text style={styles.hintTitle}>写月小结</Text>
                      <Text style={styles.hintText}>按日期把一个月的事列成表，另挑要紧的写进展</Text>
                    </View>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : null}

          {turns.map((t, i) =>
            t.kind === 'organize' ? (
              /*
               * 整理轮也照问答画（v0.20.4）。
               *
               * 以前它是一张窄卡：✨ + 小字标题 + 小字摘要。同一屏里问答是
               * 「右边气泡 / 左边正文」，整理却是一张灰边卡 —— 用户的评价是
               * 「不太像聊天」。信息一个字没少，只是把「我说了什么」放回右边、
               * 「它产出了什么」放回左边。
               */
              <View key={`${i}-org`}>
                <View style={styles.qRow}>
                  <View style={styles.qBubble}>
                    <Text style={styles.qText}>{t.question}</Text>
                  </View>
                </View>
                <View style={styles.aRow}>
                  <Text style={styles.aText}>{t.answer}</Text>
                </View>
              </View>
            ) : (
              <View key={`${i}-${t.question.slice(0, 8)}`}>
                <View style={styles.qRow}>
                  <View style={styles.qBubble}>
                    <Text style={styles.qText}>{t.question}</Text>
                  </View>
                </View>
                {t.reasoning ? (
                  <ReasoningFold
                    text={t.reasoning}
                    defaultOpen={openReasoningKey === `${i}-${t.question.slice(0, 8)}`}
                  />
                ) : null}
                <TurnAnswer turn={t} onCite={setCite} />
              </View>
            ),
          )}

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
                      {thinkingOn ? '在想…' : docMode ? '在读选定的文档…' : '在读你的记录…'}
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

          {/*
            草稿卡上方那个用户气泡：这次整理是「因为哪句话」才有的。
            判据在 util/askIntent.showsDraftAsk：最后一条历史轮已经是同一句时不画，
            否则写完历史回头一看，同一句话在屏幕上出现两次。
          */}
          {draft && showsDraftAsk(turns, draftAsk) ? (
            <View style={styles.qRow}>
              <View style={styles.qBubble}>
                <Text style={styles.qText}>{draftAsk}</Text>
              </View>
            </View>
          ) : null}

          {draft ? (
            <KnowledgeDraftCard
              draft={draft}
              onChange={setDraft}
              busy={draftBusy}
              received={draftRecv}
              elapsed={draftElapsed}
              reasoning={draftReasoning}
              error={draftErr}
              note={draftNote}
              steps={draftSteps}
              allowDoc={allowDoc}
              allowTodos={allowTodos}
              onAllowDoc={setAllowDoc}
              onAllowTodos={setAllowTodos}
              saving={savingDraft}
              receipt={organize.workspace!.receipt}
              onOpenDoc={(id) => {
                setDocReload((n) => n + 1);
                setOpenDocId(id);
              }}
              onOpenDraft={(key, mode) => setDraftDoc({ key, mode })}
              leftover={leftover}
              onContinueAll={() =>
                void startDraft(draft?.mode ?? 'knowledge', { all: true, append: true })
              }
              onApprove={(index) => void approveDraft(index)}
              onDiscard={() => setDiscardConfirm(true)}
              onRetry={() => void organize.retry()}
            />
          ) : null}

          {!!webNote && !busy ? <Text style={styles.webNote}>{webNote}</Text> : null}
          {error ? (
            <AgentError
              title="回答失败"
              message={error.message}
              code={error.code}
              detail={error.detail}
              onRetry={() => {
                if (lastQ) void send(lastQ);
              }}
            />
          ) : null}
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
                style={styles.controlButton}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="移除这条上下文"
              >
                <Ionicons name="close" size={13} color={c.text3} />
              </Pressable>
            </View>
          ) : null}

          <View style={styles.toggleRow}>
            <Pressable style={[styles.toggle, thinkingOn && styles.toggleOn]} onPress={toggleThinking} accessibilityRole="switch" accessibilityState={{ checked: thinkingOn }}>
              <Ionicons
                name="bulb-outline"
                size={13}
                color={thinkingOn ? c.accentText : c.text3}
              />
              <Text style={[styles.toggleText, thinkingOn && styles.toggleTextOn]}>思考 · {thinkingOn ? '开' : '关'}</Text>
            </Pressable>
            {docMode ? (
              // 文档模式首版直接禁用联网：来源必须只有用户选的那几份
              <View style={[styles.toggle, styles.toggleOff]} accessibilityLabel="文档模式不联网">
                <Ionicons name="cloud-offline-outline" size={13} color={c.text3} />
                <Text style={styles.toggleText}>不联网</Text>
              </View>
            ) : (
              <Pressable style={[styles.toggle, webOn && styles.toggleOn]} onPress={toggleWeb} accessibilityRole="switch" accessibilityState={{ checked: webOn }}>
                <Ionicons
                  name="globe-outline"
                  size={13}
                  color={webOn ? c.accentText : c.text3}
                />
                <Text style={[styles.toggleText, webOn && styles.toggleTextOn]}>联网 · {webOn ? '开' : '关'}</Text>
              </Pressable>
            )}
            {busy ? <Text style={styles.busyHint}>回答中…</Text> : null}
          </View>

          <View style={styles.inputRow}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder={draft ? '说要改哪里，比如「第二段并进第一段」…' : '问点什么，或者让它整理…'}
              placeholderTextColor={c.text3}
              selectionColor={c.selection}
              style={styles.input}
              multiline
              maxLength={500}
              editable={!busy}
            />
            <Pressable
              onPress={() => void send()}
              // 范围有问题时按钮直接不可用：原因就写在上面的红字里
              disabled={!canSend}
              style={[styles.send, canSend && styles.sendOn]}
              hitSlop={6}
            >
              <Ionicons name="arrow-up" size={16} color={canSend ? c.onAccent : c.text3} />
            </Pressable>
          </View>
          <View style={{ height: keyboardHeight }} />
        </View>

      </Animated.View>

      {/* ---------------- 历史会话（右滑拉出来的抽屉） ---------------- */}

      {/* 抽屉推出来时把下面的问答页压暗，眼睛才知道「上面这一层」 */}
      {historyMounted ? (
        <Animated.View pointerEvents="none" style={[styles.scrim, { opacity: dimOpacity }]} />
      ) : null}

      {historyMounted ? (
        <Animated.View
          style={[styles.historyPage, { transform: [{ translateX: historyX }] }]}
          {...closePan.panHandlers}
        >
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
        </Animated.View>
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
              onPress={() => {
                const s = actionSession;
                setActionSession(null);
                if (s) void startDraft('knowledge', { turns: s.turns, session: s });
              }}
              disabled={working !== '' || draftBusy}
            >
              <Ionicons name="sparkles-outline" size={18} color={c.text2} />
              <Text style={styles.sheetActionText}>整理成文档（AI 提炼）</Text>
            </Pressable>

            {actionSession.documentIds.length || actionSession.documentId ? (
              <Pressable
                style={styles.sheetAction}
                onPress={() => {
                  const s2 = actionSession;
                  setActionSession(null);
                  if (s2) void openSessionDocs(s2);
                }}
                disabled={working !== ''}
              >
                <Ionicons name="document-text-outline" size={18} color={c.text2} />
                <Text style={styles.sheetActionText}>
                  打开整理出的文档
                  {actionSession.documentIds.length > 1
                    ? `（${actionSession.documentIds.length} 篇）`
                    : ''}
                </Text>
              </Pressable>
            ) : null}

            <Pressable
              style={styles.sheetAction}
              onPress={() => {
                const s = actionSession;
                if (s) void reorganize(s);
              }}
              disabled={working !== '' || draftBusy}
            >
              <Ionicons name="refresh-outline" size={18} color={c.text2} />
              <Text style={styles.sheetActionText}>重新整理</Text>
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

      {/* ---------------- 一场会话整理出的多篇文档 ---------------- */}
      {sessionDocs ? (
        <View style={styles.sheetOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSessionDocs(null)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle} numberOfLines={2}>
              这场会话整理出的文档
            </Text>
            <Text style={styles.sheetSub}>点一篇打开；文档区里可以继续改或删</Text>
            {(sessionDocs.documentIds.length
              ? sessionDocs.documentIds
              : sessionDocs.documentId
                ? [sessionDocs.documentId]
                : []
            ).map((id) => (
              <Pressable
                key={id}
                style={styles.sheetAction}
                onPress={() => {
                  setSessionDocs(null);
                  setDocReload((n) => n + 1);
                  setOpenDocId(id);
                }}
              >
                <Ionicons name="document-text-outline" size={18} color={c.text2} />
                <Text style={[styles.sheetActionText, { flex: 1 }]} numberOfLines={1}>
                  {docTitles.get(id) ?? `文档 ${id}`}
                </Text>
                <Ionicons name="chevron-forward" size={13} color={c.text3} />
              </Pressable>
            ))}
            <Pressable style={styles.sheetCancel} onPress={() => setSessionDocs(null)}>
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
              <Pressable style={styles.controlButton} onPress={() => setDeleteSession(null)} hitSlop={8}>
                <Text style={styles.muted}>取消</Text>
              </Pressable>
              <Pressable style={styles.controlButton} onPress={confirmDeleteSession} disabled={working === 'delete'} hitSlop={8}>
                <Text style={styles.danger}>
                  {working === 'delete' ? '删除中…' : '删除'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {/* ---------------- 月小结面板 ---------------- */}
      {summaryOpen ? (
        <View style={styles.summaryPage}>
          <SummarySheet
            onClose={() => setSummaryOpen(false)}
            onSaved={async () => {
              setSummaryOpen(false);
              try {
                await onSaved();
              } catch {
                /* 刷新失败不影响已经写进去的小结 */
              }
              showToast('已保存到时间轴');
            }}
          />
        </View>
      ) : null}

      {/* ---------------- 文档阅读（写完直接看 / 历史里跳过来） ---------------- */}
      {openDocId !== null ? (
        <View style={styles.summaryPage}>
          <DocViewer
            docId={openDocId}
            reloadKey={docReload}
            onClose={() => setOpenDocId(null)}
            onChanged={() => setDocReload((n) => n + 1)}
            onAsk={async (ids) => {
              setOpenDocId(null);
              // 文档问和碎片问是两条入口：换范围必须新开会话，别在旧会话上改契约
              if (!(await newSession())) return;
              setScope({ kind: 'documents', documentIds: ids });
            }}
          />
        </View>
      ) : null}

      {/* ---------------- 草稿里的某一篇：整页看 / 整页改 ---------------- */}
      {draft && draftDoc && draftDocCurrent ? (
        <DraftDocPage
          doc={draftDocCurrent}
          key={draftDoc.key}
          index={draft.docs.findIndex((d) => d.key === draftDoc.key)}
          total={draft.docs.length}
          initialMode={draftDoc.mode}
          saved={savedDocs.some((d) => d.key === draftDoc.key)}
          canWrite={allowDoc && draftDocCurrent.keep}
          problem={docProblem(draftDocCurrent)}
          saving={savingDraft}
          onChange={(patch) => setDraft({ ...draft, docs: draft.docs.map((d) => d.key === draftDoc.key ? { ...d, ...patch } : d) })}
          onApprove={() => void approveDraft(draftDoc.key)}
          onClose={() => setDraftDoc(null)}
        />
      ) : null}

      {discardConfirm ? (
        <View style={styles.dialogOverlay}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>放弃这份本地草稿？</Text>
            <Text style={styles.dialogBody}>尚未写入的文档、待办和改稿记录会被移除。已经写入的文档、待办及原始碎片不受影响。</Text>
            <View style={styles.dialogActions}>
              <Pressable style={styles.controlButton} onPress={() => setDiscardConfirm(false)} disabled={savingDraft}><Text style={styles.muted}>保留</Text></Pressable>
              <Pressable style={styles.controlButton} onPress={() => { void discardDraft().then((ok) => { if (ok) setDiscardConfirm(false); }); }} disabled={savingDraft}><Text style={styles.danger}>确认放弃</Text></Pressable>
            </View>
          </View>
        </View>
      ) : null}
      {cite ? <CitationSheet cite={cite} onClose={() => setCite(null)} /> : null}
      <Toast text={toast} bottom={keyboardHeight + 110} />
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.page },
  recovery: { padding: metrics.pagePadding, gap: 8, borderWidth: metrics.strokeWidth, borderColor: c.hair, borderRadius: metrics.cardRadius, backgroundColor: c.card, marginBottom: 16 },
  recoveryTitle: { color: c.text, fontSize: 16, fontWeight: '600', lineHeight: 24 },
  recoveryText: { color: c.text2, fontSize: 13, lineHeight: 21 },
  recoveryActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  controlButton: { minHeight: metrics.controlHeight, minWidth: metrics.controlHeight, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center' },
  /**
   * 「已在新对话中」的提示条。
   *
   * 半透明黑浮在页头下方：它说的是「什么都没发生」，不能长得像一条错误，
   * 也不能像底部 Toast 那样占着输入框的位置。
   */
  newHint: {
    position: 'absolute',
    top: 58,
    alignSelf: 'center',
    zIndex: 30,
    backgroundColor: c.accent,
    borderRadius: metrics.buttonRadius,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  newHintText: { fontSize: 13, color: c.onAccent, fontWeight: '500' },
  content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 20 },
  /** 没内容时把「问点什么」放在可视区中间，而不是贴着顶部 */
  contentEmpty: { flexGrow: 1, justifyContent: 'center', paddingBottom: 90 },

  /* ---- 空态的三张提示框 ---- */
  hints: { alignSelf: 'stretch', gap: 10, marginTop: 22, paddingHorizontal: 4 },
  hint: {
    minHeight: metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: metrics.cardRadius,
    borderWidth: metrics.strokeWidth,
    borderColor: c.hair,
    backgroundColor: c.card,
  },
  hintBody: { flex: 1, gap: 2 },
  hintTitle: { fontSize: 13.5, color: c.text, fontWeight: '600' },
  hintText: { fontSize: 11.5, lineHeight: 17, color: c.text3 },

  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  /* ---- 范围条（常驻） ---- */
  scopeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.hairSoft,
  },
  scopeText: { flex: 1, minWidth: 0, fontSize: 11.5, lineHeight: 17, color: c.text2 },
  scopeTag: {
    fontSize: 10,
    lineHeight: 14,
    color: c.text3,
    borderWidth: metrics.strokeWidth,
    borderColor: c.hair,
    borderRadius: metrics.buttonRadius,
    paddingHorizontal: 6,
    overflow: 'hidden',
  },
  scopeWarn: {
    fontSize: 11.5,
    lineHeight: 17,
    color: c.danger,
    marginHorizontal: 16,
    marginTop: 6,
  },
  /** 只读的开关：看着像开关，但不给点，也不给「关掉后偷偷联网」的错觉 */
  toggleOff: { opacity: 0.75 },

  empty: { alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 15, color: c.text2, fontWeight: '500', marginTop: 4 },
  emptyBody: { fontSize: 12.5, color: c.text3, textAlign: 'center', lineHeight: 20 },

  qRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16, marginBottom: 10 },
  qBubble: {
    maxWidth: '85%',
    backgroundColor: c.accentBg,
    borderRadius: metrics.cardRadius,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  qText: { fontSize: 14, lineHeight: 21, color: c.accentText },

  aRow: { marginBottom: 6 },
  aText: { fontSize: 14, lineHeight: 23, color: c.text },
  /** 「只读了部分片段」的说明。不显眼但必须常驻，不能只写进回答正文 */
  covText: { fontSize: 11, lineHeight: 16, color: c.text3, marginTop: 6 },

  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  thinkingText: { fontSize: 13, color: c.text3 },

  srcBlock: { marginTop: 12, gap: 6 },
  srcToggle: { minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: 5 },
  srcLabel: { fontSize: 11, color: c.text3 },
  srcRow: {
    minHeight: metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: c.card,
    borderRadius: metrics.cardRadius,
    borderWidth: metrics.strokeWidth,
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

  /* ---- 网页来源：这一轮真搜到的页面，点一下开浏览器 ---- */
  webBlock: { marginTop: 10, gap: 4 },
  webTitle: { fontSize: 11, color: c.text3, letterSpacing: 0.3 },
  webRow: {
    minHeight: metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 2,
  },
  webRowText: { flex: 1, fontSize: 12.5, color: c.accentText },
  webMore: { fontSize: 11, color: c.text3, lineHeight: 16 },
  webErr: { fontSize: 11, color: c.danger, lineHeight: 16 },

  webNote: { fontSize: 11, color: c.text3, lineHeight: 17, marginTop: 10 },
  errText: { fontSize: 12, color: c.danger, lineHeight: 19, marginTop: 10 },

  footer: {
    borderTopWidth: metrics.strokeWidth,
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
    borderRadius: metrics.buttonRadius,
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
    minHeight: metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: metrics.buttonRadius,
    borderWidth: metrics.strokeWidth,
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
    borderRadius: metrics.cardRadius,
    borderWidth: metrics.strokeWidth,
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
    width: metrics.controlHeight,
    height: metrics.controlHeight,
    borderRadius: metrics.buttonRadius,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.hairSoft,
  },
  sendOn: { backgroundColor: c.accent },

  /* ---- 历史会话 ---- */
  flex: { flex: 1 },
  /** 抽屉下面那层压暗。transparent 里带 alpha，深浅主题都不用换色 */
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: c.scrim,
  },
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
    borderRadius: metrics.cardRadius,
    borderWidth: metrics.strokeWidth,
    borderColor: c.hair,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 9,
    marginBottom: 8,
  },
  histMain: { minHeight: metrics.controlHeight, justifyContent: 'center', flex: 1, paddingRight: 4 },
  histTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  histTitle: { flexShrink: 1, fontSize: 13.5, color: c.text, fontWeight: '500' },
  histBadge: {
    fontSize: 10,
    lineHeight: 14,
    color: c.tealText,
    backgroundColor: c.tealBg,
    borderRadius: metrics.buttonRadius,
    paddingHorizontal: 5,
    overflow: 'hidden',
  },
  histArchived: { fontSize: 10, color: c.text3 },
  histScope: { fontSize: 10, color: c.text3 },
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
    borderTopLeftRadius: metrics.cardRadius,
    borderTopRightRadius: metrics.cardRadius,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 24,
  },
  sheetTitle: { fontSize: 14.5, color: c.text, fontWeight: '600' },
  sheetSub: { fontSize: 11, color: c.text3, marginTop: 3, marginBottom: 8 },
  sheetAction: {
    minHeight: metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: metrics.strokeWidth,
    borderBottomColor: c.hair,
  },
  sheetActionText: { fontSize: 13.5, color: c.text },
  sheetCancel: { minHeight: metrics.controlHeight, justifyContent: 'center', paddingVertical: 11, alignItems: 'center', marginTop: 4 },
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
    borderRadius: metrics.cardRadius,
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

  /* ---- AI 整理预览 ---- */
  summaryPage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: c.page,
  },
  summaryCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 28,
    paddingBottom: 40,
  },
  summaryBusyTitle: { fontSize: 15, color: c.text, fontWeight: '600', marginTop: 6 },
  summaryBusyBody: {
    fontSize: 12.5,
    color: c.text2,
    lineHeight: 20,
    textAlign: 'center',
  },
  summaryMeta: { fontSize: 11, color: c.text3, fontVariant: ['tabular-nums'], marginTop: 4 },
  summaryError: { fontSize: 13, color: c.danger, lineHeight: 20, textAlign: 'center' },
  summaryButtons: { flexDirection: 'row', gap: 10, marginTop: 8, alignSelf: 'stretch' },
  summaryCancel: { paddingVertical: 10, paddingHorizontal: 18 },

  summaryContent: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24 },
  summaryHint: { fontSize: 11.5, color: c.text3, lineHeight: 18 },
  summaryOmitted: { fontSize: 11.5, color: c.danger, lineHeight: 18, marginTop: 6 },
  summaryBody: { fontSize: 14.5, lineHeight: 23, color: c.text, marginTop: 12 },
  summaryFooter: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
    borderTopWidth: metrics.strokeWidth,
    borderTopColor: c.hair,
  },
  ghostBtn: {
    minHeight: metrics.controlHeight,
    flex: 1,
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: metrics.buttonRadius,
    borderWidth: metrics.strokeWidth,
    borderColor: c.hair,
  },
  ghostBtnText: { fontSize: 13, color: c.text },
  solidBtn: {
    minHeight: metrics.controlHeight,
    flex: 1,
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.accent,
  },
  solidBtnText: { fontSize: 13, color: c.onAccent, fontWeight: '600' },
});
