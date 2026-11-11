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
import type {
  AiConfig,
  AskSession,
  DocumentCoverage,
  Fragment,
  QaCitation,
  QaScope,
  QaTurn,
} from '../types';
import { R, useThemedStyles, type Palette } from '../theme';
import { repo } from '../db/repo';
import { loadAiConfig } from '../ai/config';
import { AiError, type AiErrorDetail } from '../ai/chat';
import { askQuestion } from '../ai/qa';
import {
  extractKnowledge,
  reviseDraft,
  type KnowledgeSource,
  type TodoSnapshot,
} from '../ai/knowledge';
import {
  docNameOf,
  docProblem,
  draftProblem,
  emptyDraft,
  excerptOf,
  keptDocs,
  keptTodos,
  type DraftDoc,
  type DraftMode,
  type KnowledgeDraft,
} from '../util/knowledgeDoc';
import { routeAsk, TASK_SEED } from '../util/askIntent';
import { packFragments } from '../util/batch';
import { writeKnowledgeDocument } from '../documents/knowledge';
import { KnowledgeDraftCard, type AgentStep, type SavedDoc } from '../components/KnowledgeDraft';
import { AgentError, errorDetailOf } from '../components/AgentError';
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

  /* ---- 整理草稿（v0.16） ---- */
  /** 当前草稿。null = 没有正在整理的稿子 */
  const [draft, setDraft] = useState<KnowledgeDraft | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftErr, setDraftErr] = useState<ErrInfo | null>(null);
  /** 材料被截断的提示，必须显示：少看了内容就可能漏了结论 */
  const [draftNote, setDraftNote] = useState('');
  const [draftRecv, setDraftRecv] = useState(0);
  const [draftElapsed, setDraftElapsed] = useState(0);
  const [draftReasoning, setDraftReasoning] = useState('');
  /** 过程日志。整理这件事现在是「看得见在干什么」的，不再只报一个字数 */
  const [draftSteps, setDraftSteps] = useState<AgentStep[]>([]);
  const [savingDraft, setSavingDraft] = useState(false);
  /** 写入权限。默认开，但一定要看得见、关得掉 */
  const [allowDoc, setAllowDoc] = useState(true);
  const [allowTodos, setAllowTodos] = useState(true);
  /** 已经写进文档库的那几篇（按草稿下标），卡片上逐篇打勾 */
  const [savedDocs, setSavedDocs] = useState<SavedDoc[]>([]);
  /** 点「+」但本来就在新会话里：顶部闪一条提示，别让人以为按钮坏了 */
  const [newHint, setNewHint] = useState(false);
  /**
   * 这份草稿属于哪场会话。
   *
   * 不能直接用 `sessionIdRef.current`：从历史里对**别的**会话点「重新整理」时，
   * 当前打开的可能是另一场 —— 用它去 mark，会把文档挂到不相干的会话上，
   * 界面上看着「整理成功了」，其实那条历史行永远不会有徽标。
   */
  const [draftSession, setDraftSession] = useState<number | null>(null);
  /** 草稿代次：放弃之后迟到的结果不能再把卡片弹回来 */
  const draftGenRef = useRef(0);

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
  busyRef.current = busy;
  historyRef.current = historyOpen;
  overlayRef.current =
    historyOpen ||
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

  // 草稿自己的计时：生成和改稿都可能跑几十秒，得让用户知道还在动
  useEffect(() => {
    if (!draftBusy) return;
    const started = Date.now();
    const timer = setInterval(
      () => setDraftElapsed(Math.round((Date.now() - started) / 1000)),
      500,
    );
    return () => clearInterval(timer);
  }, [draftBusy]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, []);

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
    if (openDocId !== null) {
      setOpenDocId(null);
      return;
    }
    if (summaryOpen) {
      setSummaryOpen(false);
      return;
    }
    if (draft) {
      /*
       * 关掉草稿＝放弃这次整理。代次 +1，迟到的结果不再回写 ——
       * 否则关完卡片又从底下冒出来，用户会以为自己点错了。
       * 已经写进文档的那份不受影响（那时草稿已经是「已写入」状态，单独关掉即可）。
       */
      draftGenRef.current += 1;
      setDraft(null);
      setDraftBusy(false);
      setSavedDocs([]);
      return;
    }
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
  }, [
    actionSession,
    busy,
    cite,
    deleteSession,
    draft,
    historyOpen,
    onClose,
    openDocId,
    persistSession,
    summaryOpen,
    turns,
  ]);

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

  /** 历史页上还叠着别的面板时，右滑不该把历史一起关掉 */
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = !!actionSession || !!deleteSession || !!sessionDocs;

  /**
   * 历史页右滑返回问答。
   *
   * 和问答页「左滑打开历史」是同一对手势（用户要求的「像小说阅读器：
   * 左滑进去、右滑退出来」）。阈值同样 28px，且横向必须明显大于纵向，
   * 否则纵向翻历史列表时会被误判成返回。
   */
  const historyPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) =>
        historyRef.current &&
        !sheetOpenRef.current &&
        g.dx > 28 &&
        Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
      onPanResponderMove: () => undefined,
      onPanResponderRelease: () => setHistoryOpen(false),
      onPanResponderTerminate: () => undefined,
    }),
  ).current;

  /** 新建一场。旧会话已经自动存好，这里只重置当前视图 */
  function newSession() {
    if (busy) return;
    /*
     * 已经站在一个空会话里再点「+」，什么都不会发生 —— 但按钮必须有反应，
     * 否则用户会以为它坏了。所以先把面板收起、输入清空，再闪一条提示。
     */
    if (!turns.length && !draft) {
      setHistoryOpen(false);
      setActionSession(null);
      setDeleteSession(null);
      setInput('');
      setError(null);
      flashNewHint();
      return;
    }
    // 先落上一场（此时 scopeRef 还是上一场的范围），再回到页面范围
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
    setError(null);
    setWebNote('');
    setPendingQ('');
    setReasoning('');
    setOpenReasoningKey(null);
    setReceived(0);
    setElapsed(0);
    setCite(null);
    setHistoryOpen(false);
    setActionSession(null);
    setDeleteSession(null);
    draftGenRef.current += 1;
    setDraft(null);
    setDraftBusy(false);
    setDraftErr(null);
    setSavedDocs([]);
    setContext(null);
    // 新会话回到「进页面时选定的范围」：历史会话的临时范围不继承
    setScope(pageScope.scope);
    setScopeProblem(pageScope.error);
  }

  /** 打开一个历史会话 */
  function loadSession(s: AskSession) {
    if (busy) return;

    // 范围读不出来的会话不能按 records 打开：那会把「只问两份文档」变成全库问答
    if (s.scopeBroken) {
      showToast('这场会话的范围读不出来，不能继续问');
      return;
    }
    let nextScope: QaScope;
    try {
      // 只有读旧会话时允许缺字段（那时还没有范围概念，它们确实是 records）
      nextScope = normalizeQaScope(s.scope, true);
    } catch {
      showToast('这场会话的范围读不出来，不能继续问');
      return;
    }

    sessionGenRef.current += 1;
    dirtyRef.current = false;
    setTurns(s.turns);
    setSessionId(s.id);
    sessionIdRef.current = s.id;
    setSessionTitle(s.title);
    startedAtRef.current = s.createdAt;
    setScope(nextScope);
    setScopeProblem(null);
    setHistoryOpen(false);
    setActionSession(null);
    setDeleteSession(null);
    setCite(null);
    setInput('');
    setError(null);
    setWebNote('');
    setPendingQ('');
    setReasoning('');
    setOpenReasoningKey(null);
    setReceived(0);
    setElapsed(0);
    draftGenRef.current += 1;
    setDraft(null);
    setDraftBusy(false);
    setDraftErr(null);
    setSavedDocs([]);
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

  async function send(raw?: string) {
    const question = (raw ?? input).trim();
    if (!question || busy || draftBusy) return;
    if (scopeProblem) {
      // 边界不清楚就不发：宁可让用户回去重选，也不要拿错的范围去查
      setError({ message: scopeProblem });
      return;
    }

    /*
     * 草稿开着的时候，这一句话就是「改哪里」。
     *
     * 不在这里再判意图：草稿已经在屏幕上了，用户打的字如果是「把第二段并进
     * 第一段」，任何意图分类器都会把它判成问答。规则简单一点反而不会错 ——
     * 想提问就先把草稿收掉，卡片上有按钮。
     */
    if (draft) {
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
        turns,
        config: { ...config, thinking: thinkingOn },
        thinking: thinkingOn,
        // 文档模式不联网：来源必须是用户选的那几份
        useWeb: !docMode && webOn,
        contextIds: !docMode && context ? [context.id] : [],
        scope,
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

  /** 追加一行过程日志 */
  const pushStep = useCallback((step: AgentStep) => {
    setDraftSteps((prev) => [...prev, step]);
  }, []);

  /** 改最后一行（「正在写…」→「已写入」），不新增噪音 */
  const markLastStep = useCallback((patch: Partial<AgentStep>) => {
    setDraftSteps((prev) => {
      if (!prev.length) return prev;
      const next = prev.slice();
      next[next.length - 1] = { ...next[next.length - 1], ...patch };
      return next;
    });
  }, []);

  /**
   * 已有待办的快照，交给模型去重。
   *
   * 只取「未完成」和「最近完成的 12 条」：
   * - 未完成的必须全给，否则模型会把同一件事再抽一遍 —— 这正是
   *   「已经做完的事反复被整理出来」的根因：模型根本不知道待办清单里有什么。
   * - 已完成的不可能全给（几年下来上千条），但最近那批最有参考价值。
   * 子项一并带上，否则模型看到父项会以为「这件事还没拆过」。
   */
  async function loadTodoSnapshots(): Promise<TodoSnapshot[]> {
    try {
      const all = await repo.listTodos();
      const byParent = new Map<number, string[]>();
      for (const t of all) {
        if (t.parentId === null || t.mergedInto !== null) continue;
        const list = byParent.get(t.parentId) ?? [];
        list.push(t.text);
        byParent.set(t.parentId, list);
      }
      const tops = all.filter((t) => t.parentId === null && t.mergedInto === null);
      const open = tops.filter((t) => !t.done);
      const done = tops.filter((t) => t.done).slice(0, 12);
      return [...open, ...done].map((t) => ({
        text: t.text,
        done: t.done,
        due: t.dueAt,
        children: byParent.get(t.id) ?? [],
      }));
    } catch {
      return [];
    }
  }

  /**
   * 发起一次整理（v0.17）。
   *
   * 两种材料来源：碎片（受当前范围约束）和会话（从历史里点「整理成文档」）。
   * 无论哪种，**写库都发生在用户点「加入文档库」之后** —— 这一步之前
   * 数据一个字都不会变，包括模型自己觉得写得很好也不行。
   *
   * 过程日志的每一行都必须是真的：读了 N 条、拆出 M 篇、正在写《x》。
   * 不写「正在分析…」这种谁也验证不了的空话 —— 那就又回到「一个转圈」了。
   */
  async function startDraft(
    mode: DraftMode,
    opts: {
      instruction?: string;
      turns?: QaTurn[];
      session?: AskSession;
      /** 指定要整理的那批碎片（重新整理时用当初那批）。不传就自己取最近的一批 */
      fragments?: Fragment[];
    } = {},
  ) {
    if (draftBusy || busy) return;
    if (!opts.turns && !opts.fragments && docMode) {
      // 文档范围是「只问这几份文档」的契约。整理要读碎片正文，跨过去就是越界。
      showToast('这次的范围是文档，整理碎片请新开一场会话');
      return;
    }

    const gen = ++draftGenRef.current;
    setDraftErr(null);
    setDraftNote('');
    setDraftReasoning('');
    setDraftRecv(0);
    setDraftElapsed(0);
    setSavedDocs([]);
    setInput('');
    setDraft(emptyDraft(mode, []));
    setDraftSteps([{ text: '正在读材料…', state: 'running' }]);
    setDraftSession(opts.session?.id ?? sessionIdRef.current);
    setDraftBusy(true);

    try {
      const config = await loadAiConfig();
      let source: KnowledgeSource;
      let sourceIds: number[] = [];
      let hint = '';

      if (opts.turns) {
        source = { kind: 'session', turns: opts.turns };
        hint = `这场会话的 ${opts.turns.length} 轮问答`;
      } else {
        const picked = opts.fragments ?? (await pickFragments(context));
        if (!picked.length) {
          setDraft(null);
          setDraftSteps([]);
          showToast('还没有可整理的碎片，先记点什么');
          return;
        }
        sourceIds = picked.map((f) => f.id);
        source = { kind: 'fragments', fragments: picked };
        hint = opts.fragments
          ? `当初那 ${picked.length} 条碎片`
          : `最近 ${picked.length} 条碎片`;
      }
      if (draftGenRef.current !== gen) return;

      const existing = await loadTodoSnapshots();
      if (draftGenRef.current !== gen) return;
      setDraftSteps([
        { text: `读到${hint}${existing.length ? `，${existing.length} 条已有待办` : ''}`, state: 'done' },
        { text: '正在提炼可复用的知识…', state: 'running' },
      ]);

      const out = await extractKnowledge({
        source,
        mode,
        instruction: opts.instruction,
        existingTodos: existing,
        config,
        onProgress: (patch) => {
          if (draftGenRef.current !== gen) return;
          if (patch.content !== undefined) {
            const n = patch.content.length;
            setDraftRecv(n);
            markLastStep({ text: `正在写出结果…（已收到 ${n} 字）` });
          }
          if (patch.reasoning !== undefined) setDraftReasoning(patch.reasoning);
        },
      });
      if (draftGenRef.current !== gen) return;

      setDraft({ ...out.draft, sourceIds });
      // 日志如实报：拆了几篇、几条待办。没有就说没有，不写「0 篇文档」
      const bits: string[] = [];
      if (out.draft.docs.length) bits.push(`${out.draft.docs.length} 篇文档`);
      const todoN = out.draft.todos.filter((t) => t.text.trim()).length;
      if (todoN) bits.push(`${todoN} 件事`);
      setDraftSteps([
        { text: `读到${hint}`, state: 'done' },
        {
          text: bits.length ? `整理出 ${bits.join('、')}，等你过目` : '材料里没有可沉淀的知识',
          state: 'done',
        },
      ]);
      setDraftNote(
        out.truncated ? '材料太多，中间省略了一部分，可能漏掉一些细节' : '',
      );
    } catch (e) {
      if (draftGenRef.current !== gen) return;
      setDraftErr(errorDetailOf(e));
      markLastStep({ state: 'fail' });
    } finally {
      if (draftGenRef.current === gen) setDraftBusy(false);
    }
  }

  /** 草稿开着时，用户说的每一句都是「改哪里」 */
  async function reviseCurrent(instruction: string) {
    if (!draft || draftBusy || savingDraft) return;
    const gen = draftGenRef.current;
    setInput('');
    setDraftErr(null);
    setDraftRecv(0);
    setDraftElapsed(0);
    setDraftBusy(true);
    pushStep({ text: '正在按你说的改…', state: 'running' });
    try {
      const config = await loadAiConfig();
      const next = await reviseDraft({
        draft,
        instruction,
        config,
        onProgress: (patch) => {
          if (draftGenRef.current !== gen) return;
          if (patch.content !== undefined) setDraftRecv(patch.content.length);
        },
      });
      if (draftGenRef.current !== gen) return;
      setDraft(next);
      markLastStep({ text: '已按你说的改过', state: 'done' });
      setDraftNote('不满意可以继续说；改好的每一篇都可以单独加入文档库');
    } catch (e) {
      if (draftGenRef.current !== gen) return;
      setDraftErr(errorDetailOf(e));
      markLastStep({ state: 'fail' });
    } finally {
      if (draftGenRef.current === gen) setDraftBusy(false);
    }
  }

  function discardDraft() {
    draftGenRef.current += 1;
    setDraft(null);
    setDraftBusy(false);
    setDraftErr(null);
    setDraftNote('');
    setDraftSteps([]);
    setSavedDocs([]);
    setDraftSession(null);
  }

  /**
   * 写入文档库 / 待办。
   *
   * `only` 是草稿里某一篇的下标 —— 卡片上每篇的「加入文档库」走这条；
   * null 表示「全部」。
   *
   * 顺序：文档 → 待办 → 会话标记。文档写失败就中止，不留「待办进去了、
   * 文档没进去」的半个结果 —— 用户没法从界面上判断缺了哪一半。
   */
  async function approveDraft(only: number | null) {
    if (!draft || savingDraft || draftBusy) return;

    const single = only !== null ? draft.docs[only] : null;
    if (single) {
      const problem = docProblem(single);
      if (problem) {
        setDraftErr({ message: problem });
        return;
      }
      if (!allowDoc) {
        setDraftErr({ message: '「允许写入文档区」是关着的，先打开它' });
        return;
      }
    } else {
      const problem = draftProblem(draft);
      if (problem) {
        setDraftErr({ message: problem });
        return;
      }
    }

    const already = new Set(savedDocs.map((s) => s.index));
    const docTargets = (
      single
        ? [{ index: only as number, doc: single }]
        : allowDoc && draft.mode === 'knowledge'
          ? keptDocs(draft).map((doc) => ({ index: draft.docs.indexOf(doc), doc }))
          : []
    ).filter((t) => !already.has(t.index));

    const todoTargets = single ? [] : allowTodos ? keptTodos(draft) : [];
    if (!docTargets.length && !todoTargets.length) {
      setDraftErr({
        message: '没有可写入的内容：权限关掉了，或者这些都已经写过了',
      });
      return;
    }

    setSavingDraft(true);
    setDraftErr(null);
    try {
      const now = Date.now();
      const written: SavedDoc[] = [];

      for (const target of docTargets) {
        const name = docNameOf(target.doc, now, target.index);
        pushStep({ text: `正在写入《${name}》`, state: 'running' });
        const id = await writeKnowledgeDocument({
          title: name,
          bodyMd: target.doc.bodyMd,
          excerpt: target.doc.summary || excerptOf(target.doc.bodyMd),
        });
        written.push({ index: target.index, id, name });
        markLastStep({ text: `已写入《${name}》`, state: 'done' });
      }

      let todoCount = 0;
      if (todoTargets.length) {
        pushStep({ text: `正在写入 ${todoTargets.length} 件事`, state: 'running' });
        for (const t of todoTargets) {
          // 父项先落库拿到 id，子项才有地方挂。两层结构靠的就是这一步
          const parentId = await repo.insertTodo({
            text: t.text,
            dueAt: t.due,
            sourceFragmentId: null,
            parentId: null,
          });
          todoCount += 1;
          for (const ch of t.children) {
            if (!ch.keep || !ch.text.trim()) continue;
            await repo.insertTodo({
              text: ch.text,
              dueAt: ch.due,
              sourceFragmentId: null,
              parentId,
            });
            todoCount += 1;
          }
        }
        markLastStep({ text: `已写入 ${todoCount} 条待办`, state: 'done' });
      }

      // 会话上记下「这场整理出了哪几篇」：历史列表要能逐个跳过去
      const allIds = [...savedDocs.map((s) => s.id), ...written.map((w) => w.id)];
      if (draftSession !== null && allIds.length) {
        try {
          await repo.markAskSessionDocument(draftSession, allIds, draft.sourceIds);
          await loadHistory();
        } catch {
          /* 标记失败不影响已经写进去的文档 */
        }
      }
      try {
        await onSaved();
      } catch {
        /* 刷新失败不影响已经写进去的东西 */
      }

      setSavedDocs([...savedDocs, ...written]);
      /*
       * 只写了一篇时不动草稿的其余部分：另外两篇还在等用户看，
       * 待办也还没写。清空它们等于「点了一篇，别的都没了」。
       */
      if (!single) setDraft({ ...draft, todos: [] });
      const said: string[] = [];
      if (written.length) said.push(`${written.length} 篇文档`);
      if (todoCount) said.push(`${todoCount} 条待办`);
      showToast(said.length ? `已写入 ${said.join('、')}` : '没有写入任何东西');
    } catch (e) {
      setDraftErr(errorDetailOf(e));
      markLastStep({ state: 'fail' });
    } finally {
      setSavingDraft(false);
    }
  }

  /**
   * 取这一轮要整理的碎片。
   *
   * 从某条碎片进来就只整理那一条（用户点的就是它）；否则取最近的一批。
   * 用 `packFragments` 而不是 `slice`：一条超长碎片会把整批挤掉，
   * 这一点在「整理」里已经踩过一次（见 util/batch.ts）。
   */
  async function pickFragments(contextFragment: Fragment | null): Promise<Fragment[]> {
    if (contextFragment) return [contextFragment];
    try {
      const all = await repo.listFragments(200);
      const usable = all.filter((f) => f.mergedInto === null);
      return packFragments(usable, 40, 16_000);
    } catch {
      return [];
    }
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
  const docMode = scope.kind === 'documents';
  /** 范围必须一直看得见：隐私边界不能只写在代码里 */
  const scopeLine = docMode
    ? `只问这 ${scope.documentIds.length} 份文档${docNames.length ? `：${docNames.join('、')}` : ''}`
    : '范围：你的碎片、小结与待办';
  /** 能不能发出去：有字、不在忙、范围明确 */
  const canSend = !!input.trim() && !busy && !scopeProblem;

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

  return (
    <View style={styles.root} {...pan.panHandlers}>
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
        onContentSizeChange={scrollToEnd}
      >
        {!hasContent && !pendingQ && !draft ? (
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

        {turns.map((t, i) => (
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
            saved={savedDocs}
            onOpenDoc={(id) => {
              setDocReload((n) => n + 1);
              setOpenDocId(id);
            }}
            onApprove={(index) => void approveDraft(index)}
            onDiscard={discardDraft}
            onRetry={() => {
              // 重试＝用同一个来源再跑一遍。材料的取法和第一次完全一致
              if (draft?.mode === 'todos') void startDraft('todos');
              else void startDraft('knowledge');
            }}
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
          {docMode ? (
            // 文档模式首版直接禁用联网：来源必须只有用户选的那几份
            <View style={[styles.toggle, styles.toggleOff]} accessibilityLabel="文档模式不联网">
              <Ionicons name="cloud-offline-outline" size={13} color={c.text3} />
              <Text style={styles.toggleText}>不联网</Text>
            </View>
          ) : (
            <Pressable style={[styles.toggle, webOn && styles.toggleOn]} onPress={toggleWeb}>
              <Ionicons
                name="globe-outline"
                size={13}
                color={webOn ? c.accentText : c.text3}
              />
              <Text style={[styles.toggleText, webOn && styles.toggleTextOn]}>联网搜索</Text>
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
            style={styles.input}
            multiline
            maxLength={500}
            editable={!busy}
          />
          <Pressable
            onPress={() => void send()}
            // 范围有问题时按钮直接不可用：原因就写在上面的红字里
            disabled={!input.trim() || busy || !!scopeProblem}
            style={[styles.send, canSend && styles.sendOn]}
            hitSlop={6}
          >
            <Ionicons name="arrow-up" size={16} color={canSend ? c.onAccent : c.text3} />
          </Pressable>
        </View>
        <View style={{ height: keyboardHeight }} />
      </View>

      {/* ---------------- 历史会话 ---------------- */}
      {historyOpen ? (
        <View style={styles.historyPage} {...historyPan.panHandlers}>
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
            onAsk={(ids) => {
              setOpenDocId(null);
              // 文档问和碎片问是两条入口：换范围必须新开会话，别在旧会话上改契约
              newSession();
              setScope({ kind: 'documents', documentIds: ids });
            }}
          />
        </View>
      ) : null}

      {cite ? <CitationSheet cite={cite} onClose={() => setCite(null)} /> : null}
      <Toast text={toast} bottom={keyboardHeight + 110} />
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.page },
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
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderRadius: R.pill,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  newHintText: { fontSize: 13, color: '#FFFFFF', fontWeight: '500' },
  content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 20 },
  /** 没内容时把「问点什么」放在可视区中间，而不是贴着顶部 */
  contentEmpty: { flexGrow: 1, justifyContent: 'center', paddingBottom: 90 },

  /* ---- 空态的三张提示框 ---- */
  hints: { alignSelf: 'stretch', gap: 10, marginTop: 22, paddingHorizontal: 4 },
  hint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: R.card,
    borderWidth: 0.5,
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
    borderRadius: R.btn,
    backgroundColor: c.hairSoft,
  },
  scopeText: { flex: 1, minWidth: 0, fontSize: 11.5, lineHeight: 17, color: c.text2 },
  scopeTag: {
    fontSize: 10,
    lineHeight: 14,
    color: c.text3,
    borderWidth: 0.5,
    borderColor: c.hair,
    borderRadius: R.pill,
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
    borderRadius: R.card,
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
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
  },
  ghostBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: c.hair,
  },
  ghostBtnText: { fontSize: 13, color: c.text },
  solidBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: R.btn,
    backgroundColor: c.accent,
  },
  solidBtnText: { fontSize: 13, color: c.onAccent, fontWeight: '600' },
});
