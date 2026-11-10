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
import { DONE_TODO_KEEP } from '../types';
import type { Todo } from '../types';
import { repo } from '../db/repo';
import { buildTodoTree, openChildCount, orphanTodos, type TodoNode } from '../util/todoTree';
import { dayKey } from '../util/date';
import { useKeyboardHeight } from '../util/keyboard';
import { R, useThemedStyles, type Palette } from '../theme';

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

  /** 一行待办。父项与子项只差缩进和「加子项」按钮 */
  function renderRow(node: TodoNode, depth: number) {
    const { todo, children } = node;
    const due = dueLabel(todo.dueAt);
    const progress = openChildCount(node);
    const on = picked.has(todo.id);
    const folded = collapsed.has(todo.id);

    return (
      <View key={todo.id}>
        <View style={[styles.row, depth > 0 && styles.rowChild]}>
          {selecting ? (
            depth === 0 ? (
              <Pressable
                onPress={() => pick(todo.id)}
                style={styles.checkHit}
                hitSlop={6}
                accessibilityLabel={on ? '取消选择' : '选中'}
              >
                <View style={[styles.checkBox, on && styles.checkBoxOn]}>
                  {on ? <Ionicons name="checkmark" size={12} color={c.onAccent} /> : null}
                </View>
              </Pressable>
            ) : (
              // 子项不参与合并：并进另一条之后 parentId 指向谁没有意义，
              // 而且「把 3 个不同的子项合成一条」本身就不是用户想要的
              <View style={styles.checkHit} />
            )
          ) : (
            <Pressable
              onPress={() => toggle(todo)}
              style={styles.checkHit}
              hitSlop={6}
              accessibilityLabel={todo.done ? '标记为未完成' : '标记为完成'}
            >
              <Ionicons
                name={todo.done ? 'checkmark-circle' : 'ellipse-outline'}
                size={20}
                color={todo.done ? c.accent : c.text3}
              />
            </Pressable>
          )}

          <Pressable
            style={styles.main}
            onPress={() => (selecting ? pick(todo.id) : onOpenEditor(todo, null))}
            disabled={selecting && depth > 0}
          >
            <Text style={[styles.text, todo.done && styles.doneText]}>{todo.text}</Text>            {progress.total > 0 ? (
              <Text style={styles.progress}>
                {progress.total - progress.open} / {progress.total} 项
              </Text>
            ) : null}
          </Pressable>

          {due ? (
            <Text style={[styles.due, due.overdue && !todo.done && styles.dueOverdue]}>
              {due.text}
            </Text>
          ) : null}

          {progress.total > 0 && !selecting ? (
            <Pressable onPress={() => toggleCollapse(todo.id)} hitSlop={8} style={styles.iconHit}>
              <Ionicons
                name={folded ? 'chevron-down' : 'chevron-up'}
                size={14}
                color={c.text3}
              />
            </Pressable>
          ) : null}

          {!selecting && depth === 0 && !todo.done ? (
            <Pressable
              onPress={() => onOpenEditor(null, todo.id)}
              hitSlop={8}
              style={styles.iconHit}
              accessibilityLabel="加一条子项"
            >
              <Ionicons name="add" size={17} color={c.text3} />
            </Pressable>
          ) : null}
        </View>

        {!folded ? children.map((child) => renderRow({ todo: child, children: [] }, depth + 1)) : null}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {todos.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>还没有待办</Text>
            <Text style={styles.emptyBody}>
              整理时 AI 会把「有明确动作」的碎片挑出来，{'\n'}
              也可以点下面的「新建」自己写一条。
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.toolbar}>
              <Pressable
                style={({ pressed }) => [styles.toolBtn, pressed && { backgroundColor: c.hairSoft }]}
                onPress={() => onOpenEditor(null, null)}
              >
                <Ionicons name="add" size={15} color={c.accentText} />
                <Text style={styles.toolText}>新建</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.toolBtn,
                  selecting && styles.toolBtnOn,
                  pressed && { backgroundColor: c.hairSoft },
                ]}
                onPress={() => setSelecting((v) => !v)}
              >
                <Ionicons name="git-merge-outline" size={15} color={c.accentText} />
                <Text style={styles.toolText}>{selecting ? '完成' : '合并'}</Text>
              </Pressable>
            </View>

            {selecting ? (
              <Text style={styles.selectHint}>
                勾选要合并的几条（只算顶层），然后写下合并后的那一句。
              </Text>
            ) : null}

            {pending.length > 0 ? (
              <View style={styles.group}>{pending.map((n) => renderRow(n, 0))}</View>
            ) : (
              <Text style={styles.allDone}>都做完了。</Text>
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
                <Pressable style={styles.mergedBar} onPress={() => setShowMerged((v) => !v)}>
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
                        <Pressable onPress={() => unmerge(item)} hitSlop={10}>
                          <Text style={styles.mergedUndo}>恢复</Text>
                        </Pressable>
                      </View>
                    ))}
                  </View>
                ) : null}
              </>
            ) : null}

            {error ? <Text style={styles.error}>{error}</Text> : null}
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
            style={[styles.mergeBtn, picked.size < 2 && styles.btnDisabled]}
            onPress={openMerge}
            disabled={picked.size < 2}
          >
            <Text style={styles.mergeText2}>合并</Text>
          </Pressable>
        </View>
      ) : null}

      {mergeOpen ? (
        <View style={styles.sheet}>
          <Pressable style={styles.backdrop} onPress={() => setMergeOpen(false)} />
          <View style={[styles.sheetCard, { marginBottom: keyboardHeight }]}>
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
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.sheetFooter}>
              <Pressable
                style={styles.ghostBtn}
                onPress={() => setMergeOpen(false)}
                disabled={busy}
              >
                <Text style={styles.ghostText}>返回</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryBtn, busy && styles.btnDisabled]}
                onPress={confirmMerge}
                disabled={busy}
              >
                <Text style={styles.primaryText}>合并</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 40 },

  toolbar: { flexDirection: 'row', gap: 8, paddingTop: 2, paddingBottom: 10 },
  toolBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: R.pill,
    backgroundColor: c.accentBg,
  },
  toolBtnOn: { backgroundColor: c.hairSoft },
  toolText: { fontSize: 12.5, color: c.accentText, fontWeight: '500' },
  selectHint: { fontSize: 11.5, color: c.text3, lineHeight: 18, marginBottom: 10 },

  empty: { alignItems: 'center', paddingTop: 80 },
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
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  /** 子项往里缩，且没有独立卡片边框 —— 否则看着像另一条顶层待办 */
  rowChild: { paddingLeft: 34, paddingVertical: 10, backgroundColor: c.hairSoft },
  rowLast: { borderBottomWidth: 0 },
  checkHit: { width: 26, alignItems: 'center' },
  checkBox: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: c.text3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxOn: { backgroundColor: c.accent, borderColor: c.accent },
  main: { flex: 1, paddingVertical: 2 },
  text: { fontSize: 14, lineHeight: 21, color: c.text },
  doneText: { color: c.text3, textDecorationLine: 'line-through' },
  progress: { fontSize: 11, color: c.text3, marginTop: 2, fontVariant: ['tabular-nums'] },
  due: { fontSize: 11, color: c.text3 },
  dueOverdue: { color: c.danger },
  iconHit: { width: 22, alignItems: 'center' },

  hint: { fontSize: 12, color: c.text3, marginTop: 18, marginBottom: 8 },
  allDone: { fontSize: 12.5, color: c.text3, paddingVertical: 14, textAlign: 'center' },

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

  error: { fontSize: 12, color: c.danger, lineHeight: 19, marginTop: 12 },

  selectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
    backgroundColor: c.page,
  },
  selectCount: { flex: 1, fontSize: 13, color: c.text2 },
  mergeBtn: {
    backgroundColor: c.accent,
    borderRadius: R.btn,
    paddingHorizontal: 22,
    paddingVertical: 10,
    alignItems: 'center',
  },
  mergeText2: { fontSize: 13.5, color: c.onAccent, fontWeight: '500' },

  sheet: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: c.scrim,
  },
  sheetCard: {
    backgroundColor: c.page,
    borderTopLeftRadius: R.card + 4,
    borderTopRightRadius: R.card + 4,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 16,
  },
  sheetTitle: { fontSize: 14.5, color: c.text, fontWeight: '600' },
  sheetHint: { fontSize: 11.5, color: c.text3, lineHeight: 18, marginTop: 6, marginBottom: 12 },
  input: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14.5,
    lineHeight: 22,
    color: c.text,
    minHeight: 46,
  },
  sheetFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 },

  primaryBtn: {
    backgroundColor: c.accent,
    borderRadius: R.btn,
    paddingHorizontal: 22,
    paddingVertical: 11,
    minWidth: 100,
    alignItems: 'center',
  },
  primaryText: { fontSize: 14, color: c.onAccent, fontWeight: '500' },
  ghostBtn: {
    borderRadius: R.btn,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderWidth: 0.5,
    borderColor: c.hair,
    backgroundColor: c.card,
  },
  ghostText: { fontSize: 14, color: c.text2 },
  btnDisabled: { opacity: 0.4 },
});
