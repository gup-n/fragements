import type { Repo } from './types';
import { DONE_TODO_KEEP } from '../types';
import type {
  AskSession,
  Document,
  DocumentChunk,
  DocumentMeta,
  Fragment,
  FragmentNature,
  FragmentSource,
  FragmentStatus,
  Note,
  OrganizePlan,
  OrganizeScope,
  OrganizeSession,
  QaScope,
  TagStat,
  Todo,
} from '../types';
import { emptyPlan, normalizePlan } from '../util/organizePlan';
import { normalizeQaScope } from '../util/qaScope';
import { planToggle } from '../util/todoTree';
import { dedupeTags, tokenizeText } from '../util/tokenize';

/**
 * 浏览器预览用的存储实现，数据落在 localStorage。
 * 只服务于桌面端编译校验，真机走 repo.native.ts 的 SQLite。
 * 行为与 native 版保持语义一致，方便对照排查问题。
 */

const KEY = 'fragments.webdb.v2';

interface WebDb {
  seq: number;
  fragments: Fragment[];
  todos: Todo[];
  notes: Note[];
  runs: { id: number; startedAt: number; fragmentIds: number[]; model: string; resultJson: string; applied: number }[];
  settings: Record<string, string>;
  sessions: OrganizeSession[];
  askSessions: AskSession[];
  documents: Document[];
  /** v0.12：文档切片。web 侧不建 FTS，检索直接扫 text */
  documentChunks: DocumentChunk[];
}

function empty(): WebDb {
  return {
    seq: 1,
    fragments: [],
    todos: [],
    notes: [],
    runs: [],
    settings: {},
    sessions: [],
    askSessions: [],
    documents: [],
    documentChunks: [],
  };
}

/** 已完成待办保留上限，与 native 版保持一致 */
function pruneDone(d: WebDb) {
  const kept = new Set(
    d.todos
      .filter((t) => t.done && t.mergedInto === null)
      .sort((a, b) => (b.doneAt ?? b.createdAt) - (a.doneAt ?? a.createdAt) || b.id - a.id)
      .slice(0, DONE_TODO_KEEP)
      .map((t) => t.id),
  );
  d.todos = d.todos.filter((t) => !t.done || t.mergedInto !== null || kept.has(t.id));
}

let cache: WebDb | null = null;

function load(): WebDb {
  if (cache) return cache;
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    cache = raw ? { ...empty(), ...JSON.parse(raw) } : empty();
    cache!.sessions = (cache!.sessions ?? []).map((s) => ({
      ...s,
      plan: normalizePlan(s.plan ?? emptyPlan()),
    }));
    // 旧版本没有 doneAt：已完成的用 createdAt 回填，与 native v7 迁移口径一致
    cache!.todos = (cache!.todos ?? []).map((t) => ({
      ...t,
      doneAt: t.doneAt ?? (t.done ? t.createdAt : null),
      // v0.15 之前没有父子关系：补 null 当作顶层，与 native v11 迁移同口径
      parentId: t.parentId ?? null,
    }));
    // v0.15：日/周小结下线，旧数据一并清掉（与 native v11 的 DELETE 同口径）。
    // 这一步在 load 里做而不是加版本号：web 版只是桌面预览，没有迁移框架。
    cache!.notes = (cache!.notes ?? []).filter(
      (n) => n.type !== 'daily' && n.type !== 'weekly',
    );
    // 旧版本没有 askSessions；顺便兜住 turns 缺失的脏数据。
    // 旧会话没有 scope，那时还没有文档范围的问法，按 records 补（与 native 同口径）
    cache!.askSessions = (cache!.askSessions ?? []).map((s) => {
      let scope: QaScope = { kind: 'records' };
      let scopeBroken = false;
      try {
        scope = normalizeQaScope(s.scope, true);
      } catch {
        scopeBroken = true;
      }
      return {
        ...s,
        scope,
        scopeBroken,
        turns: Array.isArray(s.turns) ? s.turns : [],
        // v0.16 之前没有这两列：补 null / 空数组，与 native v12 迁移同口径
        documentId: s.documentId ?? null,
        documentIds: Array.isArray(s.documentIds)
          ? s.documentIds
          : s.documentId != null
            ? [s.documentId]
            : [],
        sourceIds: Array.isArray(s.sourceIds) ? s.sourceIds : [],
      };
    });
    pruneDone(cache!);
    // 旧版本文档没有版本与切片字段：补 0 / null，语义与 native v10 迁移一致 ——
    // 「有正文但没建索引」，需要用户主动准备才能问
    cache!.documents = (cache!.documents ?? []).map((d) => ({
      ...d,
      contentRevision: d.contentRevision ?? 0,
      indexedRevision: d.indexedRevision ?? 0,
      chunkCount: d.chunkCount ?? 0,
      contentSource: d.contentSource ?? null,
      // v0.16 之前全是导入的原件；摘要没有就空着，不要现算（正文可能几十万字）
      origin: d.origin ?? 'file',
      excerpt: d.excerpt ?? '',
    }));
    cache!.documentChunks = cache!.documentChunks ?? [];
  } catch {
    cache = empty();
  }
  return cache!;
}

function persist() {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(load()));
  } catch {
    // 配额超了也不该让 UI 崩，静默降级为内存态
  }
}

function nextId(d: WebDb) {
  return d.seq++;
}

function active(d: WebDb) {
  return d.fragments.filter((f) => f.mergedInto === null);
}

export const repo: Repo = {
  async init() {
    load();
  },

  async listFragments(limit = 500) {
    return [...load().fragments].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  },

  async findFragmentsByIds(ids) {
    if (!ids.length) return [];
    const want = new Set(ids);
    return load().fragments.filter((f) => want.has(f.id));
  },

  async listFragmentsBetween(from: number, to: number) {
    return load()
      .fragments.filter((f) => f.createdAt >= from && f.createdAt < to)
      .sort((a, b) => a.createdAt - b.createdAt);
  },

  async listFragmentIds(scope: OrganizeScope) {
    return (scope === 'all' ? active(load()) : load().fragments.filter((f) => f.status === 'inbox'))
      .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
      .map((f) => f.id);
  },

  async listFragmentsByIds(ids: number[]) {
    const set = new Set(ids);
    const byId = new Map(load().fragments.filter((f) => set.has(f.id)).map((f) => [f.id, f]));
    return ids.map((id) => byId.get(id)).filter((f): f is Fragment => !!f);
  },

  async countFragments(scope: OrganizeScope) {
    return (await this.listFragmentIds(scope)).length;
  },

  async insertFragment(
    content,
    source: FragmentSource,
    createdAt?: number,
    image?: { path: string; text?: string | null },
  ) {
    const d = load();
    const id = nextId(d);
    d.fragments.push({
      id,
      content: content.trim(),
      createdAt: createdAt ?? Date.now(),
      source,
      status: 'inbox',
      tags: [],
      project: null,
      mergedInto: null,
      nature: null,
      organizedAt: null,
      // 网页版没有相册和拍照，字段留着不填 —— 但它必须存在，
      // 否则同一个 Fragment 类型在两个端上形状不同，界面代码没法共用
      imagePath: image?.path ?? null,
      imageText: image?.text ?? null,
    });
    persist();
    return id;
  },

  async setFragmentImageText(id, text) {
    const d = load();
    const f = d.fragments.find((x) => x.id === id);
    if (f) f.imageText = text;
    persist();
  },

  async updateFragmentContent(id, content) {
    const d = load();
    const f = d.fragments.find((x) => x.id === id);
    if (f) f.content = content.trim();
    persist();
  },

  async markFragmentsOrganized(ids, at) {
    if (!ids.length) return;
    const d = load();
    const set = new Set(ids);
    for (const f of d.fragments) if (set.has(f.id)) f.organizedAt = at;
    persist();
  },

  async deleteFragment(id) {
    const d = load();
    const gone = d.fragments.find((x) => x.id === id);
    d.fragments = d.fragments.filter((x) => x.id !== id);
    // 并进它的那几条落回未整理，否则会变成「指向不存在的 id + status=merged」的孤儿
    d.fragments.forEach((x) => {
      if (x.mergedInto === id) {
        x.mergedInto = null;
        x.status = 'inbox';
      }
    });
    persist();
    return gone?.imagePath ?? null;
  },

  async applyTags(id, labels, project) {
    const d = load();
    const f = d.fragments.find((x) => x.id === id);
    if (f) {
      f.tags = dedupeTags(labels);
      f.project = project;
      // 已合并的不复活，理由同 repo.native.ts
      if (f.status !== 'merged') f.status = 'tagged';
    }
    persist();
  },

  async markMerged(dropIds, keepId) {
    const d = load();
    d.fragments.forEach((f) => {
      if (dropIds.includes(f.id)) {
        f.mergedInto = keepId;
        f.status = 'merged';
      }
    });
    persist();
  },

  async markStatus(ids, status: FragmentStatus) {
    const d = load();
    d.fragments.forEach((f) => {
      if (ids.includes(f.id) && f.status !== 'merged') f.status = status;
    });
    persist();
  },

  async setFragmentNature(ids, nature: FragmentNature) {
    const d = load();
    d.fragments.forEach((f) => {
      if (ids.includes(f.id)) f.nature = nature;
    });
    persist();
  },

  async countInbox() {
    return load().fragments.filter((f) => f.status === 'inbox').length;
  },

  async searchFragments(query, limit = 40) {
    const tokens = tokenizeText(query);
    if (!tokens.length) return [];
    const scored: { f: Fragment; score: number }[] = [];
    for (const f of active(load())) {
      const hay = `${f.content} ${f.tags.join(' ')} ${f.project ?? ''}`.toLowerCase();
      let score = 0;
      for (const t of tokens) if (hay.includes(t)) score += t.length >= 2 ? 2 : 1;
      if (score > 0) scored.push({ f, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || b.f.createdAt - a.f.createdAt)
      .slice(0, limit)
      .map((x) => x.f);
  },

  async rebuildSearchIndex() {
    return { indexed: active(load()).length };
  },

  // 浏览器端没有独立索引：搜索是当场遍历，所以「索引条数」恒等于碎片条数。
  // 界面上的自检在这儿仍然有意义 —— 它证明的是搜索这条路通不通。
  async searchIndexStats() {
    const list = active(load());
    return { indexed: list.length, total: list.length };
  },

  async selfTestSearch(samples = 5) {
    // 与 repo.native.ts 同一套口径，改一处必须同步另一处
    const list = active(load()).filter((f) => f.content.length >= 14);
    const picked = list.slice(0, samples);

    let checked = 0;
    let hit = 0;
    let viaDuplicate = 0;
    const misses: { id: number; needle: string; foundIds: number[] }[] = [];

    for (const f of picked) {
      const chars = Array.from(f.content);
      const needles = [chars.slice(3, 9).join(''), chars.slice(8, 14).join('')]
        .map((x) => x.trim())
        .filter((x) => x && tokenizeText(x).length > 0);

      if (!needles.length) continue;
      checked++;

      let ok = false;
      let dup = false;
      let lastFound: number[] = [];

      for (const needle of needles) {
        const found = await this.searchFragments(needle, 50);
        if (found.some((x) => x.id === f.id)) {
          ok = true;
          break;
        }
        if (found.some((x) => x.content === f.content)) {
          ok = true;
          dup = true;
          break;
        }
        lastFound = found.slice(0, 3).map((x) => x.id);
      }

      if (ok) {
        hit++;
        if (dup) viaDuplicate++;
      } else {
        misses.push({ id: f.id, needle: needles[0], foundIds: lastFound });
      }
    }

    return { checked, hit, viaDuplicate, misses };
  },

  async insertTodo(input) {
    const d = load();
    const id = nextId(d);
    d.todos.push({
      id,
      text: input.text,
      dueAt: input.dueAt,
      done: false,
      doneAt: null,
      sourceFragmentId: input.sourceFragmentId,
      createdAt: Date.now(),
      mergedInto: null,
      parentId: input.parentId,
    });
    // 给已完成的父项加子项 = 这件事还没完，父项退回未完成（与 native 同口径）
    if (input.parentId !== null) {
      const parent = d.todos.find((t) => t.id === input.parentId);
      if (parent?.done) {
        parent.done = false;
        parent.doneAt = null;
      }
    }
    persist();
    return id;
  },

  async updateTodo(id, patch) {
    const d = load();
    const t = d.todos.find((x) => x.id === id);
    if (!t) return;
    if (patch.text !== undefined) {
      const text = patch.text.trim();
      // 空文字不写：想删就删，改成空只会留下一条看不见的待办
      if (text) t.text = text;
    }
    if (patch.dueAt !== undefined) t.dueAt = patch.dueAt;
    persist();
  },

  async listTodos() {
    return load()
      .todos.filter((t) => t.mergedInto === null)
      .sort(
        (a, b) =>
          Number(a.done) - Number(b.done) ||
          (b.doneAt ?? b.createdAt) - (a.doneAt ?? a.createdAt) ||
          b.id - a.id,
      );
  },

  async toggleTodo(id, done) {
    const d = load();
    // 只拿还在用的条目算级联：被合并掉的子项不该参与「父项是不是全做完了」
    const live = d.todos.filter((t) => t.mergedInto === null);
    const plan = planToggle(live, id, done);
    if (!plan.length) return;

    const now = Date.now();
    for (const step of plan) {
      const t = d.todos.find((x) => x.id === step.id);
      if (!t) continue;
      if (step.done) {
        t.done = true;
        // 已经是完成的不刷新时间（与 native 的 COALESCE 同口径）
        t.doneAt = t.doneAt ?? now;
      } else {
        t.done = false;
        t.doneAt = null;
      }
    }
    if (done) pruneDone(d);
    persist();
  },

  async deleteTodo(id) {
    const d = load();
    // 子项升为顶层而不是跟着删（与 native 同口径）
    for (const t of d.todos) if (t.parentId === id) t.parentId = null;
    d.todos = d.todos.filter((x) => x.id !== id);
    persist();
  },

  async mergeTodos(keepId, dropIds, text) {
    const d = load();
    const drops = dropIds.filter((id) => id !== keepId);
    const keep = d.todos.find((t) => t.id === keepId);
    if (keep && text) keep.text = text;
    for (const t of d.todos) {
      if (drops.includes(t.id)) t.mergedInto = keepId;
      // 被合并的父项挂着的子项跟到保留项下（与 native 同口径）
      if (t.parentId !== null && drops.includes(t.parentId)) t.parentId = keepId;
    }
    persist();
  },

  async listMergedTodos() {
    return load()
      .todos.filter((t) => t.mergedInto !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  async unmergeTodos(keepId) {
    const d = load();
    for (const t of d.todos) if (t.mergedInto === keepId) t.mergedInto = null;
    persist();
  },

  async listDoneTodoSourceIds() {
    const ids = load()
      .todos.filter((t) => t.done && t.sourceFragmentId !== null)
      .map((t) => t.sourceFragmentId as number);
    return Array.from(new Set(ids));
  },

  async insertNote(input) {
    const d = load();
    const id = nextId(d);
    d.notes.push({ id, ...input, createdAt: Date.now() });
    persist();
    return id;
  },

  async upsertNote(input) {
    const d = load();
    const hit = input.period
      ? d.notes.find((n) => n.type === input.type && n.period === input.period)
      : undefined;
    if (hit) {
      hit.title = input.title;
      hit.bodyMd = input.bodyMd;
      hit.createdAt = Date.now();
      persist();
      return { id: hit.id, replaced: true };
    }
    const id = nextId(d);
    d.notes.push({ id, ...input, createdAt: Date.now() });
    persist();
    return { id, replaced: false };
  },

  async listNotes(limit = 30) {
    return [...load().notes].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  },

  async findNote(type, period) {
    return load().notes.find((n) => n.type === type && n.period === period) ?? null;
  },

  async deleteNote(id) {
    const d = load();
    d.notes = d.notes.filter((x) => x.id !== id);
    persist();
  },

  async saveOrganizeSession(input) {
    const d = load();
    const id = nextId(d);
    const now = Date.now();
    d.sessions.push({
      id,
      scope: input.scope,
      pendingIds: input.pendingIds,
      cursor: input.cursor,
      plan: input.plan,
      contextSummary: input.contextSummary,
      finished: input.finished,
      createdAt: now,
      updatedAt: now,
    });
    persist();
    return id;
  },

  async updateOrganizeSession(id, patch) {
    const d = load();
    const s = d.sessions.find((x) => x.id === id);
    if (!s) return;
    if (patch.cursor !== undefined) s.cursor = patch.cursor;
    if (patch.plan !== undefined) s.plan = patch.plan;
    if (patch.contextSummary !== undefined) s.contextSummary = patch.contextSummary;
    if (patch.finished !== undefined) s.finished = patch.finished;
    s.updatedAt = Date.now();
    persist();
  },

  async findUnfinishedOrganizeSession() {
    return (
      [...load().sessions]
        .filter((s) => !s.finished)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
    );
  },

  async finishOrganizeSession(id) {
    return this.updateOrganizeSession(id, { finished: true });
  },

  async deleteOrganizeSession(id) {
    const d = load();
    d.sessions = d.sessions.filter((s) => s.id !== id);
    persist();
  },

  async listAskSessions(includeArchived = false) {
    return load()
      .askSessions.filter((s) => includeArchived || !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async findAskSession(id) {
    return load().askSessions.find((s) => s.id === id) ?? null;
  },

  async saveAskSession(input) {
    const d = load();
    const now = Date.now();

    if (input.id !== undefined) {
      const s = d.askSessions.find((x) => x.id === input.id);
      if (!s) return input.id;
      // 与 native 一致：只改传进来的字段，undefined 保持原值
      s.title = input.title;
      s.turns = input.turns;
      s.scope = normalizeQaScope(input.scope);
      s.updatedAt = now;
      if (input.archived !== undefined) s.archived = input.archived;
      if (input.fragmentId !== undefined) s.fragmentId = input.fragmentId;
      persist();
      return s.id;
    }

    const id = nextId(d);
    d.askSessions.push({
      id,
      title: input.title,
      turns: input.turns,
      scope: normalizeQaScope(input.scope),
      archived: input.archived ?? false,
      fragmentId: input.fragmentId ?? null,
      documentId: null,
      documentIds: [],
      sourceIds: [],
      createdAt: input.createdAt,
      updatedAt: now,
    });
    persist();
    return id;
  },

  async setAskSessionArchived(id, archived) {
    const d = load();
    const s = d.askSessions.find((x) => x.id === id);
    if (s) s.archived = archived;
    // 不动 updatedAt，理由同 repo.native.ts
    persist();
  },

  async markAskSessionConverted(id, fragmentId) {
    const d = load();
    const s = d.askSessions.find((x) => x.id === id);
    if (s) s.fragmentId = fragmentId;
    persist();
  },

  async markAskSessionDocument(id, documentIds, sourceIds) {
    const d = load();
    const s = d.askSessions.find((x) => x.id === id);
    if (s) {
      const ids = documentIds ?? [];
      s.documentId = ids.length ? ids[0] : null;
      s.documentIds = ids;
      if (sourceIds) s.sourceIds = sourceIds;
    }
    persist();
  },

  async deleteAskSession(id) {
    const d = load();
    d.askSessions = d.askSessions.filter((s) => s.id !== id);
    persist();
  },

  async saveRun(input) {
    const d = load();
    const id = nextId(d);
    d.runs.push({ id, ...input, applied: 0 });
    persist();
    return id;
  },

  async markRunApplied(id) {
    const d = load();
    const r = d.runs.find((x) => x.id === id);
    if (r) r.applied = 1;
    persist();
  },

  async listDocuments() {
    // 与 native 一致：列表不返回正文
    return load()
      .documents.slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ bodyMd, ...meta }) => meta as DocumentMeta);
  },

  /** 标题、摘要、正文三处都查；与 native 同一口径，只是这里本来就在内存里 */
  async searchDocuments(query, limit = 50) {
    const q = query.trim().toLowerCase();
    const all = load()
      .documents.slice()
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const hit = !q
      ? all
      : all.filter(
          (d) =>
            d.name.toLowerCase().includes(q) ||
            (d.excerpt ?? '').toLowerCase().includes(q) ||
            d.bodyMd.toLowerCase().includes(q),
        );
    return hit.slice(0, limit).map(({ bodyMd, ...meta }) => meta as DocumentMeta);
  },

  async findDocument(id) {
    const d = load();
    const hit = d.documents.find((x) => x.id === id);
    return hit ? { ...hit } : null;
  },

  async insertDocument(input) {
    const d = load();
    const now = Date.now();
    const id = nextId(d);
    d.documents.push({
      id,
      name: input.name,
      ext: input.ext,
      size: input.size,
      fileUri: input.fileUri,
      bodyMd: '',
      pages: null,
      charCount: 0,
      state: input.state,
      error: null,
      contentRevision: 0,
      indexedRevision: 0,
      chunkCount: 0,
      contentSource: null,
      origin: input.origin ?? 'file',
      excerpt: input.excerpt ?? '',
      createdAt: now,
      updatedAt: now,
    });
    persist();
    return id;
  },

  async updateDocument(id, patch) {
    const d = load();
    const doc = d.documents.find((x) => x.id === id);
    if (!doc) return;
    if (patch.bodyMd !== undefined) {
      doc.bodyMd = patch.bodyMd;
      doc.charCount = patch.bodyMd.length;
    }
    if (patch.excerpt !== undefined) doc.excerpt = patch.excerpt;
    if (patch.pages !== undefined) doc.pages = patch.pages;
    if (patch.state !== undefined) doc.state = patch.state;
    if (patch.error !== undefined) doc.error = patch.error;
    doc.updatedAt = Date.now();
    persist();
  },

  async clearAskSessionDocuments(documentId) {
    const d = load();
    for (const s of d.askSessions) {
      // 多篇文档里删掉一篇：只摘掉这一篇，其余还在，徽标上的数量也要跟着少一
      const ids = (s.documentIds ?? []).filter((x) => x !== documentId);
      s.documentIds = ids;
      s.documentId = ids.length ? ids[0] : null;
    }
    persist();
  },

  async deleteDocument(id) {
    const d = load();
    d.documents = d.documents.filter((x) => x.id !== id);
    d.documentChunks = d.documentChunks.filter((c) => c.documentId !== id);
    persist();
  },

  async replaceDocumentContent(id, content, expectedRevision) {
    const d = load();
    const doc = d.documents.find((x) => x.id === id);
    // 与 native 同一口径：文档没了或版本已被推进，这次写入作废
    if (!doc || doc.contentRevision !== expectedRevision) return false;
    const next = expectedRevision + 1;
    doc.bodyMd = content.bodyMd;
    doc.charCount = content.bodyMd.length;
    doc.pages = content.pages;
    doc.state = 'done';
    doc.error = null;
    doc.contentRevision = next;
    doc.indexedRevision = next;
    doc.contentSource = content.source;
    doc.updatedAt = Date.now();
    d.documentChunks = d.documentChunks.filter((c) => c.documentId !== id);
    content.chunks.forEach((chunk, i) => {
      d.documentChunks.push({
        id: nextId(d),
        documentId: id,
        contentRevision: next,
        ordinal: i,
        text: chunk.text,
        locator: chunk.locator,
      });
    });
    doc.chunkCount = content.chunks.length;
    persist();
    return true;
  },

  async listDocumentChunks(documentId) {
    const d = load();
    const doc = d.documents.find((x) => x.id === documentId);
    if (!doc) return [];
    return d.documentChunks
      .filter((c) => c.documentId === documentId && c.contentRevision === doc.contentRevision)
      .sort((a, b) => a.ordinal - b.ordinal);
  },

  async searchDocumentChunks(query, documentIds, limit = 40) {
    if (!documentIds.length) return [];
    const allow = new Set(documentIds);
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const d = load();
    const revisions = new Map(d.documents.map((x) => [x.id, x.contentRevision]));
    return d.documentChunks
      .filter(
        (c) =>
          allow.has(c.documentId) &&
          c.contentRevision === revisions.get(c.documentId) &&
          c.text.toLowerCase().includes(needle),
      )
      .slice(0, limit);
  },

  async getSetting(key) {
    return load().settings[key] ?? null;
  },

  async setSetting(key, value) {
    load().settings[key] = value;
    persist();
  },

  async stats() {
    const d = load();
    return {
      total: d.fragments.length,
      // 「还没整理」= 从没进过某次整理并落库；口径和 native 版一致
      pending: d.fragments.filter((f) => f.organizedAt === null && f.mergedInto === null).length,
      // 被合并掉的待办不算「未完成」，和 native 版口径保持一致
      todoOpen: d.todos.filter((t) => !t.done && t.mergedInto === null).length,
    };
  },
};
