/**
 * 整理结果页的十类条目。
 *
 * 单独拆出来有两个原因：
 * 1. `OrganizeScreen` 已经一千多行，再塞着十段几乎同构的渲染分支会没法读；
 * 2. 这里的每一段都是「一类建议 + 逐条勾选」，改动频率低、波动小，
 *    和页面的状态机（idle / running / result / done）分开更安全。
 *
 * 组件本身无状态：勾选状态由页面统一持有，这里只负责画和回调。
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type {
  Fragment,
  KnowledgeCard,
  OrganizeMode,
  OrganizeResult,
  Todo,
} from '../types';
import { C, R, tagColor } from '../theme';
import { K, resultKeys } from '../util/resultItems';
import { replacementOf } from '../util/dedupe';

interface Props {
  result: OrganizeResult;
  mode: OrganizeMode;
  /** 本轮碎片，用来显示原文、判断标签改没改 */
  fragments: Fragment[];
  /** 打开结果页时的卡片快照，用来显示旧卡标题、判断新卡取代了谁 */
  cards: KnowledgeCard[];
  /** 已有待办，用来把 todo_id 翻成人话 */
  todos: Todo[];
  isOn: (key: string) => boolean;
  onToggle: (key: string) => void;
}

export function ResultSections({ result, mode, fragments, cards, todos, isOn, onToggle }: Props) {
  const byId = useMemo(() => new Map(fragments.map((f) => [f.id, f])), [fragments]);
  const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const todoById = useMemo(() => new Map(todos.map((t) => [t.id, t])), [todos]);

  /**
   * 新卡会顶掉哪张旧卡 —— 显示和写入用的是同一个判据（`util/dedupe.ts`），
   * 以前这里各写了一份，改一处忘另一处就会出现「界面这么说、实际那么做」。
   */
  const replacedBy = (sourceIds: number[]) => replacementOf(cards, sourceIds);

  if (!resultKeys(result).length) {
    return <Text style={s.resultHint}>AI 认为这批碎片不需要处理。</Text>;
  }

  return (
    <View>
      {result.todos.length > 0 && (
        <Section title="提炼待办" count={result.todos.length}>
          {result.todos.map((t) => {
            const key = K.todo(t.text);
            const on = isOn(key);
            return (
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <Text style={[s.rowText, !on && s.rowTextOff]}>{t.text}</Text>
                {t.due ? <Text style={s.dueText}>{t.due}</Text> : null}
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
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <Text style={[s.rowText, on && s.strikeText, !on && s.rowTextOff]}>
                  {todoById.get(d.todo_id)?.text ?? `#${d.todo_id}`}
                </Text>
                {d.reason ? <Text style={s.reasonText}>{d.reason}</Text> : null}
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
            const replaced = mode === 'refactor' ? replacedBy(k.source_ids) : null;
            // 旧卡那边被用户取消了归档，这里就得如实说保留
            const keptOld =
              !!replaced &&
              result.archive_cards.some(
                (a) => a.card_id === replaced.id && !isOn(K.archive(a.card_id)),
              );
            return (
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <View style={s.kHead}>
                  <Text style={[s.rowText, s.kTitle, !on && s.rowTextOff]}>{k.title}</Text>
                  <View style={s.topicPill}>
                    <Text style={s.topicPillText}>{k.topic}</Text>
                  </View>
                </View>
                {k.gist ? (
                  <Text style={[s.gistText, !on && s.rowTextOff]}>{k.gist}</Text>
                ) : null}
                {replaced ? (
                  <Text style={s.reasonText}>
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
            const added = c.add_source_ids.map((id) => byId.get(id)).filter((f): f is Fragment => !!f);
            return (
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <Text style={[s.rowText, s.kTitle, !on && s.rowTextOff]}>
                  {c.title ?? card?.title ?? `#${c.card_id}`}
                </Text>
                <View style={s.pillRow}>
                  <View style={s.topicPill}>
                    <Text style={s.topicPillText}>{card?.topic ?? '未知主题'}</Text>
                  </View>
                  <Text style={s.metaText}>补 {added.length} 条原文</Text>
                </View>
                {c.title && card && c.title !== card.title ? (
                  <Text style={s.reasonText}>原标题：{card.title}</Text>
                ) : null}
                {added.map((f) => (
                  <Text key={f.id} style={s.dropText} numberOfLines={2}>
                    ＋ {f.content}
                  </Text>
                ))}
                {c.reason ? <Text style={s.reasonText}>{c.reason}</Text> : null}
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
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <View style={s.kHead}>
                  <Text style={[s.rowText, s.kTitle, !on && s.rowTextOff]}>
                    {card?.title ?? `#${a.card_id}`}
                  </Text>
                  <View style={s.topicPill}>
                    <Text style={s.topicPillText}>{card?.topic ?? '未知主题'}</Text>
                  </View>
                </View>
                {card?.gist ? <Text style={s.gistText}>{card.gist}</Text> : null}
                {a.reason ? <Text style={s.reasonText}>{a.reason}</Text> : null}
              </CheckRow>
            );
          })}
        </Section>
      )}

      {result.merge_topics.length > 0 && (
        <Section
          title="合并相近主题"
          count={result.merge_topics.length}
          hint="只改主题名，卡片一张都不会少。合并后想拆回去，得去知识库手动改。默认不勾选。"
        >
          {result.merge_topics.map((m) => {
            const key = K.mergeTopic(m.to, m.from);
            const on = isOn(key);
            return (
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <View style={s.kHead}>
                  <Text style={[s.rowText, s.kTitle, !on && s.rowTextOff]}>{m.to}</Text>
                  <View style={s.topicPill}>
                    <Text style={s.topicPillText}>{m.from.length} 个主题</Text>
                  </View>
                </View>
                <Text style={s.mergeDrops}>并入：{m.from.join('、')}</Text>
                {m.reason ? <Text style={s.reasonText}>{m.reason}</Text> : null}
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
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <Text style={[s.rowText, !on && s.rowTextOff]}>
                  {todoById.get(d.todo_id)?.text ?? `#${d.todo_id}`}
                </Text>
                {d.reason ? <Text style={s.reasonText}>{d.reason}</Text> : null}
              </CheckRow>
            );
          })}
        </Section>
      )}

      {result.merge_todos.length > 0 && (
        <Section
          title="合并重复待办"
          count={result.merge_todos.length}
          hint="保留信息最全的一条，其余隐藏。回顾页有「已合并」入口，合错了能撤回。默认不勾选。"
        >
          {result.merge_todos.map((m) => {
            const key = K.mergeTodo(m.keep_id);
            const on = isOn(key);
            const keep = todoById.get(m.keep_id);
            return (
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <Text style={[s.rowText, !on && s.rowTextOff]}>
                  {keep?.text ?? `#${m.keep_id}`}
                </Text>
                {m.text && m.text !== keep?.text ? (
                  <Text style={s.mergeNewText}>合并后：{m.text}</Text>
                ) : null}
                <Text style={s.mergeDrops}>
                  并入：{m.drop_ids.map((id) => todoById.get(id)?.text ?? `#${id}`).join('；')}
                </Text>
                {m.reason ? <Text style={s.reasonText}>{m.reason}</Text> : null}
              </CheckRow>
            );
          })}
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
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <Text style={[s.rowText, !on && s.rowTextOff]} numberOfLines={2}>
                  {f?.content ?? `#${t.id}`}
                </Text>
                <View style={s.pillRow}>
                  {t.labels.map((l) => {
                    const col = tagColor(l);
                    return (
                      <View key={l} style={[s.labelPill, { backgroundColor: col.bg }]}>
                        <Text style={[s.labelPillText, { color: col.fg }]}>{l}</Text>
                      </View>
                    );
                  })}
                  {t.project ? <Text style={s.projectText}>{t.project}</Text> : null}
                </View>
                {mode === 'refactor' && labelsChanged ? (
                  <Text style={s.reasonText}>原标签：{f.tags.length ? f.tags.join('、') : '无'}</Text>
                ) : null}
                {mode === 'refactor' && projectChanged ? (
                  <Text style={s.reasonText}>原项目：{f.project ?? '无'}</Text>
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
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <Text style={[s.rowText, !on && s.rowTextOff]} numberOfLines={2}>
                  保留：{keep?.content ?? `#${m.keep_id}`}
                </Text>
                {drops.map((d) => (
                  <Text key={d.id} style={s.dropText} numberOfLines={1}>
                    并入：{d.content}
                  </Text>
                ))}
                {m.reason ? <Text style={s.reasonText}>{m.reason}</Text> : null}
              </CheckRow>
            );
          })}
        </Section>
      )}
    </View>
  );
}

/** 两组标签是否等价（集合比较，模型重排顺序不算变化） */
function sameLabels(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort().join('\u0001');
  const sb = [...b].sort().join('\u0001');
  return sa === sb;
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
    <View style={s.section}>
      <View style={s.sectionHead}>
        <Text style={s.sectionTitle}>{title}</Text>
        <Text style={s.sectionCount}>{count}</Text>
      </View>
      {hint ? <Text style={s.sectionHint}>{hint}</Text> : null}
      <View style={s.sectionBody}>{children}</View>
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
    <Pressable style={s.checkRow} onPress={onPress}>
      <View style={[s.checkCircle, on && s.checkCircleOn]}>
        {on && <Ionicons name="checkmark" size={12} color="#FFFFFF" />}
      </View>
      <View style={s.checkBody}>{children}</View>
    </Pressable>
  );
}

const s = StyleSheet.create({
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
  dropText: { fontSize: 12, color: C.text3, lineHeight: 18 },
  reasonText: { fontSize: 11, color: C.text3, marginTop: 2, lineHeight: 16 },
  mergeNewText: { fontSize: 12, color: C.accentText, marginTop: 4, lineHeight: 18 },
  mergeDrops: { fontSize: 11, color: C.text2, marginTop: 3, lineHeight: 17 },
});
