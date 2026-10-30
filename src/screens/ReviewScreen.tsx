import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { DONE_TODO_KEEP } from '../types';
import type { Note, Todo } from '../types';
import { R, useThemedStyles, type Palette } from '../theme';
import { repo } from '../db/repo';
import { dayKey, periodLabel } from '../util/date';
import { NoteBody } from '../components/NoteBody';
import { NoteViewer } from '../components/NoteViewer';
import { SummarySheet } from '../components/SummarySheet';
import { TagPanel } from '../components/TagPanel';
import { ScreenHeader } from '../components/ScreenHeader';
import { NOTE_GROUP_LABEL, groupNotes } from '../util/digest';

interface Props {
  onClose: () => void;
  /** 数据变了（新存了一条总结），通知上层刷新时间轴 */
  onChanged?: () => void | Promise<void>;
}

type Tab = 'todo' | 'note' | 'tag';

/**
 * 小结的粒度筛选。
 *
 * 以前小结只有一种排法：按月→周→日分组全铺开。日小结攒到几十篇之后，
 * 想找上个月的月总结得一直往下翻，而且「周总结压在日小结上面」这件事
 * 在只有一种粒度的时候反而看不出来。
 * 'all' 保留原来的分组混排，选具体粒度时就只留那一种、按时间倒序。
 */
type NoteFilter = 'all' | 'daily' | 'weekly' | 'monthly';

const NOTE_FILTERS: { key: NoteFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'daily', label: '日' },
  { key: 'weekly', label: '周' },
  { key: 'monthly', label: '月' },
];

/** 到期日只显示月-日；早于今天标红 */
function dueLabel(dueAt: string | null): { text: string; overdue: boolean } | null {
  if (!dueAt) return null;
  return { text: dueAt.slice(5).replace('-', '/'), overdue: dueAt < dayKey(Date.now()) };
}

export function ReviewScreen({ onClose, onChanged }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [tab, setTab] = useState<Tab>('todo');
  const [todos, setTodos] = useState<Todo[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  /** 被合并掉的待办。合并是隐藏不是删除，这里必须有入口，否则就是数据黑洞 */
  const [merged, setMerged] = useState<Todo[]>([]);
  const [showMerged, setShowMerged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [noteFilter, setNoteFilter] = useState<NoteFilter>('all');
  /** 阅读器停在第几篇。下标是**筛选后**的数组，不是 notes 的下标 */
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
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

  const shownNotes =
    noteFilter === 'all' ? notes : notes.filter((n) => n.type === noteFilter);

  /** 空态文案要用它。'all' 时兜底成「小结」，不然下标会拿到 undefined */
  const filterLabel = noteFilter === 'all' ? '小结' : NOTE_GROUP_LABEL[noteFilter];

  /*
   * 阅读器开着的时候如果数据变了（保存了新小结、删了旧的），下标可能越过新长度。
   * 不处理的话 NoteViewer 拿不到 note 会直接不渲染，用户看到一片空白且关不掉。
   */
  useEffect(() => {
    if (viewerIndex !== null && viewerIndex >= shownNotes.length) setViewerIndex(null);
  }, [viewerIndex, shownNotes.length]);

  /*
   * 'all' 走原来的分组（月 → 周 → 日 → 主题）；
   * 选了具体粒度就只剩一种，再套一层组标题是废话，直接平铺。
   */
  const noteGroups =
    noteFilter === 'all'
      ? groupNotes(shownNotes)
      : shownNotes.length
        ? [
            {
              kind: noteFilter as Note['type'],
              label: NOTE_GROUP_LABEL[noteFilter],
              notes: shownNotes,
            },
          ]
        : [];

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
          ['tag', '标签'],
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
          <ActivityIndicator color={c.accent} />
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
                          pressed && { backgroundColor: c.hairSoft },
                        ]}
                      >
                        <View style={styles.check}>
                          <Ionicons name="ellipse-outline" size={20} color={c.text3} />
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
                  <Text style={styles.hint}>
                    已完成 {finished.length} 条 · 只保留最近 {DONE_TODO_KEEP} 条
                  </Text>
                  <View style={styles.group}>
                    {finished.map((item, i) => (
                      <Pressable
                        key={item.id}
                        onPress={() => toggle(item)}
                        style={({ pressed }) => [
                          styles.row,
                          i === finished.length - 1 && styles.rowLast,
                          pressed && { backgroundColor: c.hairSoft },
                        ]}
                      >
                        <View style={styles.check}>
                          <Ionicons name="checkmark-circle" size={20} color={c.accent} />
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
                    <Ionicons name="git-merge-outline" size={16} color={c.text3} />
                    <Text style={styles.mergedLabel}>已合并 {merged.length} 条</Text>
                    <Ionicons
                      name={showMerged ? 'chevron-up' : 'chevron-down'}
                      size={13}
                      color={c.text3}
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
      ) : tab === 'tag' ? (
        <TagPanel onChanged={onChanged} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Pressable
            style={({ pressed }) => [styles.genBtn, pressed && { backgroundColor: c.accentBg }]}
            onPress={() => setSheetOpen(true)}
          >
            <Ionicons name="sparkles-outline" size={17} color={c.accentText} />
            <Text style={styles.genText}>生成总结</Text>
            <Text style={styles.genHint}>日 / 周 / 月</Text>
          </Pressable>

          {/*
            粒度筛选。数量标在胶囊上，空的那档不标数字 ——
            标个 0 只会让人想点进去看个空页面。
          */}
          <View style={styles.noteFilterRow}>
            {NOTE_FILTERS.map((f) => {
              const on = noteFilter === f.key;
              const n =
                f.key === 'all' ? notes.length : notes.filter((x) => x.type === f.key).length;
              return (
                <Pressable
                  key={f.key}
                  onPress={() => setNoteFilter(f.key)}
                  style={[styles.noteFilterChip, on && styles.noteFilterChipOn]}
                >
                  <Text style={[styles.noteFilterText, on && styles.noteFilterTextOn]}>
                    {f.label}
                  </Text>
                  {n > 0 ? (
                    <Text style={[styles.noteFilterCount, on && styles.noteFilterCountOn]}>
                      {n}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>

          {notes.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>还没有小结</Text>
              <Text style={styles.emptyBody}>
                点上面的「生成总结」，AI 会把一天／一周／一个月{'\n'}
                记下的东西压成一段，存进时间轴对应的时间点。
              </Text>
            </View>
          ) : shownNotes.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>还没有{filterLabel}</Text>
              <Text style={styles.emptyBody}>
                换个粒度看看，或者点上面的「生成总结」写一篇。
              </Text>
            </View>
          ) : (
            noteGroups.map((group) => (
              <View key={group.kind}>
                {noteFilter === 'all' ? (
                  <View style={styles.noteGroupHead}>
                    <Text style={styles.noteGroupTitle}>{group.label}</Text>
                    <Text style={styles.noteGroupCount}>{group.notes.length} 篇</Text>
                  </View>
                ) : null}
                {group.notes.map((note) => (
                  <Pressable
                    key={note.id}
                    onPress={() => setViewerIndex(shownNotes.indexOf(note))}
                    style={({ pressed }) => [styles.noteCard, pressed && { opacity: 0.7 }]}
                  >
                    <View style={styles.noteHead}>
                      <Text style={styles.noteKind}>{NOTE_GROUP_LABEL[note.type]}</Text>
                      <Text style={styles.noteDate}>
                        {periodLabel(note.period) || dayKey(note.createdAt)}
                      </Text>
                      <Text style={styles.noteChars}>
                        {note.bodyMd.replace(/\s/g, '').length} 字
                      </Text>
                    </View>
                    <NoteBody text={note.bodyMd} numberOfLines={4} style={styles.noteBody} />
                    <View style={styles.noteOpenRow}>
                      <Text style={styles.noteToggle}>点击查看全文</Text>
                      <Ionicons name="chevron-forward" size={12} color={c.accent} />
                    </View>
                  </Pressable>
                ))}
              </View>
            ))
          )}
        </ScrollView>
      )}

      {/*
        阅读器拿的是 shownNotes —— 滑动的范围必须和当前筛选一致。
        传 notes 的话，在「月」筛选下左右滑会滑进日小结里。
      */}
      {viewerIndex !== null ? (
        <NoteViewer
          notes={shownNotes}
          initialIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      ) : null}

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

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.page },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12 },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: R.pill,
    backgroundColor: c.hairSoft,
  },
  tabActive: { backgroundColor: c.accentBg },
  tabText: { fontSize: 13.5, color: c.text2 },
  tabTextActive: { color: c.accentText, fontWeight: '600' },

  content: { paddingHorizontal: 16, paddingBottom: 28 },
  hint: { fontSize: 12, color: c.text3, marginTop: 18, marginBottom: 8 },

  empty: { alignItems: 'center', paddingTop: 90 },
  emptyTitle: { fontSize: 15, color: c.text2, fontWeight: '500' },
  emptyBody: { fontSize: 13, color: c.text3, textAlign: 'center', lineHeight: 21, marginTop: 10 },

  group: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  rowLast: { borderBottomWidth: 0 },
  check: { width: 20, alignItems: 'center' },
  todoText: { flex: 1, fontSize: 14, lineHeight: 21, color: c.text },
  doneText: { color: c.text3, textDecorationLine: 'line-through' },
  due: { fontSize: 11, color: c.text3 },

  mergedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 20,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  mergedLabel: { flex: 1, fontSize: 12, color: c.text3 },
  mergedText: { flex: 1, fontSize: 13, lineHeight: 20, color: c.text3 },
  mergedUndo: { fontSize: 12, color: c.accent },
  dueOverdue: { color: c.danger },

  genBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: R.card,
    backgroundColor: c.accentBg,
    marginBottom: 12,
  },
  genText: { flex: 1, fontSize: 14, color: c.accentText, fontWeight: '500' },
  genHint: { fontSize: 11, color: c.accentText, opacity: 0.7 },

  noteFilterRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  noteFilterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: R.pill,
    backgroundColor: c.hairSoft,
  },
  noteFilterChipOn: { backgroundColor: c.accentBg },
  noteFilterText: { fontSize: 12.5, color: c.text2 },
  noteFilterTextOn: { color: c.accentText, fontWeight: '600' },
  noteFilterCount: { fontSize: 10.5, color: c.text3, fontVariant: ['tabular-nums'] },
  noteFilterCountOn: { color: c.accentText, opacity: 0.75 },

  noteGroupHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    paddingHorizontal: 2,
    marginTop: 16,
    marginBottom: 8,
  },
  noteGroupTitle: { fontSize: 12, color: c.text2, fontWeight: '600' },
  noteGroupCount: { fontSize: 11, color: c.text3 },

  noteCard: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    padding: 14,
    marginBottom: 10,
  },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  noteKind: { flex: 1, fontSize: 11, color: c.accentText, fontWeight: '500' },
  noteDate: { fontSize: 11, color: c.text3, fontVariant: ['tabular-nums'] },
  noteChars: { fontSize: 10.5, color: c.text3, fontVariant: ['tabular-nums'] },
  noteBody: { fontSize: 14, lineHeight: 23, color: c.text },
  noteOpenRow: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 9 },
  noteToggle: { fontSize: 12, color: c.accent },
});
