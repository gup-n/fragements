/**
 * 回顾页：待办 / 小结。
 *
 * v0.15 的两处改动都在这一页上：
 *
 * 1. **小结只剩月**（用户 2026-11-10 要求删掉日、周）。原来的粒度筛选
 *    （全部 / 日 / 周 / 月）随之删掉 —— 只剩一种时，筛选器只是让人多点一下。
 * 2. **待办支持两层子项**，列表与勾选级联搬到 `TodoPanel`，编辑层是 `TodoEditor`。
 *    这一页只负责取数、切 tab、以及把两件事的通知接上。
 *
 * 数据仍然一次取齐（待办 + 小结 + 已合并），因为三个 tab 都靠 `reload()`
 * 保持一致；分开取会让「刚勾完的待办在另一个 tab 里还是旧状态」。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Note, Todo } from '../types';
import { R, useThemedStyles, type Palette } from '../theme';
import { repo } from '../db/repo';
import { dayKey, periodLabel } from '../util/date';
import { NOTE_GROUP_LABEL, groupNotes } from '../util/digest';
import { NoteBody } from '../components/NoteBody';
import { NoteViewer } from '../components/NoteViewer';
import { SummarySheet } from '../components/SummarySheet';
import { ScreenHeader } from '../components/ScreenHeader';
import { TodoEditor } from '../components/TodoEditor';
import { TodoPanel } from '../components/TodoPanel';

interface Props {
  onClose: () => void;
  /** 数据变了（新存了一条总结、改动了待办），通知上层刷新时间轴 */
  onChanged?: () => void | Promise<void>;
}

type Tab = 'todo' | 'note';

/** 编辑层的目标。`todo` 为 null 表示新建，`parentId` 表示加到哪条下面 */
interface EditorTarget {
  todo: Todo | null;
  parentId: number | null;
}

export function ReviewScreen({ onClose, onChanged }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [tab, setTab] = useState<Tab>('todo');
  const [todos, setTodos] = useState<Todo[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  /** 被合并掉的待办。合并是隐藏不是删除，这里必须有入口，否则就是数据黑洞 */
  const [merged, setMerged] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  /** 阅读器停在第几篇 */
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editor, setEditor] = useState<EditorTarget | null>(null);

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

  /*
   * 阅读器开着的时候如果数据变了（保存了新小结、删了旧的），下标可能越过新长度。
   * 不处理的话 NoteViewer 拿不到 note 会直接不渲染，用户看到一片空白且关不掉。
   */
  useEffect(() => {
    if (viewerIndex !== null && viewerIndex >= notes.length) setViewerIndex(null);
  }, [viewerIndex, notes.length]);

  // v0.15 只剩月总结，分组通常只有一组；留着 groupNotes 是为了兼容
  // 库里可能残留的「主题总结」，那类旧数据也要照常读得到
  const noteGroups = groupNotes(notes);

  /*
   * 顶层未完成数。**不数子项** —— 子项是「这件事分几步」，把它算进
   * 「几件事没做完」会让一件拆成五步的事变成五件，页头上那个数字就没意义了。
   */
  const pending = todos.filter((t) => !t.done && t.parentId === null);

  const editorParent =
    editor?.parentId != null ? todos.find((t) => t.id === editor.parentId) : null;

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="回顾"
        subtitle={pending.length > 0 ? `${pending.length} 件事没做完` : '手头的事都做完了'}
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
          <ActivityIndicator color={c.accent} />
        </View>
      ) : tab === 'todo' ? (
        <TodoPanel
          todos={todos}
          merged={merged}
          onReload={reload}
          onOpenEditor={(todo, parentId) => setEditor({ todo, parentId })}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Pressable
            style={({ pressed }) => [styles.genBtn, pressed && { backgroundColor: c.accentBg }]}
            onPress={() => setSheetOpen(true)}
          >
            <Ionicons name="sparkles-outline" size={17} color={c.accentText} />
            <Text style={styles.genText}>写月总结</Text>
            <Text style={styles.genHint}>一个月一篇</Text>
          </Pressable>

          {notes.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>还没有总结</Text>
              <Text style={styles.emptyBody}>
                点上面的「写月总结」，AI 会把一个月{'\n'}
                记下的东西压成一段，存进时间轴对应的时间点。
              </Text>
            </View>
          ) : (
            noteGroups.map((group) => (
              <View key={group.kind}>
                <View style={styles.noteGroupHead}>
                  <Text style={styles.noteGroupTitle}>{group.label}</Text>
                  <Text style={styles.noteGroupCount}>{group.notes.length} 篇</Text>
                </View>
                {group.notes.map((note) => (
                  <Pressable
                    key={note.id}
                    onPress={() => setViewerIndex(notes.indexOf(note))}
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

      {viewerIndex !== null ? (
        <NoteViewer
          notes={notes}
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

      {editor ? (
        <TodoEditor
          todo={editor.todo}
          parentId={editor.parentId}
          parentText={editorParent?.text}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            await reload();
            // 待办计数变了，时间轴页头的角标也要跟着更新
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

  empty: { alignItems: 'center', paddingTop: 90 },
  emptyTitle: { fontSize: 15, color: c.text2, fontWeight: '500' },
  emptyBody: { fontSize: 13, color: c.text3, textAlign: 'center', lineHeight: 21, marginTop: 10 },

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

  noteGroupHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    paddingHorizontal: 2,
    marginTop: 6,
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
