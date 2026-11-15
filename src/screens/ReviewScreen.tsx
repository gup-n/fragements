import { BusyIndicator as ActivityIndicator } from '../components/BusyIndicator';
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
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Note, Todo } from '../types';
import { SPACE, TYPE, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { repo } from '../db/repo';
import { dayKey, periodLabel } from '../util/date';
import { NOTE_GROUP_LABEL, groupNotes } from '../util/digest';
import { NoteBody } from '../components/NoteBody';
import { NoteViewer } from '../components/NoteViewer';
import { SummarySheet } from '../components/SummarySheet';
import { ScreenHeader } from '../components/ScreenHeader';
import { ChoiceChip } from '../components/ChoiceChip';
import { TodoEditor } from '../components/TodoEditor';
import { TodoPanel } from '../components/TodoPanel';

interface Props {
  /**
   * 作为底栏 tab 常驻（v0.20.6）。此时不画返回箭头 ——
   * 平级的四个页面互相之间没有「上一页」，顶部留一个返回会让人以为退得出去。
   */
  embedded?: boolean;
  onClose?: () => void;
  /** 数据变了（新存了一条总结、改动了待办），通知上层刷新时间轴 */
  onChanged?: () => void | Promise<void>;
}

type Tab = 'todo' | 'note';

/** 编辑层的目标。`todo` 为 null 表示新建，`parentId` 表示加到哪条下面 */
interface EditorTarget {
  todo: Todo | null;
  parentId: number | null;
}

export function ReviewScreen({ embedded = false, onClose, onChanged }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [tab, setTab] = useState<Tab>('todo');
  const [todos, setTodos] = useState<Todo[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  /** 被合并掉的待办。合并是隐藏不是删除，这里必须有入口，否则就是数据黑洞 */
  const [merged, setMerged] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  /** 阅读器停在第几篇 */
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editor, setEditor] = useState<EditorTarget | null>(null);

  const reload = useCallback(async () => {
    setLoadError('');
    try {
      const [t, n, m] = await Promise.all([repo.listTodos(), repo.listNotes(60), repo.listMergedTodos()]);
      setTodos(t); setNotes(n); setMerged(m);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '暂时没有读到数据，请重试');
    } finally { setLoading(false); }
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
    <View style={styles.root}><View style={styles.normalContent} importantForAccessibility={viewerIndex !== null || sheetOpen || editor !== null ? "no-hide-descendants" : "auto"}>
      <ScreenHeader
        title="回顾"
        subtitle={loading ? '正在读取…' : loadError ? '暂时无法读取' : pending.length > 0 ? `${pending.length} 件事没做完` : '手头的事都做完了'}
        onBack={embedded ? undefined : onClose}
      />

      <View style={styles.tabs}>
        {([
          ['todo', `待办${pending.length ? ` ${pending.length}` : ''}`],
          ['note', '小结'],
        ] as [Tab, string][]).map(([key, label]) => (
          <View key={key} style={styles.tabSlot}>
            <ChoiceChip label={label} selected={tab === key} onPress={() => setTab(key)} role="tab" />
          </View>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.accent} />
        </View>
      ) : loadError ? (
        <View style={styles.center}>
          <Text style={styles.loadError} accessibilityLiveRegion="polite">{loadError}</Text>
          <Pressable style={[styles.genBtn, styles.touchTarget]} onPress={() => void reload()} accessibilityRole="button"><Text style={styles.genText}>重新读取</Text></Pressable>
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
            style={({ pressed }) => [[styles.genBtn, pressed && { backgroundColor: c.accentBg }], styles.touchTarget]}
            onPress={() => setSheetOpen(true)}
            accessibilityRole="button"
          >
            <Ionicons name="sparkles-outline" size={20} color={c.accentText} />
            <View style={styles.genCopy}>
              <Text style={styles.genText}>写月总结</Text>
              <Text style={styles.genHint}>一个月一篇</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={c.accentText} />
          </Pressable>

          {notes.length === 0 ? (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Ionicons name="sparkles-outline" size={22} color={c.text3} />
              </View>
              <Text style={styles.emptyTitle}>还没有总结</Text>
              <Text style={styles.emptyBody}>
                点上面的「写月总结」，AI 会把一个月记下的内容归纳成小结，存进时间轴。
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
                    style={({ pressed }) => [[styles.noteCard, pressed && { opacity: 0.7 }], styles.touchTarget]}
                  >
                    <Text style={styles.noteTitle}>
                      {periodLabel(note.period) || dayKey(note.createdAt)}
                    </Text>
                    <View style={styles.noteHead}>
                      <Text style={styles.noteKind}>{NOTE_GROUP_LABEL[note.type]}</Text>
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

      </View>
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

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  touchTarget: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight },
  normalContent: { flex: 1 },
  loadError: { ...TYPE.compact, color: c.danger, padding: SPACE.lg, textAlign: 'center' },
  root: { flex: 1, backgroundColor: c.page },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.md },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs, paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.xs, paddingBottom: SPACE.sm },
  tabSlot: { flex: 1, minWidth: 120 },
  content: { paddingHorizontal: metrics.pagePadding, paddingBottom: SPACE.lg },
  /** 空态规格（全项目统一）：48 圆 + 浅灰底 + 标题 18 + 说明 14 */
  empty: { alignItems: 'center', paddingTop: SPACE.xl, gap: SPACE.sm },
  emptyIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.hairSoft, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { ...TYPE.title, color: c.text, textAlign: 'center' },
  emptyBody: { ...TYPE.compact, color: c.text2, textAlign: 'center', maxWidth: 360 },
  /** 写月总结入口：淡蓝块，不描边 —— 一圈 accentHair 在淡蓝底上等于没有边界 */
  genBtn: {
    minWidth: metrics.controlHeight, minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
    paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderRadius: metrics.buttonRadius,
    backgroundColor: c.accentBg, marginBottom: SPACE.lg,
  },
  genCopy: { flex: 1, minWidth: 0, gap: 1 },
  genText: { ...TYPE.body, fontWeight: '600', color: c.accentText },
  genHint: { ...TYPE.meta, color: c.accentText },
  noteGroupHead: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: SPACE.xs, marginTop: SPACE.xxs, marginBottom: SPACE.xs },
  noteGroupTitle: { ...TYPE.label, color: c.text2 },
  noteGroupCount: { ...TYPE.meta, color: c.text2 },
  /** 小结卡：白底浮在浅灰页上就够分层，不描边 */
  noteCard: {
    backgroundColor: c.card, borderRadius: metrics.cardRadius,
    padding: SPACE.md, marginBottom: SPACE.sm,
  },
  noteTitle: { ...TYPE.title, color: c.text, marginBottom: SPACE.xxs },
  noteHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACE.xs, marginBottom: SPACE.xs },
  noteKind: { ...TYPE.meta, color: c.text2 },
  noteChars: { ...TYPE.meta, color: c.text2, fontVariant: ['tabular-nums'] },
  noteBody: { ...TYPE.body, color: c.text },
  noteOpenRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs, marginTop: SPACE.sm },
  noteToggle: { ...TYPE.label, color: c.accentText },
});
