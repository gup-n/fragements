import type { Repo } from './types';
import { DONE_TODO_KEEP } from '../types';
import type {
  AskSession,
  Document,
  DocumentChunk,
  DocumentMeta,
  Fragment,
  FragmentSource,
  Note,
  QaScope,
  Todo,
} from '../types';
import { normalizeQaScope } from '../util/qaScope';
import { planToggle } from '../util/todoTree';
import { dedupeTags, tokenizeText } from '../util/tokenize';
import { removeImageToken, resolvePendingTokens } from '../util/inlineImages';
import { fragmentSearchText } from '../util/fragmentText';
import { commitDraftEntries, draftCommitKey, positiveIds, readDraftReceipt, serializeDraftReceipt, validateDraftCommit } from './draftCommit';
import { dayKey } from '../util/date';
import { countByMonth } from '../util/digest';

/**
 * localStorage 存储适配，仅供桌面端编译校验；真机走 SQLite。
 * 不提供浏览器预览，行为与 native 版保持语义一致，便于内存桩回归。
 */

const KEY = 'fragments.webdb.v2';

interface WebDb {
  seq: number;
  fragments: Fragment[];
  todos: Todo[];
  notes: Note[];
  settings: Record<string, string>;
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
    settings: {},
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
    /*
     * v0.20：配图从 `imagePath` 一个标量变成 `images[]`。
     * 网页版本来就没有相册，老数据里不会有真图；这里只保证形状对得上 ——
     * 少一个 `images` 数组，界面 `f.images.length` 会直接抛异常。
     */
    cache!.fragments = (cache!.fragments ?? []).map((f) => ({
      ...f,
      images: Array.isArray(f.images) ? f.images : [],
    }));
  } catch (error) {
    // 读取/解析失败不等于空库；不能让下一次原子写入用空库覆盖仍存在的数据。
    // 清掉未完成规范化的缓存，下次调用可以重新读取；旧字段与规范化步骤不变。
    cache = null;
    throw error;
  }
  return cache!;
}

/**
 * 新写入路径只在独立副本上操作，setItem 抛错时不发布 rows、seq 或提交凭据。
 * 回调必须同步，不可调用公开的 async Repo 方法。没有 localStorage 时仅用于内存测试。
 */
function writeAtomically<T>(write: (d: WebDb) => T): T {
  const draft: WebDb = JSON.parse(JSON.stringify(load()));
  const result = write(draft);
  const serialized = JSON.stringify(draft);
  // 不捕获配额/权限等错误：调用方必须知道没有成功保存，cache 也仍是旧版本。
  globalThis.localStorage?.setItem(KEY, serialized);
  cache = draft;
  return result;
}

/** 旧接口的兼容写法；新增原子路径不得调用这个会吞掉持久化错误的函数。 */
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

/** 只操作事务副本；正文、图片和导入标签在同一次发布中生效。 */
function insertFragmentIn(
  d: WebDb,
  content: string,
  source: FragmentSource,
  createdAt: number,
  tags: string[] = [],
): Fragment {
  const fragment: Fragment = {
    id: nextId(d),
    content,
    createdAt,
    source,
    status: tags.length ? 'tagged' : 'inbox',
    tags: tags.slice(),
    project: null,
    mergedInto: null,
    nature: null,
    organizedAt: null,
    images: [],
  };
  d.fragments.push(fragment);
  return fragment;
}

function active(d: WebDb) {
  return d.fragments.filter((f) => f.mergedInto === null);
}

export const repo: Repo = {
  async init() {
    load();
  },

  async commitDraft(input) {
    validateDraftCommit(input);
    const key = draftCommitKey(input.draftId);
    return writeAtomically((d) => {
      const receipt = readDraftReceipt(d.settings[key]);
      const before = receipt.documents.length + receipt.todos.length;
      const now = Date.now();
      commitDraftEntries(input, receipt, {
        insertDocument: (doc) => {
          const id = nextId(d);
          const content = doc.content;
          d.documents.push({
            id,
            name: doc.title.trim(),
            ext: 'md',
            size: content.bodyMd.length,
            fileUri: null,
            bodyMd: content.bodyMd,
            pages: content.pages,
            charCount: content.bodyMd.length,
            state: 'done',
            error: null,
            contentRevision: 1,
            indexedRevision: 1,
            chunkCount: content.chunks.length,
            contentSource: content.source,
            origin: 'knowledge',
            excerpt: doc.excerpt,
            createdAt: now,
            updatedAt: now,
          });
          content.chunks.forEach((chunk, ordinal) => {
            d.documentChunks.push({
              id: nextId(d),
              documentId: id,
              contentRevision: 1,
              ordinal,
              text: chunk.text,
              locator: { ...chunk.locator },
            });
          });
          return id;
        },
        insertTodo: (text, dueAt, parentId) => {
          const id = nextId(d);
          d.todos.push({
            id, text, dueAt, parentId,
            done: false,
            doneAt: null,
            sourceFragmentId: null,
            createdAt: now,
            mergedInto: null,
          });
          return id;
        },
        findTodo: (id) => {
          const todo = d.todos.find((t) => t.id === id);
          return todo ? { parentId: todo.parentId, mergedInto: todo.mergedInto } : null;
        },
        reopenTodo: (id) => {
          const todo = d.todos.find((t) => t.id === id);
          if (todo) {
            todo.done = false;
            todo.doneAt = null;
          }
        },
      });

      // 只有新增了实际条目才推进来源/会话关系；重复调用不能冒充一次新的整理。
      if (receipt.documents.length + receipt.todos.length > before) {
        const sourceIds = positiveIds(input.sourceIds);
        const sources = new Set(sourceIds);
        for (const f of d.fragments) if (sources.has(f.id)) f.organizedAt = now;
        const session = input.sessionId === null
          ? undefined
          : d.askSessions.find((s) => s.id === input.sessionId);
        // 迟到写入不复活已删除的会话；旧文档关联与累计凭据合并，只保留仍在库里的文档。
        if (session) {
          const existingDocuments = new Set(d.documents.map((doc) => doc.id));
          const ids = positiveIds([
            ...positiveIds(session.documentIds), session.documentId,
            ...receipt.documents.map((doc) => doc.id),
          ]).filter((id) => existingDocuments.has(id));
          session.documentIds = ids;
          session.documentId = ids[0] ?? null;
          session.sourceIds = positiveIds([...positiveIds(session.sourceIds), ...sourceIds]);
        }
      }
      d.settings[key] = serializeDraftReceipt(receipt);
      return receipt;
    });
  },

  async listAllFragments() {
    return [...load().fragments].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  },

  async totalFragments() {
    return load().fragments.length;
  },

  async listFragmentsPage(offset: number, limit: number) {
    return [...load().fragments]
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
      .slice(offset, offset + limit);
  },

  async dayCounts() {
    // 没有 SQL，就在 JS 里数一遍；口径与 native 的 strftime(…,'localtime') 一致
    const buckets = new Map<string, number>();
    for (const f of load().fragments) {
      const key = dayKey(f.createdAt);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return Array.from(buckets, ([day, count]) => ({ day, count })).sort((a, b) =>
      a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
    );
  },

  async monthCounts() {
    return countByMonth(load().fragments);
  },

  async listFragments(limit = 500) {
    return [...load().fragments]
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
      .slice(0, limit);
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

  async listFragmentsByIds(ids: number[]) {
    const set = new Set(ids);
    const byId = new Map(load().fragments.filter((f) => set.has(f.id)).map((f) => [f.id, f]));
    return ids.map((id) => byId.get(id)).filter((f): f is Fragment => !!f);
  },

  async insertFragment(
    content,
    source: FragmentSource,
    createdAt?: number,
    images?: { path: string; text?: string | null; key?: string }[],
  ) {
    const text = content.trim();
    const pictures = images ?? [];
    if (!text && !pictures.length) throw new Error('记录没有正文或图片');
    if (pictures.length > 9 || pictures.some((img) => !img.path)) throw new Error('配图数量或路径无效');
    const at = createdAt ?? Date.now();
    return writeAtomically((d) => {
      const fragment = insertFragmentIn(d, text, source, at);
      const mapping: { key: string; imageId: number }[] = [];
      fragment.images = pictures.map((image) => {
        const id = nextId(d);
        if (image.key) mapping.push({ key: image.key, imageId: id });
        return { id, path: image.path, text: image.text ?? null, createdAt: at };
      });
      fragment.content = resolvePendingTokens(text, mapping);
      return fragment.id;
    });
  },

  async insertImportedFragment(content, createdAt, tags) {
    const text = content.trim();
    if (!text || !Number.isFinite(createdAt)) throw new Error('导入内容或时间无效');
    const clean = dedupeTags(tags);
    return writeAtomically((d) => insertFragmentIn(d, text, 'import', createdAt, clean).id);
  },

  async insertFragmentImages(fragmentId, images) {
    if (!images.length) return [];
    return writeAtomically((d) => {
      const fragment = d.fragments.find((f) => f.id === fragmentId);
      if (!fragment) throw new Error('这条碎片已经不存在');
      if (fragment.images.length + images.length > 9 || images.some((img) => !img.path)) {
        throw new Error('一条碎片最多9张有效配图');
      }
      const at = Date.now();
      const added = images.map((image) => ({
        id: nextId(d),
        path: image.path,
        text: image.text ?? null,
        createdAt: at,
      }));
      fragment.images.push(...added);
      // 返回值不暴露事务发布后的图片对象，调用方修改数组不会偷偷改动 cache。
      return added.map((image) => ({ ...image }));
    });
  },

  async insertFragmentImage(fragmentId, path) {
    return (await repo.insertFragmentImages(fragmentId, [{ path }]))[0].id;
  },

  async setFragmentImageText(imageId, text) {
    writeAtomically((d) => {
      for (const f of d.fragments) {
        const img = f.images.find((i) => i.id === imageId);
        if (img) {
          img.text = text;
          break;
        }
      }
    });
  },

  async deleteFragmentImage(imageId) {
    return writeAtomically((d) => {
      for (const f of d.fragments) {
        const i = f.images.findIndex((x) => x.id === imageId);
        if (i >= 0) {
          const path = f.images[i].path;
          f.images.splice(i, 1);
          f.content = removeImageToken(f.content, imageId);
          return path;
        }
      }
      return null;
    });
  },

  async updateFragmentContent(id, content) {
    writeAtomically((d) => {
      const f = d.fragments.find((x) => x.id === id);
      if (f) f.content = content.trim();
    });
  },

  async markFragmentsOrganized(ids, at) {
    if (!ids.length) return;
    const d = load();
    const set = new Set(ids);
    for (const f of d.fragments) if (set.has(f.id)) f.organizedAt = at;
    persist();
  },

  async deleteFragment(id) {
    return writeAtomically((d) => {
      const gone = d.fragments.find((x) => x.id === id);
      d.fragments = d.fragments.filter((x) => x.id !== id);
      // 并进它的那几条落回未整理，否则会变成「指向不存在的 id + status=merged」的孤儿
      d.fragments.forEach((x) => {
        if (x.mergedInto === id) {
          x.mergedInto = null;
          x.status = 'inbox';
        }
      });
      return (gone?.images ?? []).map((i) => i.path);
    });
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

  async searchFragments(query, limit = 40) {
    const tokens = tokenizeText(query);
    if (!tokens.length) return [];
    const scored: { f: Fragment; score: number }[] = [];
    for (const f of active(load())) {
      // 与 native 的可见投影相同：正文 + 图文字 + 事项，不含已经下线的旧标签。
      const hay = fragmentSearchText(f).toLowerCase();
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
    writeAtomically((d) => {
      d.settings = { ...d.settings, [key]: value };
    });
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

  /* ---------------- 完整备份（网页版不支持） ---------------- */

  /*
   * 不 import `./backup`：tsc 只认 `.ts`，会把 native 版一起拉进来
   * （Metro 才按平台挑 `.web.ts`）。这里的实现本来就只有一句拒绝，直接写在这。
   */
  async exportBackup() {
    throw new Error('网页版没有完整备份（没有私有目录和本地数据库文件），请在手机上操作');
  },

  async restoreBackup() {
    throw new Error('网页版不能从备份恢复，请在手机上操作');
  },

  async peekBackup() {
    throw new Error('网页版不能读取备份包，请在手机上操作');
  },

  async listSafetyCopies() {
    return [];
  },
};
