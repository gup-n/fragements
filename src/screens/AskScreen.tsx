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
  PanResponder,
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
  Fragment,
  QaCitation,
  QaScope,
  QaTurn,
  QaVariant,
} from '../types';
import { SPACE, TYPE, surfaceStroke, useTheme, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { WEB_INPUT_RESET } from '../util/platformStyle';
import { BusyIndicator as ActivityIndicator } from '../components/BusyIndicator';
import { useOrganize, type StartDraftOptions } from '../organize/useOrganize';
import { hasUnsavedWorkspace, remainingIds } from '../organize/workspace';
import { repo } from '../db/repo';
import { loadAiConfig } from '../ai/config';
import { AiError, type AiErrorDetail } from '../ai/chat';
import { askQuestion } from '../ai/qa';
import {
  activeIndexOf,
  historyBefore,
  turnFromVariant,
  variantsOf,
  withActive,
  withVariant,
} from '../ai/variants';
import { docProblem, type DraftMode } from '../util/knowledgeDoc';
import { planDraftInput, routeAsk, showsDraftAsk, TASK_LABEL, TASK_SEED } from '../util/askIntent';
import { KnowledgeDraftCard } from '../components/KnowledgeDraft';
import { AgentError, errorDetailOf } from '../components/AgentError';
import { clampTitle, cutPrefix } from '../util/text';
import { DraftDocPage } from '../components/DraftDocPage';
import { SummarySheet } from '../components/SummarySheet';
import { DocViewer } from '../components/DocViewer';
import { normalizeQaScope } from '../util/qaScope';
import { dayKey } from '../util/date';
import { useKeyboardHeight } from '../util/keyboard';
import { ReasoningFold } from '../components/ReasoningFold';
import { ReasoningStream } from '../components/ReasoningStream';
import { ScreenHeader } from '../components/ScreenHeader';
import { IconButton } from '../components/IconButton';
import { CitationSheet } from '../components/CitationSheet';
import { Toast } from '../components/Toast';
import { EmptyState } from '../components/EmptyState';
import { TurnAnswer, makeTurnStyles } from '../components/TurnAnswer';
import { AskHistoryPanel } from '../components/AskHistoryPanel';

interface Props {
  /**
   * 作为底栏 tab 常驻（v0.20.6）。此时不画「关闭」按钮 ——
   * 底栏就是出口，再放一个叉会让人以为这个 tab 能关掉。
   */
  embedded?: boolean;
  onClose: () => void;
  /** 存了纪要 / 整理了会话之后，通知上层刷新时间轴 */
  onSaved: () => void | Promise<void>;
  /**
   * 把「尝试关闭」注册给 App：安卓返回键由 App 统一接（它是最后注册的，
   * 天然抢不过），所以这里必须是 App 主动转发，而不是自己再挂一个监听。
   */
  registerClose: (fn: (() => void) | null) => void;
  /**
   * 切到别的 tab 之前的收尾（落盘会话、暂停整理），返回 false = 现在不能走。
   *
   * 和 registerClose 分开：关闭是「这页不要了」，切 tab 是「先放着」。
   * 共用一套收尾，但切 tab 不该顺带把覆盖层也关掉。
   */
  registerLeave?: (fn: (() => Promise<boolean>) | null) => void;
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

/**
 * 「深度思考 / 联网」两个胶囊的触控补偿。
 *
 * 胶囊高度从 48 压到 34（用户 2026-11-15：「再缩小一点」），
 * 但它是这一页最高频的两个开关，点不准比看着大更糟。四周补 7 回到 48。
 */
const TOGGLE_SLOP = { top: 7, bottom: 7, left: 4, right: 4 };
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
export function AskScreen({
  embedded = false,
  onClose,
  onSaved,
  registerClose,
  registerLeave,
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
  /**
   * 最后一句话发给了谁。失败卡上的「重试」用它 ——
   * v0.33 起必须带上 target：重新生成失败后重试，不能把同一问当成新的一轮再问一次。
   */
  const [lastRun, setLastRun] = useState<{ question: string; target: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在回答的那个问题，先上屏让用户看到自己问了什么 */
  const [pendingQ, setPendingQ] = useState('');
  /**
   * v0.33：正在补哪一轮（重新生成 / 改问题）。
   *
   * 和 `pendingQ` 分开：补旧轮次时不能把「正在回答」的那个气泡画在最底下 ——
   * 它看起来像又新问了一句。这个下标让等待提示落在那一轮下面。
   */
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  /**
   * 正在改第几轮的问题。发送时这一句发给那一轮，不是新开一轮。
   * `original` 只用于「没改就取消」的判断和提示，不发出去。
   */
  const [editing, setEditing] = useState<{ index: number; original: string } | null>(null);
  /** 开始改问题时把光标送进输入框 */
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
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
  /**
   * 会话没存上的原因（v0.36）。
   *
   * 以前 `persistSession` 的 catch 是空的：会话在回收站里、或磁盘写不进去时，
   * 每轮回答都只活在内存里，切个 tab 就全没，界面一句提示都没有。
   * 这个状态只服务一条可见的横幅，不参与问答流程。
   */
  const [saveError, setSaveError] = useState<string | null>(null);
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
  /**
   * 保存失败后「仍然离开」的第二次确认。
   *
   * 第一次拦住并说清会丢什么；用户再按一次返回（或再点一次别的 tab）才放行。
   * 不做成弹层：这一页已经有历史抽屉、引用面板等五层覆盖物，再加一层只会更难退。
   */
  const leaveAnywayRef = useRef(false);
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
  /**
   * 最后一个问答轮。只有它默认摊开「重新生成 / 改问题 / 复制」——
   * 每条历史都摊开，屏幕会变成一片灰色小字（判据交给 TurnAnswer 的 collapsible）。
   */
  const lastQaIndex = turns.reduce((acc, t, i) => (t.kind === 'organize' ? acc : i), -1);
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
  /**
   * 底部书写区实测高度，给提示条定位用。
   *
   * 原来这里写死 `keyboardHeight + 140` —— 输入区一改版（开关挪到框外、
   * 框随字数长高）这个数就不对了，提示条会压在输入框上或者飘在半空。
   * 量一次比猜一次可靠：`onLayout` 拿到的就是它实际占的高度，
   * 而且键盘高度已经作为 padding 加在里面，不用再叠加。
   */
  const [footerHeight, setFooterHeight] = useState(120);

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
    async (list: QaTurn[], titleHint?: string | null): Promise<boolean> => {
      if (!list.length) return true;
      const gen = sessionGenRef.current;
      const id = sessionIdRef.current;
      // 范围在调用的一瞬间取定：await 之后 state 可能已经换了新会话
      const sessionScope = scopeRef.current;
      const rawTitle = (titleHint ?? sessionTitle ?? list[0]?.question ?? '新会话')
        .replace(/\s+/g, ' ')
        .trim();
      const title = clampTitle(rawTitle, 32) || '新会话';
      try {
        const nextId = await repo.saveAskSession({
          id: id ?? undefined,
          title,
          turns: list,
          scope: sessionScope,
          createdAt: startedAtRef.current,
        });
        // 保存期间用户可能已经新建/切换会话，那就只落库，不再改当前界面状态
        if (sessionGenRef.current !== gen) return true;
        if (id === null) {
          sessionIdRef.current = nextId;
          setSessionId(nextId);
        }
        setSessionTitle(title);
        dirtyRef.current = false;
        leaveAnywayRef.current = false;
        setSaveError(null);
        return true;
      } catch (e) {
        /*
         * 不能吞掉：会话可能在回收站里（`saveAskSession` 会抛），
         * 也可能磁盘满了。无论哪种，这一页现在的回答都没有落库 ——
         * 用户离开就真的没了，所以必须有一条看得见的提示。
         */
        if (sessionGenRef.current === gen) {
          setSaveError(e instanceof Error ? e.message : '写入本地库失败');
        }
        return false;
      }
    },
    [sessionTitle],
  );

  /**
   * 关闭：按层逐级退。先关引用面板，再关操作层/历史，最后退页面。
   * 会话已经每轮自动存过，这里不再问「要不要留纪要」。
   */
  /**
   * 离开这一页之前必须做完的事：暂停整理、把没落盘的会话写下去。
   *
   * 返回 false 表示现在不能走（正在写库/整理被锁）。
   * 关闭按钮和「切到别的 tab」共用这一份 —— 两条路都会卸载页面，
   * 少做一次就会丢掉这一轮问答，或者让整理在后台半途消失。
   */
  const flushBeforeLeave = useCallback(async () => {
    if (organize.isLocked()) { showToast('先暂停整理，或等待写入完成'); return false; }
    if (!(await organize.suspend())) return false;
    if (dirtyRef.current) {
      const saved = await persistSession(turnsRef.current);
      if (!saved) {
        /*
         * 第一次拦住并说清代价；再按一次返回才放行。
         * 不 await 的话，页面一卸载，没落库的轮次就真的只剩内存里那一份了。
         */
        if (!leaveAnywayRef.current) {
          leaveAnywayRef.current = true;
          showToast('会话没存上。再按一次返回会放弃这次对话；也可以点上面的重试');
          return false;
        }
        leaveAnywayRef.current = false;
      }
    }
    return true;
  }, [organize, showToast, persistSession]);

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
      if (!(await flushBeforeLeave())) return;
      onClose();
    })();
  }, [organize, showToast, discardConfirm, draftDoc, openDocId, summaryOpen, cite, sessionDocs,
      deleteSession, actionSession, historyOpen, busy, flushBeforeLeave, onClose]);

  useEffect(() => {
    registerClose(attemptClose);
    return () => registerClose(null);
  }, [attemptClose, registerClose]);

  useEffect(() => {
    if (!registerLeave) return;
    registerLeave(flushBeforeLeave);
    return () => registerLeave(null);
  }, [flushBeforeLeave, registerLeave]);

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
    if (dirtyRef.current) {
      const saved = await persistSession(turnsRef.current);
      if (!saved && !leaveAnywayRef.current) {
        leaveAnywayRef.current = true;
        showToast('上一场会话没存上。再点一次会放弃没存的部分');
        return false;
      }
      leaveAnywayRef.current = false;
    }
    sessionGenRef.current += 1; dirtyRef.current = false;
    setSaveError(null);
    setTurns([]); turnsRef.current = [];
    setSessionId(null); sessionIdRef.current = null;
    setSessionTitle(null); startedAtRef.current = Date.now();
    setInput(''); setError(null); setWebNote(''); setPendingQ('');
    setEditing(null); setBusyIndex(null);
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
    if (dirtyRef.current) {
      const saved = await persistSession(turnsRef.current);
      if (!saved && !leaveAnywayRef.current) {
        leaveAnywayRef.current = true;
        showToast('上一场会话没存上。再点一次会放弃没存的部分');
        return;
      }
      leaveAnywayRef.current = false;
    }
    sessionGenRef.current += 1; dirtyRef.current = false;
    setSaveError(null);
    setTurns(s.turns); turnsRef.current = s.turns;
    setSessionId(s.id); sessionIdRef.current = s.id;
    setSessionTitle(s.title); startedAtRef.current = s.createdAt;
    setScope(nextScope); setScopeProblem(null); setHistoryOpen(false);
    setActionSession(null); setDeleteSession(null); setCite(null); setDraftDoc(null);
    setInput(''); setError(null); setWebNote(''); setPendingQ('');
    setEditing(null); setBusyIndex(null);
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

  /**
   * v0.33：把第 index 轮的问题放回输入框，发出去就追加一版。
   *
   * 不清空已有输入会被这里覆盖 —— 如果用户正在打字又点了「改问题」，
   * 他的草稿就没了。所以先看一眼：输入框里有别的内容就问一句。
   */
  function beginEdit(index: number) {
    if (busy || draftBusy) return;
    if (draft) {
      // 草稿开着时输入框属于「改稿」，这时候改历史问题会把两种上下文搅在一起
      showToast('先把当前草稿处理掉，再改历史里的问题');
      return;
    }
    const turn = turnsRef.current[index];
    if (!turn) return;
    if (input.trim() && input.trim() !== turn.question.trim()) {
      showToast('输入框里还有没发出去的话，先发掉或清空再改问题');
      return;
    }
    setEditing({ index, original: turn.question });
    setInput(turn.question);
    setError(null);
    setTimeout(() => inputRef.current?.focus(), 60);
  }

  /** 同问再答一版。上下文只到这一轮之前（见 runQuestion 里的 history） */
  async function regenerate(index: number) {
    if (busy || draftBusy) return;
    if (draft) {
      showToast('先把当前草稿处理掉，再重新生成');
      return;
    }
    const turn = turnsRef.current[index];
    if (!turn) return;
    setEditing(null);
    await runQuestion(turn.question, index);
  }

  /**
   * 切换这一轮显示的版本。
   *
   * 切换本身就落库：用户切到第 2 版然后退出，下次进来应该还是第 2 版 ——
   * 「我刚才看的那版不见了」比什么都让人怀疑数据。
   */
  function switchVariant(index: number, to: number) {
    if (busy || draftBusy) return;
    const next = turnsRef.current.map((t, i) => (i === index ? withActive(t, to) : t));
    setTurns(next);
    turnsRef.current = next;
    dirtyRef.current = true;
    void persistSession(next);
    setOpenReasoningKey(null);
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
     * v0.33：正在改某一轮的问题 —— 这一句发回那一轮，不是新开一轮。
     * 必须排在草稿与意图路由之前：改问题时那句话（「那 2025 年呢」）很容易
     * 被判成新的整理任务，而用户此刻明明是在改那一轮。
     */
    if (editing) {
      const target = editing.index;
      setEditing(null);
      setInput('');
      await runQuestion(question, target);
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

    setInput('');
    await runQuestion(question, null);
  }

  /**
   * 真正去问模型（v0.33 从 `send` 里抽出来）。
   *
   * `target === null` 新开一轮；`target = i` 把这次回答追加成第 i 轮的**又一版**
   * （重新生成 / 改问题都走这条）。抽出来的原因很实际：重新生成时不希望
   * 「这一问的旧答案」被塞进上下文，拼上下文的地方必须知道自己在补哪一轮。
   */
  async function runQuestion(question: string, target: number | null) {
    const docMode = scope.kind === 'documents';
    setLastRun({ question, target });
    if (target === null) setPendingQ(question);
    else setBusyIndex(target);
    setBusy(true);
    setError(null);
    setWebNote(docMode ? '正在读选定的文档…' : webOn ? '正在同时搜本地和网络…' : '');
    setReasoning('');
    setReceived(0);
    setElapsed(0);
    streamRef.current.lastFlush = 0;
    if (target === null) scrollToEnd();

    /*
     * 上下文只取「这一轮之前」，且每轮只取当前显示的那一版。
     * 重新生成时**不能把这一问的旧答案**喂回去 —— 那等于让模型照着上一版再写一遍。
     */
    const base = turnsRef.current;
    const history =
      target === null ? base.filter((t) => t.kind !== 'organize') : historyBefore(base, target);

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
        turns: history,
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
      /*
       * 一版回答（v0.33）。重新生成 / 改问题都追加一份、不覆盖 ——
       * 存进 `variants` 之后，底部的 `‹ 2/3 ›` 才能在旧答案之间切。
       */
      const variant: QaVariant = {
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
        at: Date.now(),
      };
      const next =
        target === null
          ? [...base, turnFromVariant(variant)]
          : base.map((t, i) => (i === target ? withVariant(t, variant) : t));
      setTurns(next);
      turnsRef.current = next;
      // 这一轮的思维链默认摊开：否则用户看到的还是「闪一下就没了」
      setOpenReasoningKey(`${target ?? base.length}-${cutPrefix(question, 8)}`);
      dirtyRef.current = true;
      // 改的是第一问时，标题跟着换 —— 会话列表里还挂着旧问题会让人以为是另一场
      void persistSession(next, target === 0 ? question : null);

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
      setBusyIndex(null);
      setBusy(false);
      // 补旧轮次时不滚到底：用户正看着那一轮，滚走等于把他从答案上拽开
      if (target === null) scrollToEnd();
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
    // 开新任务就不再是「改那一问」：编辑条留着会让下一次发送跑回旧轮次
    setEditing(null);
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
      showToast('会话已移到回收站');
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
  const sheetVisible = !!actionSession || !!deleteSession || !!sessionDocs || !!cite || discardConfirm ||
    summaryOpen || openDocId !== null || !!draftDocCurrent;
  const conversationCovered = historyMounted || sheetVisible;

  return (
    <View style={styles.root} {...openPan.panHandlers}>
      <Animated.View
        style={[styles.flex, { transform: [{ translateX: contentX }] }]}
        accessibilityElementsHidden={conversationCovered}
        importantForAccessibility={conversationCovered ? 'no-hide-descendants' : 'auto'}
      >
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
              {/* 底栏版没有「关闭」：出口是底栏，再放一个叉等于让人以为能关掉这个 tab */}
              {embedded ? null : (
                <IconButton
                  name="close"
                  size={20}
                  tone="soft"
                  onPress={attemptClose}
                  disabled={busy || draftBusy || savingDraft}
                  accessibilityLabel="保留草稿并关闭"
                />
              )}
            </View>
          }
        />
        {/* 范围常驻在标题下面：一旦滚走，用户就不记得这次到底问了什么 */}
        <View style={styles.scopeBar}>
          <Ionicons
            name={docMode ? 'documents-outline' : 'albums-outline'}
            size={16}
            color={c.text2}
            accessible={false}
          />
          <Text style={styles.scopeText} numberOfLines={2} accessibilityLabel={scopeLine}>
            {scopeLine}
          </Text>
          {docMode ? <Text style={styles.scopeTag}>不联网</Text> : null}
        </View>
        {scopeProblem ? <Text style={styles.scopeWarn}>{scopeProblem}</Text> : null}
        {/*
          会话没存上的提示放在滚动区外面：它是一条「离开就会丢」的警告，
          跟着消息滚走等于没提示。只在这一页真的有未落库轮次时出现。
        */}
        {saveError ? (
          <AgentError
            title="这次会话没存上"
            message={`${saveError}。离开这一页会丢掉还没存的部分。`}
            onRetry={() => void persistSession(turnsRef.current)}
          />
        ) : null}

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
                <Pressable style={[styles.controlButton, styles.recoveryPrimary]} onPress={organize.restore} disabled={busy || savingDraft} accessibilityRole="button" accessibilityState={{ disabled: busy || savingDraft }}><Text style={styles.recoveryPrimaryText}>恢复草稿</Text></Pressable>
                <Pressable style={styles.controlButton} onPress={() => setDiscardConfirm(true)} disabled={busy || savingDraft} accessibilityRole="button" accessibilityState={{ disabled: busy || savingDraft }}><Text style={styles.danger}>放弃草稿</Text></Pressable>
              </View>
            </View>
          ) : null}
          {organize.storageError ? <AgentError title="本地草稿未保存" message={organize.storageError} onRetry={() => void (draft ? organize.saveLocal() : organize.reloadRecovery())} /> : null}
          {draftBusy ? (
            <Pressable style={styles.pauseButton} onPress={() => void organize.pause()} accessibilityRole="button" accessibilityLabel="暂停后续整理并保留当前材料">
              <Ionicons name="pause-circle-outline" size={20} color={c.text2} accessible={false} />
              <Text style={styles.pauseText}>暂停整理 · 保留材料和进度</Text>
            </Pressable>
          ) : null}
          {!hasContent && !pendingQ && !draft && !organize.recovery ? (
            /*
              这里原来还有一段两行的产品说明（「只在你选的文档里找依据。回答中的引用
              可以打开……」）。标题已经说了这件事，下面三行入口也说清了能做什么 ——
              第三层解释就是每次进来都要重读一遍废话（用户 2026-11-15 反复要求删）。
              底色是灰的不是主色：这不是唯一入口（输入框就在下面），不该抢邀请的话。
            */
            <EmptyState
              icon="chatbubble-ellipses-outline"
              iconSize={24}
              iconColor={c.accentText}
              title={docMode ? '围绕这些文档提问' : '从碎片里找答案'}
            >
              {!docMode ? (
                <View style={styles.hints}>
                  <Pressable
                    style={[styles.hint, styles.hintDivider]}
                    onPress={() => void startDraft('knowledge', { instruction: TASK_SEED.organize })}
                    disabled={draftBusy || busy}
                    accessibilityRole="button"
                    accessibilityLabel={TASK_LABEL.organize}
                    accessibilityState={{ disabled: draftBusy || busy }}
                  >
                    <Ionicons name="sparkles-outline" size={19} color={c.accentText} accessible={false} />
                    <Text style={styles.hintTitle}>{TASK_LABEL.organize}</Text>
                    <Ionicons name="chevron-forward" size={15} color={c.text3} accessible={false} />
                  </Pressable>

                  <Pressable
                    style={[styles.hint, styles.hintDivider]}
                    onPress={() => void startDraft('todos', { instruction: TASK_SEED.todos })}
                    disabled={draftBusy || busy}
                    accessibilityRole="button"
                    accessibilityLabel={TASK_LABEL.todos}
                    accessibilityState={{ disabled: draftBusy || busy }}
                  >
                    <Ionicons name="checkbox-outline" size={19} color={c.accentText} accessible={false} />
                    <Text style={styles.hintTitle}>{TASK_LABEL.todos}</Text>
                    <Ionicons name="chevron-forward" size={15} color={c.text3} accessible={false} />
                  </Pressable>

                  <Pressable
                    style={styles.hint}
                    onPress={() => setSummaryOpen(true)}
                    disabled={draftBusy || busy}
                    accessibilityRole="button"
                    accessibilityLabel={TASK_LABEL.digest}
                    accessibilityState={{ disabled: draftBusy || busy }}
                  >
                    <Ionicons name="calendar-outline" size={19} color={c.accentText} accessible={false} />
                    <Text style={styles.hintTitle}>{TASK_LABEL.digest}</Text>
                    <Ionicons name="chevron-forward" size={15} color={c.text3} accessible={false} />
                  </Pressable>
                </View>
              ) : null}
            </EmptyState>
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
              <View key={`${i}-${cutPrefix(t.question, 8)}`}>
                <View style={styles.qRow}>
                  <View style={styles.qBubble}>
                    <Text style={styles.qText}>{t.question}</Text>
                  </View>
                </View>
                {t.reasoning ? (
                  <ReasoningFold
                    text={t.reasoning}
                    defaultOpen={openReasoningKey === `${i}-${cutPrefix(t.question, 8)}`}
                  />
                ) : null}
                <TurnAnswer
                  turn={t}
                  onCite={setCite}
                  actions={{
                    index: i,
                    total: variantsOf(t).length,
                    active: activeIndexOf(t),
                    disabled: busy || draftBusy,
                    collapsible: i !== lastQaIndex,
                    onRegenerate: () => void regenerate(i),
                    onEdit: () => beginEdit(i),
                    onSwitch: (to) => switchVariant(i, to),
                  }}
                />
                {/* 正在重写这一轮：提示落在它下面，别画到页尾去 */}
                {busyIndex === i ? (
                  <View style={styles.aRow}>
                    <View style={styles.thinkingRow}>
                      <ActivityIndicator size="small" color={c.text2} />
                      <Text style={styles.thinkingText}>
                        {received > 0 ? `正在重写这一轮…（已收到 ${received} 字）` : '正在重写这一轮…'}
                      </Text>
                    </View>
                  </View>
                ) : null}
                {busyIndex === i && reasoning ? (
                  <ReasoningStream
                    title="思考过程"
                    text={reasoning}
                    received={received}
                    elapsed={elapsed}
                    thinking={thinkingOn}
                    height={180}
                  />
                ) : null}
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
                  <Text style={styles.thinkingText}>正在读资料组织回答…（已收到 {received} 字）</Text>
                ) : (
                  <View style={styles.thinkingRow}>
                    <ActivityIndicator size="small" color={c.text2} />
                    <Text style={styles.thinkingText}>
                      {thinkingOn ? '在想…' : docMode ? '在读选定的文档…' : '在读你的记录…'}
                    </Text>
                  </View>
                )}
                {!!webNote ? <Text style={styles.busyNote}>{webNote}</Text> : null}
              </View>
            </View>
          ) : null}

          {busy && reasoning && busyIndex === null ? (
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
                if (lastRun) void runQuestion(lastRun.question, lastRun.target);
              }}
            />
          ) : null}
        </ScrollView>

        <View
          style={[styles.footer, { paddingBottom: SPACE.xs + keyboardHeight }]}
          onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
        >
          {context ? (
            <View style={styles.contextBar}>
              <Ionicons name="link-outline" size={13} color={c.accentText} />
              <Text style={styles.contextText} numberOfLines={1}>
                围绕这条记录：{context.content.replace(/\s+/g, ' ')}
              </Text>
              <Pressable
                onPress={() => setContext(null)}
                style={styles.controlButton}
                accessibilityRole="button"
                accessibilityLabel="移除这条上下文"
              >
                <Ionicons name="close" size={13} color={c.text3} />
              </Pressable>
            </View>
          ) : null}

          {/*
            正在改某一轮的问题（v0.33）。
            要说清两件事：这是第几问、发出去之后旧答案还在 —— 否则用户会以为
            「改一下就覆盖了」，于是不敢改。
          */}
          {editing ? (
            <View style={styles.editBar}>
              <Ionicons name="create-outline" size={13} color={c.accentText} />
              <Text style={styles.editBarText} numberOfLines={2}>
                正在改第 {editing.index + 1} 问 · 发送后旧答案保留，可切回
                {editing.index < turns.length - 1 ? ' · 后面的轮次不动' : ''}
              </Text>
              <Pressable
                onPress={() => { setEditing(null); setInput(''); }}
                style={styles.controlButton}
                accessibilityRole="button"
                accessibilityLabel="取消修改这一问"
              >
                <Ionicons name="close" size={13} color={c.text3} />
              </Pressable>
            </View>
          ) : null}

          {/*
            两个开关在**输入框上面**（用户 2026-11-15 要求）。
            放在框里时，它们和发送键挤在同一行，框本身永远是一行字的高度；
            挪出来之后框变成「写多少长多少」，开关也不再和发送键抢位置。
            尺寸按「读得出、点得准」压到 34：正文才是这一页的主角。
          */}
          <View style={styles.toggleRow}>
            {/*
              DeepSeek 的写法：胶囊上只写功能名，状态交给底色、字重和图标实心度。
              原来写「思考 · 开」等于把开关状态又用文字说一遍，胶囊因此宽了一圈。
              三个信号（淡蓝底 / 蓝字加粗 / 实心灯泡）同时给，不只靠颜色。
            */}
            <Pressable
              style={[styles.toggle, thinkingOn && styles.toggleOn]}
              onPress={toggleThinking}
              hitSlop={TOGGLE_SLOP}
              accessibilityRole="switch"
              accessibilityLabel="深度思考"
              accessibilityState={{ checked: thinkingOn }}
            >
              <Ionicons name={thinkingOn ? 'bulb' : 'bulb-outline'} size={13} color={thinkingOn ? c.accentText : c.text2} accessible={false} />
              <Text style={[styles.toggleText, thinkingOn && styles.toggleTextOn]}>深度思考</Text>
            </Pressable>
            {docMode ? (
              // 文档模式首版直接禁用联网：来源必须只有用户选的那几份
              <View style={styles.toggleOff} accessible accessibilityLabel="文档模式不联网" accessibilityState={{ disabled: true }}>
                <Ionicons name="cloud-offline-outline" size={13} color={c.text2} accessible={false} />
                <Text style={styles.toggleText}>不联网</Text>
              </View>
            ) : (
              <Pressable
                style={[styles.toggle, webOn && styles.toggleOn]}
                onPress={toggleWeb}
                hitSlop={TOGGLE_SLOP}
                accessibilityRole="switch"
                accessibilityLabel="联网检索"
                accessibilityState={{ checked: webOn }}
              >
                <Ionicons name={webOn ? 'globe' : 'globe-outline'} size={13} color={webOn ? c.accentText : c.text2} accessible={false} />
                <Text style={[styles.toggleText, webOn && styles.toggleTextOn]}>联网</Text>
              </Pressable>
            )}
            {busy ? <Text style={styles.busyHint}>回答中…</Text> : null}
          </View>

          <View style={styles.inputRow}>
            {/*
              输入框跟着字数长高，上限 5 行（maxHeight）。**不设固定高度** ——
              设了就不会长；有了上限，写到第五行以后框内滚动，不会把整页顶走。
            */}
            <TextInput
              ref={inputRef}
              value={input}
              onChangeText={setInput}
              placeholder={
                editing
                  ? '改这一问，发出去会追加一版'
                  : draft
                    ? '说要改哪里，比如「第二段并进第一段」…'
                    : '问点什么，或者让它整理…'
              }
              placeholderTextColor={c.text3}
              selectionColor={c.selection}
              style={styles.input}
              multiline
              textAlignVertical="top"
              maxLength={500}
              editable={!busy}
              accessibilityLabel={draft ? '改稿要求' : '问题或整理要求'}
            />
            <Pressable
              onPress={() => void send()}
              // 范围有问题时按钮直接不可用：原因就写在上面的红字里
              disabled={!canSend}
              style={[styles.send, canSend && styles.sendOn]}
              accessibilityRole="button"
              accessibilityLabel={draft ? '发送改稿要求' : '发送问题'}
              accessibilityState={{ disabled: !canSend, busy: busy || draftBusy || savingDraft }}
            >
              <Ionicons name="arrow-up" size={20} color={canSend ? c.onAccent : c.text3} accessible={false} />
            </Pressable>
          </View>
        </View>

      </Animated.View>

      {/* ---------------- 历史会话（右滑拉出来的抽屉） ---------------- */}

      {/*
        外壳、压暗层、页头、分组搬到 `components/AskHistoryPanel`（v0.26）。
        这里只交代「这一层该显示什么」，不再自己拼 JSX ——
        它和聊天流之间没有任何共享状态，混在一个 1900 行的文件里只是难找。
      */}
      <AskHistoryPanel
        mounted={historyMounted}
        sheetVisible={sheetVisible}
        translateX={historyX}
        dimOpacity={dimOpacity}
        panHandlers={closePan.panHandlers}
        openCount={sessions.filter((s) => !s.archived).length}
        loading={historyLoading}
        groups={history.groups}
        archived={history.archived}
        activeId={sessionId}
        onClose={() => setHistoryOpen(false)}
        onNewSession={newSession}
        onOpen={loadSession}
        onOpenDocs={(one) => void openSessionDocs(one)}
        onManage={setActionSession}
      />

      {/* ---------------- 会话操作 ---------------- */}
      {actionSession ? (
        <View style={styles.sheetOverlay} accessibilityViewIsModal>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setActionSession(null)} />
          <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
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

            <Pressable style={styles.sheetCancel} onPress={() => setActionSession(null)} accessibilityRole="button">
              <Text style={styles.sheetCancelText}>取消</Text>
            </Pressable>
          </ScrollView>
        </View>
      ) : null}

      {/* ---------------- 一场会话整理出的多篇文档 ---------------- */}
      {sessionDocs ? (
        <View style={styles.sheetOverlay} accessibilityViewIsModal>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSessionDocs(null)} />
          <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
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
            <Pressable style={styles.sheetCancel} onPress={() => setSessionDocs(null)} accessibilityRole="button">
              <Text style={styles.sheetCancelText}>取消</Text>
            </Pressable>
          </ScrollView>
        </View>
      ) : null}

      {/* ---------------- 删除确认 ---------------- */}
      {deleteSession ? (
        <View style={styles.dialogOverlay} accessibilityViewIsModal>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setDeleteSession(null)} accessibilityRole="button" accessibilityLabel="取消删除会话" />
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle} accessibilityRole="header">把这个会话移到回收站？</Text>
            <Text style={styles.dialogBody}>
              「{deleteSession.title}」会从历史里消失，30 天内在「设置 → 数据 → 回收站」里还能找回。
              已写入的文档、待办和碎片副本不受影响。
            </Text>
            <View style={styles.dialogActions}>
              <Pressable style={styles.controlButton} onPress={() => setDeleteSession(null)} accessibilityRole="button">
                <Text style={styles.muted}>取消</Text>
              </Pressable>
              <Pressable style={styles.controlButton} onPress={confirmDeleteSession} disabled={working === 'delete'} accessibilityRole="button" accessibilityState={{ disabled: working === 'delete', busy: working === 'delete' }}>
                <Text style={styles.danger}>
                  {working === 'delete' ? '正在移…' : '移到回收站'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {/* ---------------- 月小结面板 ---------------- */}
      {summaryOpen ? (
        <View style={styles.summaryPage} accessibilityViewIsModal>
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
        <View style={styles.summaryPage} accessibilityViewIsModal>
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
        <View style={styles.dialogOverlay} accessibilityViewIsModal>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle} accessibilityRole="header">放弃这份本地草稿？</Text>
            <Text style={styles.dialogBody}>尚未写入的文档、待办和改稿记录会被移除。已经写入的文档、待办及原始碎片不受影响。</Text>
            <View style={styles.dialogActions}>
              <Pressable style={styles.controlButton} onPress={() => setDiscardConfirm(false)} disabled={savingDraft} accessibilityRole="button" accessibilityState={{ disabled: savingDraft }}><Text style={styles.muted}>保留</Text></Pressable>
              <Pressable style={styles.controlButton} onPress={() => { void discardDraft().then((ok) => { if (ok) setDiscardConfirm(false); }); }} disabled={savingDraft} accessibilityRole="button" accessibilityState={{ disabled: savingDraft }}><Text style={styles.danger}>确认放弃</Text></Pressable>
            </View>
          </View>
        </View>
      ) : null}
      {cite ? <CitationSheet cite={cite} onClose={() => setCite(null)} /> : null}
      {/*
        提示条落在书写区上沿。位置来自实测高度，不再是一个估算的数字 ——
        「输入框 + 开关行 + 内边距」改一次版，估算值就会骗人。
      */}
      <Toast text={toast} bottom={footerHeight + 8} />
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  ...makeTurnStyles(c, metrics),
  root: { flex: 1, backgroundColor: c.page },
  flex: { flex: 1 },
  /** 恢复卡：靠 accentBg 底表态，不再套一圈有色描边 */
  recovery: {
    padding: SPACE.md, gap: SPACE.sm,
    borderRadius: metrics.cardRadius, backgroundColor: c.accentBg, marginBottom: SPACE.lg,
  },
  recoveryTitle: { ...TYPE.title, color: c.text },
  recoveryText: { ...TYPE.compact, color: c.text2 },
  recoveryActions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  recoveryPrimary: { backgroundColor: c.accent, borderRadius: metrics.buttonRadius },
  recoveryPrimaryText: { ...TYPE.label, color: c.onAccent, textAlign: 'center' },
  controlButton: {
    minHeight: metrics.controlHeight, minWidth: metrics.controlHeight,
    paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, justifyContent: 'center', alignItems: 'center',
  },
  pauseButton: {
    minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs,
    padding: SPACE.sm, backgroundColor: c.hairSoft, marginBottom: SPACE.md,
    borderRadius: metrics.buttonRadius,
  },
  pauseText: { ...TYPE.label, color: c.text, flex: 1 },
  newHint: {
    // 页头 56 加范围条约 30 —— 落在范围条下方，不压住它
    position: 'absolute', top: 96, alignSelf: 'center', zIndex: 30,
    backgroundColor: c.accent, borderRadius: metrics.buttonRadius,
    paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm,
  },
  newHintText: { ...TYPE.label, color: c.onAccent },
  content: { paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.sm, paddingBottom: SPACE.lg },
  contentEmpty: { flexGrow: 1, paddingTop: SPACE.lg, paddingBottom: SPACE.lg },
  /** 空态里的三个入口：一块浅灰底，行间用分隔线，不再各自套边框 */
  hints: {
    alignSelf: 'stretch', marginTop: SPACE.sm,
    backgroundColor: c.card, borderRadius: metrics.cardRadius, overflow: 'hidden',
  },
  hint: {
    minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
    paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs,
  },
  hintDivider: { borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair },
  hintTitle: { ...TYPE.body, flex: 1, minWidth: 0, color: c.text, fontWeight: '600' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs },
  scopeBar: {
    flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.xs,
    marginHorizontal: metrics.pagePadding, marginTop: SPACE.xxs, paddingBottom: SPACE.xs,
    borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair,
  },
  scopeText: { ...TYPE.meta, flex: 1, minWidth: 0, color: c.text2 },
  /** 范围标签：浅灰底 + 圆角就够，不再套一圈 hair 描边（那圈线在灰底上等于噪音） */
  scopeTag: {
    ...TYPE.meta, color: c.text2, backgroundColor: c.hairSoft,
    borderRadius: metrics.buttonRadius,
    paddingHorizontal: SPACE.xs, paddingVertical: SPACE.xxs, overflow: 'hidden',
  },
  scopeWarn: { ...TYPE.label, fontWeight: '400', color: c.danger, marginHorizontal: metrics.pagePadding, marginTop: SPACE.xs },
  qRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: SPACE.md, marginBottom: SPACE.sm },
  /** 用户气泡：圆角只收右下角一格，和 DeepSeek 的提问气泡同一个取向 */
  qBubble: {
    maxWidth: '85%', backgroundColor: c.accentBg,
    borderRadius: metrics.cardRadius, borderBottomRightRadius: SPACE.xxs,
    paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs,
  },
  qText: { ...TYPE.body, color: c.accentText },
  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, paddingVertical: SPACE.xs },
  thinkingText: { ...TYPE.label, fontWeight: '400', color: c.text2, flexShrink: 1 },
  busyNote: { ...TYPE.meta, color: c.text2 },
  webNote: { ...TYPE.meta, color: c.text2, marginTop: SPACE.sm, paddingLeft: SPACE.sm, borderLeftWidth: surfaceStroke(metrics), borderLeftColor: c.hair },
  footer: {
    borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair,
    backgroundColor: c.page, paddingTop: SPACE.xs,
  },
  contextBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.xs,
    marginHorizontal: metrics.pagePadding, marginBottom: SPACE.xs,
    paddingLeft: SPACE.sm, paddingVertical: SPACE.xxs,
    borderLeftWidth: metrics.strokeWidth, borderLeftColor: c.accent, backgroundColor: c.hairSoft,
  },
  contextText: { ...TYPE.meta, flex: 1, color: c.text2 },
  /** 「正在改第 N 问」：和上下文条同一形状，底色换成强调色，一眼能分清是哪种前置状态 */
  editBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.xs,
    marginHorizontal: metrics.pagePadding, marginBottom: SPACE.xs,
    paddingLeft: SPACE.sm, paddingVertical: SPACE.xxs,
    borderLeftWidth: metrics.strokeWidth, borderLeftColor: c.accent, backgroundColor: c.accentBg,
  },
  editBarText: { ...TYPE.meta, flex: 1, color: c.text2 },
  /**
   * 和首页输入卡同一套：浅灰底、无边框。
   *
   * 圆角是 `cardRadius + 8`，不是写死的 28 —— 写死的话墨水主题（cardRadius 8）
   * 也会得到一个 28 的胶囊，和它方正的卡片摆在一起像个异物。
   *
   * 横排：左边文本区（跟着字数长），右边发送键贴底。竖排的话发送键会另起一行，
   * 单行输入时那一行纯属白占 —— 而这一页最常见的输入就是一句话。
   */
  inputRow: {
    marginHorizontal: metrics.pagePadding,
    paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, gap: SPACE.xs,
    flexDirection: 'row', alignItems: 'flex-end',
    backgroundColor: c.hairSoft, borderRadius: metrics.cardRadius + 8,
  },
  /**
   * 文本区：一行 34 起，随字数长高到 5 行封顶。
   *
   * **不能设固定 height**（设了就不长），也不能不给 maxHeight（写长了会把
   * 整页顶走、上面的对话全被挤出去）。44 是原来的一行高度，
   * 用户 2026-11-15 说「再缩小一点」，于是压到 34 —— 一行 26 加 8 的内边距。
   */
  input: {
    ...TYPE.body, color: c.text, flex: 1, minWidth: 0,
    minHeight: 34, maxHeight: TYPE.body.lineHeight * 5,
    paddingTop: 3, paddingBottom: 3,
    ...WEB_INPUT_RESET,
  },
  /**
   * 开关行在输入框**外面**，和页左右对齐。
   * 放在框里时它和发送键挤一行，框永远只有一行高；挪出来之后各归各位。
   */
  toggleRow: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
    gap: 6, marginHorizontal: metrics.pagePadding, marginBottom: 6,
  },
  /** DeepSeek 那种胶囊：浅灰底、无边框；选中换成淡蓝底 + 蓝字 + 实心图标 */
  toggle: {
    minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs,
    borderRadius: 999, backgroundColor: c.hairSoft, paddingHorizontal: 10,
  },
  toggleOn: { backgroundColor: c.accentBg },
  toggleText: { ...TYPE.meta, color: c.text2, flexShrink: 1 },
  toggleTextOn: { color: c.accentText, fontWeight: '600' },
  /**
   * 文档模式下的「不联网」：它就是一个 off 状态的胶囊，长得和别的 off 一样。
   *
   * 原来还叠了 `opacity: 0.55`，本意是「这条不能用」，代价是胶囊里的字
   * （text2）乘 0.55 之后对比度掉到 2 出头 —— 在深色主题下几乎看不见。
   * 「不能用」由 `accessibilityState.disabled` 说，界面不必再糊一遍。
   */
  toggleOff: {
    minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs,
    borderRadius: 999, backgroundColor: c.hairSoft, paddingHorizontal: 10,
  },
  busyHint: { ...TYPE.meta, color: c.text2 },
  send: {
    width: metrics.controlHeight, height: metrics.controlHeight,
    borderRadius: 999, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.hairSoft,
  },
  sendOn: { backgroundColor: c.accent },
  sheetOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end', backgroundColor: c.scrim },
  /** 底部面板：白底 + 上圆角就够分层了，上沿那条线是多余的 */
  sheet: {
    backgroundColor: c.card, borderTopLeftRadius: metrics.cardRadius, borderTopRightRadius: metrics.cardRadius,
    maxHeight: '88%', flexGrow: 0,
  },
  sheetBody: { paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.lg, paddingBottom: SPACE.xl },
  sheetTitle: { ...TYPE.title, color: c.text },
  sheetSub: { ...TYPE.meta, color: c.text2, marginTop: SPACE.xxs, marginBottom: SPACE.sm },
  sheetAction: { minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.sm, borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair },
  sheetActionText: { ...TYPE.body, color: c.text, flex: 1, minWidth: 0 },
  sheetCancel: { minHeight: metrics.controlHeight, justifyContent: 'center', paddingVertical: SPACE.sm, alignItems: 'center', marginTop: SPACE.xs },
  sheetCancelText: { ...TYPE.label, color: c.text2 },
  dialogOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', padding: SPACE.lg, backgroundColor: c.scrim },
  dialog: { backgroundColor: c.card, borderRadius: metrics.cardRadius, padding: SPACE.lg, gap: SPACE.sm },
  dialogTitle: { ...TYPE.title, color: c.text },
  dialogBody: { ...TYPE.body, color: c.text2 },
  dialogActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: SPACE.xs, marginTop: SPACE.xs },
  danger: { ...TYPE.label, color: c.danger },
  muted: { ...TYPE.label, color: c.text2 },
  summaryPage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.page },
});
