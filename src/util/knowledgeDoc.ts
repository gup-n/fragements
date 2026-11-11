/**
 * 整理草稿：模型产出的知识文档与待办建议，在用户点「通过并写入」之前的那份东西。
 *
 * 这一份是**唯一判据**：模型返回的原始 JSON、界面上的可编辑文本、最终写库的内容，
 * 全都经过这里。散在三处各写一遍的后果是「界面显示 3 条待办、实际写进去 2 条」，
 * 而用户不会去数。
 *
 * v0.17 的两处形状变化，都是用户直接提出来的：
 * 1. **一次整理可以产出多篇文档**。原来一篇「雷霆大正文」把换盘步骤、报错含义、
 *    型号选择全塞在一起，找具体做法得从头读。现在按主题拆开，每篇一个场景。
 * 2. **待办分两层**。整理一次抽出十几条平铺待办，看起来就是一堆碎片；
 *    真正的「一件事分几步」在库里本来就有父子结构（todos.parent_id），只是没被用上。
 */
import type { Document } from '../types';

export type DraftMode = 'knowledge' | 'todos';

/** 一条待办（含它自己的子步骤，子步骤不再有子步骤） */
export interface DraftTodo {
  text: string;
  /** YYYY-MM-DD 或 null */
  due: string | null;
  /** 勾掉 = 这条不写。默认全勾 */
  keep: boolean;
  /** 子步骤。只有一层，和 Todo.parentId 的两层约束对齐 */
  children: DraftTodoChild[];
}

export interface DraftTodoChild {
  text: string;
  due: string | null;
  keep: boolean;
}

/** 一篇待写入的文档 */
export interface DraftDoc {
  title: string;
  bodyMd: string;
  /** 一句话说明这篇讲什么。列表上用它，不截正文 */
  summary: string;
  /** 勾掉 = 这篇不写。默认全勾 */
  keep: boolean;
}

export interface KnowledgeDraft {
  docs: DraftDoc[];
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
/** 一次最多收几篇。再多就不是「整理」而是「拆碎」了 */
export const MAX_DOCS = 4;
/**
 * 「整理全部」时跨批合并的上限。
 *
 * 单批 4 篇，10 批最多 40 篇 —— 那是「文档区被这次整理灌满」，用户要花一个下午
 * 逐篇读。所以合并后只留 12 篇，剩下的在卡片上如实说「还有 N 篇没列出来」。
 * 这不是丢数据：被丢的只是**这一轮没展示的**，碎片原文一个字没动。
 */
export const MAX_DOCS_ALL = 12;

export function emptyDraft(mode: DraftMode, sourceIds: number[] = []): KnowledgeDraft {
  return { docs: [], todos: [], sourceIds, mode, note: '' };
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

function toChild(raw: unknown): DraftTodoChild | null {
  const t = obj(raw);
  const text = str(t.text);
  if (!text) return null;
  return { text, due: dueValid(str(t.due)) ? str(t.due) : null, keep: true };
}

function toTodo(raw: unknown): DraftTodo | null {
  const t = obj(raw);
  const text = str(t.text);
  if (!text) return null;
  return {
    text,
    due: dueValid(str(t.due)) ? str(t.due) : null,
    keep: true,
    // 子项空文字不能留：列表上是一行空行，写进去是一条看不见的待办
    children: arr(t.children).map(toChild).filter((x): x is DraftTodoChild => x !== null),
  };
}

function toDoc(raw: unknown): DraftDoc | null {
  const d = obj(raw);
  const body = str(d.body_md) || str(d.body);
  // 空正文的文档写进去就是一篇点开全白的记录，直接丢掉
  if (!body) return null;
  return {
    title: clipTitle(str(d.title)),
    bodyMd: body,
    summary: str(d.summary) || excerptOf(body, 60),
    keep: true,
  };
}

/**
 * 模型 JSON → 草稿。形状一律在这里收敛，界面上不接受 unknown。
 *
 * 兼容两种形状：
 * - `{ docs: [...] }`（v0.17 起）
 * - `{ title, body_md }`（v0.16 及更早的 prompt 只产一篇）
 * 兼容旧形状不是为了向后兼容数据，而是因为第三方接口偶尔会照着旧的示例返回 ——
 * 那时丢掉整篇正文，用户看到的是一次白跑。
 */
export function normalizeDraft(
  raw: unknown,
  mode: DraftMode,
  sourceIds: number[],
): KnowledgeDraft {
  const root = obj(raw);

  const docs: DraftDoc[] = [];
  const list = arr(root.docs ?? root.documents);
  for (const item of list) {
    const d = toDoc(item);
    if (d) docs.push(d);
  }
  if (!docs.length) {
    const single = toDoc(root);
    if (single) docs.push(single);
  }

  const todos = arr(root.todos)
    .map(toTodo)
    .filter((t): t is DraftTodo => t !== null);

  return {
    docs: docs.slice(0, MAX_DOCS),
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
export function docNameOf(doc: DraftDoc, now: number, index = 0): string {
  const t = clipTitle(doc.title);
  if (t) return t;
  const d = new Date(now);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
  return index > 0 ? `整理 ${date}（${index + 1}）` : `整理 ${date}`;
}

export function keptDocs(draft: KnowledgeDraft): DraftDoc[] {
  return draft.docs.filter((d) => d.keep && d.bodyMd.trim().length > 0);
}

export function keptTodos(draft: KnowledgeDraft): DraftTodo[] {
  return draft.todos.filter((t) => t.keep && t.text.trim());
}

/** 待办总条数（含子项）。界面上的「N 条」用它，含子项才是用户要写进去的条数 */
export function countTodos(draft: KnowledgeDraft): number {
  let n = 0;
  for (const t of keptTodos(draft)) n += 1 + t.children.filter((c) => c.keep && c.text.trim()).length;
  return n;
}

/** 主待办条数（不含子项）。进度日志里说「N 件事、M 个步骤」用它 */
export function todoShape(draft: KnowledgeDraft): { top: number; sub: number } {
  const kept = keptTodos(draft);
  let sub = 0;
  for (const t of kept) sub += t.children.filter((c) => c.keep && c.text.trim()).length;
  return { top: kept.length, sub };
}

/**
 * 「整理全部」时一批一批跑，结果往同一份草稿里并。
 *
 * 为什么需要去重而不是直接拼：分批是按「装箱」切的，同一个主题很可能跨在两批的
 * 边界上 —— 第 3 批写《群晖换盘》，第 4 批又写一篇同名的。直接拼起来，用户会在
 * 卡片上看到两篇一样的东西，然后逐篇读一遍才发现重复。
 *
 * 判重只用**标题**和**待办原文**，不做语义比较：语义相似度判错一次，用户就会
 * 丢掉一整篇他还没看过的东西。标题相同才合并，其余一律保留 —— 宁可多一篇，
 * 不能悄悄少一篇。
 */
export function mergeDrafts(
  base: KnowledgeDraft,
  next: KnowledgeDraft,
  maxDocs = MAX_DOCS_ALL,
): { draft: KnowledgeDraft; dropped: number } {
  const docs = base.docs.slice();
  const seen = new Set(docs.map((d) => (d.title || d.bodyMd.slice(0, 12)).trim().toLowerCase()));
  let dropped = 0;
  for (const d of next.docs) {
    const key = (d.title || d.bodyMd.slice(0, 12)).trim().toLowerCase();
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    if (docs.length >= maxDocs) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    docs.push(d);
  }

  const todos = base.todos.slice();
  const byText = new Map(todos.map((t) => [todoKey(t.text), t]));
  for (const t of next.todos) {
    const key = todoKey(t.text);
    const hit = byText.get(key);
    if (!hit) {
      todos.push(t);
      byText.set(key, t);
      continue;
    }
    // 同一件事在两批里各拆了一半步骤：补上缺的那几步，而不是整条丢掉
    const have = new Set(hit.children.map((c) => todoKey(c.text)));
    for (const c of t.children) {
      if (!have.has(todoKey(c.text))) hit.children.push(c);
    }
    if (!hit.due && t.due) hit.due = t.due;
  }

  return {
    draft: {
      docs,
      todos,
      sourceIds: Array.from(new Set([...base.sourceIds, ...next.sourceIds])),
      mode: base.mode,
      note: next.note || base.note,
    },
    dropped,
  };
}

/** 待办判重的键：空白折叠 + 小写。标点和语序不动 —— 那是用户的原话 */
function todoKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 写入前能检查出来的问题。返回 null 表示可以写。
 *
 * 只拦「写进去一定是废的」那几种：没有正文、没有勾任何东西。
 * 正文长短、语气一律不管 —— 那是用户的判断，不是代码该替他做的。
 */
export function draftProblem(draft: KnowledgeDraft): string | null {
  const docs = keptDocs(draft);
  const todos = keptTodos(draft);
  if (draft.mode === 'todos') {
    if (!todos.length) return '还没有勾选任何待办';
    return null;
  }
  if (!docs.length && !todos.length) return '没有可写入的文档，也没有勾选待办';
  return null;
}

/** 单篇能不能写。卡片上那篇的按钮用它 */
export function docProblem(doc: DraftDoc): string | null {
  if (!doc.bodyMd.trim()) return '正文是空的';
  if (!doc.title.trim()) return '还没起标题';
  return null;
}

/**
 * 草稿 → 文档记录的形状（还没写库）。
 *
 * 单独一步是为了让「什么时候算写进去了」有一个明确的边界：
 * 界面上点「通过并写入」之后，先算出这个东西，再交给 repo。
 */
export function draftToDocument(
  doc: DraftDoc,
  now: number,
  index = 0,
): Pick<Document, 'name' | 'ext' | 'size' | 'fileUri' | 'bodyMd' | 'origin' | 'excerpt'> {
  const bodyMd = doc.bodyMd.trim();
  return {
    name: docNameOf(doc, now, index),
    ext: 'md',
    size: bodyMd.length,
    fileUri: null,
    bodyMd,
    origin: 'knowledge',
    excerpt: doc.summary || excerptOf(bodyMd),
  };
}

/**
 * 整理写进历史的那句话。
 *
 * 只说结果，不复述过程：历史行的预览位置只够两行，
 * 「整理出 2 篇文档：《A》《B》，3 条待办」比「AI 正在深度思考」有用得多。
 * 也**不写「成功」**：没有产出时就说没有，别让它看起来像跑了点什么。
 */
export function describeForHistory(draft: KnowledgeDraft, leftover = 0): string {
  const docs = draft.docs.filter((d) => d.bodyMd.trim());
  const todos = draft.todos.filter((t) => t.text.trim());
  if (!docs.length && !todos.length) return '这批碎片里没有可沉淀的知识，没有生成文档。';
  const bits: string[] = [];
  if (docs.length) {
    const names = docs.map((d) => `《${d.title.trim() || '未命名'}》`).join('、');
    bits.push(`整理出 ${docs.length} 篇文档：${names}`);
  }
  if (todos.length) {
    const n = todos.reduce((sum, t) => sum + 1 + t.children.filter((c) => c.text.trim()).length, 0);
    bits.push(`${n} 条待办`);
  }
  const tail = leftover ? `；还有 ${leftover} 条碎片没整理` : '';
  return `${bits.join('，')}${tail}。`;
}

/** 会话行上的徽标文案。已有文档才显示，否则返回 null */
export function documentBadge(name: string | null | undefined): string | null {
  const n = (name ?? '').trim();
  if (!n) return null;
  return n.length > 12 ? `${n.slice(0, 12)}…` : n;
}
