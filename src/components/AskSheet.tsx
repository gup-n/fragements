/**
 * 知识库问答面板：拿卡片当事实来源回答提问。
 *
 * 范围默认是「当前主题」（选一个主题进来时几乎都是想知道这个主题的事），
 * 可以一键切成「全库」。问答结果不落库 —— 它只是查询，不是内容。
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { KnowledgeCard } from '../types';
import { AiError, type ChatProgress } from '../ai/chat';
import { askKnowledge, type AskOutcome } from '../ai/ask';
import { loadAiConfig } from '../ai/config';
import { repo } from '../db/repo';
import { C, R } from '../theme';
import { useKeyboardHeight } from '../util/keyboard';
import { NoteBody } from './NoteBody';
import { ReasoningStream } from './ReasoningStream';

type Phase = 'ask' | 'running' | 'answer';

interface Props {
  /** 进入时的默认范围；null 表示从首页进来的，只有全库可选 */
  topic: string | null;
  onClose: () => void;
  /** 点引用卡片时交给上层打开详情 */
  onOpenCard: (card: KnowledgeCard) => void;
}

export function AskSheet({ topic, onClose, onOpenCard }: Props) {
  const [scope, setScope] = useState<'topic' | 'all'>(topic ? 'topic' : 'all');
  const [topicCount, setTopicCount] = useState<number | null>(null);
  const [allCount, setAllCount] = useState<number | null>(null);
  const [question, setQuestion] = useState('');
  const [phase, setPhase] = useState<Phase>('ask');
  const [result, setResult] = useState<AskOutcome | null>(null);
  const [error, setError] = useState('');

  const [reasoning, setReasoning] = useState('');
  const [received, setReceived] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [thinkingOn, setThinkingOn] = useState(false);
  const [showTrace, setShowTrace] = useState(false);

  const startedAtRef = useRef(0);
  const streamRef = useRef({ lastFlush: 0 });
  const keyboardHeight = useKeyboardHeight();

  useEffect(() => {
    let alive = true;
    (async () => {
      const [t, a] = await Promise.all([
        topic ? repo.listKnowledgeCards(topic) : Promise.resolve([]),
        repo.listKnowledgeCards(),
      ]);
      if (!alive) return;
      setTopicCount(t.length);
      setAllCount(a.length);
    })();
    return () => {
      alive = false;
    };
  }, [topic]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phase === 'running') return true; // 正在生成，别让返回把请求丢了
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [phase, onClose]);

  useEffect(() => {
    if (phase !== 'running') return;
    const timer = setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [phase]);

  function handleProgress(patch: ChatProgress) {
    const now = Date.now();
    if (now - streamRef.current.lastFlush < 120) return;
    streamRef.current.lastFlush = now;
    if (patch.reasoning !== undefined) setReasoning(patch.reasoning);
    if (patch.content !== undefined) setReceived(patch.content.length);
  }

  async function ask() {
    if (!question.trim()) return;
    setError('');
    setResult(null);
    setReasoning('');
    setReceived(0);
    setElapsed(0);
    setShowTrace(false);
    streamRef.current.lastFlush = 0;
    startedAtRef.current = Date.now();
    setPhase('running');

    try {
      const config = await loadAiConfig();
      if (!config.apiKey) {
        setPhase('ask');
        setError('还没配置 API Key，先去设置页填一个');
        return;
      }
      setThinkingOn(config.thinking);

      const cards = await repo.listKnowledgeCards(scope === 'topic' && topic ? topic : undefined);
      if (!cards.length) {
        setPhase('ask');
        setError(scope === 'topic' ? '这个主题下还没有卡片' : '知识库还是空的');
        return;
      }

      const outcome = await askKnowledge({
        question,
        cards,
        config,
        onProgress: handleProgress,
      });
      setReasoning(outcome.reasoning);
      setResult(outcome);
      setPhase('answer');
    } catch (e) {
      setPhase('ask');
      setError(e instanceof AiError ? e.message : e instanceof Error ? e.message : '提问失败，再试一次');
    }
  }

  const canAsk = question.trim().length > 0 && phase !== 'running';

  return (
    <View style={[s.root, { paddingBottom: keyboardHeight }]}>
      <View style={s.header}>
        <Pressable onPress={onClose} hitSlop={12} style={s.headBtn}>
          <Ionicons name="close" size={22} color={C.text} />
        </Pressable>
        <Text style={s.title}>问知识库</Text>
        <View style={s.headBtn} />
      </View>

      <View style={s.scopeRow}>
        {topic ? (
          <Pressable
            onPress={() => setScope('topic')}
            style={[s.chip, scope === 'topic' && s.chipOn]}
          >
            <Text style={[s.chipText, scope === 'topic' && s.chipTextOn]} numberOfLines={1}>
              {topic}
              {topicCount !== null ? ` ${topicCount}` : ''}
            </Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => setScope('all')} style={[s.chip, scope === 'all' && s.chipOn]}>
          <Text style={[s.chipText, scope === 'all' && s.chipTextOn]}>
            全库{allCount !== null ? ` ${allCount}` : ''}
          </Text>
        </Pressable>
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
          onPress={ask}
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
        {phase === 'running' ? (
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

            {result.cited.length > 0 ? (
              <>
                <Text style={s.sectionLabel}>回答里提到的卡片</Text>
                <View style={s.citedWrap}>
                  {result.cited.map((card) => (
                    <Pressable key={card.id} style={s.cited} onPress={() => onOpenCard(card)}>
                      <Text style={s.citedTopic}>{card.topic}</Text>
                      <Text style={s.citedTitle} numberOfLines={1}>
                        {card.title}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}

            <Text style={s.footMeta}>
              读了 {result.scanned} / {result.total} 张卡
              {result.reasoning ? ' · 生成过程的思考可展开' : ''}
            </Text>

            {result.reasoning ? (
              <View style={s.traceCard}>
                <Pressable style={s.traceHead} onPress={() => setShowTrace((v) => !v)} hitSlop={4}>
                  <Ionicons
                    name={showTrace ? 'chevron-down' : 'chevron-forward'}
                    size={13}
                    color={C.text3}
                  />
                  <Text style={s.traceTitle}>模型思考过程</Text>
                  <Text style={s.traceMeta}>{result.reasoning.length} 字</Text>
                </Pressable>
                {showTrace ? (
                  <ScrollView style={s.traceScroll} contentContainerStyle={s.traceBody} nestedScrollEnabled>
                    <Text style={s.traceText}>{result.reasoning}</Text>
                  </ScrollView>
                ) : null}
              </View>
            ) : null}
          </>
        ) : phase === 'ask' ? (
          <View style={s.tips}>
            <Text style={s.tipsTitle}>可以这样问</Text>
            <Text style={s.tipsLine}>· 上次那个问题最后是怎么解决的？</Text>
            <Text style={s.tipsLine}>· 我记过哪些跟 C 盘清理有关的结论？</Text>
            <Text style={s.tipsLine}>· 这两条笔记里说的盘符为什么不一样？</Text>
            <Text style={s.muted}>
              回答只依据知识库里的卡片，卡片里没有就会直说没有。
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: C.page },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  headBtn: { width: 28, alignItems: 'flex-start' },
  title: { fontSize: 16, color: C.text, fontWeight: '500' },

  scopeRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  chip: {
    maxWidth: '60%',
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

  footMeta: { fontSize: 11, color: C.text3, marginTop: 14 },

  traceCard: {
    marginTop: 12,
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  traceHead: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  traceTitle: { flex: 1, fontSize: 12, color: C.text2 },
  traceMeta: { fontSize: 11, color: C.text3 },
  traceScroll: { maxHeight: 220, marginTop: 8, backgroundColor: C.hairSoft, borderRadius: R.btn },
  traceBody: { padding: 10 },
  traceText: { fontSize: 12, lineHeight: 19, color: C.text2 },

  tips: { paddingTop: 6 },
  tipsTitle: { fontSize: 12, color: C.text3, marginBottom: 8 },
  tipsLine: { fontSize: 13, lineHeight: 24, color: C.text2 },
  muted: { fontSize: 11, color: C.text3, lineHeight: 18, marginTop: 16 },
});
