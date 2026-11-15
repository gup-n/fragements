/**
 * 待办列表：两层父子、勾选级联、多选合并。
 *
 * 数据与勾选逻辑都不在这里 —— 列表只负责「长什么样、点了调用谁」。
 * 父子怎么排序在 `util/todoTree.buildTodoTree`，勾一条会牵动谁在
 * `util/todoTree.planToggle`（repo 里执行）。这样同一套规则不会在
 * 界面和存储层各写一遍。
 *
 * 合并复用 `repo.mergeTodos`（隐藏而非删除），「已合并」区就是它的撤回入口 ——
 * 这条从 v0.3 就有的规矩不能因为列表改版而丢。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { IconButton } from './IconButton';
import { DONE_TODO_KEEP } from '../types';
import type { Todo } from '../types';
import { repo } from '../db/repo';
import { buildTodoTree, openChildCount, orphanTodos, type TodoNode } from '../util/todoTree';
import { dayKey } from '../util/date';
import { useKeyboardHeight } from '../util/keyboard';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';

interface Props {
  todos: Todo[];
  /** 被合并掉的条目，「已合并」区用 */
  merged: Todo[];
  onReload: () => void | Promise<void>;
  /** 打开编辑层。todo 为 null 表示新建，parentId 用于「加到某条下面」 */
  onOpenEditor: (todo: Todo | null, parentId: number | null) => void;
}

/** 到期日只显示月/日；早于今天标红 */
function dueLabel(dueAt: string | null): { text: string; overdue: boolean } | null {
  if (!dueAt) return null;
  return { text: dueAt.slice(5).replace('-', '/'), overdue: dueAt < dayKey(Date.now()) };
}

/**
 * 勾选框四周补出来的触控区。
 *
 * 看得见的勾选框是 28（列表密度要的就是这个数），上下补 10 ——
 * 一行 33 高，补完就是 48 高，手指点得准。左右只补 4：
 * 再往外就压到正文上了，点开头几个字会变成勾选。
 */
const CHECK_SLOP = { top: 10, bottom: 10, left: 4, right: 4 };

export function TodoPanel({ todos, merged, onReload, onOpenEditor }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const keyboardHeight = useKeyboardHeight();

  /** 多选合并模式。只允许选顶层 —— 子项并进另一条之后 parentId 指向谁没有意义 */
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeText, setMergeText] = useState('');
  const [showMerged, setShowMerged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 折叠的父项。默认全展开 —— 有子项的条目通常就那么几条 */
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  // 退出选择模式时把勾选清掉，否则下次进来还挂着上一轮的选择
  useEffect(() => {
    if (!selecting) setPicked(new Set());
  }, [selecting]);

  /*
   * 合并层是覆盖在列表上的，返回键必须先在它自己身上消化掉 ——
   * 否则按一下直接退回时间轴，而合并层还开着，用户会以为「点了返回没反应」。
   */
  useEffect(() => {
    if (!mergeOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setMergeOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [mergeOpen]);

  /*
   * 孤儿（父项已被合并或删掉、自己还挂在那个 id 下）当顶层显示。
   * `buildTodoTree` 只返回 parentId 为 null 的，孤儿不在其中 —— 不补这一步，
   * 它们就是「数据还在、界面上看不见、也勾不掉」。
   */
  const tree = useMemo(() => {
    const roots = buildTodoTree(todos);
    const orphans = orphanTodos(todos).map((todo) => ({ todo, children: [] as Todo[] }));
    return [...roots, ...orphans];
  }, [todos]);
  const pending = tree.filter((n) => !n.todo.done);
  const finished = tree.filter((n) => n.todo.done);

  const toggle = useCallback(
    async (item: Todo) => {
      try {
        await repo.toggleTodo(item.id, !item.done);
        await onReload();
      } catch (e) {
        setError(e instanceof Error ? e.message : '没勾上，再试一次');
      }
    },
    [onReload],
  );

  const pick = useCallback((id: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleCollapse = useCallback((id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function openMerge() {
    if (picked.size < 2) return;
    /*
     * 默认拿**第一个被勾选的**那条文字当结果，而不是列表里最靠前的。
     * 保留项（keepId）也是这个 id —— 两者必须同一口径，
     * 否则输入框里写的是 A、实际被合并进去的是 B，用户看不出差别。
     */
    const keepId = Array.from(picked)[0];
    const keep = todos.find((t) => t.id === keepId);
    setMergeText(keep?.text ?? '');
    setMergeOpen(true);
    setError('');
  }

  async function confirmMerge() {
    if (busy) return;
    const body = mergeText.trim();
    if (!body) {
      setError('合并后的待办不能是空的');
      return;
    }
    // picked 是 Set，插入顺序就是勾选顺序，第一条当保留项
    const ids = Array.from(picked);
    const keepId = ids[0];
    if (keepId === undefined) return;

    setBusy(true);
    setError('');
    try {
      await repo.mergeTodos(keepId, ids, body);
      await onReload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '没合并成，再试一次');
      setBusy(false);
      return;
    }
    setBusy(false);
    setMergeOpen(false);
    setSelecting(false);
  }

  async function unmerge(item: Todo) {
    if (item.mergedInto === null) return;
    await repo.unmergeTodos(item.mergedInto);
    await onReload();
  }

  /**
   * 一行待办。
   *
   * 2026-11-15 重排：[勾选框][正文 + 一行小字][两个紧凑图标] 挤在**同一行**里。
   * 原来正文独占一整行、图标另起一行，而图标按钮各占 48 高 ——
   * 一条待办因此在列表里长到 96 以上，三条就占满一屏。用户的原话是
   * 「代办和待办之间隔得非常开」「一个待办占用的空间非常大」。
   *
   * 交付物没变：进度、到期、展开步骤、加子项都还在，只是不再各占一行。
   */
  function renderRow(node: TodoNode, depth: number) {
    const { todo, children } = node;
    const due = dueLabel(todo.dueAt);
    const progress = openChildCount(node);
    const selected = picked.has(todo.id);
    const folded = collapsed.has(todo.id);
    /*
     * 进度和到期合成一行小字。原来它们是两行（各带 marginTop），
     * 一条带子项的待办因此比同级高出将近一行 —— 而这两条信息都很短，
     * 「3/5 步 · 到期 11/20」一行读得完。
     */
    const meta = [
      progress.total > 0 ? `${progress.total - progress.open}/${progress.total} 步` : '',
      due ? `${due.overdue && !todo.done ? '已逾期 ' : '到期 '}${due.text}` : '',
    ].filter(Boolean).join(' · ');
    const overdue = !!due && due.overdue && !todo.done;
    return (
      <View key={todo.id}>
        <View style={[styles.row, depth > 0 && styles.rowChild]}>
          {selecting && depth > 0 ? <View style={styles.checkGap} /> : (
            <Pressable
              onPress={() => selecting ? pick(todo.id) : void toggle(todo)}
              style={styles.checkHit}
              hitSlop={CHECK_SLOP}
              accessibilityRole="checkbox"
              accessibilityLabel={`${selecting ? '合并选择' : '完成状态'}：${todo.text}`}
              accessibilityState={{ checked: selecting ? selected : todo.done }}
            >
              <Ionicons
                name={(selecting ? selected : todo.done) ? 'checkmark-circle' : 'ellipse-outline'}
                size={depth > 0 ? 18 : 20}
                color={(selecting ? selected : todo.done) ? c.accent : c.text2}
              />
            </Pressable>
          )}
          <Pressable
            style={styles.main}
            onPress={() => selecting ? pick(todo.id) : onOpenEditor(todo, null)}
            disabled={selecting && depth > 0}
            accessibilityRole="button"
            accessibilityLabel={`${selecting ? '选择' : '编辑待办'}：${todo.text}`}
            accessibilityState={{ disabled: selecting && depth > 0 }}
          >
            <Text
              style={[styles.text, depth > 0 && styles.textChild, todo.done && styles.doneText]}
              numberOfLines={3}
            >
              {todo.text}
            </Text>
            {meta ? (
              <Text style={[styles.sub, overdue && styles.dueOverdue]} numberOfLines={1}>
                {meta}
              </Text>
            ) : null}
          </Pressable>
          {!selecting && (progress.total > 0 || (depth === 0 && !todo.done)) ? (
            <View style={styles.rowTools}>
              {progress.total > 0 ? (
                <IconButton compact name={folded ? 'chevron-down' : 'chevron-up'} size={17} onPress={() => toggleCollapse(todo.id)} accessibilityLabel={`${folded ? '展开' : '收起'}步骤：${todo.text}`} accessibilityState={{ expanded: !folded }} />
              ) : null}
              {depth === 0 && !todo.done ? (
                <IconButton compact name="add" size={18} onPress={() => onOpenEditor(null, todo.id)} accessibilityLabel={`添加子项：${todo.text}`} />
              ) : null}
            </View>
          ) : null}
        </View>
        {!folded ? children.map((child) => renderRow({ todo: child, children: [] }, depth + 1)) : null}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView importantForAccessibility={mergeOpen ? "no-hide-descendants" : "auto"} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {todos.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Ionicons name="checkbox-outline" size={22} color={c.text3} />
            </View>
            <Text style={styles.emptyTitle}>还没有待办</Text>
            <Text style={styles.emptyBody}>
              整理时会挑出「有明确动作」的碎片，也可以直接新建一条。
            </Text>
            <Pressable style={[[styles.toolBtn, { marginTop: SPACE.xs }], styles.touchTarget]} onPress={() => onOpenEditor(null, null)} accessibilityRole="button"><Ionicons name="add" size={18} color={c.accentText} /><Text style={styles.toolText}>新建待办</Text></Pressable>
          </View>
        ) : (
          <>
            <View style={styles.toolbar}>
              <Pressable
                style={({ pressed }) => [[styles.toolBtn, pressed && { backgroundColor: c.hairSoft }], styles.touchTarget]}
                onPress={() => onOpenEditor(null, null)}
              >
                <Ionicons name="add" size={15} color={c.accentText} />
                <Text style={styles.toolText}>新建</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [[
                  styles.toolBtn,
                  selecting && styles.toolBtnOn,
                  pressed && !selecting && { backgroundColor: c.hairSoft },
                ], styles.touchTarget]}
                onPress={() => setSelecting((v) => !v)} accessibilityRole="button" accessibilityState={{ selected: selecting }}
              >
                <Ionicons name="git-merge-outline" size={15} color={selecting ? c.onAccent : c.accentText} />
                <Text style={[styles.toolText, selecting && styles.toolTextOn]}>{selecting ? '完成' : '合并'}</Text>
              </Pressable>
            </View>

            {selecting ? (
              <Text style={styles.selectHint}>
                勾选要合并的几条（只算顶层），再写下合并后的那一句。
              </Text>
            ) : null}

            {pending.length > 0 ? (
              <>
                <Text style={styles.groupTitle}>未完成 · {pending.length} 件</Text>
                <View style={styles.group}>{pending.map((n) => renderRow(n, 0))}</View>
              </>
            ) : (
              <View style={styles.allDone}>
                <Ionicons name="checkmark-circle-outline" size={28} color={c.text2} />
                <Text style={styles.allDoneTitle}>手头的事都做完了</Text>
              </View>
            )}

            {finished.length > 0 ? (
              <>
                <Text style={styles.hint}>
                  已完成 {finished.length} 条 · 只保留最近 {DONE_TODO_KEEP} 条
                </Text>
                <View style={styles.group}>{finished.map((n) => renderRow(n, 0))}</View>
              </>
            ) : null}

            {merged.length > 0 ? (
              <>
                <Pressable style={[styles.mergedBar, styles.touchTarget]} onPress={() => setShowMerged((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: showMerged }}>
                  <Ionicons name="git-merge-outline" size={16} color={c.text3} />
                  <Text style={styles.mergedLabel}>已合并 {merged.length} 条</Text>
                  <Ionicons
                    name={showMerged ? 'chevron-up' : 'chevron-down'}
                    size={13}
                    color={c.text3}
                  />
                </Pressable>
                {showMerged ? (
                  <View style={styles.group}>
                    {merged.map((item, i) => (
                      <View
                        key={item.id}
                        style={[styles.row, i === merged.length - 1 && styles.rowLast]}
                      >
                        <Text style={styles.mergedText}>{item.text}</Text>
                        <Pressable onPress={() => void unmerge(item)} style={[styles.toolBtn, styles.touchTarget]} accessibilityRole="button" accessibilityLabel={`恢复待办：${item.text}`}>
                          <Text style={styles.mergedUndo}>恢复</Text>
                        </Pressable>
                      </View>
                    ))}
                  </View>
                ) : null}
              </>
            ) : null}

            {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
          </>
        )}
      </ScrollView>

      {/*
        选择模式的底部条。不贴在页面最底而是浮在列表上，
        是因为「已选 N 条」必须和列表同时可见 —— 看不到选了哪几条就没法确认。
      */}
      {selecting ? (
        <View style={styles.selectBar}>
          <Text style={styles.selectCount}>
            {picked.size > 0 ? `已选 ${picked.size} 条` : '还没选'}
          </Text>
          <Pressable
            accessibilityRole="button" accessibilityState={{ disabled: picked.size < 2 }} style={[[styles.mergeBtn, picked.size < 2 && styles.btnDisabled], styles.touchTarget]}
            onPress={openMerge}
            disabled={picked.size < 2}
          >
            <Text style={styles.mergeText2}>合并</Text>
          </Pressable>
        </View>
      ) : null}

      {mergeOpen ? (
        <View style={styles.sheet} accessibilityViewIsModal>
          <Pressable style={[styles.backdrop, styles.touchTarget]} onPress={() => setMergeOpen(false)} />
          <ScrollView style={[styles.sheetCard, { marginBottom: keyboardHeight }]} contentContainerStyle={styles.sheetCardContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.sheetTitle}>合并后的待办</Text>
            <Text style={styles.sheetHint}>
              其余 {Math.max(picked.size - 1, 0)} 条会从列表里消失，在「已合并」里可以恢复。
            </Text>
            <TextInput
              style={styles.input}
              value={mergeText}
              onChangeText={(v) => {
                setMergeText(v);
                if (error) setError('');
              }}
              placeholder="一句话说清这件事"
              placeholderTextColor={c.text3}
              multiline
              autoFocus
              maxLength={200}
            />
            {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
            <View style={styles.sheetFooter}>
              <Pressable
                style={[styles.ghostBtn, styles.touchTarget]}
                onPress={() => setMergeOpen(false)}
                disabled={busy}
              >
                <Text style={styles.ghostText}>返回</Text>
              </Pressable>
              <Pressable
                style={[[styles.primaryBtn, busy && styles.btnDisabled], styles.touchTarget]}
                onPress={confirmMerge}
                disabled={busy}
              >
                <Text style={styles.primaryText}>合并</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  touchTarget: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight },
  root: { flex: 1 },
  content: { paddingHorizontal: metrics.pagePadding, paddingBottom: SPACE.xl },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs, paddingBottom: SPACE.xs },
  /** 工具按钮：淡蓝底、无边框。原来还套一圈 accentHair，在淡蓝底上等于没有边界 */
  toolBtn: {
    minWidth: metrics.controlHeight, minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs,
    paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: metrics.buttonRadius,
    backgroundColor: c.accentBg,
  },
  /**
   * 「完成」= 正处于合并选择模式。
   *
   * 原来这个态用 `borderColor: c.focus`（墨水主题是纯黑）表示，而其余样式和
   * 普通态一样 —— 于是「进入选择模式」唯一的信号就是一圈黑框。
   * 现在用实心主色底 + 反白字，按钮本身变成一个明确的「退出」动作。
   */
  toolBtnOn: { backgroundColor: c.accent },
  toolText: { ...TYPE.label, color: c.accentText },
  toolTextOn: { color: c.onAccent },
  selectHint: { ...TYPE.compact, color: c.text2, marginBottom: SPACE.xs },
  /** 空态规格（全项目统一）：48 圆 + 浅灰底 + 标题 18 + 说明 14 */
  empty: { alignItems: 'center', paddingTop: SPACE.xl, gap: SPACE.sm },
  emptyIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.hairSoft, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { ...TYPE.title, color: c.text, textAlign: 'center' },
  emptyBody: { ...TYPE.compact, color: c.text2, textAlign: 'center', maxWidth: 360 },
  groupTitle: { ...TYPE.label, color: c.text2, marginBottom: 6 },
  /** 分组：白卡浮在浅灰页上，不描边；行间靠 0.5 的分隔线 */
  group: { backgroundColor: c.card, borderRadius: metrics.cardRadius, overflow: 'hidden' },
  /**
   * 一行待办。
   *
   * paddingVertical 6 而不是 8：行与行之间本来就有 0.5 的分隔线和勾选框的
   * hitSlop，再给 8+8 就是「一句话后面空出半行」。6+6 读起来是一张紧凑的清单。
   */
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 4, paddingHorizontal: SPACE.xs, paddingVertical: 6,
    borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair,
  },
  /** 子项只有缩进与细分隔，不再单独套一张卡。 */
  rowChild: { paddingLeft: SPACE.md, backgroundColor: c.hairSoft },
  rowLast: { borderBottomWidth: 0 },
  /** 28 的勾选框 + 10 的 hitSlop = 48 的触控区。别再给它套 touchTarget，那会把它撑回 48 的实心槽 */
  checkHit: { width: 28, height: 28, marginTop: -2, alignItems: 'center', justifyContent: 'center' },
  /** 选择模式下子项不显示勾选框，留同样宽的空位，父项和子项的正文才对齐 */
  checkGap: { width: 28 },
  main: { flex: 1, minWidth: 0, justifyContent: 'center', paddingVertical: 1 },
  /** 图标挤在同一行右侧，不再另起一行 —— 另起一行时它们各占 48，行高直接翻倍 */
  rowTools: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: -4 },
  /** 待办是列表，compact 比正文更紧凑；一行能多看见一条就是收益 */
  text: { ...TYPE.compact, color: c.text },
  /**
   * 子项小一号。原来父项和子项都是 14/21，唯一的区别只有左边的缩进和一层淡底，
   * 用户 2026-11-15 报「子待办的字体大小也没有区分」—— 层级必须写在字号上。
   */
  textChild: { ...TYPE.meta, color: c.text2 },
  doneText: { color: c.text2, textDecorationLine: 'line-through' },
  /** 进度 / 到期合成的一行小字 */
  sub: { ...TYPE.caption, color: c.text2, marginTop: 1, fontVariant: ['tabular-nums'] },
  dueOverdue: { color: c.danger },
  hint: { ...TYPE.meta, color: c.text2, marginTop: SPACE.sm, marginBottom: SPACE.xxs },
  allDone: { alignItems: 'center', gap: SPACE.xs, paddingVertical: SPACE.md },
  allDoneTitle: { ...TYPE.title, color: c.text, textAlign: 'center' },
  mergedBar: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginTop: SPACE.md, paddingVertical: SPACE.xs, paddingHorizontal: SPACE.xxs },
  mergedLabel: { flex: 1, ...TYPE.label, color: c.text2 },
  mergedText: { flex: 1, ...TYPE.compact, color: c.text2, paddingVertical: SPACE.xs },
  mergedUndo: { ...TYPE.label, color: c.accentText },
  error: { ...TYPE.compact, color: c.danger, marginTop: SPACE.sm },
  /** 选择模式的底条：紧贴底栏，不再自带上边线（底栏自己有一条，叠在一起就是双线） */
  selectBar: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.xs,
    backgroundColor: c.page,
  },
  selectCount: { flex: 1, ...TYPE.body, color: c.text, fontWeight: '600' },
  mergeBtn: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight, backgroundColor: c.accent, borderRadius: metrics.buttonRadius, paddingHorizontal: SPACE.xl, alignItems: 'center', justifyContent: 'center' },
  mergeText2: { ...TYPE.body, color: c.onAccent, fontWeight: '600' },
  sheet: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.scrim },
  sheetCard: {
    flexGrow: 0, flexShrink: 1, maxHeight: '100%', backgroundColor: c.card,
    borderTopLeftRadius: metrics.cardRadius, borderTopRightRadius: metrics.cardRadius,
  },
  sheetCardContent: { paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.lg, paddingBottom: SPACE.md },
  sheetTitle: { ...TYPE.heading, color: c.text },
  sheetHint: { ...TYPE.compact, color: c.text2, marginTop: SPACE.xxs, marginBottom: SPACE.sm },
  /** 合并输入框：浅灰底、无边框，和首页/问页的书写区一致 */
  input: {
    backgroundColor: c.hairSoft, borderRadius: metrics.cardRadius + 8,
    paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm,
    ...TYPE.reading, color: c.text, minHeight: 100, textAlignVertical: 'top',
  },
  sheetFooter: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: SPACE.sm, marginTop: SPACE.md },
  primaryBtn: {
    minHeight: metrics.controlHeight, backgroundColor: c.accent, borderRadius: metrics.buttonRadius,
    paddingHorizontal: SPACE.xl, minWidth: 100, alignItems: 'center', justifyContent: 'center',
  },
  primaryText: { ...TYPE.body, color: c.onAccent, fontWeight: '600' },
  ghostBtn: {
    minWidth: metrics.controlHeight, minHeight: metrics.controlHeight, borderRadius: metrics.buttonRadius,
    paddingHorizontal: SPACE.md, backgroundColor: c.hairSoft, alignItems: 'center', justifyContent: 'center',
  },
  ghostText: { ...TYPE.body, color: c.text2 },
  btnDisabled: { opacity: 0.5 },
});
