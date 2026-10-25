/**
 * 知识库问答面板。
 *
 * 范围可以选「全库」或任意一个主题。从某个主题页进来时默认就是那个主题，
 * 但**不锁死** —— 从知识库首页进来时同样能选，胶囊排成一行横向滚动。
 * （v0.6.2 之前只有「当前主题 / 全库」两档，首页进来时 `topic` 是 null，
 * 界面上就只剩一个「全库」，用户以为不能选主题。）
 *
 * ## v0.6.5：从「一问一答」改成真正的会话
 *
 * 以前这一页只有一份 `result`：问完一句，答案顶掉上一句，追问时也没有上下文
 * （`history` 默认只带用户手动勾选的问答记录，等于空）—— 每次提问都像新开一轮。
 * 现在一次打开面板期间的所有问答都在 `turns` 里，按时间排成一条消息流：
 *
 * - 布局照常规 chat：消息在上、输入栏固定底部（原来是输入栏顶在页头下面，
 *   答案挤在下面，看着不像聊天）；
 * - 深度思考收在**回答上方**（原来在答案下面，要看到思考先得读完全文）；
 * - 第 N 轮把前 N-1 轮的 Q/A 作为**真正的多轮 messages** 交给模型，
 *   卡片清单只出现一次，不再压成一段「更早的问答」文本；
 * - 退出面板才等于这一轮结束：`turns` 随组件卸载清掉。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { AskAction, AskLog, KnowledgeCard, WebHit } from '../types';
import { AiError, type ChatProgress } from '../ai/chat';
import { askKnowledge, type AskTurn } from '../ai/ask';
import { searchWeb } from '../ai/search';
import { loadAiConfig } from '../ai/config';
import { repo } from '../db/repo';
import { C, R } from '../theme';
import { useKeyboardHeight } from '../util/keyboard';
import { NoteBody } from './NoteBody';
import { ReasoningStream } from './ReasoningStream';
import { ReasoningCollapse } from './ReasoningCollapse';
import { AskActions } from './AskActions';
import { AskHistory } from './AskHistory';
import { IconButton } from './IconButton';
import { ScreenHeader } from './ScreenHeader';

/** 一屏里的一轮。answer 为空表示还在生成 */
interface Turn {
  id: number;
  question: string;
  answer: string;
  reasoning: string;
  cited: KnowledgeCard[];
  web: WebHit[];
  actions: AskAction[];
  /** 模型写了 action 块但校验没过的条数 */
  rejected: number;
  scanned: number;
  total: number;
  thinkSec: number;
  webTried: boolean;
  error: string;
}

function blankTurn(id: number, question: string, webTried: boolean): Turn {
  return {
    id,
    question,
    answer: '',
    reasoning: '',
    cited: [],
    web: [],
    actions: [],
    rejected: 0,
    scanned: 0,
    total: 0,
    thinkSec: 0,
    webTried,
    error: '',
  };
}

interface Props {
  /** 进入时的默认范围；null 表示从首页进来的，默认全库 */
  topic: string | null;
  onClose: () => void;
  /** 点引用卡片时交给上层打开详情 */
  onOpenCard: (card: KnowledgeCard) => void;
  /** 执行了改动建议后刷新知识库（卡片、主题都变了） */
  onChanged?: () => void;
}

export function AskSheet({ topic, onClose, onOpenCard, onChanged }: Props) {
  const [view, setView] = useState<'chat' | 'history'>('chat');
  /**
   * 检索范围：主题名，或 `'all'`。
   *
   * 原来是 `'topic' | 'all'` 两档，靠 props.topic 决定「主题」具体指哪个 ——
   * 结果是**从知识库首页进来时 `topic` 是 null，界面上只剩「全库」一个胶囊**，
   * 用户没有任何途径切到某个主题（真机反馈「为什么没办法选择主题」）。
   * 现在范围直接存主题名，主题列表从库里实时取，从哪进来都能选。
   */
  const [scope, setScope] = useState<string>(topic ?? 'all');
  const scopedTopic = scope === 'all' ? null : scope;

  const [topicCards, setTopicCards] = useState<KnowledgeCard[]>([]);
  const [allCards, setAllCards] = useState<KnowledgeCard[]>([]);
  /** 主题 + 卡片数，用来渲染范围胶囊上的计数 */
  const [topicStats, setTopicStats] = useState<{ topic: string; count: number }[]>([]);
  const topics = useMemo(() => topicStats.map((t) => t.topic), [topicStats]);

  const [question, setQuestion] = useState('');
  /** 整个会话的消息流。退出面板（组件卸载）才算这一轮结束 */
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  /** 正在生成的那一条的实时状态：思维链、已收字数、秒数 */
  const [live, setLive] = useState<{
    id: number;
    reasoning: string;
    received: number;
    elapsed: number;
    thinking: boolean;
  } | null>(null);
  /** 联网搜索阶段要单独显示一行，否则那几秒用户不知道在等什么 */
  const [searching, setSearching] = useState(false);

  const [logs, setLogs] = useState<AskLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  /** 手动勾选要带进这一轮的历史记录（跨会话的记忆） */
  const [pinned, setPinned] = useState<Set<number>>(new Set());

  const startedAtRef = useRef(0);
  const streamRef = useRef({ lastFlush: 0 });
  const seqRef = useRef(0);
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView> | null>(null);
  /** 用户往上翻的时候不要把他拽回底部 */
  const stickRef = useRef(true);
  const keyboardHeight = useKeyboardHeight();

  const reloadIndex = useCallback(async () => {
    const [tc, ac, ts] = await Promise.all([
      scope === 'all' ? Promise.resolve<KnowledgeCard[]>([]) : repo.listKnowledgeCards(scope),
      repo.listKnowledgeCards(),
      repo.listKnowledgeTopics(),
    ]);
    setTopicCards(tc);
    setAllCards(ac);
    setTopicStats(ts.map((t) => ({ topic: t.topic, count: t.count })));
  }, [scope]);

  const reloadLogs = useCallback(async () => {
    try {
      setLogs(await repo.listAskLogs(null, 80));
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    reloadIndex();
    reloadLogs();
  }, [reloadIndex, reloadLogs]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // 正在生成，别让返回把请求丢了
      if (busy) return true;
      if (view === 'history') {
        setView('chat');
        return true;
      }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [busy, view, onClose]);

  // 计时器只更新 live，不动消息流 —— 否则每 0.5 秒重排整屏
  useEffect(() => {
    if (!busy || !live) return;
    const timer = setInterval(() => {
      setLive((prev) =>
        prev ? { ...prev, elapsed: Math.round((Date.now() - startedAtRef.current) / 1000) } : prev,
      );
    }, 500);
    return () => clearInterval(timer);
  }, [busy, live?.id]);

  const pinnedTurns = useMemo<AskTurn[]>(
    () => logs.filter((l) => pinned.has(l.id)).map((l) => ({ question: l.question, answer: l.answer })),
    [logs, pinned],
  );

  function handleProgress(patch: ChatProgress) {
    const now = Date.now();
    if (now - streamRef.current.lastFlush < 120) return;
    streamRef.current.lastFlush = now;
    setLive((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        reasoning: patch.reasoning ?? prev.reasoning,
        received: patch.content !== undefined ? patch.content.length : prev.received,
      };
    });
  }

  function titleOf(id: number) {
    return allCards.find((c) => c.id === id)?.title ?? null;
  }

  function scopeLabel(s: string) {
    return s === 'all' ? '全库' : s;
  }

  function patchTurn(id: number, patch: Partial<Turn>) {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  /**
   * 跑一轮。
   *
   * @param q 问题（已定稿）
   * @param withWeb 是否先联网再答
   * @param replaceId 传了就替换那一轮（联网重查），不传就是新的一条
   */
  async function runAsk(q: string, withWeb: boolean, replaceId?: number) {
    if (!q || busy) return;

    const id = replaceId ?? ++seqRef.current;
    /** 这一轮之前的所有轮次 —— 追问的上下文就是它们 */
    const before = replaceId
      ? turns.slice(0, Math.max(0, turns.findIndex((t) => t.id === replaceId)))
      : turns;
    const history: AskTurn[] = [
      ...pinnedTurns,
      ...before.filter((t) => t.answer).map((t) => ({ question: t.question, answer: t.answer })),
    ];

    setSearching(false);
    streamRef.current.lastFlush = 0;
    startedAtRef.current = Date.now();
    setBusy(true);
    setTurns((prev) => {
      const fresh = blankTurn(id, q, withWeb);
      if (!replaceId) return [...prev, fresh];
      return prev.map((t) => (t.id === replaceId ? fresh : t));
    });
    setLive({ id, reasoning: '', received: 0, elapsed: 0, thinking: false });
    if (!replaceId) setQuestion('');
    stickRef.current = true;

    const startedAt = startedAtRef.current;
    let searchMs = 0;

    try {
      const config = await loadAiConfig();
      if (!config.apiKey) {
        patchTurn(id, { error: '还没配置 API Key，先去设置页填一个' });
        return;
      }

      // 每轮现取卡片：上一轮可能刚执行了合并/改名，用旧快照会读到已经不存在的主题
      const [scoped, all, stats] = await Promise.all([
        scope === 'all' ? Promise.resolve<KnowledgeCard[]>([]) : repo.listKnowledgeCards(scope),
        repo.listKnowledgeCards(),
        repo.listKnowledgeTopics(),
      ]);
      setTopicCards(scoped);
      setAllCards(all);
      setTopicStats(stats.map((t) => ({ topic: t.topic, count: t.count })));

      const cards = scope === 'all' ? all : scoped;
      if (!cards.length) {
        patchTurn(id, {
          error: scopedTopic ? `「${scopedTopic}」下还没有卡片` : '知识库还是空的',
        });
        return;
      }

      setLive((prev) => (prev ? { ...prev, thinking: config.thinking } : prev));

      let hits: WebHit[] = [];
      if (withWeb) {
        setSearching(true);
        const t0 = Date.now();
        hits = await searchWeb(config, q);
        searchMs = Date.now() - t0;
        setSearching(false);
      }

      const outcome = await askKnowledge({
        question: q,
        cards,
        topics: stats.map((t) => t.topic),
        // 提案里的卡片 id 可能落在当前主题之外（比如让他顺手归档一张旧卡），
        // 校验时用全库的 id 集合，不然一整批都会被判成非法
        contextCardIds: all.map((c) => c.id),
        config,
        web: hits,
        turns: history,
        onProgress: handleProgress,
      });

      patchTurn(id, {
        answer: outcome.answer,
        reasoning: outcome.reasoning,
        cited: outcome.cited,
        web: outcome.web,
        actions: outcome.actions,
        rejected: outcome.rejected,
        scanned: outcome.scanned,
        total: outcome.total,
        // 扣掉联网那一段：标签写的是「深度思考」，把搜索耗时算进去就成假数字了
        thinkSec: Math.max(1, Math.round((Date.now() - startedAt - searchMs) / 1000)),
      });

      // 落库单独兜一层：写记录失败不该把已经拿到的答案也弄丢
      try {
        await repo.insertAskLog({
          scope: scopedTopic ?? 'all',
          question: q,
          answer: outcome.answer,
          reasoning: outcome.reasoning,
          citedIds: outcome.cited.map((c) => c.id),
          web: outcome.web,
        });
        await reloadLogs();
      } catch (e) {
        console.warn('[fragments] 问答记录没存上', e);
      }
    } catch (e) {
      patchTurn(id, {
        error: e instanceof AiError ? e.message : e instanceof Error ? e.message : '提问失败，再试一次',
      });
    } finally {
      setSearching(false);
      setBusy(false);
      setLive(null);
    }
  }

  function submit() {
    const q = question.trim();
    if (!q) return;
    runAsk(q, false);
  }

  /**
   * 联网重查只对**最后一条**开放。
   * 重查中间那一轮会把后面几轮的上下文全部作废（它们的回答是基于旧的搜索结果），
   * 所以界面上也只在最后一轮显示这个按钮。
   */
  function retryWithWeb(turn: Turn) {
    const last = turns[turns.length - 1];
    if (!last || last.id !== turn.id || busy) return;
    runAsk(turn.question, true, turn.id);
  }

  async function appliedActions() {
    await reloadLogs();
    await reloadIndex();
    // 当前范围的主题可能刚被合并/改名，留在那儿只会一直提示「没有卡片」
    if (scopedTopic && !(await repo.listKnowledgeCards(scopedTopic)).length) setScope('all');
    onChanged?.();
  }

  /**
   * 切范围。整个会话必须一起清掉 —— 消息流里前几轮读的是另一个范围的卡片，
   * 留着会让模型在下一轮把两个范围混着答。
   *
   * 询问中不给切：请求还在跑，切完它回来会把旧范围的答案写到新范围上。
   */
  function pickScope(next: string) {
    if (next === scope || busy) return;
    setScope(next);
    setTurns([]);
    setSearching(false);
    stickRef.current = true;
  }

  async function editLog(id: number, text: string) {
    await repo.updateAskLogQuestion(id, text);
    await reloadLogs();
  }

  async function deleteLog(id: number) {
    await repo.deleteAskLog(id);
    setPinned((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    await reloadLogs();
  }

  function togglePin(log: AskLog) {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(log.id)) next.delete(log.id);
      else next.add(log.id);
      return next;
    });
  }

  function pinRecent() {
    setPinned(new Set(logs.slice(0, 3).map((l) => l.id)));
  }

  const rangeLocked = busy;
  const canAsk = question.trim().length > 0 && !busy;

  /**
   * 范围胶囊的顺序：全库永远排第一，**进来时那个主题排第二** ——
   * 主题一多就要横着找，把它顶到前面才不用滚。
   */
  const scopeOptions = useMemo(() => {
    if (!topic) return topicStats;
    return [
      ...topicStats.filter((t) => t.topic === topic),
      ...topicStats.filter((t) => t.topic !== topic),
    ];
  }, [topicStats, topic]);

  if (view === 'history') {
    return (
      <View style={[s.root, { paddingBottom: keyboardHeight }]}>
        <ScreenHeader
          title="问答记录"
          subtitle={`${logs.length} 条 · 不参与卡片检索`}
          onBack={() => setView('chat')}
        />
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          <AskHistory
            logs={logs}
            loading={logsLoading}
            pinned={pinned}
            onTogglePin={togglePin}
            onPinRecent={pinRecent}
            onEdit={editLog}
            onDelete={deleteLog}
            scopeLabel={scopeLabel}
          />
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <ScreenHeader
        title="问知识库"
        subtitle={
          turns.length
            ? `本轮 ${turns.length} 个问题 · 退出后结束`
            : '一次打开期间算同一轮，可以直接追问'
        }
        backIcon="close"
        onBack={onClose}
        right={
          <IconButton
            name="time-outline"
            size={19}
            tone="soft"
            color={C.text2}
            badge={logs.length}
            onPress={() => setView('history')}
            accessibilityLabel="问答记录"
          />
        }
      />

      <View style={s.scopeRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.scopeScroll}
          style={s.scopeFlex}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable
            onPress={() => pickScope('all')}
            disabled={rangeLocked}
            style={[s.chip, scope === 'all' && s.chipOn, rangeLocked && s.chipOff]}
          >
            <Text style={[s.chipText, scope === 'all' && s.chipTextOn]}>
              全库{allCards.length ? ` ${allCards.length}` : ''}
            </Text>
          </Pressable>
          {scopeOptions.map((t) => {
            const on = scope === t.topic;
            return (
              <Pressable
                key={t.topic}
                onPress={() => pickScope(t.topic)}
                disabled={rangeLocked}
                style={[s.chip, on && s.chipOn, rangeLocked && s.chipOff]}
              >
                <Text style={[s.chipText, on && s.chipTextOn]} numberOfLines={1}>
                  {t.topic}
                  {t.count ? ` ${t.count}` : ''}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {pinnedTurns.length ? (
          <View style={s.ctxChip}>
            <Ionicons name="attach" size={11} color={C.accentText} />
            <Text style={s.ctxChipText}>带 {pinnedTurns.length} 条</Text>
            <Pressable onPress={() => setPinned(new Set())} hitSlop={8}>
              <Ionicons name="close" size={11} color={C.accentText} />
            </Pressable>
          </View>
        ) : null}
      </View>

      <ScrollView
        ref={scrollRef}
        style={s.stream}
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const bottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
          stickRef.current = bottom < 80;
        }}
        scrollEventThrottle={64}
        onContentSizeChange={() => {
          if (stickRef.current) scrollRef.current?.scrollToEnd({ animated: false });
        }}
      >
        {turns.length === 0 && !busy ? (
          <View style={s.tips}>
            <Text style={s.tipsTitle}>可以这样问</Text>
            <Text style={s.tipsLine}>· 上次那个问题最后是怎么解决的？</Text>
            <Text style={s.tipsLine}>· 我记过哪些跟 C 盘清理有关的结论？</Text>
            <Text style={s.tipsLine}>· 把「工具」和「资讯」这两个主题合并掉</Text>
            <Text style={s.muted}>
              回答只依据知识库里的卡片，卡片里没有就会直说没有 —— 那种时候可以点「联网再查一次」。
              {'\n\n'}
              让他合并主题、改卡片的请求，会先变成几条建议，你勾选后才真正改动。
              {'\n\n'}
              这一页关掉之前，问过的都算同一轮 —— 可以直接说「那张卡」「再改一下」。
            </Text>
          </View>
        ) : null}

        {turns.map((t) => {
          const running = live?.id === t.id;
          return (
            <View key={t.id} style={s.turn}>
              <View style={s.askRow}>
                <View style={s.askBubble}>
                  <Text style={s.askText}>{t.question}</Text>
                </View>
              </View>

              {/* 思考在答案上方 —— 和网页 chat 一致：先「想过」，再「说」 */}
              {t.reasoning && t.answer ? (
                <ReasoningCollapse text={t.reasoning} seconds={t.thinkSec} />
              ) : null}

              {running && searching ? (
                <View style={s.stageCard}>
                  <ActivityIndicator size="small" color={C.accent} />
                  <Text style={s.stageText} numberOfLines={2}>
                    正在联网搜索「{t.question}」…
                  </Text>
                </View>
              ) : null}

              {running && !searching && !t.answer ? (
                <ReasoningStream
                  title="正在翻知识库…"
                  text={live.reasoning}
                  received={live.received}
                  elapsed={live.elapsed}
                  thinking={live.thinking}
                  height={220}
                />
              ) : null}

              {t.error ? <Text style={s.turnError}>{t.error}</Text> : null}

              {t.answer ? (
                <View style={s.answerCard}>
                  <NoteBody text={t.answer} style={s.answer} />
                </View>
              ) : null}

              {t.rejected > 0 ? (
                <Text style={s.rejectNote}>
                  有 {t.rejected} 条改动建议因为主题名或卡片 id 跟知识库对不上被丢掉了 ——
                  让它照清单里的原名再给一次就行。
                </Text>
              ) : null}

              {t.cited.length > 0 ? (
                <>
                  <Text style={s.sectionLabel}>回答里提到的卡片</Text>
                  <View style={s.citedWrap}>
                    {t.cited.map((card) => (
                      <Pressable key={card.id} style={s.cited} onPress={() => onOpenCard(card)}>
                        <Text style={s.citedTopic}>
                          {card.topic}
                          {card.subtopic ? ` · ${card.subtopic}` : ''}
                        </Text>
                        <Text style={s.citedTitle} numberOfLines={1}>
                          {card.title}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </>
              ) : null}

              {t.web.length ? (
                <>
                  <Text style={s.sectionLabel}>这次搜到的网络资料</Text>
                  <View style={s.citedWrap}>
                    {t.web.map((hit, i) => (
                      <Pressable
                        key={hit.url}
                        style={s.webItem}
                        onPress={() => {
                          // 打不开就静默 —— 链接只是补充信息，不该弹错误打断阅读
                          Linking.openURL(hit.url).catch(() => {});
                        }}
                      >
                        <Text style={s.webTitle} numberOfLines={2}>
                          [W{i + 1}] {hit.title}
                        </Text>
                        <Text style={s.webUrl} numberOfLines={1}>
                          {hit.url}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </>
              ) : null}

              <AskActions actions={t.actions} titleOf={titleOf} onApplied={appliedActions} />

              {t.answer ? (
                <View style={s.turnFoot}>
                  <Text style={s.footMeta}>
                    读了 {t.scanned} / {t.total} 张卡
                    {t.web.length ? ` · 网络 ${t.web.length} 条` : ''}
                  </Text>
                  {!t.web.length && !busy && t.id === turns[turns.length - 1]?.id ? (
                    <Pressable onPress={() => retryWithWeb(t)} hitSlop={8} style={s.webBtn}>
                      <Ionicons name="globe-outline" size={13} color={C.accentText} />
                      <Text style={s.webBtnText}>{t.webTried ? '再搜一次' : '联网再查一次'}</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}

              {t.webTried && t.answer && !t.web.length ? (
                <Text style={s.webEmpty}>
                  联网搜过了，没找到能用的资料，上面的回答仍然只依据卡片。
                </Text>
              ) : null}
            </View>
          );
        })}
      </ScrollView>

      {/* 输入栏固定在底部：消息流在上面滚，这里不跟着走 */}
      <View style={[s.composer, { paddingBottom: keyboardHeight + 8 }]}>
        <View style={s.inputRow}>
          <TextInput
            style={s.input}
            value={question}
            onChangeText={setQuestion}
            placeholder={turns.length ? '接着问，或者让它改点什么…' : '比如：群晖换盘之后要做什么？'}
            placeholderTextColor={C.text3}
            multiline
            editable={!busy}
          />
          <Pressable
            style={[s.sendBtn, !canAsk && s.sendOff]}
            onPress={submit}
            disabled={!canAsk}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Ionicons name="arrow-up" size={18} color="#FFFFFF" />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: C.page },

  scopeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  /** 范围胶囊横向滚动：「带 N 条」那个跟标记留在右边不滚 */
  scopeFlex: { flex: 1 },
  scopeScroll: { gap: 8, paddingRight: 4, alignItems: 'center' },
  chip: {
    maxWidth: 200,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: R.pill,
    borderWidth: 0.5,
    borderColor: C.hair,
    backgroundColor: C.card,
  },
  chipOn: { backgroundColor: C.accentBg, borderColor: C.accentBg },
  /** 询问中：范围胶囊整体压暗，表示这轮不能切 */
  chipOff: { opacity: 0.45 },
  chipText: { fontSize: 12, color: C.text2 },
  chipTextOn: { color: C.accentText, fontWeight: '500' },
  ctxChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: R.pill,
    backgroundColor: C.accentBg,
  },
  ctxChipText: { fontSize: 11, color: C.accentText },

  /** 消息流占据剩下的全部高度，输入栏才推得到底部 */
  stream: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 18 },

  turn: { marginBottom: 24 },

  askRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 10 },
  askBubble: {
    maxWidth: '86%',
    backgroundColor: C.accentBg,
    borderRadius: R.card,
    borderTopRightRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  askText: { fontSize: 14.5, lineHeight: 22, color: C.text },

  answerCard: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    padding: 15,
  },
  answer: { fontSize: 15, lineHeight: 25 },

  turnError: { fontSize: 12.5, color: C.danger, lineHeight: 19, marginTop: 4 },
  rejectNote: { fontSize: 11.5, color: C.amberText, lineHeight: 18, marginTop: 8 },

  stageCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.accentBg,
    paddingHorizontal: 14,
    paddingVertical: 16,
  },
  stageText: { flex: 1, fontSize: 13, lineHeight: 20, color: C.text2 },

  sectionLabel: { fontSize: 12, color: C.text3, marginTop: 16, marginBottom: 8 },
  citedWrap: { gap: 8 },
  cited: {
    backgroundColor: C.card,
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: C.hair,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  citedTopic: { fontSize: 10, color: C.accentText, marginBottom: 2 },
  citedTitle: { fontSize: 13, color: C.text },

  webItem: {
    backgroundColor: C.hairSoft,
    borderRadius: R.btn,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  webTitle: { fontSize: 12.5, lineHeight: 18, color: C.text },
  webUrl: { fontSize: 10.5, color: C.text3, marginTop: 3 },

  turnFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
    gap: 10,
  },
  footMeta: { flex: 1, fontSize: 11, color: C.text3 },
  webBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: C.accentBg,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: R.pill,
  },
  webBtnText: { fontSize: 11.5, color: C.accentText, fontWeight: '500' },
  webEmpty: { fontSize: 11, lineHeight: 17, color: C.text3, marginTop: 8 },

  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
    backgroundColor: C.page,
    paddingTop: 8,
    paddingHorizontal: 16,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 8,
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    fontSize: 14.5,
    lineHeight: 21,
    color: C.text,
    paddingTop: 3,
    paddingBottom: 3,
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendOff: { opacity: 0.35 },

  tips: { paddingTop: 6 },
  tipsTitle: { fontSize: 12, color: C.text3, marginBottom: 8 },
  tipsLine: { fontSize: 13, lineHeight: 24, color: C.text2 },
  muted: { fontSize: 11, color: C.text3, lineHeight: 18, marginTop: 16 },
});
