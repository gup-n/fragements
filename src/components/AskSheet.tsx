/**
 * 知识库问答面板。
 *
 * 范围默认是「当前主题」（选一个主题进来时几乎都是想知道这个主题的事），
 * 可以一键切成「全库」。
 *
 * v0.5.0 起这一页承担四件事：
 * 1. **回答** —— 只依据卡片，卡片没有就直说没有；
 * 2. **联网** —— 手动点「联网再查一次」才会去搜（自动触发会在他没注意时花掉额度，
 *    而且搜索结果是不可控的，混进「我的知识库」答案里的边界必须由用户自己划）；
 * 3. **改动建议** —— 模型可以提议合并主题 / 改名 / 归档 / 重构卡片，勾选后才执行；
 * 4. **问答记录** —— 独立扁平和区，默认不参与检索，可手动带进这一轮。
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
import type { AskLog, KnowledgeCard, WebHit } from '../types';
import { AiError, type ChatProgress } from '../ai/chat';
import { askKnowledge, type AskHistoryItem, type AskOutcome } from '../ai/ask';
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

type Phase = 'ask' | 'running' | 'answer';
/** 联网搜完再读卡片，两段要分开显示，否则用户不知道那几秒在等什么 */
type Stage = 'search' | 'read' | null;

interface Props {
  /** 进入时的默认范围；null 表示从首页进来的，只有全库可选 */
  topic: string | null;
  onClose: () => void;
  /** 点引用卡片时交给上层打开详情 */
  onOpenCard: (card: KnowledgeCard) => void;
  /** 执行了改动建议后刷新知识库（卡片、主题都变了） */
  onChanged?: () => void;
}

export function AskSheet({ topic, onClose, onOpenCard, onChanged }: Props) {
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [scope, setScope] = useState<'topic' | 'all'>(topic ? 'topic' : 'all');
  const [topicCards, setTopicCards] = useState<KnowledgeCard[]>([]);
  const [allCards, setAllCards] = useState<KnowledgeCard[]>([]);
  const [topics, setTopics] = useState<string[]>([]);

  const [question, setQuestion] = useState('');
  /** 本轮定稿的问题。联网重查要用它 —— 用户可能已经把输入框改了 */
  const [asked, setAsked] = useState('');
  const [phase, setPhase] = useState<Phase>('ask');
  const [result, setResult] = useState<AskOutcome | null>(null);
  const [error, setError] = useState('');
  const [stage, setStage] = useState<Stage>(null);
  /** 联网搜过但一条没搜到，也要说一声，别让人以为按钮没反应 */
  const [webTried, setWebTried] = useState(false);

  const [reasoning, setReasoning] = useState('');
  const [received, setReceived] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  /** 整轮用了几秒，用于「深度思考 N 秒」 */
  const [thinkSec, setThinkSec] = useState(0);
  const [thinkingOn, setThinkingOn] = useState(false);

  const [logs, setLogs] = useState<AskLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  /** 手动勾选要带进这一轮的记录 */
  const [pinned, setPinned] = useState<Set<number>>(new Set());

  const startedAtRef = useRef(0);
  const streamRef = useRef({ lastFlush: 0 });
  const keyboardHeight = useKeyboardHeight();

  const reloadIndex = useCallback(async () => {
    const [tc, ac, ts] = await Promise.all([
      topic ? repo.listKnowledgeCards(topic) : Promise.resolve<KnowledgeCard[]>([]),
      repo.listKnowledgeCards(),
      repo.listKnowledgeTopics(),
    ]);
    setTopicCards(tc);
    setAllCards(ac);
    setTopics(ts.map((t) => t.topic));
  }, [topic]);

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
      if (phase === 'running') return true;
      if (view === 'history') {
        setView('chat');
        return true;
      }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [phase, view, onClose]);

  useEffect(() => {
    if (phase !== 'running') return;
    const timer = setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [phase]);

  const scopeCards = scope === 'topic' && topic ? topicCards : allCards;
  const pinnedLogs = useMemo(() => logs.filter((l) => pinned.has(l.id)), [logs, pinned]);

  function handleProgress(patch: ChatProgress) {
    const now = Date.now();
    if (now - streamRef.current.lastFlush < 120) return;
    streamRef.current.lastFlush = now;
    if (patch.reasoning !== undefined) setReasoning(patch.reasoning);
    if (patch.content !== undefined) setReceived(patch.content.length);
  }

  function titleOf(id: number) {
    return allCards.find((c) => c.id === id)?.title ?? null;
  }

  function scopeLabel(s: string) {
    return s === 'all' ? '全库' : s;
  }

  /**
   * @param q 本轮问题（已定稿）
   * @param withWeb 是否先联网再答
   */
  async function runAsk(q: string, withWeb: boolean) {
    if (!q || phase === 'running') return;

    setError('');
    setResult(null);
    setReasoning('');
    setReceived(0);
    setElapsed(0);
    setThinkSec(0);
    setWebTried(false);
    setStage(null);
    streamRef.current.lastFlush = 0;
    startedAtRef.current = Date.now();
    setPhase('running');

    const history: AskHistoryItem[] = pinnedLogs.map((l) => ({
      question: l.question,
      answer: l.answer,
    }));

    try {
      const config = await loadAiConfig();
      if (!config.apiKey) {
        setPhase('ask');
        setError('还没配置 API Key，先去设置页填一个');
        return;
      }
      setThinkingOn(config.thinking);

      const cards = scope === 'topic' && topic ? topicCards : allCards;
      if (!cards.length) {
        setPhase('ask');
        setError(scope === 'topic' ? '这个主题下还没有卡片' : '知识库还是空的');
        return;
      }

      let hits: WebHit[] = [];
      let searchMs = 0;
      if (withWeb) {
        setStage('search');
        setWebTried(true);
        const t0 = Date.now();
        hits = await searchWeb(config, q);
        searchMs = Date.now() - t0;
      }

      setStage('read');
      const outcome = await askKnowledge({
        question: q,
        cards,
        topics,
        // 提案里的卡片 id 可能落在当前主题之外（比如让他顺手归档一张旧卡），
        // 校验时用全库的 id 集合，不然一整批都会被判成非法
        contextCardIds: allCards.map((c) => c.id),
        config,
        web: hits,
        history,
        onProgress: handleProgress,
      });

      setReasoning(outcome.reasoning);
      setResult(outcome);
      // 扣掉联网那一段：标签写的是「深度思考」，把搜索耗时算进去就成假数字了
      setThinkSec(Math.max(1, Math.round((Date.now() - startedAtRef.current - searchMs) / 1000)));
      setPhase('answer');

      // 落库单独兜一层：写记录失败不该把已经拿到的答案也弄丢
      try {
        await repo.insertAskLog({
          scope: scope === 'topic' && topic ? topic : 'all',
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
      setPhase('ask');
      setError(e instanceof AiError ? e.message : e instanceof Error ? e.message : '提问失败，再试一次');
    } finally {
      setStage(null);
    }
  }

  function submit() {
    const q = question.trim();
    if (!q) return;
    setAsked(q);
    runAsk(q, false);
  }

  function retryWithWeb() {
    if (!asked) return;
    runAsk(asked, true);
  }

  async function appliedActions() {
    await reloadLogs();
    await reloadIndex();
    // 当前主题可能刚被合并/改名，留在「本主题」范围里只会一直提示「没有卡片」
    if (topic && !(await repo.listKnowledgeCards(topic)).length) setScope('all');
    onChanged?.();
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

  const canAsk = question.trim().length > 0 && phase !== 'running';

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
    <View style={[s.root, { paddingBottom: keyboardHeight }]}>
      <ScreenHeader
        title="问知识库"
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
        {topic ? (
          <Pressable
            onPress={() => setScope('topic')}
            style={[s.chip, scope === 'topic' && s.chipOn]}
          >
            <Text style={[s.chipText, scope === 'topic' && s.chipTextOn]} numberOfLines={1}>
              {topic}
              {topicCards.length ? ` ${topicCards.length}` : ''}
            </Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => setScope('all')} style={[s.chip, scope === 'all' && s.chipOn]}>
          <Text style={[s.chipText, scope === 'all' && s.chipTextOn]}>
            全库{allCards.length ? ` ${allCards.length}` : ''}
          </Text>
        </Pressable>
        {pinnedLogs.length ? (
          <View style={s.ctxChip}>
            <Ionicons name="attach" size={11} color={C.accentText} />
            <Text style={s.ctxChipText}>带 {pinnedLogs.length} 条</Text>
            <Pressable onPress={() => setPinned(new Set())} hitSlop={8}>
              <Ionicons name="close" size={11} color={C.accentText} />
            </Pressable>
          </View>
        ) : null}
      </View>

      <View style={s.inputBox}>
        <TextInput
          style={s.input}
          value={question}
          onChangeText={setQuestion}
          placeholder="比如：群晖换盘之后要做什么？"
          placeholderTextColor={C.text3}
          multiline
          editable={phase !== 'running'}
        />
        <Pressable
          style={[s.sendBtn, !canAsk && s.sendDisabled]}
          onPress={submit}
          disabled={!canAsk}
        >
          {phase === 'running' ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Ionicons name="arrow-up" size={18} color="#FFFFFF" />
          )}
        </Pressable>
      </View>

      {error ? <Text style={s.error}>{error}</Text> : null}

      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        {phase === 'running' && stage === 'search' ? (
          <View style={s.stageCard}>
            <ActivityIndicator size="small" color={C.accent} />
            <Text style={s.stageText} numberOfLines={2}>
              正在联网搜索「{asked}」…
            </Text>
          </View>
        ) : null}

        {phase === 'running' && stage !== 'search' ? (
          <ReasoningStream
            title="正在翻知识库…"
            text={reasoning}
            received={received}
            elapsed={elapsed}
            thinking={thinkingOn}
            height={240}
          />
        ) : null}

        {result ? (
          <>
            <View style={s.answerCard}>
              <NoteBody text={result.answer} style={s.answer} />
            </View>

            {/* 答案落地后思维链退成一行 —— 想看再点，不再占半屏 */}
            {result.reasoning && thinkingOn ? (
              <ReasoningCollapse text={result.reasoning} seconds={thinkSec} />
            ) : null}

            {result.cited.length > 0 ? (
              <>
                <Text style={s.sectionLabel}>回答里提到的卡片</Text>
                <View style={s.citedWrap}>
                  {result.cited.map((card) => (
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

            {result.web.length ? (
              <>
                <Text style={s.sectionLabel}>这次搜到的网络资料</Text>
                <View style={s.citedWrap}>
                  {result.web.map((hit, i) => (
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

            <AskActions actions={result.actions} titleOf={titleOf} onApplied={appliedActions} />

            <View style={s.answerFoot}>
              <Text style={s.footMeta}>
                读了 {result.scanned} / {result.total} 张卡
                {result.web.length ? ` · 网络 ${result.web.length} 条` : ''}
              </Text>
              {result.web.length === 0 ? (
                <Pressable onPress={retryWithWeb} hitSlop={8} style={s.webBtn}>
                  <Ionicons name="globe-outline" size={13} color={C.accentText} />
                  <Text style={s.webBtnText}>
                    {webTried ? '再搜一次' : '联网再查一次'}
                  </Text>
                </Pressable>
              ) : null}
            </View>

            {webTried && result.web.length === 0 ? (
              <Text style={s.webEmpty}>联网搜过了，没找到能用的资料，上面的回答仍然只依据卡片。</Text>
            ) : null}
          </>
        ) : phase === 'ask' ? (
          <View style={s.tips}>
            <Text style={s.tipsTitle}>可以这样问</Text>
            <Text style={s.tipsLine}>· 上次那个问题最后是怎么解决的？</Text>
            <Text style={s.tipsLine}>· 我记过哪些跟 C 盘清理有关的结论？</Text>
            <Text style={s.tipsLine}>· 把「工具」和「资讯」这两个主题合并掉</Text>
            <Text style={s.muted}>
              回答只依据知识库里的卡片，卡片里没有就会直说没有 —— 那种时候可以点「联网再查一次」。
              {'\n\n'}
              让他合并主题、改卡片的请求，会先变成几条建议，你勾选后才真正改动。
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: C.page },

  scopeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  chip: {
    maxWidth: '55%',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: R.pill,
    borderWidth: 0.5,
    borderColor: C.hair,
    backgroundColor: C.card,
  },
  chipOn: { backgroundColor: C.accentBg, borderColor: C.accentBg },
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

  inputBox: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginHorizontal: 16,
    padding: 10,
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    fontSize: 14,
    lineHeight: 21,
    color: C.text,
    paddingTop: 4,
    paddingBottom: 4,
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.35 },

  error: { fontSize: 12, color: C.danger, marginTop: 10, marginHorizontal: 16 },

  content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 28 },

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

  answerCard: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    padding: 16,
  },
  answer: { fontSize: 15, lineHeight: 25 },

  sectionLabel: { fontSize: 12, color: C.text3, marginTop: 18, marginBottom: 8 },
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

  answerFoot: {
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

  tips: { paddingTop: 6 },
  tipsTitle: { fontSize: 12, color: C.text3, marginBottom: 8 },
  tipsLine: { fontSize: 13, lineHeight: 24, color: C.text2 },
  muted: { fontSize: 11, color: C.text3, lineHeight: 18, marginTop: 16 },
});
