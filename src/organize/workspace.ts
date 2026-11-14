/** 整理工作区的纯状态：身份、逐项授权、来源快照与可恢复进度。没有 IO 或模型调用。 */
import type { AskSession, Fragment, QaScope, QaTurn } from '../types';
import type { DraftCommitReceipt } from '../db/types';
import { isDraftKey as validKey } from '../db/draftCommit';
import {
  emptyDraft,
  type DraftDoc,
  type DraftMode,
  type DraftTodo,
  type DraftTodoChild,
  type KnowledgeDraft,
} from '../util/knowledgeDoc';
import { normalizeQaScope } from '../util/qaScope';

export type KeyedDoc = DraftDoc & { key: string };
export type KeyedChild = DraftTodoChild & { key: string };
export type KeyedTodo = Omit<DraftTodo, 'children'> & { key: string; children: KeyedChild[] };
export type KeyedDraft = Omit<KnowledgeDraft, 'docs' | 'todos' | 'draftId'> & {
  draftId: string;
  docs: KeyedDoc[];
  todos: KeyedTodo[];
};
export interface WorkStep { text: string; state: 'done' | 'running' | 'fail' }
export interface DraftOwner {
  id: number | null;
  title: string;
  turns: QaTurn[];
  scope: QaScope;
  createdAt: number;
}
export type SourceSnapshot =
  | { kind: 'fragments'; ids: number[]; all: boolean }
  | { kind: 'session'; turns: QaTurn[]; title: string };
export type BatchSnapshot =
  | { kind: 'fragments'; fragments: Fragment[] }
  | { kind: 'session'; turns: QaTurn[] };
export interface DraftRequest {
  mode: DraftMode;
  instruction: string;
  source: SourceSnapshot;
  owner: DraftOwner;
}
export interface DraftWorkspace {
  version: 1;
  draft: KeyedDraft;
  request: DraftRequest;
  /** 已成功生成且与草稿一起持久化的 id，而不是最大 id/日期游标。 */
  processedIds: number[];
  missingIds: number[];
  /** 失败/退出后原样重试的这一批；没有 API Key，没有自动重发。 */
  pending: BatchSnapshot | null;
  sessionProcessed: boolean;
  pendingRevision?: {
    instruction: string;
    material: string;
    history: string[];
    base: KeyedDraft;
    existingTodos: { text: string; done: boolean; due: string | null; children: string[] }[];
  } | null;
  receipt: DraftCommitReceipt;
  phase: 'ready' | 'running' | 'paused' | 'failed' | 'complete';
  allowDoc: boolean;
  allowTodos: boolean;
  history: string[];
  draftAsk: string;
  steps: WorkStep[];
  note: string;
  error: string | null;
  updatedAt: number;
}

let serial = 0;
export function newDraftId(): string {
  serial += 1;
  return `d${Date.now().toString(36)}-${serial.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const idsOf = (ids: number[]) => [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
const textKey = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
const docKey = (doc: DraftDoc) => `${textKey(doc.title)}\n${doc.bodyMd.trim()}`;

/** 仅由应用补 key；旧类型/断言仍可构造不带身份的草稿。不会修改传入对象。 */
export function ensureDraftIdentity(input: KnowledgeDraft, draftId = input.draftId || newDraftId()): KeyedDraft {
  const used = new Set<string>();
  let n = 0;
  const key = (old: string | undefined, kind: string) => {
    if (validKey(old) && !used.has(old)) { used.add(old); return old; }
    let next: string;
    do { next = `${draftId}.${kind}.${(++n).toString(36)}`; } while (used.has(next));
    used.add(next);
    return next;
  };
  // 先保留已有身份，避免给缺 key 的项分配了稍后已有项的身份。
  for (const item of [...input.docs, ...input.todos, ...input.todos.flatMap((t) => t.children)]) {
    if (validKey(item.key)) used.add(item.key);
  }
  const reserved = new Set(used);
  used.clear();
  const assign = (old: string | undefined, kind: string) => {
    if (validKey(old) && !used.has(old)) return key(old, kind);
    let next: string;
    do { next = `${draftId}.${kind}.${(++n).toString(36)}`; } while (reserved.has(next) || used.has(next));
    return key(next, kind);
  };
  return {
    ...input,
    draftId,
    sourceIds: idsOf(input.sourceIds),
    docs: input.docs.map((d) => ({ ...d, key: assign(d.key, 'doc') })),
    todos: input.todos.map((t) => ({
      ...t,
      key: assign(t.key, 'todo'),
      children: t.children.map((c) => ({ ...c, key: assign(c.key, 'child') })),
    })),
  };
}

export function createWorkspace(input: {
  mode: DraftMode;
  source: SourceSnapshot;
  instruction?: string;
  owner: DraftOwner;
  draftId?: string;
}): DraftWorkspace {
  const source = clone(input.source);
  if (source.kind === 'fragments') source.ids = idsOf(source.ids);
  const instruction = input.instruction?.trim() || (input.mode === 'todos' ? '整理待办' : '整理碎片');
  return {
    version: 1,
    draft: ensureDraftIdentity(emptyDraft(input.mode), input.draftId),
    request: { mode: input.mode, source, instruction, owner: clone(input.owner) },
    processedIds: [], missingIds: [], pending: null, sessionProcessed: false,
    receipt: { documents: [], todos: [] }, phase: 'ready',
    allowDoc: true, allowTodos: true, history: [], draftAsk: instruction,
    steps: [], note: '', error: null, updatedAt: Date.now(),
  };
}

export function ownerOfSession(session: AskSession): DraftOwner {
  return { id: session.id, title: session.title, turns: clone(session.turns), scope: clone(session.scope), createdAt: session.createdAt };
}

/** 模型只能修正文；keep、已保存内容及本地身份均由应用决定。 */
export function reconcileRevision(
  original: KnowledgeDraft,
  proposed: KnowledgeDraft,
  receipt: DraftCommitReceipt = { documents: [], todos: [] },
): { draft: KeyedDraft; unreviewed: number; retained: number } {
  const base = ensureDraftIdentity(original);
  const savedDocs = new Set(receipt.documents.map((d) => d.key));
  const savedTodos = new Set(receipt.todos.map((t) => t.key));
  let unreviewed = 0;
  let retained = 0;
  let next = 0;
  const taken = new Set([...base.docs, ...base.todos, ...base.todos.flatMap((t) => t.children)].map((x) => x.key));
  const fresh = (kind: string) => {
    let key: string;
    do { key = `${base.draftId}.rev-${kind}.${Date.now().toString(36)}.${(++serial).toString(36)}.${++next}`; } while (taken.has(key));
    taken.add(key);
    return key;
  };
  function match<T extends { key: string }>(candidate: { key?: string }, list: T[], used: Set<string>, same: (old: T) => boolean): T | undefined {
    const byId = validKey(candidate.key) ? list.find((old) => old.key === candidate.key && !used.has(old.key)) : undefined;
    if (byId) return byId;
    // 第三方不回 key 时仅接受唯一的精确内容匹配，绝不用数组下标猜。
    const exact = list.filter((old) => !used.has(old.key) && same(old));
    return exact.length === 1 ? exact[0] : undefined;
  }
  const docUsed = new Set<string>();
  const docs: KeyedDoc[] = proposed.docs.map((d) => {
    const old = match(d, base.docs, docUsed, (x) => docKey(x) === docKey(d));
    if (!old) { unreviewed++; return { ...d, key: fresh('doc'), keep: false }; }
    docUsed.add(old.key);
    return savedDocs.has(old.key) ? { ...old } : { ...d, key: old.key, keep: old.keep };
  });
  for (const d of base.docs) if (!docUsed.has(d.key)) { docs.push({ ...d }); retained++; }

  const todoUsed = new Set<string>();
  const todos: KeyedTodo[] = proposed.todos.map((t) => {
    const old = match(t, base.todos, todoUsed, (x) => textKey(x.text) === textKey(t.text));
    if (!old) {
      unreviewed += 1 + t.children.length;
      return { ...t, key: fresh('todo'), keep: false, children: t.children.map((c) => ({ ...c, key: fresh('child'), keep: false })) };
    }
    todoUsed.add(old.key);
    const childUsed = new Set<string>();
    const children: KeyedChild[] = t.children.map((c) => {
      const prior = match(c, old.children, childUsed, (x) => textKey(x.text) === textKey(c.text));
      if (!prior) { unreviewed++; return { ...c, key: fresh('child'), keep: false }; }
      childUsed.add(prior.key);
      return savedTodos.has(prior.key) ? { ...prior } : { ...c, key: prior.key, keep: prior.keep };
    });
    for (const c of old.children) if (!childUsed.has(c.key)) { children.push({ ...c }); retained++; }
    const content = savedTodos.has(old.key) ? old : t;
    return { ...content, key: old.key, keep: old.keep, children };
  });
  for (const t of base.todos) if (!todoUsed.has(t.key)) {
    todos.push({ ...t, children: t.children.map((c) => ({ ...c })) }); retained++;
  }
  return {
    draft: { ...base, docs, todos, note: proposed.note },
    unreviewed, retained,
  };
}

/** 新批次只合并完全相同的内容；同标题不同正文仍保留供审阅，绝不因总篇数丢结果。 */
export function appendDraftBatch(baseInput: KnowledgeDraft, next: KnowledgeDraft): KeyedDraft {
  const base = ensureDraftIdentity(baseInput);
  const draft: KnowledgeDraft = {
    ...base,
    docs: base.docs.map((d) => ({ ...d })),
    todos: base.todos.map((t) => ({ ...t, children: t.children.map((c) => ({ ...c })) })),
    sourceIds: idsOf([...base.sourceIds, ...next.sourceIds]),
    note: next.note || base.note,
  };
  for (const d of next.docs) {
    if (!draft.docs.some((old) => docKey(old) === docKey(d))) draft.docs.push({ ...d, key: undefined });
  }
  for (const t of next.todos) {
    const old = draft.todos.find((x) => textKey(x.text) === textKey(t.text));
    if (!old) {
      draft.todos.push({ ...t, key: undefined, children: t.children.map((c) => ({ ...c, key: undefined })) });
    } else {
      for (const child of t.children) if (!old.children.some((c) => textKey(c.text) === textKey(child.text))) {
        // 已拒绝的父项不会因为新一批补子项而被恢复勾选。
        old.children.push({ ...child, key: undefined, keep: old.keep && child.keep });
      }
    }
  }
  return ensureDraftIdentity(draft, base.draftId);
}

export interface DraftTargets {
  documents: KeyedDoc[];
  todos: KeyedTodo[];
  documentCount: number;
  /** 真正新增的父项+子项数，既有父项只作定位不计数。 */
  todoCount: number;
}
/** 显示/按钮/写库共用的唯一计划；已保存父项可复用身份只增加新批准子项。 */
export function selectDraftTargets(
  draftInput: KnowledgeDraft,
  receipt: DraftCommitReceipt,
  allowDoc: boolean,
  allowTodos: boolean,
  onlyKey: string | null = null,
): DraftTargets {
  const draft = ensureDraftIdentity(draftInput);
  const doneDocs = new Set(receipt.documents.map((d) => d.key));
  const doneTodos = new Set(receipt.todos.map((t) => t.key));
  const documents = allowDoc && draft.mode === 'knowledge'
    ? draft.docs.filter((d) => d.keep && d.bodyMd.trim() && !doneDocs.has(d.key) && (!onlyKey || d.key === onlyKey))
    : [];
  let todoCount = 0;
  const todos: KeyedTodo[] = [];
  if (!onlyKey && allowTodos) for (const t of draft.todos) {
    if (!t.keep || !t.text.trim()) continue;
    const children = t.children.filter((c) => c.keep && c.text.trim() && !doneTodos.has(c.key));
    const pendingParent = !doneTodos.has(t.key);
    if (!pendingParent && !children.length) continue;
    todos.push({ ...t, children });
    todoCount += (pendingParent ? 1 : 0) + children.length;
  }
  return { documents, todos, documentCount: documents.length, todoCount };
}

export function remainingIds(work: DraftWorkspace): number[] {
  if (work.request.source.kind !== 'fragments') return [];
  const done = new Set([...work.processedIds, ...work.missingIds]);
  return work.request.source.ids.filter((id) => !done.has(id));
}
export function hasUnfinishedWork(work: DraftWorkspace): boolean {
  return work.request.source.kind === 'session' ? !work.sessionProcessed : remainingIds(work).length > 0;
}

/**
 * 新任务能否无损替换当前工作区，与当前允许写什么/勾了什么完全无关。
 * 取消选择只是“不批准写入”，绝不是授权丢弃尚未保存的产出。
 */
export function hasUnsavedWorkspace(work: DraftWorkspace): boolean {
  if (hasUnfinishedWork(work) || work.pending !== null || work.pendingRevision != null) return true;
  const documents = new Set(work.receipt.documents.map((entry) => entry.key));
  const todos = new Set(work.receipt.todos.map((entry) => entry.key));
  if (work.draft.docs.some((doc) => (doc.title.trim() || doc.bodyMd.trim() || doc.summary.trim()) && !documents.has(doc.key))) return true;
  return work.draft.todos.some((todo) =>
    (!!todo.text.trim() && !todos.has(todo.key)) ||
    todo.children.some((child) => !!child.text.trim() && !todos.has(child.key)),
  );
}

/** 严格恢复：损坏/未知版本报错，不清空、不改成一个新 draftId 重复写入。 */
export function decodeWorkspace(raw: string | null): DraftWorkspace | null {
  if (raw === null || raw === '') return null;
  try {
    const w = JSON.parse(raw) as DraftWorkspace;
    if (!w || w.version !== 1 || !validKey(w.draft?.draftId)) throw new Error();
    const d = w.draft;
    if (!Array.isArray(d.docs) || !Array.isArray(d.todos) || !Array.isArray(d.sourceIds)) throw new Error();
    if (d.mode !== 'knowledge' && d.mode !== 'todos') throw new Error();
    const keys = new Set<string>();
    const checkItem = (item: { key?: string; keep: boolean }) => {
      if (!item || !validKey(item.key) || keys.has(item.key) || typeof item.keep !== 'boolean') throw new Error();
      keys.add(item.key);
    };
    for (const doc of d.docs) { checkItem(doc); if (typeof doc.title !== 'string' || typeof doc.bodyMd !== 'string' || typeof doc.summary !== 'string') throw new Error(); }
    for (const todo of d.todos) {
      checkItem(todo);
      if (typeof todo.text !== 'string' || !Array.isArray(todo.children)) throw new Error();
      for (const child of todo.children) { checkItem(child); if (typeof child.text !== 'string') throw new Error(); }
    }
    if (!w.request || w.request.mode !== d.mode || typeof w.request.instruction !== 'string') throw new Error();
    const source = w.request.source;
    if (source?.kind === 'fragments') {
      if (!Array.isArray(source.ids) || source.ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || typeof source.all !== 'boolean') throw new Error();
    } else if (source?.kind === 'session') {
      if (!Array.isArray(source.turns) || typeof source.title !== 'string' || source.turns.some((t) => typeof t?.question !== 'string' || typeof t?.answer !== 'string')) throw new Error();
    } else throw new Error();
    const owner = w.request.owner;
    if (!owner || typeof owner.title !== 'string' || !Array.isArray(owner.turns) || !Number.isFinite(owner.createdAt)) throw new Error();
    if (owner.id !== null && (!Number.isSafeInteger(owner.id) || owner.id <= 0)) throw new Error();
    owner.scope = normalizeQaScope(owner.scope);
    const validIds = (list: unknown): list is number[] => Array.isArray(list) &&
      list.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(list).size === list.length;
    if (!validIds(w.processedIds) || !validIds(w.missingIds) || !validIds(d.sourceIds) || typeof w.sessionProcessed !== 'boolean') throw new Error();
    const sourceSet = new Set(source.kind === 'fragments' ? source.ids : []);
    if ([...w.processedIds, ...w.missingIds, ...d.sourceIds].some((id) => !sourceSet.has(id))) throw new Error();
    if (w.processedIds.some((id) => w.missingIds.includes(id) || !d.sourceIds.includes(id))) throw new Error();
    if (source.kind === 'fragments' && w.sessionProcessed) throw new Error();
    if (source.kind === 'session' && (w.processedIds.length || w.missingIds.length || d.sourceIds.length)) throw new Error();
    if (!w.receipt || !Array.isArray(w.receipt.documents) || !Array.isArray(w.receipt.todos)) throw new Error();
    const receiptKeys = new Set<string>();
    const docKeys = new Set(d.docs.map((item) => item.key));
    const todoKeys = new Set(d.todos.flatMap((item) => [item.key, ...item.children.map((child) => child.key)]));
    for (const item of [...w.receipt.documents, ...w.receipt.todos]) {
      if (!validKey(item?.key) || !keys.has(item.key) || receiptKeys.has(item.key) || !Number.isSafeInteger(item.id) || item.id <= 0) throw new Error();
      receiptKeys.add(item.key);
    }
    if (w.receipt.documents.some((item) => !docKeys.has(item.key) || typeof item.name !== 'string') || w.receipt.todos.some((item) => !todoKeys.has(item.key))) throw new Error();
    if (typeof w.allowDoc !== 'boolean' || typeof w.allowTodos !== 'boolean' || !Array.isArray(w.history) || !Array.isArray(w.steps)) throw new Error();
    if (w.history.some((entry) => typeof entry !== 'string') || w.steps.some((step) => typeof step?.text !== 'string' || !['done', 'running', 'fail'].includes(step.state))) throw new Error();
    if (typeof w.draftAsk !== 'string' || typeof w.note !== 'string' || (w.error !== null && typeof w.error !== 'string') || !Number.isFinite(w.updatedAt)) throw new Error();
    if (!['ready', 'running', 'paused', 'failed', 'complete'].includes(w.phase)) throw new Error();
    if (w.pending !== null) {
      if (w.pending?.kind === 'fragments') {
        if (source.kind !== 'fragments' || !Array.isArray(w.pending.fragments)) throw new Error();
        const pendingIds = w.pending.fragments.map((f) => f?.id);
        if (!validIds(pendingIds) || !pendingIds.length || pendingIds.some((id) => !sourceSet.has(id) || w.processedIds.includes(id) || w.missingIds.includes(id))) throw new Error();
        if (w.pending.fragments.some((f) => typeof f?.content !== 'string' || !Number.isFinite(f?.createdAt) || !Array.isArray(f?.images) || f.images.some((image) => !Number.isSafeInteger(image?.id) || image.id <= 0 || typeof image.path !== 'string' || (image.text !== null && typeof image.text !== 'string')))) throw new Error();
      } else if (w.pending?.kind === 'session') {
        if (source.kind !== 'session' || w.sessionProcessed || JSON.stringify(w.pending.turns) !== JSON.stringify(source.turns)) throw new Error();
      } else throw new Error();
    }
    if (w.pendingRevision != null) {
      const revision = w.pendingRevision;
      if (typeof revision.instruction !== 'string' || !revision.instruction.trim() || typeof revision.material !== 'string' || !Array.isArray(revision.history) || revision.history.some((line) => typeof line !== 'string') || !Array.isArray(revision.existingTodos) || revision.base?.draftId !== d.draftId) throw new Error();
      if (revision.existingTodos.some((todo) => typeof todo?.text !== 'string' || typeof todo.done !== 'boolean' || (todo.due !== null && typeof todo.due !== 'string') || !Array.isArray(todo.children) || todo.children.some((line) => typeof line !== 'string'))) throw new Error();
      // 基础稿同样验证身份/来源，不接受损坏 JSON 注入另一份草稿作为“重试”。
      decodeWorkspace(JSON.stringify({ ...w, draft: revision.base, pendingRevision: null }));
    }
    if (w.phase === 'complete' && hasUnfinishedWork(w)) throw new Error();
    // 冷启动不续跑：上次发出去的模型请求可能已结束，也可能失败，必须由人点重试。
    return { ...w, phase: w.phase === 'running' ? 'paused' : w.phase, steps: w.steps.map((s) => s.state === 'running' ? { ...s, text: `${s.text}（已暂停）`, state: 'fail' as const } : s) };
  } catch {
    throw new Error('本地整理草稿无法读取，未覆盖原记录。请保留数据后排查，不要反复重新写入。');
  }
}

export function encodeWorkspace(work: DraftWorkspace): string {
  const raw = JSON.stringify(work);
  decodeWorkspace(raw);
  return raw;
}
