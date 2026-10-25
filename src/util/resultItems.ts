/**
 * 确认页的字段元数据与勾选 key。
 *
 * v0.7 起只有六组：标签、新待办、标记完成、删除待办、合并待办、合并碎片。
 * 「会让内容消失」的三组（删除待办 / 合并待办 / 合并碎片）默认不勾，
 * 这条纪律由本文件统一决定，**不要在渲染代码里另写一份**。
 */
import type { OrganizeReview } from '../types';
import { normText } from './text';

/**
 * 确认项的稳定 key。
 *
 * 不能用数组下标 —— 结果会重排、增删条目，下标一动，
 * 用户刚才取消掉的勾选就会落到另一条内容上。用内容本身做 key。
 */
export const K = {
  /** 标签按名字分组，勾选粒度是「整组标签」 */
  tagGroup: (label: string) => `tag:${label}`,
  todo: (text: string) => `todo:${normText(text)}`,
  merge: (keepId: number) => `merge:${keepId}`,
  done: (todoId: number) => `done:${todoId}`,
  drop: (todoId: number) => `drop:${todoId}`,
  mergeTodo: (keepId: number) => `mtodo:${keepId}`,
} as const;

export interface GroupMeta {
  key: 'tags' | 'todos' | 'todo_done' | 'drop_todos' | 'merge_todos' | 'merge';
  label: string;
  /** true = 会让内容消失，默认不勾 */
  destructive: boolean;
  hint: string;
}

export const GROUPS: GroupMeta[] = [
  { key: 'tags', label: '标签', destructive: false, hint: '按标签名分组；取消一组就等于这批碎片不打这个标签' },
  { key: 'todos', label: '新待办', destructive: false, hint: '从碎片里抽出来的、还没进回顾页的待办' },
  { key: 'todo_done', label: '标记完成', destructive: false, hint: '碎片里明确说了已经做完；不丢内容，回顾页还能取消' },
  { key: 'drop_todos', label: '删除待办', destructive: true, hint: '真删除，不可撤销；只有确认是误抽/过时才勾' },
  { key: 'merge_todos', label: '合并待办', destructive: true, hint: '被合并的那条会隐藏，回顾页「已合并」里能撤回' },
  { key: 'merge', label: '合并碎片', destructive: true, hint: '重复的原文折叠到保留那条里，原文不删除' },
];

/** 所有可勾选的 key（用于「应用 N 项」计数与全选） */
export function allKeys(review: OrganizeReview): string[] {
  const out: string[] = [];
  for (const g of review.tags) out.push(K.tagGroup(g.label));
  for (const t of review.todos) out.push(K.todo(t.text));
  for (const d of review.todo_done) out.push(K.done(d.todo_id));
  for (const d of review.drop_todos) out.push(K.drop(d.todo_id));
  for (const m of review.merge_todos) out.push(K.mergeTodo(m.keep_id));
  for (const m of review.merge) out.push(K.merge(m.keep_id));
  return out;
}

/** 安全项（不会让内容消失）。「全选安全项」只勾这些 */
export function safeKeys(review: OrganizeReview): string[] {
  const out: string[] = [];
  for (const g of review.tags) {
    // 新标签且和已有标签长得很像：默认不勾，让用户先看一眼
    if (g.isNew && g.similarTo) continue;
    out.push(K.tagGroup(g.label));
  }
  for (const t of review.todos) out.push(K.todo(t.text));
  for (const d of review.todo_done) out.push(K.done(d.todo_id));
  return out;
}

/** 默认取消勾选的集合：破坏性操作 + 疑似重复的新标签 */
export function defaultDeselected(review: OrganizeReview): Set<string> {
  const safe = new Set(safeKeys(review));
  const off = new Set<string>();
  for (const key of allKeys(review)) if (!safe.has(key)) off.add(key);
  return off;
}

export interface ReviewCounts {
  /** 会被打标签的碎片条数（一个碎片可能出现在多组里，按 id 去重） */
  taggedFragments: number;
  newTags: number;
  todos: number;
  done: number;
  dropped: number;
  mergedTodos: number;
  mergedFragments: number;
  processed: number;
  skipped: number;
  rejected: number;
}

export function reviewCounts(review: OrganizeReview): ReviewCounts {
  const ids = new Set<number>();
  for (const g of review.tags) for (const id of g.fragmentIds) ids.add(id);
  return {
    taggedFragments: ids.size,
    newTags: review.newTagCount,
    todos: review.todos.length,
    done: review.todo_done.length,
    dropped: review.drop_todos.length,
    mergedTodos: review.merge_todos.length,
    mergedFragments: review.merge.length,
    processed: review.processedCount,
    skipped: review.skippedCount,
    rejected: review.rejected,
  };
}

/** 这个 key 是否属于破坏性操作 —— commit 里也要用它兜底 */
export function isDestructiveKey(key: string): boolean {
  return key.startsWith('merge:') || key.startsWith('drop:') || key.startsWith('mtodo:');
}
