import React, { useMemo, useState } from 'react';
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
import type { AiConfig, Fragment, KnowledgeCard, OrganizeResult, Todo } from '../types';
import { C, R, tagColor } from '../theme';
import { repo } from '../db/repo';
import { loadAiConfig } from '../ai/config';
import { AiError, organize } from '../ai/deepseek';
import { todayISO } from '../util/date';
import { useKeyboardHeight } from '../util/keyboard';

interface Props {
  fragments: Fragment[];
  onClose: () => void;
  onApplied: () => void;
  onOpenSettings: () => void;
}

type Phase = 'idle' | 'running' | 'error' | 'result' | 'applying' | 'done';

/** 整理范围：只处理未读，或连已整理的一起重看 */
type Scope = 'inbox' | 'all';

const INBOX_LIMIT = 60;
/** 混着整理时：未读优先，剩下的额度留给最近整理过的 */
const MIXED_INBOX_LIMIT = 40;
const MIXED_ORGANIZED_LIMIT = 60;

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
  summary: 'summary',
};

export function OrganizeScreen({ fragments, onClose, onApplied, onOpenSettings }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [scope, setScope] = useState<Scope>('inbox');
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

  const keyboardHeight = useKeyboardHeight();

  const inbox = useMemo(() => fragments.filter((f) => f.status === 'inbox'), [fragments]);
  const organized = useMemo(() => fragments.filter((f) => f.status === 'tagged'), [fragments]);

  const batch = useMemo(() => {
    if (scope === 'inbox') return inbox.slice(0, INBOX_LIMIT);
    const picked = [...inbox.slice(0, MIXED_INBOX_LIMIT), ...organized.slice(0, MIXED_ORGANIZED_LIMIT)];
    const seen = new Set<number>();
    return picked.filter((f) => {
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    });
  }, [scope, inbox, organized]);

  const available = inbox.length + (scope === 'all' ? organized.length : 0);
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
    result.tags.forEach((t) => keys.push(K.tag(t.id)));
    result.merge.forEach((m) => keys.push(K.merge(m.keep_id, m.drop_ids)));
    if (result.summary) keys.push(K.summary);
    return keys;
  }, [result]);

  const isOn = (key: string) => !deselected.has(key);
  const acceptedCount = allKeys.filter(isOn).length;

  function toggle(key: string) {
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /**
   * 「标记待办完成」是本页唯一会**减少**用户可见内容的操作：
   * 误标之后待办从列表里消失，用户很难注意到自己少了一件事。
   * 所以这一类默认不勾选，必须由用户主动点一下。
   * 追问时只把「这一轮新冒出来的」置为不勾，用户已表过态的保持原样。
   */
  function withFreshDone(
    prev: Set<string>,
    fresh: OrganizeResult,
    previous: OrganizeResult | null,
  ) {
    const known = new Set((previous?.todo_done ?? []).map((d) => K.done(d.todo_id)));
    const next = new Set(prev);
    for (const d of fresh.todo_done) {
      const key = K.done(d.todo_id);
      if (!known.has(key)) next.add(key);
    }
    return next;
  }

  async function start() {
    setPhase('running');
    setErrorMsg('');
    setRefineError('');
    try {
      const cfg = await loadAiConfig();
      if (!cfg.apiKey) {
        setPhase('idle');
        setErrorMsg('还没配置 API Key，先去设置页填一个');
        return;
      }
      const startedAt = Date.now();
      const topicList = (await repo.listKnowledgeTopics()).map((t) => t.topic);
      const cardList = await repo.listKnowledgeCards();
      const todoList = await repo.listTodos();

      const outcome = await organize({
        fragments: batch,
        config: cfg,
        topics: topicList,
        cards: cardList,
        todos: todoList,
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
      setResult(outcome.result);
      setDeselected(withFreshDone(new Set(), outcome.result, null));
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
    try {
      const outcome = await organize({
        fragments: batch,
        config,
        topics,
        cards,
        todos,
        previousRaw: raw,
        instruction,
      });
      setRaw(outcome.raw);
      setResult(outcome.result);
      setDeselected((prev) => withFreshDone(prev, outcome.result, result));
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
        await repo.insertKnowledgeCard({
          topic: k.topic,
          title: k.title,
          gist: k.gist,
          body: k.body,
          sourceIds: k.source_ids,
        });
        if (k.source_ids.length) await repo.setFragmentNature(k.source_ids, 'knowledge');
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

  const headerTitle = round > 1 ? `整理 · 第 ${round} 版` : '整理';

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
            <View style={styles.heroCard}>
              <Text style={styles.heroNum}>{inbox.length}</Text>
              <Text style={styles.heroLabel}>条未整理的碎片</Text>

              <Pressable style={styles.scopeRow} onPress={() => setScope(scope === 'inbox' ? 'all' : 'inbox')}>
                <View style={[styles.scopeBox, scope === 'all' && styles.scopeBoxOn]}>
                  {scope === 'all' && <Ionicons name="checkmark" size={11} color="#FFFFFF" />}
                </View>
                <View style={styles.scopeBody}>
                  <Text style={styles.scopeTitle}>连同已整理的一起重看</Text>
                  <Text style={styles.scopeSub}>
                    {scope === 'all'
                      ? `会带上最近 ${Math.min(organized.length, MIXED_ORGANIZED_LIMIT)} 条已整理的碎片，AI 可以重新归类、合并它们`
                      : '只看未读。已有知识卡和未完成待办始终作为参考，用来补充卡片、标记完成'}
                  </Text>
                </View>
              </Pressable>

              <Pressable
                style={[styles.primaryBtn, !batch.length && styles.primaryBtnDisabled]}
                onPress={start}
                disabled={!batch.length}
              >
                <Text style={styles.primaryBtnText}>
                  {batch.length ? `开始整理 ${batch.length} 条` : '没有可整理的碎片'}
                </Text>
              </Pressable>

              {overflow > 0 && (
                <Text style={styles.overflowText}>
                  还有 {overflow} 条这次没带上，处理完再整理一轮即可。
                </Text>
              )}
              {!!errorMsg && <Text style={styles.errText}>{errorMsg}</Text>}
            </View>

            {errorMsg.includes('API Key') && (
              <Pressable style={styles.linkRow} onPress={onOpenSettings}>
                <Text style={styles.linkText}>去设置里填 API Key</Text>
                <Ionicons name="chevron-forward" size={13} color={C.accent} />
              </Pressable>
            )}
          </View>
        )}

        {phase === 'running' && (
          <View style={styles.centerBox}>
            <ActivityIndicator color={C.accent} />
            <Text style={styles.centerText}>
              {refining ? `正在按第 ${round} 版的要求重写…` : `正在整理 ${batch.length} 条碎片…`}
            </Text>
            <Text style={styles.centerSub}>通常需要 5–15 秒</Text>
          </View>
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
            <Text style={styles.resultHint}>
              逐条确认。关掉的项不会写入。
              {round > 1 ? '追问后没改动的条目，你之前的勾选状态会保留。' : ''}
            </Text>

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
                hint="默认不勾选。勾上才会标完成 —— 标错了待办会从列表里消失，不容易发现。"
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
              <Section title="分类打标" count={result.tags.length}>
                {result.tags.map((t) => {
                  const key = K.tag(t.id);
                  const on = isOn(key);
                  const f = byId.get(t.id);
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

  scopeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    alignSelf: 'stretch',
    marginTop: 18,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
  },
  scopeBox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.hair,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  scopeBoxOn: { backgroundColor: C.accent, borderColor: C.accent },
  scopeBody: { flex: 1 },
  scopeTitle: { fontSize: 13, color: C.text, fontWeight: '500' },
  scopeSub: { fontSize: 11, color: C.text3, lineHeight: 17, marginTop: 3 },

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
