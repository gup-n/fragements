import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Note, Todo } from '../types';
import { C, R } from '../theme';
import { repo } from '../db/repo';
import { dayKey, periodLabel } from '../util/date';
import { NoteBody } from '../components/NoteBody';
import { SummarySheet } from '../components/SummarySheet';
import { ScreenHeader } from '../components/ScreenHeader';

interface Props {
  onClose: () => void;
  /** 数据变了（新存了一条总结），通知上层刷新时间轴 */
  onChanged?: () => void | Promise<void>;
}

type Tab = 'todo' | 'note';

const NOTE_KIND: Record<Note['type'], string> = {
  daily: '日小结',
  weekly: '周总结',
  monthly: '月总结',
  theme: '主题总结',
};

/** 到期日只显示月-日；早于今天标红 */
function dueLabel(dueAt: string | null): { text: string; overdue: boolean } | null {
  if (!dueAt) return null;
  return { text: dueAt.slice(5).replace('-', '/'), overdue: dueAt < dayKey(Date.now()) };
}

export function ReviewScreen({ onClose, onChanged }: Props) {
  const [tab, setTab] = useState<Tab>('todo');
  const [todos, setTodos] = useState<Todo[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  /** 被合并掉的待办。合并是隐藏不是删除，这里必须有入口，否则就是数据黑洞 */
  const [merged, setMerged] = useState<Todo[]>([]);
  const [showMerged, setShowMerged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [openNote, setOpenNote] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const reload = useCallback(async () => {
    const [t, n, m] = await Promise.all([
      repo.listTodos(),
      repo.listNotes(60),
      repo.listMergedTodos(),
    ]);
    setTodos(t);
    setNotes(n);
    setMerged(m);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function toggle(item: Todo) {
    await repo.toggleTodo(item.id, !item.done);
    await reload();
  }

  /** 撤回一次合并：这批被并掉的条目全部放回列表 */
  async function unmerge(item: Todo) {
    if (item.mergedInto === null) return;
    await repo.unmergeTodos(item.mergedInto);
    await reload();
  }

  const pending = todos.filter((t) => !t.done);
  const finished = todos.filter((t) => t.done);

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="回顾"
        subtitle={
          pending.length > 0 ? `${pending.length} 项待办没做完` : '待办已经清空了'
        }
        onBack={onClose}
      />

      <View style={styles.tabs}>
        {([
          ['todo', `待办${pending.length ? ` ${pending.length}` : ''}`],
          ['note', '小结'],
        ] as [Tab, string][]).map(([key, label]) => (
          <Pressable
            key={key}
            onPress={() => setTab(key)}
            style={[styles.tab, tab === key && styles.tabActive]}
          >
            <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : tab === 'todo' ? (
        <ScrollView contentContainerStyle={styles.content}>
          {todos.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>还没有待办</Text>
              <Text style={styles.emptyBody}>
                整理时 AI 会把「有明确动作」的碎片挑出来，{'\n'}你确认后就会出现在这里。
              </Text>
            </View>
          ) : (
            <>
              {pending.length > 0 && (
                <View style={styles.group}>
                  {pending.map((item, i) => {
                    const due = dueLabel(item.dueAt);
                    return (
                      <Pressable
                        key={item.id}
                        onPress={() => toggle(item)}
                        style={({ pressed }) => [
                          styles.row,
                          i === pending.length - 1 && styles.rowLast,
                          pressed && { backgroundColor: C.hairSoft },
                        ]}
                      >
                        <View style={styles.check}>
                          <Ionicons name="ellipse-outline" size={20} color={C.text3} />
                        </View>
                        <Text style={styles.todoText}>{item.text}</Text>
                        {due && (
                          <Text style={[styles.due, due.overdue && styles.dueOverdue]}>
                            {due.text}
                          </Text>
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              )}

              {finished.length > 0 && (
                <>
                  <Text style={styles.hint}>已完成 {finished.length} 条</Text>
                  <View style={styles.group}>
                    {finished.map((item, i) => (
                      <Pressable
                        key={item.id}
                        onPress={() => toggle(item)}
                        style={({ pressed }) => [
                          styles.row,
                          i === finished.length - 1 && styles.rowLast,
                          pressed && { backgroundColor: C.hairSoft },
                        ]}
                      >
                        <View style={styles.check}>
                          <Ionicons name="checkmark-circle" size={20} color={C.accent} />
                        </View>
                        <Text style={[styles.todoText, styles.doneText]}>{item.text}</Text>
                      </Pressable>
                    ))}
                  </View>
                </>
              )}

              {merged.length > 0 && (
                <>
                  <Pressable style={styles.mergedBar} onPress={() => setShowMerged((v) => !v)}>
                    <Ionicons name="git-merge-outline" size={16} color={C.text3} />
                    <Text style={styles.mergedLabel}>已合并 {merged.length} 条</Text>
                    <Ionicons
                      name={showMerged ? 'chevron-up' : 'chevron-down'}
                      size={13}
                      color={C.text3}
                    />
                  </Pressable>
                  {showMerged && (
                    <View style={styles.group}>
                      {merged.map((item, i) => (
                        <View
                          key={item.id}
                          style={[styles.row, i === merged.length - 1 && styles.rowLast]}
                        >
                          <Text style={styles.mergedText}>{item.text}</Text>
                          <Pressable onPress={() => unmerge(item)} hitSlop={10}>
                            <Text style={styles.mergedUndo}>恢复</Text>
                          </Pressable>
                        </View>
                      ))}
                    </View>
                  )}
                </>
              )}
            </>
          )}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Pressable
            style={({ pressed }) => [styles.genBtn, pressed && { backgroundColor: C.accentBg }]}
            onPress={() => setSheetOpen(true)}
          >
            <Ionicons name="sparkles-outline" size={17} color={C.accentText} />
            <Text style={styles.genText}>生成总结</Text>
            <Text style={styles.genHint}>日 / 周 / 月</Text>
          </Pressable>

          {notes.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>还没有小结</Text>
              <Text style={styles.emptyBody}>
                点上面的「生成总结」，AI 会把一天／一周／一个月{'\n'}
                记下的东西压成一段，存进时间轴对应的时间点。
              </Text>
            </View>
          ) : (
            notes.map((note) => {
              const open = openNote === note.id;
              return (
                <Pressable
                  key={note.id}
                  onPress={() => setOpenNote(open ? null : note.id)}
                  style={styles.noteCard}
                >
                  <View style={styles.noteHead}>
                    <Text style={styles.noteKind}>{NOTE_KIND[note.type] ?? '总结'}</Text>
                    <Text style={styles.noteDate}>
                      {periodLabel(note.period) || dayKey(note.createdAt)}
                    </Text>
                  </View>
                  <NoteBody
                    text={note.bodyMd}
                    numberOfLines={open ? undefined : 5}
                    style={styles.noteBody}
                  />
                  <Text style={styles.noteToggle}>{open ? '收起' : '展开'}</Text>
                </Pressable>
              );
            })
          )}
        </ScrollView>
      )}

      {sheetOpen ? (
        <SummarySheet
          onClose={() => setSheetOpen(false)}
          onSaved={async () => {
            await reload();
            await onChanged?.();
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.page },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12 },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: R.pill,
    backgroundColor: C.hairSoft,
  },
  tabActive: { backgroundColor: C.accentBg },
  tabText: { fontSize: 13.5, color: C.text2 },
  tabTextActive: { color: C.accentText, fontWeight: '600' },

  content: { paddingHorizontal: 16, paddingBottom: 28 },
  hint: { fontSize: 12, color: C.text3, marginTop: 18, marginBottom: 8 },

  empty: { alignItems: 'center', paddingTop: 90 },
  emptyTitle: { fontSize: 15, color: C.text2, fontWeight: '500' },
  emptyBody: { fontSize: 13, color: C.text3, textAlign: 'center', lineHeight: 21, marginTop: 10 },

  group: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.hair,
  },
  rowLast: { borderBottomWidth: 0 },
  check: { width: 20, alignItems: 'center' },
  todoText: { flex: 1, fontSize: 14, lineHeight: 21, color: C.text },
  doneText: { color: C.text3, textDecorationLine: 'line-through' },
  due: { fontSize: 11, color: C.text3 },

  mergedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 20,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  mergedLabel: { flex: 1, fontSize: 12, color: C.text3 },
  mergedText: { flex: 1, fontSize: 13, lineHeight: 20, color: C.text3 },
  mergedUndo: { fontSize: 12, color: C.accent },
  dueOverdue: { color: C.danger },

  genBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: R.card,
    backgroundColor: C.accentBg,
    marginBottom: 12,
  },
  genText: { flex: 1, fontSize: 14, color: C.accentText, fontWeight: '500' },
  genHint: { fontSize: 11, color: C.accentText, opacity: 0.7 },

  noteCard: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    padding: 14,
    marginBottom: 10,
  },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  noteKind: { fontSize: 11, color: C.accentText, fontWeight: '500' },
  noteDate: { fontSize: 11, color: C.text3, fontVariant: ['tabular-nums'] },
  noteBody: { fontSize: 14, lineHeight: 23, color: C.text },
  noteToggle: { fontSize: 12, color: C.accent, marginTop: 9 },
});
