/**
 * 整理确认页的六组条目。
 *
 * 单独拆出来有两个原因：
 * 1. `OrganizeScreen` 已经很长了，再塞六段几乎同构的渲染分支会没法读；
 * 2. 这里每一段都是「一类建议 + 勾选」，改动频率低，和页面的状态机分开更安全。
 *
 * 组件本身无状态：勾选状态由页面统一持有，这里只负责画和回调。
 * **哪些项默认不勾由 `util/resultItems.ts` 决定**，不要在这里另写一份 ——
 * 破坏性操作默认不勾这条纪律，只允许有一个出处。
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Fragment, OrganizeReview, Todo } from '../types';
import { R, useThemedStyles, type Palette, tagColor } from '../theme';
import { K } from '../util/resultItems';

interface Props {
  review: OrganizeReview;
  /** 本轮碎片，用来看标签改没改、显示合并的原文 */
  fragments: Fragment[];
  /** 已有待办，用来把 todo_id 翻成人话 */
  todos: Todo[];
  isOn: (key: string) => boolean;
  onToggle: (key: string) => void;
  /** all 模式：标签会覆盖旧值，要标出「原来是什么」 */
  refactor: boolean;
}

export function ResultSections({ review, fragments, todos, isOn, onToggle, refactor }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const byId = useMemo(() => new Map(fragments.map((f) => [f.id, f])), [fragments]);
  const todoById = useMemo(() => new Map(todos.map((t) => [t.id, t])), [todos]);

  const total =
    review.tags.length +
    review.todos.length +
    review.todo_done.length +
    review.drop_todos.length +
    review.merge_todos.length +
    review.merge.length;

  if (!total) {
    return (
      <Text style={styles.resultHint}>
        这次跑完了 {review.processedCount} 条碎片，没有需要改动的内容。点下面的按钮把它们记为已整理即可，
        原文一个字都不会动。
      </Text>
    );
  }

  return (
    <View>
      {review.tags.length > 0 && (
        <Section
          title="标签"
          count={review.tags.length}
          hint={
            review.newTagCount > 0
              ? `其中 ${review.newTagCount} 个是新建的。勾一整组 = 这批碎片都打上这个标签。`
              : '全部是已有标签，勾选后直接套用。'
          }
        >
          {review.tags.map((g) => {
            const key = K.tagGroup(g.label);
            const on = isOn(key);
            const col = tagColor(c, g.label);
            return (
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <View style={styles.tagHead}>
                  <View style={[styles.labelPill, { backgroundColor: col.bg }]}>
                    <Text style={[styles.labelPillText, { color: col.fg }]}>{g.label}</Text>
                  </View>
                  {g.isNew ? (
                    <View style={styles.newPill}>
                      <Text style={styles.newPillText}>新</Text>
                    </View>
                  ) : null}
                  <Text style={styles.metaText}>{g.fragmentIds.length} 条</Text>
                </View>
                {g.similarTo ? (
                  <Text style={styles.warnText}>和已有的「{g.similarTo}」很像，是同一个意思就改用那个</Text>
                ) : null}
              </CheckRow>
            );
          })}
        </Section>
      )}

      {review.todos.length > 0 && (
        <Section title="新待办" count={review.todos.length} hint="从碎片里抽出来、还没进回顾页的待办。">
          {review.todos.map((t) => {
            const key = K.todo(t.text);
            const on = isOn(key);
            return (
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <Text style={[styles.rowText, !on && styles.rowTextOff]}>{t.text}</Text>
                {t.due ? <Text style={styles.dueText}>截止 {t.due}</Text> : null}
              </CheckRow>
            );
          })}
        </Section>
      )}

      {review.todo_done.length > 0 && (
        <Section
          title="这些待办好像做完了"
          count={review.todo_done.length}
          hint="默认勾选。标错了在回顾页的「已完成」里点一下就能撤回，不丢内容。"
        >
          {review.todo_done.map((d) => {
            const key = K.done(d.todo_id);
            const on = isOn(key);
            return (
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <Text style={[styles.rowText, on && styles.strikeText, !on && styles.rowTextOff]}>
                  {todoById.get(d.todo_id)?.text ?? `#${d.todo_id}`}
                </Text>
                {d.reason ? <Text style={styles.reasonText}>{d.reason}</Text> : null}
              </CheckRow>
            );
          })}
        </Section>
      )}

      {review.drop_todos.length > 0 && (
        <Section
          title="建议删掉的待办"
          count={review.drop_todos.length}
          hint="真删除，不能撤销。碎片原文不受影响。默认不勾选。"
        >
          {review.drop_todos.map((d) => {
            const key = K.drop(d.todo_id);
            const on = isOn(key);
            return (
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <Text style={[styles.rowText, !on && styles.rowTextOff]}>
                  {todoById.get(d.todo_id)?.text ?? `#${d.todo_id}`}
                </Text>
                {d.reason ? <Text style={styles.reasonText}>{d.reason}</Text> : null}
              </CheckRow>
            );
          })}
        </Section>
      )}

      {review.merge_todos.length > 0 && (
        <Section
          title="合并重复待办"
          count={review.merge_todos.length}
          hint="保留信息最全的一条，其余隐藏。回顾页有「已合并」入口，合错了能撤回。默认不勾选。"
        >
          {review.merge_todos.map((m) => {
            const key = K.mergeTodo(m.keep_id);
            const on = isOn(key);
            const keep = todoById.get(m.keep_id);
            return (
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
                <Text style={[styles.rowText, !on && styles.rowTextOff]}>
                  {keep?.text ?? `#${m.keep_id}`}
                </Text>
                {m.text && m.text !== keep?.text ? (
                  <Text style={styles.mergeNewText}>合并后：{m.text}</Text>
                ) : null}
                <Text style={styles.mergeDrops}>
                  并入：{m.drop_ids.map((id) => todoById.get(id)?.text ?? `#${id}`).join('；')}
                </Text>
                {m.reason ? <Text style={styles.reasonText}>{m.reason}</Text> : null}
              </CheckRow>
            );
          })}
        </Section>
      )}

      {review.merge.length > 0 && (
        <Section
          title="疑似重复的碎片"
          count={review.merge.length}
          hint="重复的原文折叠到保留那条里，原文不删除，详情页还能看到「已合并」。默认不勾选。"
        >
          {review.merge.map((m) => {
            const key = K.merge(m.keep_id);
            const on = isOn(key);
            const keep = byId.get(m.keep_id);
            const drops = m.drop_ids.map((id) => byId.get(id)).filter((f): f is Fragment => !!f);
            return (
              <CheckRow key={key} on={on} onPress={() => onToggle(key)}>
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

      {refactor ? (
        <Text style={styles.footNote}>
          这一轮是「全部重过」：勾上的标签会覆盖旧标签；没勾的碎片保留原有标签，不会被清空。
        </Text>
      ) : null}
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
  const { c, styles } = useThemedStyles(makeStyles);
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
  const { c, styles } = useThemedStyles(makeStyles);
  return (
    <Pressable style={styles.checkRow} onPress={onPress}>
      <View style={[styles.checkCircle, on && styles.checkCircleOn]}>
        {on && <Ionicons name="checkmark" size={12} color={c.onAccent} />}
      </View>
      <View style={styles.checkBody}>{children}</View>
    </Pressable>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  resultHint: { fontSize: 12, color: c.text3, marginBottom: 14, marginTop: 4, lineHeight: 18 },

  section: { marginBottom: 20 },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  sectionTitle: { fontSize: 13, color: c.text, fontWeight: '500' },
  sectionCount: { fontSize: 11, color: c.text3 },
  sectionHint: { fontSize: 11, color: c.text3, lineHeight: 16, marginBottom: 7, paddingHorizontal: 2 },
  sectionBody: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    overflow: 'hidden',
  },

  checkRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  checkCircle: {
    width: 17,
    height: 17,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: c.hair,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkCircleOn: { backgroundColor: c.accent, borderColor: c.accent },
  checkBody: { flex: 1, gap: 4 },
  rowText: { fontSize: 14, lineHeight: 21, color: c.text },
  rowTextOff: { color: c.text3 },
  strikeText: { textDecorationLine: 'line-through', color: c.text2 },

  tagHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  labelPill: { borderRadius: R.pill, paddingHorizontal: 9, paddingVertical: 3 },
  labelPillText: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  newPill: {
    backgroundColor: c.amberBg,
    borderRadius: R.pill,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  newPillText: { fontSize: 10, lineHeight: 14, color: c.amberText },
  metaText: { fontSize: 11, color: c.text3 },
  warnText: { fontSize: 11, color: c.amberText, lineHeight: 16 },
  dueText: { fontSize: 11, color: c.text3, marginTop: 1 },
  dropText: { fontSize: 12, color: c.text3, lineHeight: 18 },
  reasonText: { fontSize: 11, color: c.text3, marginTop: 2, lineHeight: 16 },
  mergeNewText: { fontSize: 12, color: c.accentText, marginTop: 4, lineHeight: 18 },
  mergeDrops: { fontSize: 11, color: c.text2, marginTop: 3, lineHeight: 17 },
  footNote: { fontSize: 11, color: c.text3, lineHeight: 17, paddingHorizontal: 2, marginTop: -6 },
});
