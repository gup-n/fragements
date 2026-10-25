import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type {
  AiConfig,
  DigestKind,
  Fragment,
  KnowledgeCard,
  Note,
  OrganizeMode,
  OrganizeResult,
  Todo,
} from '../types';
import { C, R } from '../theme';
import { repo } from '../db/repo';
import { commitResult } from '../db/commit';
import { loadAiConfig } from '../ai/config';
import { AiError } from '../ai/chat';
import { organize } from '../ai/deepseek';
import type { OrganizeProgress } from '../ai/deepseek';
import { missingDigests } from '../util/digest';
import { freshOffKeys, resultKeys } from '../util/resultItems';
import { pruneResult } from '../util/dedupe';
import { packFragments, pendingOnly } from '../util/batch';
import { useKeyboardHeight } from '../util/keyboard';
import { SummarySheet } from '../components/SummarySheet';
import { ResultSections } from '../components/ResultSections';
import { BacklogCard } from '../components/BacklogCard';
import { ReasoningStream } from '../components/ReasoningStream';
import { ReasoningTrace } from '../components/ReasoningTrace';
import { ScreenHeader } from '../components/ScreenHeader';

interface Props {
  fragments: Fragment[];
  /** 用于算出「哪些周期还没有小结」 */
  notes: Note[];
  onClose: () => void;
  onApplied: () => void | Promise<void>;
  onOpenSettings: () => void;
}

type Phase = 'idle' | 'running' | 'error' | 'result' | 'applying' | 'done';

/**
 * 重构范围：
 * - all = 全部碎片（未整理 + 已整理），一次把历史重新过一遍
 * - recent = 只挑整理过的
 * - topic = 某个知识卡主题下的碎片
 */
type RefactorScope = 'all' | 'recent' | 'topic';

/**
 * 单次整理最多带多少条。
 *
 * 这里从 60 降到 30 不是拍脑袋：条数不是成本，**字数和输出量**才是。
 * 60 条的一次整理，思考链 + 九类 JSON 很容易把输出推到三四万 token，
 * 一轮要跑七八分钟 —— 中途被截断就等于全废。砍到 30 条之后单轮输出量减半，
 * 思考链短了、失败代价也小了。剩下的用「继续整理」接着跑，
 * 比在客户端里自动拆批简单得多，而且每一轮都还能正常追问。
 */
const INBOX_LIMIT = 30;
/**
 * 单次整理的字符预算。条数只是粗控 ——
 * 一条三千字的长笔记和三十条随手记一样重，光按条数装箱会让它独占整批。
 * 超预算就提前收手，把它留到下一轮（单独跑而不是被截断）。
 */
const BATCH_CHAR_BUDGET = 12_000;
/** 重构单次上限。原文比未读碎片长得多，多了 token 会爆 */
const REFACTOR_LIMIT = 20;
/** 重构的字数预算比整理宽一点：它要把旧标签一起发给模型，每条天然更长 */
const REFACTOR_CHAR_BUDGET = 16_000;

/** 整理页「待补小结」最多列几条 */
const BACKLOG_LIMIT = 10;

export function OrganizeScreen({ fragments, notes, onClose, onApplied, onOpenSettings }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<OrganizeMode>('organize');
  const [refactorScope, setRefactorScope] = useState<RefactorScope>('all');
  /** 待补小结面板：选中的那条周期 */
  const [digestTarget, setDigestTarget] = useState<{ kind: DigestKind; period: string } | null>(null);
  const [refactorTopic, setRefactorTopic] = useState<string | null>(null);
  const [result, setResult] = useState<OrganizeResult | null>(null);
  /** 模型原始输出，追问时原样回传 */
  const [raw, setRaw] = useState('');
  /** 被用户取消勾选的项；新结果里默认全选，所以只记「取消」比记「选中」更稳 */
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [round, setRound] = useState(0);
  /** 真正写进库的条数。不能用「勾选了几项」代替 —— 勾了但无事可做的项不算 */
  const [applied, setApplied] = useState(0);
  /** 刚才写库的那一批有几条。done 页要报它，不能用重新装箱后的 batch.length */
  const [appliedBatch, setAppliedBatch] = useState(0);
  const [refineText, setRefineText] = useState('');
  const [refineError, setRefineError] = useState('');
  const [refining, setRefining] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [runId, setRunId] = useState<number | null>(null);
  /**
   * 这一次进来之后已经过了一遍的碎片 id。
   *
   * 之前「继续整理剩下的 N 条」点下去还是原来那 20 条，根因就是批次永远从池子头部取：
   * 重构**不改变碎片状态**（它们本来就是 tagged），池子一点没变；
   * 整理模式只把「AI 给了标签且用户勾选」的那几条标成 tagged，
   * 剩下没被抽到标签的仍留在 inbox 前排，下一批还是它们打头。
   * 现在两层兜底：这里记会话内游标，commit 里再把整批标成 tagged。
   */
  const [doneIds, setDoneIds] = useState<Set<number>>(new Set());
  /** 这一轮被降噪收起的重复卡片 / 待办，如实显示，别让内容悄悄少掉 */
  const [pruned, setPruned] = useState({ cards: 0, todos: 0 });

  // 首轮请求时拿到的上下文，追问要复用同一份，否则模型看到的范围会变
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [topics, setTopics] = useState<string[]>([]);
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  /** 重构 idle 面板要按主题挑范围，得先知道有哪些主题 */
  const [idleTopics, setIdleTopics] = useState<{ topic: string; count: number }[]>([]);

  /** 模型的思维链（累积全文）。只用于展示，永远不参与解析 */
  const [reasoning, setReasoning] = useState('');
  /** 正文已经接收到多少字，给用户一个「确实在动」的信号 */
  const [received, setReceived] = useState(0);
  /** 这一轮已经跑了多少秒 */
  const [elapsed, setElapsed] = useState(0);
  /** 结果页里思考过程是否展开 */
  const [showReasoning, setShowReasoning] = useState(false);
  /** 本轮模型是否开着思考模式，用来区分「还没开始想」和「模型不支持」 */
  const [thinkingOn, setThinkingOn] = useState(false);

  const startedAtRef = useRef(0);
  /**
   * 流式回调的频率很高（一个思考过程可能几百个 chunk），
   * 每来一块就 setState 会把 JS 线程占满、界面卡住。
   * 这里用 ref 攒着，最多 120ms 上屏一次；结束时再用最终值兜一次底。
   */
  const streamRef = useRef({ lastFlush: 0 });

  const keyboardHeight = useKeyboardHeight();

  const inbox = useMemo(() => fragments.filter((f) => f.status === 'inbox'), [fragments]);
  const organized = useMemo(() => fragments.filter((f) => f.status === 'tagged'), [fragments]);

  const backlog = useMemo(
    () => missingDigests(fragments, notes, BACKLOG_LIMIT),
    [fragments, notes],
  );

  // 进页面或切换模式时刷新一次已有卡片/主题，空闲面板要用
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [c, t] = await Promise.all([repo.listKnowledgeCards(), repo.listKnowledgeTopics()]);
        if (!alive) return;
        setCards(c);
        setIdleTopics(t);
      } catch {
        /* 读不到就空着，不影响整理 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [mode]);

  /** 还没过过一遍的待整理碎片。doneIds 是会话内游标，刷新后仍留在 inbox 的靠它挡 */
  const inboxPool = useMemo(() => pendingOnly(inbox, doneIds), [inbox, doneIds]);

  const organizeBatch = useMemo(
    () => packFragments(inboxPool, INBOX_LIMIT, BATCH_CHAR_BUDGET),
    [inboxPool],
  );

  const refactorPool = useMemo(() => {
    if (refactorScope === 'topic') {
      if (!refactorTopic) return [];
      const ids = new Set<number>();
      for (const c of cards) {
        if (c.topic === refactorTopic) c.sourceIds.forEach((id) => ids.add(id));
      }
      return fragments.filter((f) => ids.has(f.id));
    }
    // 「全部」把未整理的一起带上：以前必须先整理完才能重构，等于每次都要跑两轮。
    // 已合并（重复被折叠）的碎片不参与 —— 它们的内容已经在保留那条里了
    if (refactorScope === 'all') return fragments.filter((f) => f.mergedInto === null);
    return organized;
  }, [refactorScope, refactorTopic, cards, fragments, organized]);

  /** 本次会话已经重构过的不再重复装箱，否则「继续」永远取前 20 条 */
  const refactorPending = useMemo(
    () => pendingOnly(refactorPool, doneIds),
    [refactorPool, doneIds],
  );

  const refactorBatch = useMemo(
    () => packFragments(refactorPending, REFACTOR_LIMIT, REFACTOR_CHAR_BUDGET),
    [refactorPending],
  );

  const batch = mode === 'refactor' ? refactorBatch : organizeBatch;
  const available = mode === 'refactor' ? refactorPending.length : inboxPool.length;
  const overflow = available - batch.length;

  const acceptedKeys = useMemo(() => resultKeys(result), [result]);
  const isOn = (key: string) => !deselected.has(key);
  const acceptedCount = acceptedKeys.filter(isOn).length;

  // 运行中每 0.5 秒刷新一次计时，让人知道没卡住
  useEffect(() => {
    if (phase !== 'running' && !refining) return;
    const timer = setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [phase, refining]);

  /**
   * 流式回调。传进来的都是累积全文，所以丢掉几次中间态不会导致内容缺失 ——
   * 但最终值一定要在请求结束后再兜一次底，否则最后 120ms 里的内容会看不见。
   */
  function handleProgress(patch: OrganizeProgress) {
    const now = Date.now();
    if (now - streamRef.current.lastFlush < 120) return;
    streamRef.current.lastFlush = now;
    if (patch.reasoning !== undefined) setReasoning(patch.reasoning);
    if (patch.content !== undefined) setReceived(patch.content.length);
  }

  /** 开始新一轮之前把流式相关的状态清干净 */
  function beginRun() {
    setReasoning('');
    setReceived(0);
    setElapsed(0);
    setShowReasoning(false);
    streamRef.current.lastFlush = 0;
    startedAtRef.current = Date.now();
  }

  function toggle(key: string) {
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function start() {
    setPhase('running');
    setErrorMsg('');
    setRefineError('');
    beginRun();
    try {
      const cfg = await loadAiConfig();
      if (!cfg.apiKey) {
        setPhase('idle');
        setErrorMsg('还没配置 API Key，先去设置页填一个');
        return;
      }
      setThinkingOn(cfg.thinking);
      const startedAt = startedAtRef.current;
      const topicList = (await repo.listKnowledgeTopics()).map((t) => t.topic);
      const cardList = await repo.listKnowledgeCards();
      const todoList = await repo.listTodos();

      const outcome = await organize({
        fragments: batch,
        config: cfg,
        topics: topicList,
        cards: cardList,
        todos: todoList,
        mode,
        onProgress: handleProgress,
      });
      const cleaned = pruneResult(outcome.result, {
        cards: cardList,
        todos: todoList,
        refactor: mode === 'refactor',
      });

      const id = await repo.saveRun({
        startedAt,
        fragmentIds: batch.map((f) => f.id),
        model: cfg.model,
        resultJson: outcome.raw,
      });

      setRunId(id);
      setConfig(cfg);
      setTopics(topicList);
      setCards(cardList);
      setTodos(todoList);
      setRaw(outcome.raw);
      // 以最终值为准，补上节流可能漏掉的尾巴
      setReasoning(outcome.reasoning);
      setReceived(outcome.raw.length);
      setResult(cleaned.result);
      setPruned({ cards: cleaned.droppedCards, todos: cleaned.droppedTodos });
      setDeselected(freshOffKeys(new Set(), cleaned.result, null));
      setRound(1);
      setPhase('result');
    } catch (e) {
      const err = e as AiError;
      setErrorMsg(err?.message || '整理失败，稍后再试');
      setPhase('error');
    }
  }

  /** 多轮追问：把上一轮原始输出回传给模型，让它基于自己的结果改 */
  async function refine() {
    const instruction = refineText.trim();
    if (!instruction || !config || !raw) return;
    setRefining(true);
    setRefineError('');
    setErrorMsg('');
    beginRun();
    setThinkingOn(config.thinking);
    try {
      const outcome = await organize({
        fragments: batch,
        config,
        topics,
        cards,
        todos,
        previousRaw: raw,
        instruction,
        mode,
        onProgress: handleProgress,
      });
      const cleaned = pruneResult(outcome.result, {
        cards,
        todos,
        refactor: mode === 'refactor',
      });
      setRaw(outcome.raw);
      setResult(cleaned.result);
      setPruned({ cards: cleaned.droppedCards, todos: cleaned.droppedTodos });
      setReasoning(outcome.reasoning);
      setReceived(outcome.raw.length);
      // 内容没变的条目保留用户之前的勾选状态，只有新冒出来的破坏性操作才置为不勾
      setDeselected((prev) => freshOffKeys(prev, cleaned.result, result));
      setRefineText('');
      setRound((r) => r + 1);
    } catch (e) {
      const err = e as AiError;
      setRefineError(err?.message || '追问失败，稍后再试');
    } finally {
      setRefining(false);
    }
  }

  async function apply() {
    if (!result) return;
    setPhase('applying');
    try {
      const report = await commitResult({
        result,
        accepted: isOn,
        fragments,
        cards,
        // 整批都算「过了一遍」：只标「有标签且被勾选」的那几条，
        // 剩下没被抽到标签的会永远留在 inbox 前排，下次整理又是它们
        batchFragmentIds: batch.map((f) => f.id),
      });
      if (runId) await repo.markRunApplied(runId);
      setApplied(report.applied);
      setAppliedBatch(batch.length);
      // 会话内游标。重构不改碎片状态，没有它「继续重构」永远是同一批
      setDoneIds((prev) => new Set([...prev, ...batch.map((f) => f.id)]));
      // 先刷新再进 done：done 页要显示「还剩几条待整理」，
      // 用刷新前的 inbox 去算会把这一批已经整理完的又算一遍
      try {
        await onApplied();
      } catch {
        /* 刷新失败不该翻成「写入失败」—— 内容已经进库了，下次进页面会重读 */
      }
      setPhase('done');
    } catch (e) {
      setErrorMsg((e as Error)?.message || '写入失败');
      setPhase('error');
    }
  }

  const word = mode === 'refactor' ? '重构' : '整理';
  /** 当前模式的单批条数上限。文案里要用它，别再直接引常量 —— 重构那档是另一个数 */
  const batchLimit = mode === 'refactor' ? REFACTOR_LIMIT : INBOX_LIMIT;
  const headerTitle = round > 1 ? `${word} · 第 ${round} 版` : word;

  function switchMode(next: OrganizeMode) {
    if (next === mode) return;
    setMode(next);
    setErrorMsg('');
  }

  /** 切到按主题时自动选中第一个，否则池子是空的，用户会以为没东西可重构 */
  function pickTopicScope() {
    setRefactorScope('topic');
    if (!refactorTopic && idleTopics.length) setRefactorTopic(idleTopics[0].topic);
  }

  return (
    <View style={styles.root}>
      <ScreenHeader
        title={headerTitle}
        subtitle={mode === 'refactor' ? '把碎片重新过一遍，与旧结果对照' : '处理还没整理过的碎片'}
        onBack={onClose}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {phase === 'idle' && (
          <View>
            <View style={styles.segment}>
              <Pressable
                style={[styles.segmentItem, mode === 'organize' && styles.segmentItemOn]}
                onPress={() => switchMode('organize')}
              >
                <Ionicons
                  name="sparkles-outline"
                  size={14}
                  color={mode === 'organize' ? C.accentText : C.text3}
                />
                <Text style={[styles.segmentText, mode === 'organize' && styles.segmentTextOn]}>
                  整理未读
                </Text>
              </Pressable>
              <Pressable
                style={[styles.segmentItem, mode === 'refactor' && styles.segmentItemOn]}
                onPress={() => switchMode('refactor')}
              >
                <Ionicons
                  name="sync-outline"
                  size={14}
                  color={mode === 'refactor' ? C.accentText : C.text3}
                />
                <Text style={[styles.segmentText, mode === 'refactor' && styles.segmentTextOn]}>
                  重构已整理
                </Text>
              </Pressable>
            </View>

            <View style={styles.heroCard}>
              <Text style={styles.heroNum}>{available}</Text>
              <Text style={styles.heroLabel}>
                {mode === 'refactor'
                  ? refactorScope === 'topic' && refactorTopic
                    ? `「${refactorTopic}」下待重构`
                    : refactorScope === 'all'
                      ? '条待重构（未整理 + 已整理）'
                      : '条已整理待重构'
                  : '条未整理的碎片'}
              </Text>
              {doneIds.size > 0 && (
                <Text style={styles.heroSub}>本次已经过 {doneIds.size} 条，不会再重复取</Text>
              )}

              {mode === 'refactor' && (
                <View style={styles.scopeBlock}>
                  <Text style={styles.scopeLabel}>重构范围</Text>
                  <View style={styles.chipRow}>
                    <Chip
                      label="全部碎片"
                      on={refactorScope === 'all'}
                      onPress={() => setRefactorScope('all')}
                    />
                    <Chip
                      label="只重构已整理"
                      on={refactorScope === 'recent'}
                      onPress={() => setRefactorScope('recent')}
                    />
                    <Chip label="按主题" on={refactorScope === 'topic'} onPress={pickTopicScope} />
                  </View>
                  {refactorScope === 'topic' && (
                    <View style={styles.chipRow}>
                      {idleTopics.length ? (
                        idleTopics.map((t) => (
                          <Chip
                            key={t.topic}
                            label={`${t.topic} · ${t.count}`}
                            on={refactorTopic === t.topic}
                            onPress={() => setRefactorTopic(t.topic)}
                          />
                        ))
                      ) : (
                        <Text style={styles.scopeSub}>还没有知识卡，先用「整理未读」跑一轮。</Text>
                      )}
                    </View>
                  )}
                </View>
              )}

              <Pressable
                style={[styles.primaryBtn, !batch.length && styles.primaryBtnDisabled]}
                onPress={start}
                disabled={!batch.length}
              >
                <Text style={styles.primaryBtnText}>
                  {batch.length
                    ? `${mode === 'refactor' ? '开始重构' : '开始整理'} ${batch.length} 条`
                    : '没有可处理的碎片'}
                </Text>
              </Pressable>

              <BacklogCard
                backlog={backlog}
                onPick={(kind, period) => setDigestTarget({ kind, period })}
              />

              {overflow > 0 && (
                <Text style={styles.overflowText}>
                  一次只带 {batchLimit} 条，剩下 {overflow} 条下一轮。
                </Text>
              )}
              {!!errorMsg && <Text style={styles.errText}>{errorMsg}</Text>}
            </View>

            {mode === 'refactor' && (
              <View style={styles.explainCard}>
                <Text style={styles.explainTitle}>重构做什么</Text>
                <Text style={styles.explainText}>
                  把这些碎片重新过一遍：重新判标签、重新沉淀知识卡。结果会跟原来的整理逐条对照，
                  被新卡取代的旧卡只会建议归档 —— 归档可恢复，原文一个字都不动。
                </Text>
                <Text style={styles.explainText}>
                  会减少内容的三类操作（归档卡、删待办、合并待办）默认不勾选，得你自己点。
                  已做完的待办会自动标掉，因为那不算删除，回顾页里还能看到、也能撤回。
                </Text>
                <Text style={styles.explainText}>
                  不会重复抽待办 —— 上一轮已经抽过了，再抽一遍只会让列表变重复。
                </Text>
              </View>
            )}

            {mode === 'organize' && errorMsg.includes('API Key') && (
              <Pressable style={styles.linkRow} onPress={onOpenSettings}>
                <Text style={styles.linkText}>去设置里填 API Key</Text>
                <Ionicons name="chevron-forward" size={13} color={C.accent} />
              </Pressable>
            )}
          </View>
        )}

        {phase === 'running' && (
          <ReasoningStream
            title={`${word} ${batch.length} 条碎片…`}
            text={reasoning}
            received={received}
            elapsed={elapsed}
            thinking={thinkingOn}
            height={300}
          />
        )}

        {phase === 'applying' && (
          <View style={styles.centerBox}>
            <ActivityIndicator color={C.accent} />
            <Text style={styles.centerText}>正在写入…</Text>
          </View>
        )}

        {phase === 'error' && (
          <View style={styles.heroCard}>
            <Text style={styles.errTitle}>出错了</Text>
            <Text style={styles.errText}>{errorMsg}</Text>
            <Pressable style={styles.primaryBtn} onPress={start}>
              <Text style={styles.primaryBtnText}>重试</Text>
            </Pressable>
            <Pressable style={styles.secondaryBtn} onPress={onOpenSettings}>
              <Text style={styles.secondaryBtnText}>检查设置</Text>
            </Pressable>
          </View>
        )}

        {phase === 'done' && (
          <View style={styles.centerBox}>
            <Ionicons name="checkmark-circle-outline" size={36} color={C.accent} />
            <Text style={styles.centerText}>已写入 {applied} 项</Text>
            <Text style={styles.doneMeta}>这一批 {appliedBatch} 条已经{word}过一遍</Text>
            {overflow > 0 ? (
              <>
                <Text style={styles.doneSub}>
                  还剩 {overflow} 条没{word}。一次只带 {batchLimit} 条是为了让模型专心 ——
                  一轮跑太多，输出容易撞上限，出错就得从头再来。
                </Text>
                <Pressable style={styles.primaryBtn} onPress={start}>
                  <Text style={styles.primaryBtnText}>
                    继续{word}剩下的 {batch.length} 条
                  </Text>
                </Pressable>
                <Pressable style={styles.secondaryBtn} onPress={onClose}>
                  <Text style={styles.secondaryBtnText}>先回时间轴</Text>
                </Pressable>
              </>
            ) : (
              <Pressable style={styles.primaryBtn} onPress={onClose}>
                <Text style={styles.primaryBtnText}>回到时间轴</Text>
              </Pressable>
            )}
          </View>
        )}

        {phase === 'result' && result && (
          <View>
            {refining ? (
              <ReasoningStream
                title={`按第 ${round} 版的要求重写…`}
                text={reasoning}
                received={received}
                elapsed={elapsed}
                thinking={thinkingOn}
                height={300}
              />
            ) : (
              <>
                <Text style={styles.resultHint}>
                  逐条确认。关掉的项不会写入。
                  {round > 1 ? '追问后没改动的条目，你之前的勾选状态会保留。' : ''}
                </Text>
                {pruned.cards > 0 || pruned.todos > 0 ? (
                  <Text style={styles.pruneNote}>
                    已自动收起
                    {pruned.cards > 0 ? `${pruned.cards} 张和已有卡片重复的知识卡` : ''}
                    {pruned.cards > 0 && pruned.todos > 0 ? '、' : ''}
                    {pruned.todos > 0 ? `${pruned.todos} 条重复待办` : ''}
                    —— 重复的新卡会把新来源补进旧卡，内容一个字都没丢。
                  </Text>
                ) : null}
                <ReasoningTrace
                  text={reasoning}
                  expanded={showReasoning}
                  onToggle={() => setShowReasoning((v) => !v)}
                />
              </>
            )}

            <ResultSections
              result={result}
              mode={mode}
              fragments={fragments}
              cards={cards}
              todos={todos}
              isOn={isOn}
              onToggle={toggle}
            />
          </View>
        )}
      </ScrollView>

      {phase === 'result' && (
        <View style={[styles.footer, keyboardHeight > 0 && { paddingBottom: keyboardHeight + 8 }]}>
          <View style={styles.refineRow}>
            <TextInput
              value={refineText}
              onChangeText={setRefineText}
              placeholder="不满意？说一句让 AI 改，比如「待办合并成一条」"
              placeholderTextColor={C.text3}
              style={styles.refineInput}
              multiline
              maxLength={200}
              editable={!refining}
            />
            <Pressable
              onPress={refine}
              disabled={!refineText.trim() || refining}
              style={[styles.refineSend, refineText.trim() && styles.refineSendOn]}
              hitSlop={6}
            >
              {refining ? (
                <ActivityIndicator size="small" color={C.text3} />
              ) : (
                <Ionicons name="arrow-up" size={15} color={refineText.trim() ? '#FFFFFF' : C.text3} />
              )}
            </Pressable>
          </View>
          {!!refineError && <Text style={styles.refineErr}>{refineError}</Text>}

          <View style={styles.bottomBar}>
            <Pressable style={styles.secondaryBtnFlex} onPress={onClose}>
              <Text style={styles.secondaryBtnText}>全部放弃</Text>
            </Pressable>
            <Pressable
              style={[styles.primaryBtnFlex, (!acceptedCount || refining) && styles.primaryBtnDisabled]}
              onPress={apply}
              disabled={!acceptedCount || refining}
            >
              <Text style={styles.primaryBtnText}>应用 {acceptedCount} 项</Text>
            </Pressable>
          </View>
        </View>
      )}

      {digestTarget && (
        <SummarySheet
          initialKind={digestTarget.kind}
          initialPeriod={digestTarget.period}
          onClose={() => setDigestTarget(null)}
          onSaved={onApplied}
        />
      )}
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.chip, on && styles.chipOn]} onPress={onPress}>
      {on ? <Ionicons name="checkmark" size={12} color={C.accentText} /> : null}
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.page },

  content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24 },

  segment: {
    flexDirection: 'row',
    backgroundColor: C.hairSoft,
    borderRadius: R.btn,
    padding: 3,
    marginBottom: 14,
  },
  segmentItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 8,
    borderRadius: R.btn - 2,
  },
  segmentItemOn: { backgroundColor: C.card },
  segmentText: { fontSize: 13, color: C.text2 },
  segmentTextOn: { color: C.text, fontWeight: '500' },

  heroCard: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    padding: 22,
    alignItems: 'center',
  },
  heroNum: { fontSize: 40, color: C.text, fontWeight: '500', lineHeight: 46 },
  heroLabel: { fontSize: 13, color: C.text2, marginTop: 2 },
  heroSub: { fontSize: 11, color: C.text3, marginTop: 6 },

  scopeBlock: {
    alignSelf: 'stretch',
    marginTop: 18,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
  },
  scopeLabel: { fontSize: 12, color: C.text2, marginBottom: 9 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: R.pill,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderWidth: 0.5,
    borderColor: C.hair,
  },
  chipOn: { backgroundColor: C.accentBg, borderColor: C.accentBg },
  chipText: { fontSize: 12, color: C.text2, lineHeight: 17 },
  chipTextOn: { color: C.accentText },
  scopeSub: { fontSize: 11, color: C.text3, lineHeight: 17 },

  explainCard: {
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: R.card,
    backgroundColor: C.hairSoft,
    gap: 8,
  },
  explainTitle: { fontSize: 12, color: C.text, fontWeight: '500' },
  explainText: { fontSize: 11, color: C.text2, lineHeight: 18 },

  overflowText: { fontSize: 11, color: C.text3, marginTop: 10, textAlign: 'center', lineHeight: 17 },

  primaryBtn: {
    backgroundColor: C.accent,
    borderRadius: R.btn,
    paddingVertical: 11,
    paddingHorizontal: 22,
    marginTop: 18,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  primaryBtnDisabled: { backgroundColor: C.hair },
  primaryBtnText: { fontSize: 14, color: '#FFFFFF', fontWeight: '500' },
  secondaryBtn: {
    borderRadius: R.btn,
    paddingVertical: 10,
    paddingHorizontal: 22,
    marginTop: 8,
    alignSelf: 'stretch',
    alignItems: 'center',
    borderWidth: 0.5,
    borderColor: C.hair,
  },
  secondaryBtnText: { fontSize: 13, color: C.text2 },

  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    marginTop: 14,
    paddingVertical: 8,
  },
  linkText: { fontSize: 13, color: C.accent },

  centerBox: { alignItems: 'center', justifyContent: 'center', paddingVertical: 80, gap: 10 },
  centerText: { fontSize: 14, color: C.text2 },
  doneMeta: { fontSize: 11.5, color: C.text3, marginTop: -2 },
  doneSub: {
    fontSize: 12,
    color: C.text3,
    lineHeight: 19,
    textAlign: 'center',
    maxWidth: 300,
    marginBottom: 4,
  },

  errTitle: { fontSize: 14, color: C.danger, fontWeight: '500', marginBottom: 8 },
  errText: { fontSize: 12, color: C.danger, lineHeight: 19, textAlign: 'center', marginTop: 12 },

  resultHint: { fontSize: 12, color: C.text3, marginBottom: 14, marginTop: 4, lineHeight: 18 },
  pruneNote: { fontSize: 11.5, color: C.amberText, lineHeight: 18, marginBottom: 14 },

  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
    backgroundColor: C.page,
    paddingTop: 8,
    paddingBottom: 8,
  },
  refineRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginHorizontal: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
  },
  refineInput: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
    color: C.text,
    maxHeight: 72,
    paddingTop: 3,
    paddingBottom: 3,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
  },
  refineSend: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.hairSoft,
  },
  refineSendOn: { backgroundColor: C.accent },
  refineErr: { fontSize: 11, color: C.danger, paddingHorizontal: 16, paddingTop: 6, lineHeight: 16 },

  bottomBar: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 6,
  },
  secondaryBtnFlex: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: C.hair,
  },
  primaryBtnFlex: {
    flex: 1.6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: R.btn,
    backgroundColor: C.accent,
  },
});
