/** Shared validation and durable receipts for the native/web atomic draft commit. */
import type { DraftCommitInput, DraftCommitReceipt } from './types';
import { dueValid } from '../util/knowledgeDoc';

export const isDraftKey = (key: unknown): key is string =>
  typeof key === 'string' && /^[A-Za-z0-9:_.-]{1,200}$/.test(key);
const validKey = isDraftKey;
const validId = (id: unknown): id is number =>
  typeof id === 'number' && Number.isSafeInteger(id) && id > 0;

export function draftCommitKey(draftId: string): string {
  if (!validKey(draftId)) throw new Error('草稿标识无效，请重新打开草稿');
  return `draft.commit.${draftId}`;
}

export function validateDraftCommit(input: DraftCommitInput): void {
  draftCommitKey(input.draftId);
  if (!Array.isArray(input.documents) || !Array.isArray(input.todos) ||
      !Array.isArray(input.sourceIds) || input.sourceIds.some((id) => !validId(id)) ||
      (input.sessionId !== null && !validId(input.sessionId))) {
    throw new Error('草稿写入范围无效，未写入任何内容');
  }
  if (!input.documents.length && !input.todos.length) throw new Error('没有可写入的内容');
  const keys = new Set<string>();
  const takeKey = (key: string) => {
    if (!validKey(key) || keys.has(key)) throw new Error('草稿条目标识重复或无效，未写入任何内容');
    keys.add(key);
  };
  const date = (value: string | null) => {
    if (value !== null && !dueValid(value)) throw new Error('待办日期无效，未写入任何内容');
  };
  for (const doc of input.documents) {
    takeKey(doc.key);
    if (!doc.title?.trim() || typeof doc.excerpt !== 'string' ||
        !doc.content?.bodyMd?.trim() || !Array.isArray(doc.content.chunks) || !doc.content.chunks.length ||
        doc.content.chunks.some((c) => typeof c.text !== 'string' || !c.text.trim() || !c.locator)) {
      throw new Error('文档正文或检索片段无效，未写入任何内容');
    }
  }
  for (const todo of input.todos) {
    takeKey(todo.key);
    if (!todo.text?.trim() || !Array.isArray(todo.children)) throw new Error('待办内容无效');
    date(todo.dueAt);
    for (const child of todo.children) {
      takeKey(child.key);
      if (!child.text?.trim()) throw new Error('子项内容无效');
      date(child.dueAt);
    }
  }
}

export function readDraftReceipt(raw: string | null | undefined): DraftCommitReceipt {
  if (raw === null || raw === undefined) return { documents: [], todos: [] };
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Array.isArray(value.documents) || !Array.isArray(value.todos)) throw new Error();
    const keys = new Set<string>();
    for (const entry of [...value.documents, ...value.todos]) {
      if (!validKey(entry?.key) || !validId(entry?.id) || keys.has(entry.key)) throw new Error();
      keys.add(entry.key);
    }
    if (value.documents.some((entry: { name?: unknown }) => typeof entry.name !== 'string')) throw new Error();
    return {
      documents: value.documents.map((entry: { key: string; id: number; name: string }) => ({ key: entry.key, id: entry.id, name: entry.name })),
      todos: value.todos.map((entry: { key: string; id: number }) => ({ key: entry.key, id: entry.id })),
    };
  } catch {
    // Treating this as an empty receipt would duplicate records already committed.
    throw new Error('这份草稿的写入凭据无法读取，已停止以避免重复写入');
  }
}

export function serializeDraftReceipt(receipt: DraftCommitReceipt): string {
  return JSON.stringify({ version: 1, ...receipt });
}

export function assertReceiptKinds(input: DraftCommitInput, receipt: DraftCommitReceipt): void {
  const docs = new Set(receipt.documents.map((d) => d.key));
  const todos = new Set(receipt.todos.map((t) => t.key));
  if (input.documents.some((d) => todos.has(d.key)) ||
      input.todos.some((t) => docs.has(t.key) || t.children.some((c) => docs.has(c.key)))) {
    throw new Error('草稿条目的写入身份发生冲突，已停止以保护现有内容');
  }
}

export interface DraftCommitStorage {
  insertDocument(doc: DraftCommitInput['documents'][number]): number;
  insertTodo(text: string, dueAt: string | null, parentId: number | null): number;
  findTodo(id: number): { parentId: number | null; mergedInto: number | null } | null;
  reopenTodo(id: number): void;
}

/** Called inside the platform transaction; never stores anything outside that transaction. */
export function commitDraftEntries(
  input: DraftCommitInput,
  receipt: DraftCommitReceipt,
  storage: DraftCommitStorage,
): DraftCommitReceipt {
  assertReceiptKinds(input, receipt);
  const documents = new Map(receipt.documents.map((d) => [d.key, d]));
  const todos = new Map(receipt.todos.map((t) => [t.key, t]));
  for (const doc of input.documents) {
    if (documents.has(doc.key)) continue;
    const entry = { key: doc.key, id: storage.insertDocument(doc), name: doc.title.trim() };
    documents.set(entry.key, entry);
    receipt.documents.push(entry);
  }
  for (const todo of input.todos) {
    let parent = todos.get(todo.key);
    const existingParent = !!parent;
    if (!parent) {
      parent = { key: todo.key, id: storage.insertTodo(todo.text.trim(), todo.dueAt, null) };
      todos.set(parent.key, parent);
      receipt.todos.push(parent);
    }
    const children = todo.children.filter((child) => !todos.has(child.key));
    if (existingParent && children.length) {
      const stored = storage.findTodo(parent.id);
      if (!stored || stored.parentId !== null || stored.mergedInto !== null) {
        throw new Error('原父待办已删除或合并，不能自动重建；请新建待办后再添加子项');
      }
    }
    for (const child of children) {
      const entry = { key: child.key, id: storage.insertTodo(child.text.trim(), child.dueAt, parent.id) };
      todos.set(entry.key, entry);
      receipt.todos.push(entry);
    }
    if (children.length) storage.reopenTodo(parent.id);
  }
  return receipt;
}

export function positiveIds(raw: unknown): number[] {
  return Array.isArray(raw) ? Array.from(new Set(raw.filter(validId))) : [];
}
