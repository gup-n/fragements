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
import type { ScrollViewInstance } from 'react-native';
import type { AiConfig, Fragment, KnowledgeCard, OrganizeResult, Todo } from '../types';
import { C, R, tagColor } from '../theme';
import { repo } from '../db/repo';
import { loadAiConfig } from '../ai/config';
import { AiError } from '../ai/chat';
import { organize } from '../ai/deepseek';
import type { OrganizeProgress } from '../ai/deepseek';
import { todayISO } from '../util/date';
import { useKeyboardHeight } from '../util/keyboard';

interface Props {
  fragments: Fragment[];
  onClose: () => void;
  onApplied: () => void;
  onOpenSettings: () => void;
}

type Phase = 'idle' | 'running' | 'error' | 'result' | 'applying' | 'done';

/**
 * organize = 处理未读碎片
 * refactor = 把已整理过的碎片重新过一遍，结果与旧标签、旧知识卡逐项对照
 */
type Mode = 'organize' | 'refactor';

/** 重构范围：最近整理过的，或某个主题下的全部碎片 */
type RefactorScope = 'recent' | 'topic';

const INBOX_LIMIT = 60;
/** 重构单次上限。原文比未读碎片长得多，多了 token 会爆 */
const REFACTOR_LIMIT = 40;

/**
 * 确认项的稳定 key。
 *
 * 不能用数组下标 —— 追问之后模型会重排、增删条目，下标一动，
 * 用户刚才取消掉的勾选就会落到另一条内容上。用内容本身做 key，
 * 只要这一条没变，它的勾选状态就跟着它走。
 */
const K = {
  todo: (text: string) => `todo|${text}`,
  knowledge: (topic: string, title: string) => `knowledge|${topic}|${title}`,
  tag: (id: number) => `tag|${id}`,
  merge: (keepId: number, dropIds: number[]) => `merge|${keepId}|${dropIds.join(',')}`,
  done: (todoId: number) => `done|${todoId}`,
  card: (cardId: number) => `card|${cardId}`,
  archive: (cardId: number) => `archive|${cardId}`,
  drop: (todoId: number) => `drop|${todoId}`,
  summary: 'summary',
};

/** 两组标签是否等价（集合比较，模型重排顺序不算变化） */
function sameLabels(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort().join('\u0001');
  const sb = [...b].sort().join('\u0001');
  return sa === sb;
}

export function OrganizeScreen({ fragments, onClose, onApplied, onOpenSettings }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<Mode>('organize');
  const [refactorScope, setRefactorScope] = useState<RefactorScope>('recent');
  const [refactorTopic, setRefactorTopic] = useState<string | null>(null);
  const [result, setResult] = useState<OrganizeResult | null>(null);
  /** 模型原始输出，追问时原样回传 */
  const [raw, setRaw] = useState('');
  /** 被用户取消勾选的项；新结果里默认全选，所以只记「取消」比记「选中」更稳 */
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [round, setRound] = useState(0);
  const [refineText, setRefineText] = useState('');
  const [refineError, setRefineError] = useState('');
  const [refining, setRefining] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [runId, setRunId] = useState<number | null>(null);

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

  const organizeBatch = useMemo(() => inbox.slice(0, INBOX_LIMIT), [inbox]);

  const refactorPool = useMemo(() => {
    if (refactorScope === 'topic') {
      if (!refactorTopic) return [];
      const ids = new Set<number>();
      for (const c of cards) {
        if (c.topic === refactorTopic) c.sourceIds.forEach((id) => ids.add(id));
      }
      return fragments.filter((f) => ids.has(f.id));
    }
    return organized;
  }, [refactorScope, refactorTopic, cards, fragments, organized]);

  const refactorBatch = useMemo(() => refactorPool.slice(0, REFACTOR_LIMIT), [refactorPool]);

  const batch = mode === 'refactor' ? refactorBatch : organizeBatch;
  const available = mode === 'refactor' ? refactorPool.length : inbox.length;
  const overflow = available - batch.length;

  const byId = useMemo(() => new Map(fragments.map((f) => [f.id, f])), [fragments]);
  const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const todoById = useMemo(() => new Map(todos.map((t) => [t.id, t])), [todos]);

  const allKeys = useMemo(() => {
    if (!result) return [];
    const keys: string[] = [];
    result.todos.forEach((t) => keys.push(K.todo(t.text)));
    result.knowledge.forEach((k) => keys.push(K.knowledge(k.topic, k.title)));
    result.todo_done.forEach((d) => keys.push(K.done(d.todo_id)));
    result.card_update.forEach((c) => keys.push(K.card(c.card_id)));
    result.archive_cards.forEach((a) => keys.push(K.archive(a.card_id)));
    result.drop_todos.forEach((d) => keys.push(K.drop(d.todo_id)));
    result.tags.forEach((t) => keys.push(K.tag(t.id)));
    result.merge.forEach((m) => keys.push(K.merge(m.keep_id, m.drop_ids)));
    if (result.summary) keys.push(K.summary);
    return keys;
  }, [result]);

  const isOn = (key: string) => !deselected.has(key);
  const acceptedCount = allKeys.filter(isOn).length;

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

  /**
   * 「归档卡」和「删待办」默认不勾选：它们会让内容从列表里消失，
   * 误操作很难被发现，必须由用户主动点一下。
   *
   * 「标记待办完成」不在此列 —— 用户明确要求「已经做完的自动标掉」。
   * 而且标完成不会让内容消失：回顾页有独立的已完成区，时间轴上对应碎片带「已完成」标记。
   *
   * 追问时只把「这一轮新冒出来的」置为不勾，用户已经表过态的保持原样。
   */
  function withFreshOff(prev: Set<string>, fresh: OrganizeResult, previous: OrganizeResult | null) {
    const next = new Set(prev);
    const addNew = (now: string[], before: string[]) => {
      const known = new Set(before);
      for (const key of now) if (!known.has(key)) next.add(key);
    };
    addNew(
      fresh.archive_cards.map((a) => K.archive(a.card_id)),
      (previous?.archive_cards ?? []).map((a) => K.archive(a.card_id)),
    );
    addNew(
      fresh.drop_todos.map((d) => K.drop(d.todo_id)),
      (previous?.drop_todos ?? []).map((d) => K.drop(d.todo_id)),
    );
    return next;
  }

  /**
   * 新卡和某张旧卡的来源碎片重叠 ≥ 50%，就认为这张新卡是旧卡的「替代版本」。
   * 重建构场景：同一段原文重新提炼，标题措辞变了，但讲的还是同一件事。
   */
  function replacementOf(sourceIds: number[]): KnowledgeCard | null {
    if (!sourceIds.length) return null;
    const incoming = new Set(sourceIds);
    let best: KnowledgeCard | null = null;
    let bestScore = 0;
    for (const c of cards) {
      if (!c.sourceIds.length) continue;
      const hit = c.sourceIds.filter((id) => incoming.has(id)).length;
      const score = hit / Math.min(c.sourceIds.length, sourceIds.length);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return bestScore >= 0.5 ? best : null;
  }

  /**
   * 重构模式要做的两件降噪，不能寄希望于模型自己收敛：
   *
   * 1. **不再重复抽待办**。这些碎片上次整理时已经抽过一遍了，模型重看一遍
   *    会再抽出来一批同样的 —— 每重构一次待办列表就多一份重复。判据两条：
   *    文案（去掉标点空白后）相同，或者这条碎片本来就派生出过待办。
   * 2. **不再生成今日小结**。重构的碎片本来就整理过了，那时候小结已经写过。
   *    再写一条同一天的小结纯属重复。
   *
   * 标签、知识卡、归档、删待办这些才是重构真正要产出的东西，原样保留。
   */
  function pruneRefactorResult(res: OrganizeResult, existing: Todo[]): OrganizeResult {
    if (mode !== 'refactor') return res;
    const norm = (s: string) => s.replace(/[\s，。、,.!！?？~～;；:：'"“”‘’()（）\[\]【】\-—_/]/g, '');
    const seenText = new Set(existing.map((t) => norm(t.text)));
    const seenSource = new Set(
      existing.map((t) => t.sourceFragmentId).filter((n): n is number => n !== null),
    );
    const todos = res.todos.filter(
      (t) => !seenText.has(norm(t.text)) && !(t.id !== null && seenSource.has(t.id)),
    );
    return { ...res, todos, summary: null };
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
      const cleaned = pruneRefactorResult(outcome.result, todoList);

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
      setResult(cleaned);
      setDeselected(withFreshOff(new Set(), cleaned, null));
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
      const cleaned = pruneRefactorResult(outcome.result, todos);
      setRaw(outcome.raw);
      setResult(cleaned);
      setReasoning(outcome.reasoning);
      setReceived(outcome.raw.length);
      setDeselected((prev) => withFreshOff(prev, cleaned, result));
      setRefineText('');
      setRound((r) => r + 1);
      // 其余项保留 deselected：内容没变的那几条，用户取消过就还是取消
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
    // 同一张旧卡可能被多张新卡判定为替代，只归档一次
    const archivedByReplacement = new Set<number>();
    /**
     * 用户明确取消勾选的「归档这张卡」，替代逻辑也不能偷偷把它归档掉。
     * 「操作要用户授权」这条得由代码保证，不能只在界面上提示一句。
     */
    const declinedArchive = new Set(
      result.archive_cards.filter((a) => !isOn(K.archive(a.card_id))).map((a) => a.card_id),
    );
    try {
      const tagItems = result.tags.filter((t) => isOn(K.tag(t.id)));
      for (const t of tagItems) {
        await repo.applyTags(t.id, t.labels, t.project);
      }

      for (const t of result.todos) {
        if (!isOn(K.todo(t.text))) continue;
        await repo.insertTodo({ text: t.text, dueAt: t.due, sourceFragmentId: t.id });
      }

      const todoSourceIds = result.todos
        .filter((t) => isOn(K.todo(t.text)))
        .map((t) => t.id)
        .filter((n): n is number => n !== null);
      if (todoSourceIds.length) await repo.setFragmentNature(todoSourceIds, 'todo');

      // 本轮碎片说明某些待办已经做完了
      for (const d of result.todo_done) {
        if (!isOn(K.done(d.todo_id))) continue;
        await repo.toggleTodo(d.todo_id, true);
      }

      for (const k of result.knowledge) {
        if (!isOn(K.knowledge(k.topic, k.title))) continue;
        // 和旧卡高度重叠 = 这张新卡就是旧卡的替代版本，旧卡归档而不是留着两份
        const replaced = replacementOf(k.source_ids);
        await repo.insertKnowledgeCard({
          topic: k.topic,
          title: k.title,
          gist: k.gist,
          body: k.body,
          sourceIds: k.source_ids,
        });
        if (k.source_ids.length) await repo.setFragmentNature(k.source_ids, 'knowledge');
        if (replaced && !declinedArchive.has(replaced.id) && !archivedByReplacement.has(replaced.id)) {
          await repo.updateKnowledgeCard(replaced.id, { archived: true });
          archivedByReplacement.add(replaced.id);
        }
      }

      // AI 主动建议归档的旧卡
      for (const a of result.archive_cards) {
        if (!isOn(K.archive(a.card_id))) continue;
        await repo.updateKnowledgeCard(a.card_id, { archived: true });
      }

      // AI 主动建议删掉的待办（真删除，界面上默认不勾选）
      for (const d of result.drop_todos) {
        if (!isOn(K.drop(d.todo_id))) continue;
        await repo.deleteTodo(d.todo_id);
      }

      // 补充已有卡：原文只追加不覆盖，卡片已有的正文一个字都不动
      for (const c of result.card_update) {
        if (!isOn(K.card(c.card_id))) continue;
        const card = cardById.get(c.card_id);
        if (!card) continue;
        // 已经在卡里的不要再追加一次，否则同一段原文会重复出现
        const addedIds = c.add_source_ids.filter((id) => byId.has(id) && !card.sourceIds.includes(id));
        const addedText = addedIds
          .map((id) => byId.get(id)?.content.trim())
          .filter((s): s is string => !!s);
        if (!addedText.length) continue;
        await repo.updateKnowledgeCard(c.card_id, {
          sourceIds: Array.from(new Set([...card.sourceIds, ...addedIds])),
          body: `${card.body}\n\n${addedText.join('\n\n')}`,
          ...(c.title ? { title: c.title } : {}),
          ...(c.gist ? { gist: c.gist } : {}),
        });
      }

      if (result.summary && isOn(K.summary)) {
        await repo.insertNote({
          type: 'daily',
          title: null,
          bodyMd: result.summary.body_md,
          period: todayISO(),
        });
      }

      for (const m of result.merge) {
        if (!isOn(K.merge(m.keep_id, m.drop_ids))) continue;
        await repo.markMerged(m.drop_ids, m.keep_id);
      }

      if (tagItems.length) {
        await repo.markStatus(
          tagItems.map((t) => t.id),
          'tagged',
        );
      }

      if (runId) await repo.markRunApplied(runId);
      setPhase('done');
      onApplied();
    } catch (e) {
      setErrorMsg((e as Error)?.message || '写入失败');
      setPhase('error');
    }
  }

  const word = mode === 'refactor' ? '重构' : '整理';
  const headerTitle = round > 1 ? `${word} · 第 ${round} 版` : word;

  function switchMode(next: Mode) {
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
      <View style={styles.header}>
        <Pressable onPress={onClose} hitSlop={12} style={styles.back}>
          <Ionicons name="chevron-back" size={20} color={C.text} />
        </Pressable>
        <Text style={styles.title}>{headerTitle}</Text>
        <View style={{ width: 24 }} />
      </View>

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
                <Text style={[styles.segmentText, mode === 'organize' && styles.segmentTextOn]}>
                  整理未读
                </Text>
              </Pressable>
              <Pressable
                style={[styles.segmentItem, mode === 'refactor' && styles.segmentItemOn]}
                onPress={() => switchMode('refactor')}
              >
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
                    ? `「${refactorTopic}」下的碎片`
                    : '条已整理的碎片'
                  : '条未整理的碎片'}
              </Text>

              {mode === 'refactor' && (
                <View style={styles.scopeBlock}>
                  <Text style={styles.scopeLabel}>重构范围</Text>
                  <View style={styles.chipRow}>
                    <Chip
                      label="最近整理过"
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

              {overflow > 0 && (
                <Text style={styles.overflowText}>
                  还有 {overflow} 条这次没带上，处理完再来一轮即可。
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
                  会减少内容的两类操作（归档卡、删待办）默认不勾选，得你自己点。已做完的待办会自动标掉，
                  因为那不算删除，回顾页里还能看到、也能撤回。
                </Text>
                <Text style={styles.explainText}>
                  不会重复抽待办、也不会重复写今日小结 —— 那些上一轮已经有了。
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
          <ReasoningPanel
            title={`${word} ${batch.length} 条碎片…`}
            text={reasoning}
            received={received}
            elapsed={elapsed}
            thinking={thinkingOn}
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
            <Text style={styles.centerText}>已写入 {acceptedCount} 项</Text>
            <Pressable style={styles.primaryBtn} onPress={onClose}>
              <Text style={styles.primaryBtnText}>回到时间轴</Text>
            </Pressable>
          </View>
        )}

        {phase === 'result' && result && (
          <View>
            {refining ? (
              <ReasoningPanel
                title={`按第 ${round} 版的要求重写…`}
                text={reasoning}
                received={received}
                elapsed={elapsed}
                thinking={thinkingOn}
              />
            ) : (
              <>
                <Text style={styles.resultHint}>
                  逐条确认。关掉的项不会写入。
                  {round > 1 ? '追问后没改动的条目，你之前的勾选状态会保留。' : ''}
                </Text>
                <ReasoningTrace
                  text={reasoning}
                  expanded={showReasoning}
                  onToggle={() => setShowReasoning((v) => !v)}
                />
              </>
            )}

            {result.todos.length > 0 && (
              <Section title="提炼待办" count={result.todos.length}>
                {result.todos.map((t) => {
                  const key = K.todo(t.text);
                  const on = isOn(key);
                  return (
                    <CheckRow key={key} on={on} onPress={() => toggle(key)}>
                      <Text style={[styles.rowText, !on && styles.rowTextOff]}>{t.text}</Text>
                      {t.due ? <Text style={styles.dueText}>{t.due}</Text> : null}
                    </CheckRow>
                  );
                })}
              </Section>
            )}

            {result.todo_done.length > 0 && (
              <Section
                title="这些待办好像做完了"
                count={result.todo_done.length}
                hint="默认勾选 —— 碎片里写明已经做完的，自动标掉。标错了会在回顾页的已完成区，点一下就能撤回。"
              >
                {result.todo_done.map((d) => {
                  const key = K.done(d.todo_id);
                  const on = isOn(key);
                  return (
                    <CheckRow key={key} on={on} onPress={() => toggle(key)}>
                      <Text style={[styles.rowText, on && styles.strikeText, !on && styles.rowTextOff]}>
                        {todoById.get(d.todo_id)?.text ?? `#${d.todo_id}`}
                      </Text>
                      {d.reason ? <Text style={styles.reasonText}>{d.reason}</Text> : null}
                    </CheckRow>
                  );
                })}
              </Section>
            )}

            {result.knowledge.length > 0 && (
              <Section title="沉淀知识" count={result.knowledge.length}>
                {result.knowledge.map((k) => {
                  const key = K.knowledge(k.topic, k.title);
                  const on = isOn(key);
                  // 重构时提前算一下这张新卡会不会顶掉某张旧卡，让用户看得见
                  const replaced = mode === 'refactor' ? replacementOf(k.source_ids) : null;
                  // 旧卡那边被用户取消了归档，这里就得如实说保留
                  const keptOld =
                    !!replaced &&
                    result.archive_cards.some(
                      (a) => a.card_id === replaced.id && !isOn(K.archive(a.card_id)),
                    );
                  return (
                    <CheckRow key={key} on={on} onPress={() => toggle(key)}>
                      <View style={styles.kHead}>
                        <Text style={[styles.rowText, styles.kTitle, !on && styles.rowTextOff]}>
                          {k.title}
                        </Text>
                        <View style={styles.topicPill}>
                          <Text style={styles.topicPillText}>{k.topic}</Text>
                        </View>
                      </View>
                      {k.gist ? (
                        <Text style={[styles.gistText, !on && styles.rowTextOff]}>{k.gist}</Text>
                      ) : null}
                      {replaced ? (
                        <Text style={styles.reasonText}>
                          {keptOld
                            ? `旧卡「${replaced.title}」保留，不归档`
                            : `会归档被它取代的旧卡：${replaced.title}`}
                        </Text>
                      ) : null}
                    </CheckRow>
                  );
                })}
              </Section>
            )}

            {result.card_update.length > 0 && (
              <Section title="补充到已有知识卡" count={result.card_update.length}>
                {result.card_update.map((c) => {
                  const key = K.card(c.card_id);
                  const on = isOn(key);
                  const card = cardById.get(c.card_id);
                  const added = c.add_source_ids
                    .map((id) => byId.get(id))
                    .filter((f): f is Fragment => !!f);
                  return (
                    <CheckRow key={key} on={on} onPress={() => toggle(key)}>
                      <Text style={[styles.rowText, styles.kTitle, !on && styles.rowTextOff]}>
                        {c.title ?? card?.title ?? `#${c.card_id}`}
                      </Text>
                      <View style={styles.pillRow}>
                        <View style={styles.topicPill}>
                          <Text style={styles.topicPillText}>{card?.topic ?? '未知主题'}</Text>
                        </View>
                        <Text style={styles.metaText}>补 {added.length} 条原文</Text>
                      </View>
                      {c.title && card && c.title !== card.title ? (
                        <Text style={styles.reasonText}>原标题：{card.title}</Text>
                      ) : null}
                      {added.map((f) => (
                        <Text key={f.id} style={styles.dropText} numberOfLines={2}>
                          ＋ {f.content}
                        </Text>
                      ))}
                      {c.reason ? <Text style={styles.reasonText}>{c.reason}</Text> : null}
                    </CheckRow>
                  );
                })}
              </Section>
            )}

            {result.archive_cards.length > 0 && (
              <Section
                title="建议归档的知识卡"
                count={result.archive_cards.length}
                hint="归档后卡片会从知识库折叠进「已归档」，随时能恢复，原文不会丢。默认不勾选。"
              >
                {result.archive_cards.map((a) => {
                  const key = K.archive(a.card_id);
                  const on = isOn(key);
                  const card = cardById.get(a.card_id);
                  return (
                    <CheckRow key={key} on={on} onPress={() => toggle(key)}>
                      <View style={styles.kHead}>
                        <Text style={[styles.rowText, styles.kTitle, !on && styles.rowTextOff]}>
                          {card?.title ?? `#${a.card_id}`}
                        </Text>
                        <View style={styles.topicPill}>
                          <Text style={styles.topicPillText}>{card?.topic ?? '未知主题'}</Text>
                        </View>
                      </View>
                      {card?.gist ? <Text style={styles.gistText}>{card.gist}</Text> : null}
                      {a.reason ? <Text style={styles.reasonText}>{a.reason}</Text> : null}
                    </CheckRow>
                  );
                })}
              </Section>
            )}

            {result.drop_todos.length > 0 && (
              <Section
                title="建议删掉的待办"
                count={result.drop_todos.length}
                hint="真删除，不能撤销。待办删了不影响原碎片，原文还在时间轴上。默认不勾选。"
              >
                {result.drop_todos.map((d) => {
                  const key = K.drop(d.todo_id);
                  const on = isOn(key);
                  return (
                    <CheckRow key={key} on={on} onPress={() => toggle(key)}>
                      <Text style={[styles.rowText, !on && styles.rowTextOff]}>
                        {todoById.get(d.todo_id)?.text ?? `#${d.todo_id}`}
                      </Text>
                      {d.reason ? <Text style={styles.reasonText}>{d.reason}</Text> : null}
                    </CheckRow>
                  );
                })}
              </Section>
            )}

            {result.summary && (
              <Section title="今日小结" count={1}>
                <CheckRow on={isOn(K.summary)} onPress={() => toggle(K.summary)}>
                  <Text style={[styles.summaryText, !isOn(K.summary) && styles.rowTextOff]}>
                    {result.summary.body_md}
                  </Text>
                </CheckRow>
              </Section>
            )}

            {result.tags.length > 0 && (
              <Section
                title="分类打标"
                count={result.tags.length}
                hint={
                  mode === 'refactor'
                    ? '重构会覆盖旧标签。下面标出「原标签」的条目是这次真正改了的，其余没变。'
                    : undefined
                }
              >
                {result.tags.map((t) => {
                  const key = K.tag(t.id);
                  const on = isOn(key);
                  const f = byId.get(t.id);
                  const labelsChanged = !!f && !sameLabels(f.tags, t.labels);
                  const projectChanged = !!f && (f.project ?? null) !== (t.project ?? null);
                  return (
                    <CheckRow key={key} on={on} onPress={() => toggle(key)}>
                      <Text style={[styles.rowText, !on && styles.rowTextOff]} numberOfLines={2}>
                        {f?.content ?? `#${t.id}`}
                      </Text>
                      <View style={styles.pillRow}>
                        {t.labels.map((l) => {
                          const col = tagColor(l);
                          return (
                            <View key={l} style={[styles.labelPill, { backgroundColor: col.bg }]}>
                              <Text style={[styles.labelPillText, { color: col.fg }]}>{l}</Text>
                            </View>
                          );
                        })}
                        {t.project ? <Text style={styles.projectText}>{t.project}</Text> : null}
                      </View>
                      {mode === 'refactor' && labelsChanged ? (
                        <Text style={styles.reasonText}>
                          原标签：{f.tags.length ? f.tags.join('、') : '无'}
                        </Text>
                      ) : null}
                      {mode === 'refactor' && projectChanged ? (
                        <Text style={styles.reasonText}>
                          原项目：{f.project ?? '无'}
                        </Text>
                      ) : null}
                    </CheckRow>
                  );
                })}
              </Section>
            )}

            {result.merge.length > 0 && (
              <Section title="疑似重复" count={result.merge.length}>
                {result.merge.map((m) => {
                  const key = K.merge(m.keep_id, m.drop_ids);
                  const on = isOn(key);
                  const keep = byId.get(m.keep_id);
                  const drops = m.drop_ids.map((id) => byId.get(id)).filter(Boolean) as Fragment[];
                  return (
                    <CheckRow key={key} on={on} onPress={() => toggle(key)}>
                      <Text style={[styles.rowText, !on && styles.rowTextOff]} numberOfLines={2}>
                        保留：{keep?.content ?? `#${m.keep_id}`}
                      </Text>
                      {drops.map((d) => (
                        <Text key={d.id} style={styles.dropText} numberOfLines={1}>
                          并入：{d.content}
                        </Text>
                      ))}
                      {m.reason ? <Text style={styles.reasonText}>{m.reason}</Text> : null}
                    </CheckRow>
                  );
                })}
              </Section>
            )}

            {!result.todos.length &&
              !result.knowledge.length &&
              !result.todo_done.length &&
              !result.card_update.length &&
              !result.archive_cards.length &&
              !result.drop_todos.length &&
              !result.summary &&
              !result.tags.length &&
              !result.merge.length && (
                <Text style={styles.resultHint}>AI 认为这批碎片不需要处理。</Text>
              )}
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
    </View>
  );
}

/** 字数：过千就折成 1.2k，长思考过程动辄几千字，原样数字太占地方 */
function fmtCount(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * 运行中的思考面板。思维链边生成边往下滚，底部给两个字数和秒数 ——
 * 主要是让人确认「它在动」，而不是卡死了。
 */
function ReasoningPanel({
  title,
  text,
  received,
  elapsed,
  thinking,
}: {
  title: string;
  text: string;
  received: number;
  elapsed: number;
  thinking: boolean;
}) {
  const scrollRef = useRef<ScrollViewInstance>(null);
  return (
    <View style={styles.liveCard}>
      <View style={styles.liveHead}>
        <ActivityIndicator size="small" color={C.accent} />
        <Text style={styles.liveTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.liveClock}>{elapsed}s</Text>
      </View>

      {text ? (
        <ScrollView
          ref={scrollRef}
          style={styles.liveScroll}
          contentContainerStyle={styles.liveScrollBody}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          // 只有最长的流式面板需要跟随，内容一长就贴底
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          <Text style={styles.liveText}>{text}</Text>
        </ScrollView>
      ) : (
        <Text style={styles.liveEmpty}>
          {thinking ? '模型正在通读这批碎片，还没开始落笔…' : '当前没开思考模式，只能等结果出来'}
        </Text>
      )}

      <View style={styles.liveFoot}>
        <Text style={styles.liveMeta}>{text ? `思考 ${fmtCount(text.length)} 字` : '等待首字'}</Text>
        <Text style={styles.liveMeta}>{received ? `结果 ${fmtCount(received)} 字` : '结果未开始'}</Text>
      </View>
    </View>
  );
}

/**
 * 结果页里的思考过程折叠区。
 * 默认收起 —— 确认流程才是主任务，思考过程是「想追问时再翻」的参考。
 */
function ReasoningTrace({
  text,
  expanded,
  onToggle,
}: {
  text: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!text) return null;
  return (
    <View style={styles.traceCard}>
      <Pressable style={styles.traceHead} onPress={onToggle} hitSlop={4}>
        <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={13} color={C.text3} />
        <Text style={styles.traceTitle}>模型思考过程</Text>
        <Text style={styles.traceMeta}>{fmtCount(text.length)} 字</Text>
      </Pressable>
      {expanded && (
        <ScrollView style={styles.traceScroll} contentContainerStyle={styles.traceScrollBody} nestedScrollEnabled>
          <Text style={styles.traceText}>{text}</Text>
        </ScrollView>
      )}
    </View>
  );
}

function Section({
  title,
  count,
  hint,
  children,
}: {
  title: string;
  count: number;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionCount}>{count}</Text>
      </View>
      {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.chip, on && styles.chipOn]} onPress={onPress}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

function CheckRow({
  on,
  onPress,
  children,
}: {
  on: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable style={styles.checkRow} onPress={onPress}>
      <View style={[styles.checkCircle, on && styles.checkCircleOn]}>
        {on && <Ionicons name="checkmark" size={12} color="#FFFFFF" />}
      </View>
      <View style={styles.checkBody}>{children}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.page },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  back: { width: 24 },
  title: { fontSize: 16, color: C.text, fontWeight: '500' },

  content: { paddingHorizontal: 16, paddingBottom: 24 },

  segment: {
    flexDirection: 'row',
    backgroundColor: C.hairSoft,
    borderRadius: R.btn,
    padding: 3,
    marginBottom: 14,
  },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: R.btn - 2 },
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
  centerSub: { fontSize: 12, color: C.text3 },

  errTitle: { fontSize: 14, color: C.danger, fontWeight: '500', marginBottom: 8 },
  errText: { fontSize: 12, color: C.danger, lineHeight: 19, textAlign: 'center', marginTop: 12 },

  resultHint: { fontSize: 12, color: C.text3, marginBottom: 14, marginTop: 4, lineHeight: 18 },

  // 运行中的思考面板
  liveCard: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    padding: 14,
    marginTop: 4,
  },
  liveHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  liveTitle: { flex: 1, fontSize: 13, color: C.text, fontWeight: '500' },
  liveClock: { fontSize: 12, color: C.text3 },
  liveScroll: { maxHeight: 300, marginTop: 12 },
  liveScrollBody: { paddingBottom: 2 },
  liveText: { fontSize: 12, lineHeight: 20, color: C.text2 },
  liveEmpty: { fontSize: 12, color: C.text3, lineHeight: 20, marginTop: 12 },
  liveFoot: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
  },
  liveMeta: { fontSize: 11, color: C.text3 },

  // 结果页的思考过程折叠区
  traceCard: {
    backgroundColor: C.hairSoft,
    borderRadius: R.card,
    marginBottom: 16,
    overflow: 'hidden',
  },
  traceHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  traceTitle: { flex: 1, fontSize: 12, color: C.text2 },
  traceMeta: { fontSize: 11, color: C.text3 },
  traceScroll: { maxHeight: 260 },
  traceScrollBody: { paddingHorizontal: 12, paddingBottom: 12 },
  traceText: { fontSize: 12, lineHeight: 20, color: C.text2 },

  section: { marginBottom: 20 },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  sectionTitle: { fontSize: 13, color: C.text, fontWeight: '500' },
  sectionCount: { fontSize: 11, color: C.text3 },
  sectionHint: { fontSize: 11, color: C.text3, lineHeight: 16, marginBottom: 7, paddingHorizontal: 2 },
  sectionBody: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    overflow: 'hidden',
  },

  checkRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.hair,
  },
  checkCircle: {
    width: 17,
    height: 17,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: C.hair,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkCircleOn: { backgroundColor: C.accent, borderColor: C.accent },
  checkBody: { flex: 1, gap: 4 },
  rowText: { fontSize: 14, lineHeight: 21, color: C.text },
  rowTextOff: { color: C.text3 },
  strikeText: { textDecorationLine: 'line-through', color: C.text2 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5, marginTop: 2 },
  labelPill: { borderRadius: R.pill, paddingHorizontal: 8, paddingVertical: 2 },
  labelPillText: { fontSize: 11, lineHeight: 15 },
  projectText: { fontSize: 11, color: C.text3 },
  metaText: { fontSize: 11, color: C.text3 },
  dueText: { fontSize: 11, color: C.text3, marginTop: 1 },
  kHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  kTitle: { flex: 1 },
  topicPill: {
    backgroundColor: C.tealBg,
    borderRadius: R.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginTop: 2,
  },
  topicPillText: { fontSize: 11, lineHeight: 15, color: C.tealText },
  gistText: { fontSize: 12, lineHeight: 19, color: C.text2 },
  summaryText: { fontSize: 14, lineHeight: 22, color: C.text },
  dropText: { fontSize: 12, color: C.text3, lineHeight: 18 },
  reasonText: { fontSize: 11, color: C.text3, marginTop: 2, lineHeight: 16 },

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
