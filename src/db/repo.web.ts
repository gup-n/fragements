import type { Repo } from './types';
import { DONE_TODO_KEEP } from '../types';
import type {
  AskSession,
  DocProposal,
  DocTag,
  Document,
  DocumentChunk,
  DocumentContentInput,
  DocumentMeta,
  Fragment,
  FragmentSource,
  Note,
  QaScope,
  Todo,
  TrashEntry,
  TrashKind,
} from '../types';
import { normalizeQaScope } from '../util/qaScope';
import { planToggle } from '../util/todoTree';
import { dedupeTags, tokenizeText } from '../util/tokenize';
import { docTagKey, normalizeTagName } from '../util/docTags';
import { docImageNames, removeImageToken, resolvePendingTokens } from '../util/inlineImages';
import { fragmentSearchText } from '../util/fragmentText';
import { commitDraftEntries, draftCommitKey, positiveIds, readDraftReceipt, serializeDraftReceipt, validateDraftCommit } from './draftCommit';
import { dayKey } from '../util/date';
import { countChars } from '../util/text';
import { trashDetail, trashTitle } from '../util/trash';
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
  /**
   * v0.28 回收站。web 侧不像 SQLite 那样有一列 `deleted_at` 可加 ——
   * 这几个数组本来就存在 localStorage 里，硬塞一个字段等于改公开类型。
   * 所以只在库里记「谁被删了、什么时候删的」，读取时统一走 `isTrashed`。
   */
  trash: { kind: TrashKind; id: number; at: number }[];
  docTags: DocTag[];
  /** 文档 ↔ 标签。native 是 `doc_tag_links` 表 */
  docTagLinks: { documentId: number; tagId: number }[];
  docProposals: DocProposal[];
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
    trash: [],
    docTags: [],
    docTagLinks: [],
    docProposals: [],
  };
}

/** 这一条是不是在回收站里。**所有列表查询都要过它**，与 native 的 `deleted_at IS NULL` 同口径 */
function trashedAt(d: WebDb, kind: TrashKind, id: number): number | null {
  return d.trash.find((t) => t.kind === kind && t.id === id)?.at ?? null;
}

function isTrashed(d: WebDb, kind: TrashKind, id: number): boolean {
  return trashedAt(d, kind, id) !== null;
}

/**
 * 放进回收站。**先删同一条的旧记录**：native 那句
 * `UPDATE ... SET deleted_at = ?` 天然幂等，而 web 这里是数组 push ——
 * 重复删两次会多出一行，回收站条数比实际多，恢复时又会多算一次。
 */
function markTrashed(d: WebDb, kind: TrashKind, id: number): void {
  d.trash = d.trash.filter((t) => !(t.kind === kind && t.id === id));
  d.trash.push({ kind, id, at: Date.now() });
}

/** 没进回收站的碎片（含已合并的）。导出与备份要用全量 */
function liveFragments(d: WebDb): Fragment[] {
  return d.fragments.filter((f) => !isTrashed(d, 'fragment', f.id));
}


/** 彻底删除一批条目（web 侧）。与 native 的 purgeRefs 同口径 */
function purgeIn(d: WebDb, keys: Set<string>): string[] {
  const files: string[] = [];
  const hit = (kind: TrashKind, id: number) => keys.has(`${kind}:${id}`);

  for (const f of d.fragments) {
    if (!hit('fragment', f.id)) continue;
    for (const img of f.images) files.push(img.path);
  }
  d.fragments = d.fragments.filter((f) => !hit('fragment', f.id));

  const goneDocs = new Set(d.documents.filter((x) => hit('document', x.id)).map((x) => x.id));
  for (const doc of d.documents) {
    if (!hit('document', doc.id)) continue;
    if (doc.fileUri) files.push(doc.fileUri);
    // 内嵌图只有文件名、没有行 —— 正文一删就再也找不到它们
    for (const name of docImageNames(doc.bodyMd)) files.push(name);
  }
  d.documents = d.documents.filter((x) => !hit('document', x.id));
  d.documentChunks = d.documentChunks.filter((c) => !goneDocs.has(c.documentId));
  d.docTagLinks = d.docTagLinks.filter((l) => !goneDocs.has(l.documentId));
  if (goneDocs.size) {
    for (const s of d.askSessions) {
      const ids = (s.documentIds ?? []).filter((id) => !goneDocs.has(id));
      s.documentIds = ids;
      s.documentId = ids.length ? ids[0] : null;
    }
  }

  d.askSessions = d.askSessions.filter((s) => !hit('ask_session', s.id));
  d.trash = d.trash.filter((t) => !keys.has(`${t.kind}:${t.id}`));
  return files;
}

/** 时间轴上看得见的：没合并、也没进回收站 */
function active(d: WebDb): Fragment[] {
  return liveFragments(d).filter((f) => f.mergedInto === null);
}

function liveDocuments(d: WebDb): Document[] {
  return d.documents.filter((doc) => !isTrashed(d, 'document', doc.id));
}

function liveSessions(d: WebDb): AskSession[] {
  return d.askSessions.filter((s) => !isTrashed(d, 'ask_session', s.id));
}

/**
 * 给一批文档补上标签。只取 approved：AI 提的、用户还没点头的不参与分类
 * （与 native 的 attachDocTags 同口径）。
 */
function withTags(d: WebDb, docs: Document[]): Document[] {
  const byDoc = new Map<number, DocTag[]>();
  for (const link of d.docTagLinks) {
    const tag = d.docTags.find((t) => t.id === link.tagId);
    if (!tag || tag.state !== 'approved') continue;
    const bucket = byDoc.get(link.documentId) ?? [];
    bucket.push({ ...tag, count: 0 });
    byDoc.set(link.documentId, bucket);
  }
  return docs.map((doc) => ({ ...doc, tags: byDoc.get(doc.id) ?? [] }));
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
     *
     * 同一段还要补 `organizedAt` / `mergedInto` / `nature`：native 侧这几个
     * 是后加的列，旧行是 NULL；web 的旧数据里是 `undefined`，而 `active()` 与
     * `stats.pending` 都按 `=== null` 判断 —— 不补的话这些碎片既不出现在
     * 搜索结果里，也被算成「已整理」。
     */
    cache!.fragments = (cache!.fragments ?? []).map((f) => ({
      ...f,
      images: Array.isArray(f.images) ? f.images : [],
      organizedAt: f.organizedAt ?? null,
      mergedInto: f.mergedInto ?? null,
      nature: f.nature ?? null,
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
 * 唯一的写路径：在独立副本上操作，setItem 抛错时不发布 rows、seq 或提交凭据。
 * 回调必须同步，不可调用公开的 async Repo 方法。
 *
 * 没有 localStorage 时**显式报错**而不是退回内存态 —— 后者会让「没存上」
 * 看起来像「存上了」，刷新之后用户才发现记录不见了。
 */
function writeAtomically<T>(write: (d: WebDb) => T): T {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error('这个浏览器没有可用的本地存储，改动无法保存');
  const draft: WebDb = JSON.parse(JSON.stringify(load()));
  const result = write(draft);
  const serialized = JSON.stringify(draft);
  // 不捕获配额/权限等错误：调用方必须知道没有成功保存，cache 也仍是旧版本。
  storage.setItem(KEY, serialized);
  cache = draft;
  return result;
}

function nextId(d: WebDb) {
  return d.seq++;
}

/**
 * 写正文与切片、推进版本号。**调用方拥有事务副本**。
 * 版本号对不上返回 false，由调用方决定要不要抛。
 */
function applyContentIn(
  d: WebDb,
  id: number,
  content: DocumentContentInput,
  expectedRevision: number,
): boolean {
  const doc = d.documents.find((x) => x.id === id);
  if (!doc || doc.contentRevision !== expectedRevision) return false;
  const next = expectedRevision + 1;
  doc.bodyMd = content.bodyMd;
  doc.charCount = countChars(content.bodyMd);
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
  return true;
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
            charCount: countChars(content.bodyMd),
            state: 'done',
            error: null,
            contentRevision: 1,
            indexedRevision: 1,
            chunkCount: content.chunks.length,
            contentSource: content.source,
            origin: 'knowledge',
            originId: null,
            stage: 'library',
            tags: [],
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
        for (const f of d.fragments) {
          // 整理期间被删掉的来源不要再打「已整理」，理由同 native
          if (sources.has(f.id) && !isTrashed(d, 'fragment', f.id)) f.organizedAt = now;
        }
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
    return [...liveFragments(load())].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  },

  async totalFragments() {
    return liveFragments(load()).length;
  },

  async listFragmentsPage(offset: number, limit: number) {
    return [...liveFragments(load())]
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
      .slice(offset, offset + limit);
  },

  async dayCounts() {
    // 没有 SQL，就在 JS 里数一遍；口径与 native 的 strftime(…,'localtime') 一致
    const buckets = new Map<string, { count: number; chars: number }>();
    for (const f of liveFragments(load())) {
      const key = dayKey(f.createdAt);
      const row = buckets.get(key) ?? { count: 0, chars: 0 };
      row.count += 1;
      row.chars += f.content.length;
      buckets.set(key, row);
    }
    return Array.from(buckets, ([day, row]) => ({ day, count: row.count, chars: row.chars })).sort((a, b) =>
      a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
    );
  },

  async monthCounts() {
    return countByMonth(liveFragments(load()));
  },

  async listFragments(limit = 500) {
    return [...liveFragments(load())]
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
      .slice(0, limit);
  },

  async findFragmentsByIds(ids) {
    if (!ids.length) return [];
    const want = new Set(ids);
    return liveFragments(load()).filter((f) => want.has(f.id));
  },

  async listFragmentsBetween(from: number, to: number) {
    return liveFragments(load())
      .filter((f) => f.createdAt >= from && f.createdAt < to)
      .sort((a, b) => a.createdAt - b.createdAt);
  },

  async listFragmentsByIds(ids: number[]) {
    const set = new Set(ids);
    const byId = new Map(liveFragments(load()).filter((f) => set.has(f.id)).map((f) => [f.id, f]));
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
      if (!fragment || isTrashed(d, 'fragment', fragmentId)) {
        throw new Error('这条碎片已经不存在，或已在回收站');
      }
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

  async setFragmentImageText(imageId, text) {
    writeAtomically((d) => {
      for (const f of d.fragments) {
        if (isTrashed(d, 'fragment', f.id)) continue;
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
      if (!f || isTrashed(d, 'fragment', id)) {
        throw new Error('这条碎片不存在或已在回收站，改动没有保存');
      }
      f.content = content.trim();
    });
  },

  async markFragmentsOrganized(ids, at) {
    if (!ids.length) return;
    writeAtomically((d) => {
      const set = new Set(ids);
      for (const f of d.fragments) {
        if (!set.has(f.id) || isTrashed(d, 'fragment', f.id)) continue;
        f.organizedAt = at;
      }
    });
  },

  async deleteFragment(id) {
    // 软删：只记「谁、什么时候」。文件与配图行都不动，30 天内恢复还看得见图。
    // 并进它的那几条仍然落回未整理 —— 理由同 repo.native.ts
    return writeAtomically((d) => {
      markTrashed(d, 'fragment', id);
      for (const x of d.fragments) {
        if (x.mergedInto === id) {
          x.mergedInto = null;
          x.status = 'inbox';
        }
      }
      return [];
    });
  },

  async applyTags(id, labels, project) {
    writeAtomically((d) => {
      // 已在回收站的碎片不接受写入，理由同 repo.native.ts
      if (isTrashed(d, 'fragment', id)) return;
      const f = d.fragments.find((x) => x.id === id);
      if (!f) return;
      f.tags = dedupeTags(labels);
      f.project = project;
      // 已合并的不复活，理由同 repo.native.ts
      if (f.status !== 'merged') f.status = 'tagged';
    });
  },

  async searchFragments(query, limit = 40, offset = 0) {
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
      .sort((a, b) => b.score - a.score || b.f.createdAt - a.f.createdAt || b.f.id - a.f.id)
      .slice(offset, offset + limit)
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
    return writeAtomically((d) => {
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
      return id;
    });
  },

  async updateTodo(id, patch) {
    writeAtomically((d) => {
      const t = d.todos.find((x) => x.id === id);
      if (!t) return;
      if (patch.text !== undefined) {
        const text = patch.text.trim();
        // 空文字不写：想删就删，改成空只会留下一条看不见的待办
        if (text) t.text = text;
      }
      if (patch.dueAt !== undefined) t.dueAt = patch.dueAt;
    });
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
    // 只拿还在用的条目算级联：被合并掉的子项不该参与「父项是不是全做完了」
    const plan = planToggle(
      load().todos.filter((t) => t.mergedInto === null),
      id,
      done,
    );
    if (!plan.length) return;

    const now = Date.now();
    writeAtomically((d) => {
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
    });
  },

  async deleteTodo(id) {
    writeAtomically((d) => {
      // 子项升为顶层而不是跟着删（与 native 同口径）
      for (const t of d.todos) if (t.parentId === id) t.parentId = null;
      d.todos = d.todos.filter((x) => x.id !== id);
    });
  },

  async mergeTodos(keepId, dropIds, text) {
    writeAtomically((d) => {
      const drops = dropIds.filter((id) => id !== keepId);
      const keep = d.todos.find((t) => t.id === keepId);
      if (keep && text) keep.text = text;
      for (const t of d.todos) {
        if (drops.includes(t.id)) t.mergedInto = keepId;
        // 被合并的父项挂着的子项跟到保留项下（与 native 同口径）
        if (t.parentId !== null && drops.includes(t.parentId)) t.parentId = keepId;
      }
    });
  },

  async listMergedTodos() {
    return load()
      .todos.filter((t) => t.mergedInto !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  async unmergeTodos(keepId) {
    writeAtomically((d) => {
      for (const t of d.todos) if (t.mergedInto === keepId) t.mergedInto = null;
    });
  },

  async listDoneTodoSourceIds() {
    const ids = load()
      .todos.filter((t) => t.done && t.sourceFragmentId !== null)
      .map((t) => t.sourceFragmentId as number);
    return Array.from(new Set(ids));
  },

  async insertNote(input) {
    return writeAtomically((d) => {
      const id = nextId(d);
      d.notes.push({ id, ...input, createdAt: Date.now() });
      return id;
    });
  },

  async upsertNote(input) {
    return writeAtomically((d) => {
      const hit = input.period
        ? d.notes.find((n) => n.type === input.type && n.period === input.period)
        : undefined;
      if (hit) {
        hit.title = input.title;
        hit.bodyMd = input.bodyMd;
        hit.createdAt = Date.now();
        return { id: hit.id, replaced: true };
      }
      const id = nextId(d);
      d.notes.push({ id, ...input, createdAt: Date.now() });
      return { id, replaced: false };
    });
  },

  async listNotes(limit = 30) {
    return [...load().notes].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  },

  async findNote(type, period) {
    return load().notes.find((n) => n.type === type && n.period === period) ?? null;
  },

  async deleteNote(id) {
    writeAtomically((d) => {
      d.notes = d.notes.filter((x) => x.id !== id);
    });
  },

  async listAskSessions(includeArchived = false) {
    return liveSessions(load())
      .filter((s) => includeArchived || !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async findAskSession(id) {
    return liveSessions(load()).find((s) => s.id === id) ?? null;
  },

  async saveAskSession(input) {
    const now = Date.now();
    return writeAtomically((d) => {
      if (input.id !== undefined) {
        // 与 native 一致：回收站里的会话不再接受写入
        const s = liveSessions(d).find((x) => x.id === input.id);
        if (!s) throw new Error('这场会话已被删除，这次回答没能保存');
        // 与 native 一致：只改传进来的字段，undefined 保持原值
        s.title = input.title;
        s.turns = input.turns;
        s.scope = normalizeQaScope(input.scope);
        s.updatedAt = now;
        if (input.archived !== undefined) s.archived = input.archived;
        if (input.fragmentId !== undefined) s.fragmentId = input.fragmentId;
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
      return id;
    });
  },

  async setAskSessionArchived(id, archived) {
    writeAtomically((d) => {
      // 与 native 一致：不动 updatedAt
      if (isTrashed(d, 'ask_session', id)) return;
      const s = d.askSessions.find((x) => x.id === id);
      if (s) s.archived = archived;
    });
  },

  async markAskSessionDocument(id, documentIds, sourceIds) {
    writeAtomically((d) => {
      if (isTrashed(d, 'ask_session', id)) return;
      const s = d.askSessions.find((x) => x.id === id);
      if (s) {
        const ids = documentIds ?? [];
        s.documentId = ids.length ? ids[0] : null;
        s.documentIds = ids;
        if (sourceIds) s.sourceIds = sourceIds;
      }
    });
  },

  async deleteAskSession(id) {
    writeAtomically((d) => {
      markTrashed(d, 'ask_session', id);
    });
  },

  async listDocuments() {
    // 与 native 一致：列表不返回正文
    const d = load();
    return withTags(d, liveDocuments(d))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ bodyMd, ...meta }) => meta as DocumentMeta);
  },

  /** 标题、摘要、正文三处都查；与 native 同一口径，只是这里本来就在内存里 */
  async searchDocuments(query, limit = 50) {
    const q = query.trim().toLowerCase();
    const db = load();
    const all = withTags(db, liveDocuments(db)).sort((a, b) => b.updatedAt - a.updatedAt);
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
    const hit = liveDocuments(d).find((x) => x.id === id);
    return hit ? { ...withTags(d, [hit])[0] } : null;
  },

  async insertDocument(input) {
    return writeAtomically((d) => {
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
        originId: input.originId ?? null,
        stage: input.stage ?? 'library',
        tags: [],
        excerpt: input.excerpt ?? '',
        createdAt: now,
        updatedAt: now,
      });
      return id;
    });
  },

  async createDocumentWithContent(input) {
    /*
     * 记录、正文+切片、标签在**同一次发布**里。分成三步调用时，第二步失败会
     * 留下一篇空壳：它在列表里看得见、点开是空的，也没有任何任务会去补它。
     */
    return writeAtomically((d) => {
      const now = Date.now();
      const id = nextId(d);
      d.documents.push({
        id,
        name: input.name,
        ext: input.ext,
        size: input.size,
        fileUri: null,
        bodyMd: '',
        pages: null,
        charCount: 0,
        state: 'parsing',
        error: null,
        contentRevision: 0,
        indexedRevision: 0,
        chunkCount: 0,
        contentSource: null,
        origin: input.origin ?? 'authored',
        originId: input.originId ?? null,
        stage: 'library',
        tags: [],
        excerpt: input.excerpt ?? '',
        createdAt: now,
        updatedAt: now,
      });
      // 刚插的记录版本号必然是 0；走不到 false，走到了说明有人并发改了它
      if (!applyContentIn(d, id, input.content, 0)) {
        throw new Error('文档刚被改过，正文没有写进去');
      }
      for (const raw of input.tagNames ?? []) {
        const name = normalizeTagName(raw);
        if (!name) continue;
        const key = docTagKey(name);
        let tagId = d.docTags.find((t) => docTagKey(t.name) === key)?.id;
        if (tagId === undefined) {
          const created: DocTag = {
            id: nextId(d),
            name,
            state: input.tagState ?? 'approved',
            createdAt: now,
            count: 0,
          };
          d.docTags.push(created);
          tagId = created.id;
        }
        if (!d.docTagLinks.some((l) => l.documentId === id && l.tagId === tagId)) {
          d.docTagLinks.push({ documentId: id, tagId });
        }
      }
      return id;
    });
  },

  async updateDocument(id, patch) {
    writeAtomically((d) => {
      // 与 native 一致：回收站里的文档不接受迟到的改名 / 改正文
      if (isTrashed(d, 'document', id)) return;
      const doc = d.documents.find((x) => x.id === id);
      if (!doc) return;
      if (patch.name !== undefined) doc.name = patch.name.trim() || '未命名文档';
      if (patch.bodyMd !== undefined) {
        doc.bodyMd = patch.bodyMd;
        doc.charCount = countChars(patch.bodyMd);
      }
      if (patch.excerpt !== undefined) doc.excerpt = patch.excerpt;
      if (patch.pages !== undefined) doc.pages = patch.pages;
      if (patch.state !== undefined) doc.state = patch.state;
      if (patch.error !== undefined) doc.error = patch.error;
      doc.updatedAt = Date.now();
    });
  },

  async clearAskSessionDocuments(documentId) {
    writeAtomically((d) => {
      for (const s of d.askSessions) {
        // 多篇文档里删掉一篇：只摘掉这一篇，其余还在，徽标上的数量也要跟着少一
        const ids = (s.documentIds ?? []).filter((x) => x !== documentId);
        s.documentIds = ids;
        s.documentId = ids.length ? ids[0] : null;
      }
    });
  },

  async deleteDocument(id) {
    // 软删：切片留着（可重建的投影），检索路径会按 liveDocuments 过滤掉它
    writeAtomically((d) => {
      markTrashed(d, 'document', id);
    });
  },

  async replaceDocumentContent(id, content, expectedRevision) {
    /*
     * 先只读判断，免得为一次注定失败的写入做整库深拷贝。
     * 与 native 同一口径：文档没了、已在回收站、或版本已被推进，这次写入作废。
     */
    const snapshot = load();
    const current = snapshot.documents.find((x) => x.id === id);
    if (!current || isTrashed(snapshot, 'document', id) || current.contentRevision !== expectedRevision) {
      return false;
    }
    return writeAtomically((d) => applyContentIn(d, id, content, expectedRevision));
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
    const revisions = new Map(liveDocuments(d).map((x) => [x.id, x.contentRevision]));
    return d.documentChunks
      .filter(
        (c) =>
          allow.has(c.documentId) &&
          c.contentRevision === revisions.get(c.documentId) &&
          c.text.toLowerCase().includes(needle),
      )
      .slice(0, limit);
  },

  /* ---------------- 回收站（v0.28） ---------------- */

  async listTrash() {
    const d = load();
    const entries: TrashEntry[] = d.trash.map((item) => {
      const at = item.at;
      if (item.kind === 'fragment') {
        const f = d.fragments.find((x) => x.id === item.id);
        const text = f?.content ?? '';
        return {
          kind: 'fragment', id: item.id, deletedAt: at,
          title: trashTitle('fragment', text),
          detail: trashDetail('fragment', countChars(text), 0),
          files: (f?.images ?? []).map((i) => i.path),
        };
      }
      if (item.kind === 'document') {
        const doc = d.documents.find((x) => x.id === item.id);
        return {
          kind: 'document', id: item.id, deletedAt: at,
          title: trashTitle('document', doc?.name ?? ''),
          detail: trashDetail('document', doc?.charCount ?? 0, 0),
          files: doc?.fileUri ? [doc.fileUri] : [],
        };
      }
      const s = d.askSessions.find((x) => x.id === item.id);
      const turns = s?.turns?.length ?? 0;
      return {
        kind: 'ask_session', id: item.id, deletedAt: at,
        title: trashTitle('ask_session', s?.title ?? ''),
        detail: trashDetail('ask_session', 0, turns),
        files: [],
      };
    });
    return entries.sort((a, b) => b.deletedAt - a.deletedAt || b.id - a.id);
  },

  async trashCount() {
    return load().trash.length;
  },

  async restoreTrash(refs) {
    if (!refs.length) return 0;
    return writeAtomically((d) => {
      const keys = new Set(refs.map((r) => `${r.kind}:${r.id}`));
      const before = d.trash.length;
      d.trash = d.trash.filter((t) => !keys.has(`${t.kind}:${t.id}`));
      return before - d.trash.length;
    });
  },

  async purgeTrash(refs) {
    if (!refs.length) return [];
    return writeAtomically((d) => purgeIn(d, new Set(refs.map((r) => `${r.kind}:${r.id}`))));
  },

  async purgeExpiredTrash(before) {
    return writeAtomically((d) => {
      const expired = new Set(d.trash.filter((t) => t.at < before).map((t) => `${t.kind}:${t.id}`));
      return purgeIn(d, expired);
    });
  },

  /* ---------------- 文档标签（v0.28，平铺） ---------------- */

  async listDocTags() {
    const d = load();
    const counts = new Map<number, number>();
    for (const link of d.docTagLinks) {
      const doc = liveDocuments(d).find((x) => x.id === link.documentId);
      if (!doc || doc.stage !== 'library') continue;
      counts.set(link.tagId, (counts.get(link.tagId) ?? 0) + 1);
    }
    return d.docTags
      .map((tag) => ({ ...tag, count: counts.get(tag.id) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  },

  async createDocTag(name, state = 'approved') {
    const clean = normalizeTagName(name);
    if (!clean) throw new Error('标签名不能为空');
    return writeAtomically((d) => {
      // 比较键折叠全半角与大小写：「ＡＩ」不该在「AI」旁边再长一条
      const key = docTagKey(clean);
      const existing = d.docTags.find((t) => docTagKey(t.name) === key);
      if (existing) return { ...existing };
      const tag: DocTag = { id: nextId(d), name: clean, state, createdAt: Date.now(), count: 0 };
      d.docTags.push(tag);
      return { ...tag };
    });
  },

  async deleteDocTag(id) {
    writeAtomically((d) => {
      d.docTags = d.docTags.filter((t) => t.id !== id);
      d.docTagLinks = d.docTagLinks.filter((l) => l.tagId !== id);
    });
  },

  async setDocumentTags(documentId, tagIds) {
    const want = Array.from(new Set(tagIds.filter((n) => Number.isFinite(n))));
    writeAtomically((d) => {
      d.docTagLinks = d.docTagLinks.filter((l) => l.documentId !== documentId || want.includes(l.tagId));
      for (const tagId of want) {
        if (!d.docTagLinks.some((l) => l.documentId === documentId && l.tagId === tagId)) {
          d.docTagLinks.push({ documentId, tagId });
        }
      }
    });
  },

  async setDocumentStage(id, stage) {
    writeAtomically((d) => {
      const doc = d.documents.find((x) => x.id === id);
      if (doc) {
        doc.stage = stage;
        doc.updatedAt = Date.now();
      }
    });
  },

  /* ---------------- AI 提案（v0.28） ---------------- */

  async insertProposal(input) {
    return writeAtomically((d) => {
      const id = nextId(d);
      d.docProposals.push({
        id,
        kind: input.kind,
        documentId: input.documentId,
        payload: input.payload,
        state: 'pending',
        createdAt: Date.now(),
        decidedAt: null,
      });
      return id;
    });
  },

  async findProposal(id) {
    const hit = load().docProposals.find((p) => p.id === id);
    return hit ? { ...hit, payload: { ...hit.payload } } : null;
  },

  async decideProposal(id, state) {
    writeAtomically((d) => {
      const p = d.docProposals.find((x) => x.id === id);
      if (p) {
        p.state = state;
        p.decidedAt = Date.now();
      }
    });
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
    const live = liveFragments(d);
    return {
      total: live.length,
      // 「还没整理」= 从没进过某次整理并落库；口径和 native 版一致
      pending: live.filter((f) => f.organizedAt === null && f.mergedInto === null).length,
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

  async restoreSafetyCopy() {
    throw new Error('网页版没有恢复点，请在手机上操作');
  },
};
