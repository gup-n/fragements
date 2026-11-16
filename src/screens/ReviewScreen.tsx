import { BusyIndicator as ActivityIndicator } from '../components/BusyIndicator';
/**
 * 回顾页：待办 / 日历 / 小结。
 *
 * 三件事各占一个 tab：
 *
 * 1. **待办**（v0.15 起支持两层子项）。列表与勾选级联在 `TodoPanel`，编辑层是 `TodoEditor`。
 * 2. **日历**（v0.22）：月视图 + 某一天的明细。参照 jotsy 的月历 ——
 *    格子只回答「这天有没有东西」，点开再看那天到底写了什么、哪几件到期。
 *    「回顾」这个名字本来就该先给一张时间地图，而不是一上来就是一列待办。
 * 3. **小结**：只剩月总结（v0.15 删掉了日/周）。
 *
 * 数据仍然一次取齐（待办 + 小结 + 已合并），因为三个 tab 都靠 `reload()`
 * 保持一致；分开取会让「刚勾完的待办在另一个 tab 里还是旧状态」。
 * 碎片由上层传进来（`fragments`）—— 日历要看「哪天记了东西」，
 * 这一页原来不持有碎片，是这一版唯一新增的数据依赖。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Fragment, Note, Todo } from '../types';
import { SPACE, TYPE, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { repo } from '../db/repo';
import { dayKey, daySubLabel, periodAnchor, periodLabel } from '../util/date';
import { NOTE_GROUP_LABEL, groupNotes, missingDigests, reviewSubtitle } from '../util/digest';
import { WEEKDAY_HEADS, keyToTs, monthCells, monthTitle, shiftMonth, type MonthRef } from '../util/calendar';
import { stripImageTokens } from '../util/inlineImages';
import { shortPreview } from '../util/text';
import { NoteBody } from '../components/NoteBody';
import { NoteViewer } from '../components/NoteViewer';
import { SummarySheet } from '../components/SummarySheet';
import { ScreenHeader } from '../components/ScreenHeader';
import { ChoiceChip } from '../components/ChoiceChip';
import { IconButton } from '../components/IconButton';
import { TodoEditor } from '../components/TodoEditor';
import { TodoPanel } from '../components/TodoPanel';
import { EmptyState } from '../components/EmptyState';

interface Props {
  /**
   * 作为底栏 tab 常驻（v0.20.6）。此时不画返回箭头 ——
   * 平级的四个页面互相之间没有「上一页」，顶部留一个返回会让人以为退得出去。
   */
  embedded?: boolean;
  onClose?: () => void;
  /** 切到设置页（App 的 tab 切换）。月总结面板缺 Key 时要一个真能点的入口 */
  onOpenSettings?: () => void;
  /** 数据变了（新存了一条总结、改动了待办），通知上层刷新时间轴 */
  onChanged?: () => void | Promise<void>;
  /** 全部碎片。日历用它标出「哪天记过东西」，也是点开某天后的明细来源 */
  fragments?: Fragment[];
}

type Tab = 'todo' | 'calendar' | 'note';

/** 编辑层的目标。`todo` 为 null 表示新建，`parentId` 表示加到哪条下面 */
interface EditorTarget {
  todo: Todo | null;
  parentId: number | null;
}

/**
 * 日历里「这一天有什么」。三个点各表一件事，都只算事实不算程度：
 * 有记录 / 有未完成的到期 / 有小结。
 */
interface DayMarks {
  frags: number;
  todos: number;
  notes: number;
}

function marksText(m: DayMarks): string {
  const bits = [
    m.frags ? `${m.frags} 条记录` : '',
    m.todos ? `${m.todos} 件到期` : '',
    m.notes ? `${m.notes} 篇小结` : '',
  ].filter(Boolean);
  return bits.length ? bits.join(' · ') : '这天没有内容';
}

export function ReviewScreen({ embedded = false, onClose, onChanged, onOpenSettings, fragments = [] }: Props) {
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
  /**
   * 月度总结面板要预选的月份。`undefined` = 没开；
   * 空串 = 开了但没有缺口（面板自己退到最近一个月）。
   */
  const [sheetPeriod, setSheetPeriod] = useState<string | undefined>(undefined);
  const sheetOpen = sheetPeriod !== undefined;
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

  /*
   * 还没写小结的月份。判据直接用 `util/digest.missingDigests`（月小结面板里的「待补」也是它），
   * 不在这里重写一遍「哪些月算缺」—— 重写就会和面板里的数字对不上。
   * 本月的碎片不算缺口：月份还没过完，写出来是半截。
   *
   * 取 3 条而不是 1 条：入口要能把人直接送到**最近那个缺口**，
   * 原来只数了总数，点进去却停在本月（本月通常一条碎片都没有）。
   */
  const backlog = useMemo(
    () => missingDigests(fragments, notes, 3),
    [fragments, notes],
  );

  return (
    <View style={styles.root}><View style={styles.normalContent} importantForAccessibility={viewerIndex !== null || sheetOpen || editor !== null ? "no-hide-descendants" : "auto"}>
      <ScreenHeader
        title="回顾"
        subtitle={
          loading
            ? '正在读取…'
            : loadError
              ? '暂时无法读取'
              : reviewSubtitle(pending.length, backlog.total)
        }
        onBack={embedded ? undefined : onClose}
      />

      <View style={styles.tabs}>
        {([
          ['todo', '待办'],
          ['calendar', '日历'],
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
      ) : tab === 'calendar' ? (
        <CalendarTab
          todos={todos}
          notes={notes}
          fragments={fragments}
          onToggle={async (todo) => {
            await repo.toggleTodo(todo.id, !todo.done);
            await reload();
            await onChanged?.();
          }}
          onOpenEditor={(todo) => setEditor({ todo, parentId: null })}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Pressable
            style={({ pressed }) => [[styles.genBtn, pressed && { backgroundColor: c.accentBg }], styles.touchTarget]}
            onPress={() => setSheetPeriod(backlog.items[0]?.period ?? '')}
            accessibilityRole="button"
            accessibilityLabel={
              backlog.total > 0
                ? `写月总结，最近没写的是${periodLabel(backlog.items[0]?.period ?? null)}`
                : '写月总结'
            }
          >
            <Ionicons name="sparkles-outline" size={20} color={c.accentText} />
            <View style={styles.genCopy}>
              <Text style={styles.genText}>写月总结</Text>
              {/*
                「一个月一篇」是恒定的事实，说一次就够了；这里换成会变的状态。
                点进去**直接停在最近那个缺口月**（v0.23）—— 原来固定停在本月，
                而本月通常一条碎片都没有，于是「3 个月还没写」点进去是一张空面板。
              */}
              <Text style={styles.genHint}>
                {backlog.total > 0 ? `${backlog.total} 个月还没写` : '一个月一篇'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={c.accentText} />
          </Pressable>

          {notes.length === 0 ? (
            <EmptyState
              icon="sparkles-outline"
              title="还没有总结"
              body="点上面的「写月总结」，AI 会把一个月记下的内容归纳成小结，存进时间轴。"
            />
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
                    <NoteBody text={note.bodyMd} numberOfLines={3} style={styles.noteBody} />
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
          initialPeriod={sheetPeriod || undefined}
          onOpenSettings={onOpenSettings}
          onClose={() => setSheetPeriod(undefined)}
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

/**
 * 日历 tab。
 *
 * 参考 jotsy：**月视图只做索引，明细放在下面**。格子里不放文字摘要 ——
 * 一个月 42 格里塞摘要，谁都看不清；但「这天有没有东西」必须一眼可见，
 * 所以用一排小点表示（记录 / 到期 / 小结各一种），点开某天才展开。
 *
 * 不做的两件事，写在这里免得下次又想起来：
 * - 年视图热力图：那是另一种读法（看一年），和「查某天」不是同一个动作；
 * - 农历 / 节假日：要一张每年都要维护的表，而这里记的是自己的事，不是日历软件。
 */
function CalendarTab({
  todos,
  notes,
  fragments,
  onToggle,
  onOpenEditor,
}: {
  todos: Todo[];
  notes: Note[];
  fragments: Fragment[];
  onToggle: (todo: Todo) => Promise<void>;
  onOpenEditor: (todo: Todo) => void;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  const todayKey = dayKey(Date.now());
  const [view, setView] = useState<MonthRef>(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });
  /** 选中的那一天。默认今天 —— 进日历第一眼应该看到「现在」 */
  const [picked, setPicked] = useState(todayKey);
  /**
   * 当天记录是否已展开。
   *
   * 默认只列三条：一天记十几条时，明细区会把下面的内容全推走。
   * v0.22.0 那行写的是「还有 N 条，去时间轴看」—— 一句话指了个去不了的地方，
   * 等于没有功能。现在点它就地展开，不再跨页。
   */
  const [allFrags, setAllFrags] = useState(false);

  const cells = useMemo(() => monthCells(view.year, view.month), [view.year, view.month]);

  /**
   * 每一天有什么。三份数据摊成一张表，格子渲染时只查一次 ——
   * 42 个格子各筛一遍 500 条碎片，滚起来会掉帧。
   */
  const byDay = useMemo(() => {
    const map = new Map<string, DayMarks>();
    const bump = (key: string, field: keyof DayMarks) => {
      const row = map.get(key) ?? { frags: 0, todos: 0, notes: 0 };
      row[field] += 1;
      map.set(key, row);
    };
    for (const f of fragments) bump(dayKey(f.createdAt), 'frags');
    // 已完成的不再标红：日历是「还要做什么」，不是「做过什么」
    for (const t of todos) if (t.dueAt && !t.done && t.mergedInto === null) bump(t.dueAt, 'todos');
    for (const n of notes) bump(dayKey(periodAnchor(n.period) ?? n.createdAt), 'notes');
    return map;
  }, [fragments, todos, notes]);

  /** 本月合计：记录条数、记了几天、还有几件到期。日历下面那一行 */
  const monthStat = useMemo(() => {
    const prefix = `${view.year}-${String(view.month).padStart(2, '0')}`;
    let frags = 0;
    let days = 0;
    let due = 0;
    for (const [key, row] of byDay) {
      if (!key.startsWith(prefix)) continue;
      frags += row.frags;
      if (row.frags > 0) days += 1;
      due += row.todos;
    }
    return { frags, days, due };
  }, [byDay, view.year, view.month]);

  const nowView = useMemo(() => {
    const d = new Date();
    return d.getFullYear() === view.year && d.getMonth() + 1 === view.month;
  }, [view.year, view.month]);

  const dayTs = keyToTs(picked);
  const dayTodo = useMemo(() => todos.filter((t) => t.dueAt === picked && t.mergedInto === null), [todos, picked]);
  const dayFrag = useMemo(() => fragments.filter((f) => dayKey(f.createdAt) === picked), [fragments, picked]);
  const dayNote = useMemo(
    () => notes.filter((n) => dayKey(periodAnchor(n.period) ?? n.createdAt) === picked),
    [notes, picked],
  );

  function pickCell(cell: (typeof cells)[number]) {
    setPicked(cell.key);
    setAllFrags(false);
    // 点到相邻月份补齐的那几天就跟着翻月，否则选中的日子不在视野里
    if (!cell.inMonth) setView({ year: cell.year, month: cell.month });
  }

  return (
    <ScrollView contentContainerStyle={styles.calContent}>
      <View style={styles.calHead}>
        <Text style={styles.calTitle}>{monthTitle(view)}</Text>
        <View style={styles.calNav}>
          {nowView ? null : (
            <Pressable
              onPress={() => {
                const d = new Date();
                setView({ year: d.getFullYear(), month: d.getMonth() + 1 });
                setPicked(todayKey);
              }}
              style={styles.calToday}
              hitSlop={CHECK_SLOP}
              accessibilityRole="button"
              accessibilityLabel="回到今天"
            >
              <Text style={styles.calTodayText}>今天</Text>
            </Pressable>
          )}
          <IconButton compact name="chevron-back" size={18} onPress={() => setView(shiftMonth(view, -1))} accessibilityLabel="上一月" />
          <IconButton compact name="chevron-forward" size={18} onPress={() => setView(shiftMonth(view, 1))} accessibilityLabel="下一月" />
        </View>
      </View>

      <View style={styles.calWeek}>
        {WEEKDAY_HEADS.map((w) => (
          <Text key={w} style={styles.weekHead}>{w}</Text>
        ))}
      </View>

      <View style={styles.calGrid}>
        {cells.map((cell) => {
          const marks = byDay.get(cell.key);
          const on = picked === cell.key;
          const isToday = todayKey === cell.key;
          return (
            <Pressable
              key={cell.key}
              style={styles.cellWrap}
              onPress={() => pickCell(cell)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${cell.month} 月 ${cell.day} 日${marks ? '，' + marksText(marks) : ''}`}
            >
              <View style={[styles.cell, on && styles.cellOn, isToday && !on && styles.cellToday]}>
                <Text
                  style={[
                    styles.cellDay,
                    !cell.inMonth && styles.cellDayOut,
                    on && styles.cellDayOn,
                  ]}
                >
                  {cell.day}
                </Text>
                <View style={styles.cellDots}>
                  {marks?.frags ? <View style={[styles.dot, { backgroundColor: on ? c.onAccent : c.text3 }]} /> : null}
                  {marks?.todos ? <View style={[styles.dot, { backgroundColor: on ? c.onAccent : c.accent }]} /> : null}
                  {marks?.notes ? <View style={[styles.dot, { backgroundColor: on ? c.onAccent : c.amberText }]} /> : null}
                </View>
              </View>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.calStat}>
        {monthStat.frags > 0
          ? `本月 ${monthStat.frags} 条记录 · 记了 ${monthStat.days} 天${monthStat.due ? ` · ${monthStat.due} 件到期` : ''}`
          : `本月还没有记录${monthStat.due ? ` · ${monthStat.due} 件到期` : ''}`}
      </Text>

      <View style={styles.dayPanel}>
        <View style={styles.dayHead}>
          <Text style={styles.dayTitle}>{daySubLabel(dayTs)}</Text>
          <Text style={styles.dayCount}>{marksText({ frags: dayFrag.length, todos: dayTodo.length, notes: dayNote.length })}</Text>
        </View>

        {dayTodo.map((todo) => (
          <View key={todo.id} style={styles.dayRow}>
            <Pressable
              onPress={() => void onToggle(todo)}
              style={styles.dayCheck}
              hitSlop={CHECK_SLOP}
              accessibilityRole="checkbox"
              accessibilityLabel={`完成状态：${todo.text}`}
              accessibilityState={{ checked: todo.done }}
            >
              <Ionicons
                name={todo.done ? 'checkmark-circle' : 'ellipse-outline'}
                size={19}
                color={todo.done ? c.accent : c.text2}
              />
            </Pressable>
            <Pressable style={styles.dayMain} onPress={() => onOpenEditor(todo)} accessibilityRole="button" accessibilityLabel={`编辑待办：${todo.text}`}>
              <Text style={[styles.dayText, todo.done && styles.dayTextDone]} numberOfLines={2}>{todo.text}</Text>
            </Pressable>
          </View>
        ))}

        {dayNote.map((note) => (
          <Text key={`n${note.id}`} style={styles.dayQuote} numberOfLines={2}>
            {periodLabel(note.period)}小结 · {note.bodyMd.replace(/[#*>\-\n]+/g, ' ').trim().slice(0, 60)}
          </Text>
        ))}

        {dayFrag.length ? (
          <View style={styles.dayFrags}>
            {(allFrags ? dayFrag.slice(0, DAY_FRAG_LIMIT) : dayFrag.slice(0, DAY_FRAG_PREVIEW)).map((f) => {
              const text = stripImageTokens(f.content).replace(/\s+/g, ' ').trim();
              return (
                <Text key={`f${f.id}`} style={styles.dayQuote} numberOfLines={2}>
                  {text ? shortPreview(text, 70) : `[${f.images.length} 张图]`}
                </Text>
              );
            })}
            {dayFrag.length > DAY_FRAG_PREVIEW ? (
              <Pressable
                onPress={() => setAllFrags((v) => !v)}
                style={styles.dayMoreWrap}
                hitSlop={CHECK_SLOP}
                accessibilityRole="button"
                accessibilityState={{ expanded: allFrags }}
                accessibilityLabel={allFrags ? '收起这天的记录' : `展开这天的其余 ${dayFrag.length - DAY_FRAG_PREVIEW} 条记录`}
              >
                <Text style={styles.dayMore}>
                  {allFrags
                    ? '收起'
                    : `展开其余 ${dayFrag.length - DAY_FRAG_PREVIEW} 条`}
                </Text>
              </Pressable>
            ) : null}
            {allFrags && dayFrag.length > DAY_FRAG_LIMIT ? (
              <Text style={styles.dayEmpty}>
                只列最近 {DAY_FRAG_LIMIT} 条，更早的请在时间轴里看。
              </Text>
            ) : null}
          </View>
        ) : null}

        {dayTodo.length === 0 && dayFrag.length === 0 && dayNote.length === 0 ? (
          <Text style={styles.dayEmpty}>这天没有记录，也没有到期的待办。</Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

const CHECK_SLOP = { top: 9, bottom: 9, left: 4, right: 4 };
/** 当天明细默认列几条，以及展开后最多列几条（再多就该去时间轴看了，但它得能点） */
const DAY_FRAG_PREVIEW = 3;
const DAY_FRAG_LIMIT = 30;

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  touchTarget: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight },
  normalContent: { flex: 1 },
  loadError: { ...TYPE.compact, color: c.danger, padding: SPACE.lg, textAlign: 'center' },
  root: { flex: 1, backgroundColor: c.page },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.md },
  /**
   * 三个 tab 平分一行。
   *
   * minWidth 从 120 降到 88：三个 tab × 120 在 360dp 的屏上放不下（328 可用），
   * flexWrap 会把「小结」折到第二行 —— 一行 chip 变成两行，页头下面白掉一截。
   */
  tabs: { flexDirection: 'row', gap: SPACE.xs, paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.xs, paddingBottom: SPACE.sm },
  tabSlot: { flex: 1, minWidth: 88 },
  content: { paddingHorizontal: metrics.pagePadding, paddingBottom: SPACE.lg },
  /** 空态规格（全项目统一）：48 圆 + 浅灰底 + 标题 18 + 说明 14 */
  /** 写月总结入口：淡蓝块，不描边 —— 一圈 accentHair 在淡蓝底上等于没有边界 */
  genBtn: {
    minWidth: metrics.controlHeight, minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
    paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderRadius: metrics.buttonRadius,
    backgroundColor: c.accentBg, marginBottom: SPACE.md,
  },
  genCopy: { flex: 1, minWidth: 0, gap: 1 },
  genText: { ...TYPE.body, fontWeight: '600', color: c.accentText },
  genHint: { ...TYPE.meta, color: c.accentText },
  noteGroupHead: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: SPACE.xs, marginBottom: 6 },
  noteGroupTitle: { ...TYPE.label, color: c.text2 },
  noteGroupCount: { ...TYPE.meta, color: c.text2 },
  /** 小结卡：白底浮在浅灰页上就够分层，不描边 */
  noteCard: {
    backgroundColor: c.card, borderRadius: metrics.cardRadius,
    padding: SPACE.md, marginBottom: SPACE.xs,
  },
  noteTitle: { ...TYPE.title, color: c.text, marginBottom: 2 },
  noteHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACE.xs, marginBottom: 6 },
  noteKind: { ...TYPE.meta, color: c.text2 },
  noteChars: { ...TYPE.meta, color: c.text2, fontVariant: ['tabular-nums'] },
  noteBody: { ...TYPE.compact, color: c.text },
  noteOpenRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs, marginTop: SPACE.xs },
  noteToggle: { ...TYPE.label, color: c.accentText },

  /* ---- 日历 ---- */
  calContent: { paddingHorizontal: metrics.pagePadding, paddingBottom: SPACE.lg },
  calHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, paddingTop: SPACE.xxs, paddingBottom: SPACE.xs },
  calTitle: { ...TYPE.title, flex: 1, minWidth: 0, color: c.text },
  calNav: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  calToday: { minHeight: 32, paddingHorizontal: SPACE.xs, justifyContent: 'center', borderRadius: metrics.buttonRadius },
  calTodayText: { ...TYPE.label, color: c.accentText },
  calWeek: { flexDirection: 'row', paddingBottom: 2 },
  weekHead: { ...TYPE.caption, flexBasis: '14.2857%', color: c.text3, textAlign: 'center' },
  /** 6 行 × 44：固定 42 格，翻月时高度不跳 */
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  cellWrap: { flexBasis: '14.2857%', height: 44, alignItems: 'center', justifyContent: 'center' },
  cell: {
    width: 38, height: 38, borderRadius: metrics.buttonRadius,
    alignItems: 'center', justifyContent: 'center',
  },
  /** 选中：实心主色 + 反白字。别只换个字色 —— 42 格里那点色差看不出来 */
  cellOn: { backgroundColor: c.accent },
  /** 今天：一圈主色细边。它和「选中」是两件事，可以同时成立（选中优先，实心更明显） */
  cellToday: { borderWidth: metrics.strokeWidth, borderColor: c.accentHair, backgroundColor: c.hairSoft },
  cellDay: { ...TYPE.label, color: c.text, fontVariant: ['tabular-nums'] },
  /**
   * 邻月的日子：靠颜色变淡，不靠透明度。
   *
   * 原来写的是 `color: c.text3, opacity: 0.45` —— 浅色下 text3 是 5.1:1，
   * 乘 0.45 之后只剩 2 出头；深色下更糊。它们**仍然可以点**（点一下就翻到那个月），
   * 不是装饰，得读得出来。字重从 600 掉回 400 已经够区分「不在本月」。
   */
  cellDayOut: { color: c.text3, fontWeight: '400' },
  cellDayOn: { color: c.onAccent, fontWeight: '700' },
  cellDots: { flexDirection: 'row', gap: 2, height: 4, marginTop: 1 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  calStat: { ...TYPE.meta, color: c.text3, marginTop: SPACE.xs, marginBottom: SPACE.sm },
  dayPanel: {
    backgroundColor: c.card, borderRadius: metrics.cardRadius,
    paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, gap: 2,
  },
  dayHead: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: SPACE.xs, marginBottom: SPACE.xxs },
  dayTitle: { ...TYPE.label, color: c.text },
  dayCount: { ...TYPE.meta, flex: 1, minWidth: 0, color: c.text3 },
  dayRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.xxs, paddingVertical: 2 },
  /** 19 的图标 + 9 的 hitSlop = 37 的触控区，配合整行 44 的可点高度够用 */
  dayCheck: { width: 26, height: 26, marginTop: -3, alignItems: 'center', justifyContent: 'center' },
  dayMain: { flex: 1, minWidth: 0, justifyContent: 'center' },
  dayText: { ...TYPE.compact, color: c.text },
  dayTextDone: { color: c.text2, textDecorationLine: 'line-through' },
  dayQuote: { ...TYPE.meta, color: c.text2, paddingVertical: 3 },
  dayFrags: { marginTop: 2 },
  /** 「展开其余 N 条」得能点：整行给 28 的可见高度，上下由 hitSlop 补 */
  dayMoreWrap: { minHeight: 28, justifyContent: 'center', alignSelf: 'flex-start' },
  dayMore: { ...TYPE.meta, color: c.accentText, paddingVertical: 3 },
  dayEmpty: { ...TYPE.meta, color: c.text3, paddingVertical: 6 },
});
