import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Fragment, OrganizeResult } from '../types';
import { C, R, tagColor } from '../theme';
import { TagPill } from '../components/TagPill';
import { repo } from '../db/repo';
import { loadAiConfig } from '../ai/config';
import { AiError, organize } from '../ai/deepseek';
import { todayISO } from '../util/date';

interface Props {
  fragments: Fragment[];
  onClose: () => void;
  onApplied: () => void;
  onOpenSettings: () => void;
}

type Phase = 'idle' | 'running' | 'error' | 'result' | 'applying' | 'done';

const BATCH_LIMIT = 60;

export function OrganizeScreen({ fragments, onClose, onApplied, onOpenSettings }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<OrganizeResult | null>(null);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [errorMsg, setErrorMsg] = useState('');
  const [runId, setRunId] = useState<number | null>(null);

  const inbox = useMemo(() => fragments.filter((f) => f.status === 'inbox'), [fragments]);
  const batch = useMemo(() => inbox.slice(0, BATCH_LIMIT), [inbox]);
  const overflow = inbox.length - batch.length;

  const acceptedCount = useMemo(() => {
    if (!result) return 0;
    let n = 0;
    result.tags.forEach((t) => decisions[`tag:${t.id}`] && n++);
    result.todos.forEach((_, i) => decisions[`todo:${i}`] && n++);
    result.knowledge.forEach((_, i) => decisions[`knowledge:${i}`] && n++);
    if (result.summary && decisions.summary) n++;
    result.merge.forEach((_, i) => decisions[`merge:${i}`] && n++);
    return n;
  }, [result, decisions]);

  async function start() {
    setPhase('running');
    setErrorMsg('');
    try {
      const config = await loadAiConfig();
      if (!config.apiKey) {
        setPhase('idle');
        setErrorMsg('还没配置 API Key，先去设置页填一个');
        return;
      }
      const startedAt = Date.now();
      const topics = (await repo.listKnowledgeTopics()).map((t) => t.topic);
      const data = await organize({ fragments: batch, config, topics });
      const id = await repo.saveRun({
        startedAt,
        fragmentIds: batch.map((f) => f.id),
        model: config.model,
        resultJson: JSON.stringify(data),
      });
      setRunId(id);
      setResult(data);
      const initial: Record<string, boolean> = {};
      data.tags.forEach((t) => (initial[`tag:${t.id}`] = true));
      data.todos.forEach((_, i) => (initial[`todo:${i}`] = true));
      data.knowledge.forEach((_, i) => (initial[`knowledge:${i}`] = true));
      data.merge.forEach((_, i) => (initial[`merge:${i}`] = true));
      if (data.summary) initial.summary = true;
      setDecisions(initial);
      setPhase('result');
    } catch (e) {
      const err = e as AiError;
      setErrorMsg(err?.message || '整理失败，稍后再试');
      setPhase('error');
    }
  }

  async function apply() {
    if (!result) return;
    setPhase('applying');
    try {
      const tagItems = result.tags.filter((t) => decisions[`tag:${t.id}`]);
      for (const t of tagItems) {
        await repo.applyTags(t.id, t.labels, t.project);
      }

      for (let i = 0; i < result.todos.length; i++) {
        if (!decisions[`todo:${i}`]) continue;
        const t = result.todos[i];
        await repo.insertTodo({ text: t.text, dueAt: t.due, sourceFragmentId: t.id });
      }

      const todoSourceIds = result.todos
        .filter((_, i) => decisions[`todo:${i}`])
        .map((t) => t.id)
        .filter((n): n is number => n !== null);
      if (todoSourceIds.length) await repo.setFragmentNature(todoSourceIds, 'todo');

      for (let i = 0; i < result.knowledge.length; i++) {
        if (!decisions[`knowledge:${i}`]) continue;
        const k = result.knowledge[i];
        await repo.insertKnowledgeCard({
          topic: k.topic,
          title: k.title,
          gist: k.gist,
          body: k.body,
          sourceIds: k.source_ids,
        });
        if (k.source_ids.length) await repo.setFragmentNature(k.source_ids, 'knowledge');
      }

      if (result.summary && decisions.summary) {
        await repo.insertNote({
          type: 'daily',
          title: null,
          bodyMd: result.summary.body_md,
          period: todayISO(),
        });
      }

      for (let i = 0; i < result.merge.length; i++) {
        if (!decisions[`merge:${i}`]) continue;
        const m = result.merge[i];
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

  function toggle(key: string) {
    setDecisions((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const byId = useMemo(() => new Map(fragments.map((f) => [f.id, f])), [fragments]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onClose} hitSlop={12} style={styles.back}>
          <Ionicons name="chevron-back" size={20} color={C.text} />
        </Pressable>
        <Text style={styles.title}>整理</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {phase === 'idle' && (
          <View>
            <View style={styles.heroCard}>
              <Text style={styles.heroNum}>{inbox.length}</Text>
              <Text style={styles.heroLabel}>条未整理的碎片</Text>
              <Text style={styles.heroHint}>
                点下面的按钮，AI 会一次性帮你分类打标、提炼待办、写一段小结，并找出重复的条目。
                {overflow > 0 ? `\n本次先处理最近 ${batch.length} 条，剩余 ${overflow} 条下次再说。` : ''}
              </Text>
              <Pressable
                style={[styles.primaryBtn, !batch.length && styles.primaryBtnDisabled]}
                onPress={start}
                disabled={!batch.length}
              >
                <Text style={styles.primaryBtnText}>
                  {batch.length ? '开始整理' : '没有待整理的碎片'}
                </Text>
              </Pressable>
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
            <Text style={styles.centerText}>正在整理 {batch.length} 条碎片…</Text>
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
            <Text style={styles.errTitle}>整理失败</Text>
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
            <Text style={styles.resultHint}>逐条确认。关掉的项不会写入。</Text>

            {result.todos.length > 0 && (
              <Section title="提炼待办" count={result.todos.length}>
                {result.todos.map((t, i) => {
                  const on = !!decisions[`todo:${i}`];
                  return (
                    <CheckRow key={`todo-${i}`} on={on} onPress={() => toggle(`todo:${i}`)}>
                      <Text style={[styles.rowText, !on && styles.rowTextOff]}>{t.text}</Text>
                      {t.due ? <Text style={styles.dueText}>{t.due}</Text> : null}
                    </CheckRow>
                  );
                })}
              </Section>
            )}

            {result.knowledge.length > 0 && (
              <Section title="沉淀知识" count={result.knowledge.length}>
                {result.knowledge.map((k, i) => {
                  const on = !!decisions[`knowledge:${i}`];
                  return (
                    <CheckRow
                      key={`knowledge-${i}`}
                      on={on}
                      onPress={() => toggle(`knowledge:${i}`)}
                    >
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

            {result.summary && (
              <Section title="今日小结" count={1}>
                <CheckRow on={!!decisions.summary} onPress={() => toggle('summary')}>
                  <Text style={[styles.summaryText, !decisions.summary && styles.rowTextOff]}>
                    {result.summary.body_md}
                  </Text>
                </CheckRow>
              </Section>
            )}

            {result.tags.length > 0 && (
              <Section title="分类打标" count={result.tags.length}>
                {result.tags.map((t) => {
                  const f = byId.get(t.id);
                  const on = !!decisions[`tag:${t.id}`];
                  return (
                    <CheckRow key={`tag-${t.id}`} on={on} onPress={() => toggle(`tag:${t.id}`)}>
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
                {result.merge.map((m, i) => {
                  const on = !!decisions[`merge:${i}`];
                  const keep = byId.get(m.keep_id);
                  const drops = m.drop_ids.map((id) => byId.get(id)).filter(Boolean) as Fragment[];
                  return (
                    <CheckRow key={`merge-${i}`} on={on} onPress={() => toggle(`merge:${i}`)}>
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

            {result.tags.length === 0 &&
              result.todos.length === 0 &&
              result.knowledge.length === 0 &&
              !result.summary &&
              result.merge.length === 0 && (
                <Text style={styles.resultHint}>AI 认为这批碎片不需要处理。</Text>
              )}
          </View>
        )}
      </ScrollView>

      {phase === 'result' && (
        <View style={styles.bottomBar}>
          <Pressable style={styles.secondaryBtnFlex} onPress={onClose}>
            <Text style={styles.secondaryBtnText}>全部放弃</Text>
          </Pressable>
          <Pressable style={styles.primaryBtnFlex} onPress={apply} disabled={!acceptedCount}>
            <Text style={styles.primaryBtnText}>
              应用 {acceptedCount} 项
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionCount}>{count}</Text>
      </View>
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
  heroHint: {
    fontSize: 12,
    color: C.text3,
    lineHeight: 20,
    textAlign: 'center',
    marginTop: 14,
  },

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

  resultHint: { fontSize: 12, color: C.text3, marginBottom: 14, marginTop: 4 },

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
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5, marginTop: 2 },
  labelPill: { borderRadius: R.pill, paddingHorizontal: 8, paddingVertical: 2 },
  labelPillText: { fontSize: 11, lineHeight: 15 },
  projectText: { fontSize: 11, color: C.text3 },
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
  reasonText: { fontSize: 11, color: C.text3, marginTop: 2 },

  bottomBar: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
    backgroundColor: C.page,
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
