import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Note, Todo } from '../types';
import { C, R } from '../theme';
import { repo } from '../db/repo';
import { dayKey } from '../util/date';

interface Props {
  onClose: () => void;
}

type Tab = 'todo' | 'note';

/** 到期日只显示月-日；早于今天标红 */
function dueLabel(dueAt: string | null): { text: string; overdue: boolean } | null {
  if (!dueAt) return null;
  return { text: dueAt.slice(5).replace('-', '/'), overdue: dueAt < dayKey(Date.now()) };
}

export function ReviewScreen({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>('todo');
  const [todos, setTodos] = useState<Todo[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [openNote, setOpenNote] = useState<number | null>(null);

  const reload = useCallback(async () => {
    const [t, n] = await Promise.all([repo.listTodos(), repo.listNotes(60)]);
    setTodos(t);
    setNotes(n);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function toggle(item: Todo) {
    await repo.toggleTodo(item.id, !item.done);
    await reload();
  }

  const pending = todos.filter((t) => !t.done);
  const finished = todos.filter((t) => t.done);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onClose} hitSlop={12} style={styles.back}>
          <Ionicons name="chevron-back" size={20} color={C.text} />
        </Pressable>
        <Text style={styles.title}>回顾</Text>
        <View style={{ width: 24 }} />
      </View>

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
                          <Ionicons name="ellipse-outline" size={19} color={C.text3} />
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
                          <Ionicons name="checkmark-circle" size={19} color={C.accent} />
                        </View>
                        <Text style={[styles.todoText, styles.doneText]}>{item.text}</Text>
                      </Pressable>
                    ))}
                  </View>
                </>
              )}
            </>
          )}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {notes.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>还没有小结</Text>
              <Text style={styles.emptyBody}>
                整理时勾选「今日小结」，{'\n'}AI 会把当天的事浓缩成一段存在这里。
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
                  <Text style={styles.noteDate}>
                    {note.period ?? dayKey(note.createdAt)}
                  </Text>
                  <Text style={styles.noteBody} numberOfLines={open ? undefined : 4}>
                    {note.bodyMd}
                  </Text>
                  <Text style={styles.noteToggle}>{open ? '收起' : '展开'}</Text>
                </Pressable>
              );
            })
          )}
        </ScrollView>
      )}
    </View>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: R.pill,
    backgroundColor: C.hairSoft,
  },
  tabActive: { backgroundColor: C.accentBg },
  tabText: { fontSize: 13, color: C.text2 },
  tabTextActive: { color: C.accentText, fontWeight: '500' },

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
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.hair,
  },
  rowLast: { borderBottomWidth: 0 },
  check: { width: 20, alignItems: 'center' },
  todoText: { flex: 1, fontSize: 14, lineHeight: 21, color: C.text },
  doneText: { color: C.text3, textDecorationLine: 'line-through' },
  due: { fontSize: 11, color: C.text3 },
  dueOverdue: { color: C.danger },

  noteCard: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    padding: 14,
    marginBottom: 10,
  },
  noteDate: { fontSize: 11, color: C.text3, marginBottom: 7, fontVariant: ['tabular-nums'] },
  noteBody: { fontSize: 13, lineHeight: 21, color: C.text },
  noteToggle: { fontSize: 12, color: C.accent, marginTop: 9 },
});
