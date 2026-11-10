/**
 * 整理草稿：模型产出的知识文档与待办建议，在用户点「通过并写入」之前的那份东西。
 *
 * 这一份是**唯一判据**：模型返回的原始 JSON、界面上的可编辑文本、最终写库的内容，
 * 全都经过这里。散在三处各写一遍的后果是「界面显示 3 条待办、实际写进去 2 条」，
 * 而用户不会去数。
 */
import type { Document } from '../types';

export type DraftMode = 'knowledge' | 'todos';

export interface DraftTodo {
  text: string;
  /** YYYY-MM-DD 或 null */
  due: string | null;
  /** 勾掉 = 这条不写。默认全勾 */
  keep: boolean;
}

export interface KnowledgeDraft {
  title: string;
  bodyMd: string;
  todos: DraftTodo[];
  /** 这次喂给模型的碎片 id，写库时记到会话上，供「重新整理」 */
  sourceIds: number[];
  mode: DraftMode;
  /** 模型的一句说明：用了多少条、覆盖了什么。只展示，不写库 */
  note: string;
}

/** 标题上限。手机上列表一行放得下的大致长度，超了会被截断成省略号 */
export const TITLE_MAX = 24;
const EXCERPT_MAX = 110;

export function emptyDraft(mode: DraftMode, sourceIds: number[] = []): KnowledgeDraft {
  return { title: '', bodyMd: '', todos: [], sourceIds, mode, note: '' };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/**
 * 日期校验要真校验。
 *
 * `2026-02-31` 能被 `Date` 悄悄滚到 3 月 3 日，只查格式的话它会被原样写库，
 * 然后在待办列表里显示成一个不存在的日期。所以解析回来必须和输入一致。
 */
export function dueValid(due: string | null | undefined): due is string {
  if (!due) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return false;
  const [y, m, d] = due.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 模型 JSON → 草稿。形状一律在这里收敛，界面上不接受 unknown */
export function normalizeDraft(
  raw: unknown,
  mode: DraftMode,
  sourceIds: number[],
): KnowledgeDraft {
  const root = obj(raw);
  const todos: DraftTodo[] = arr(root.todos)
    .map((item) => obj(item))
    .map((t) => ({
      text: str(t.text),
      due: dueValid(str(t.due)) ? str(t.due) : null,
      keep: true,
    }))
    // 空文字不能留：列表上是一行空行，写进去是一条看不见的待办
    .filter((t) => t.text.length > 0);

  const body = str(root.body_md) || str(root.body);
  return {
    title: clipTitle(str(root.title)),
    bodyMd: body,
    todos,
    sourceIds,
    mode,
    note: str(root.note),
  };
}

export function clipTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/**
 * 列表摘要。
 *
 * 表格行不能原样当摘要（一串竖线在列表里没法看），所以把 `|` 换成 `·`、
 * 去掉表头分隔行。它是给人扫一眼用的，不是正文的一部分。
 */
export function excerptOf(bodyMd: string, max = EXCERPT_MAX): string {
  const flat = bodyMd
    .split('\n')
    .filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || line.trim() === '')
    .join('\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' · ')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 文档名。没有标题时用日期兜底，绝不允许出现一篇没有名字的文档 */
export function docNameOf(draft: KnowledgeDraft, now: number): string {
  const t = clipTitle(draft.title);
  if (t) return t;
  const d = new Date(now);
  return `整理 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export function keptTodos(draft: KnowledgeDraft): DraftTodo[] {
  return draft.todos.filter((t) => t.keep && t.text.trim());
}

/**
 * 写入前能检查出来的问题。返回 null 表示可以写。
 *
 * 只拦「写进去一定是废的」那几种：没标题、没正文、没有勾任何东西。
 * 正文长短、语气一律不管 —— 那是用户的判断，不是代码该替他做的。
 */
export function draftProblem(draft: KnowledgeDraft): string | null {
  const hasBody = draft.bodyMd.trim().length > 0;
  const todos = keptTodos(draft);
  if (draft.mode === 'todos') {
    if (!todos.length) return '还没有勾选任何待办';
    return null;
  }
  if (!hasBody && !todos.length) return '正文是空的，也没有勾选待办';
  if (!hasBody) return '正文是空的';
  return null;
}

/**
 * 草稿 → 文档记录的形状（还没写库）。
 *
 * 单独一步是为了让「什么时候算写进去了」有一个明确的边界：
 * 界面上点「通过并写入」之后，先算出这个东西，再交给 repo。
 */
export function draftToDocument(
  draft: KnowledgeDraft,
  now: number,
): Pick<Document, 'name' | 'ext' | 'size' | 'fileUri' | 'bodyMd' | 'origin' | 'excerpt'> {
  const bodyMd = draft.bodyMd.trim();
  return {
    name: docNameOf(draft, now),
    ext: 'md',
    size: bodyMd.length,
    fileUri: null,
    bodyMd,
    origin: 'knowledge',
    excerpt: excerptOf(bodyMd),
  };
}

/** 会话行上的徽标文案。已有文档才显示，否则返回 null */
export function documentBadge(name: string | null | undefined): string | null {
  const n = (name ?? '').trim();
  if (!n) return null;
  return n.length > 12 ? `${n.slice(0, 12)}…` : n;
}
