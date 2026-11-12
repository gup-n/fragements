import * as SQLite from 'expo-sqlite';
import type { Repo, OrganizeSessionPatch } from './types';
import { parseTags } from './types';
import { DONE_TODO_KEEP } from '../types';
import type {
  AskSession,
  Document,
  DocumentChunk,
  DocumentContentInput,
  DocumentLocator,
  DocumentMeta,
  Fragment,
  FragmentImage,
  FragmentNature,
  FragmentSource,
  FragmentStatus,
  Note,
  OrganizePlan,
  OrganizeScope,
  OrganizeSession,
  QaScope,
  QaTurn,
  TagStat,
  Todo,
} from '../types';
import { normalizePlan } from '../util/organizePlan';
import { normalizeQaScope } from '../util/qaScope';
import { planToggle } from '../util/todoTree';
import { buildFtsQuery, dedupeTags, indexText, likeNeedle, tokenizeText } from '../util/tokenize';
import { stripImageTokens } from '../util/inlineImages';

let _db: SQLite.SQLiteDatabase | null = null;

function db(): SQLite.SQLiteDatabase {
  if (!_db) _db = SQLite.openDatabaseSync('fragments.db');
  return _db;
}

/**
 * 迁移脚本按顺序累加，永不修改已发布的条目。
 * 当前 PRAGMA user_version 表示已执行到第几条。
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS fragments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    content     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    source      TEXT    NOT NULL DEFAULT 'app',
    status      TEXT    NOT NULL DEFAULT 'inbox',
    tags        TEXT    NOT NULL DEFAULT '[]',
    project     TEXT,
    merged_into INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_fragments_created ON fragments(created_at DESC);

  CREATE TABLE IF NOT EXISTS organize_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at   INTEGER NOT NULL,
    fragment_ids TEXT    NOT NULL,
    model        TEXT,
    result_json  TEXT,
    applied      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT    NOT NULL,
    title      TEXT,
    body_md    TEXT    NOT NULL,
    period     TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS todos (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    text               TEXT    NOT NULL,
    due_at             TEXT,
    done               INTEGER NOT NULL DEFAULT 0,
    source_fragment_id INTEGER,
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_todos_done ON todos(done);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2：引入内容性质与知识卡（v0.7 已废弃，表在 v6 删除）
  `
  ALTER TABLE fragments ADD COLUMN nature TEXT;

  CREATE TABLE IF NOT EXISTS knowledge_cards (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    topic      TEXT    NOT NULL,
    title      TEXT    NOT NULL,
    gist       TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    source_ids TEXT    NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    archived   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_cards_topic ON knowledge_cards(topic);
  `,
  // v3：待办可以「合并」——被合并的那条留痕而不是删掉，合错了能撤回
  `
  ALTER TABLE todos ADD COLUMN merged_into INTEGER;
  CREATE INDEX IF NOT EXISTS idx_todos_merged ON todos(merged_into);
  `,
  // v4：知识卡支持二级方向（v0.7 已废弃）
  `
  ALTER TABLE knowledge_cards ADD COLUMN subtopic TEXT;
  CREATE INDEX IF NOT EXISTS idx_cards_subtopic ON knowledge_cards(topic, subtopic);
  `,
  // v5：问答记录独立成表（v0.7 已废弃，表在 v6 删除）
  `
  CREATE TABLE IF NOT EXISTS ask_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    scope      TEXT    NOT NULL,
    question   TEXT    NOT NULL,
    answer     TEXT    NOT NULL,
    reasoning  TEXT    NOT NULL DEFAULT '',
    cited_ids  TEXT    NOT NULL DEFAULT '[]',
    web_json   TEXT    NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ask_scope ON ask_logs(scope, created_at DESC);
  `,
  // v6：v0.7 —— 去掉知识库/问答记录；加本地全文索引与整理会话
  `
  DROP TABLE IF EXISTS knowledge_cards;
  DROP TABLE IF EXISTS ask_logs;

  CREATE VIRTUAL TABLE IF NOT EXISTS fragment_fts USING fts5(text, tokenize = 'unicode61');

  CREATE TABLE IF NOT EXISTS organize_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    scope           TEXT    NOT NULL,
    pending_ids     TEXT    NOT NULL DEFAULT '[]',
    cursor          INTEGER NOT NULL DEFAULT 0,
    plan_json       TEXT    NOT NULL DEFAULT '{}',
    context_summary TEXT    NOT NULL DEFAULT '',
    finished        INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_open ON organize_sessions(finished, updated_at DESC);
  `,
  // v7：已完成待办只保留最近 5 条（用户 2026-10-26 明确要求物理清理）。
  //     done_at 用来判断「最近完成」；旧数据没有完成时间，用 created_at 回填。
  //     只清理未被合并的条目 —— merged_into 非空的还要留给「已合并 → 恢复」用。
  `
  ALTER TABLE todos ADD COLUMN done_at INTEGER;
  UPDATE todos SET done_at = created_at WHERE done = 1 AND done_at IS NULL;
  DELETE FROM todos
   WHERE merged_into IS NULL
     AND done = 1
     AND id NOT IN (
       SELECT id FROM todos
        WHERE merged_into IS NULL AND done = 1
        ORDER BY COALESCE(done_at, created_at) DESC, id DESC
        LIMIT 5
     );
  CREATE INDEX IF NOT EXISTS idx_todos_done_at ON todos(done_at DESC);
  `,
  // v8：「问」页的会话持久化。
  //     回答里引用的来源正文随轮次存快照 —— 碎片可删、小结会被覆盖、待办会合并，
  //     只存 id 的话历史会话点开引用就查不到东西了。
  `
  CREATE TABLE IF NOT EXISTS ask_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    turns_json  TEXT    NOT NULL DEFAULT '[]',
    archived    INTEGER NOT NULL DEFAULT 0,
    fragment_id INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ask_sessions_updated ON ask_sessions(archived, updated_at DESC);
  `,
  // v9：文档库（v0.10.0）。
  //     正文单独存一列 body_md，列表查询不取它 —— 一篇文档解析出来可能几十万字，
  //     每次打开列表都读一遍会让首屏明显变卡。
  //     原文件不进库，只存路径；文件本身放在 App 私有目录里。
  `
  CREATE TABLE IF NOT EXISTS documents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    ext        TEXT    NOT NULL DEFAULT '',
    size       INTEGER NOT NULL DEFAULT 0,
    file_uri   TEXT,
    body_md    TEXT    NOT NULL DEFAULT '',
    pages      INTEGER,
    char_count INTEGER NOT NULL DEFAULT 0,
    state      TEXT    NOT NULL DEFAULT 'parsing',
    error      TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);
  `,
  // v10：文档工作区（v0.12）。
  //
  //     content_revision 是「正文版本」，indexed_revision 是「切片索引基于哪一版」。
  //     分开存是因为两者会短暂不一致：正文换了一版而索引还没重建时，
  //     问答必须拒绝使用（否则拿旧切片配新正文，引用指错地方），
  //     但用户仍应该能读到新正文。用一个字段表达不了这种中间态。
  //
  //     切片单独成表 + 独立 FTS：文档切片是可重建的搜索投影，
  //     不进 fragment_fts —— 一条碎片和一段 PDF 正文混在同一个索引里，
  //     时间轴搜索会被文档段落污染。
  //
  //     已有文档的 content_revision 保持 0：正文在库里，但没有切片。
  //     迁移**故意不自动建索引** —— 建索引要跑分词和入库，
  //     属于用户点「准备资料」的动作，不能借迁移之名悄悄做掉。
  `
  ALTER TABLE documents ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE documents ADD COLUMN indexed_revision INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE documents ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE documents ADD COLUMN content_source TEXT;

  CREATE TABLE IF NOT EXISTS document_chunks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id      INTEGER NOT NULL,
    content_revision INTEGER NOT NULL,
    ordinal          INTEGER NOT NULL,
    text             TEXT    NOT NULL,
    locator_json     TEXT    NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_document_chunks_doc
    ON document_chunks(document_id, content_revision, ordinal);

  CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(text, tokenize = 'unicode61');

  ALTER TABLE ask_sessions ADD COLUMN scope_json TEXT;
  `,
  // v11：待办支持两层子项；日/周小结下线（v0.15）。
  //
  //     子项用 `parent_id` 自引用，不建独立表：两者字段完全一样，拆表之后
  //     「列出所有未完成待办」要 UNION，父项完成时还得跨表更新，
  //     而「一条待办能挂子项、也能被挂」这件事本来就是一个自引用。
  //
  //     删日/周小结是用户 2026-11-10 明确要求。迁移里直接 DELETE 而不是加一个
  //     `hidden` 标记：留着标记，迟早有某条查询忘了过滤，界面上又冒出来；
  //     而且用户要的就是「旧内容也不留」。月总结（monthly）与旧的主题总结
  //     （theme）不动 —— 前者还在用，后者属于更早的数据，不在这次范围内。
  `
  ALTER TABLE todos ADD COLUMN parent_id INTEGER;
  CREATE INDEX IF NOT EXISTS idx_todos_parent ON todos(parent_id);
  DELETE FROM notes WHERE type IN ('daily', 'weekly');
  `,
  // v12：整理产出落成「知识文档」（v0.16）。
  //
  //     origin 区分「导入的原件」和「整理出来的知识」：前者有 file_uri，
  //     后者天生没有；而导入的原件被清掉之后 file_uri 也会变空 ——
  //     只靠 file_uri 判不出来，所以必须单独一列。
  //
  //     excerpt 是列表里那一行摘要。**不能在列表查询时现算**：
  //     正文可能几十万字，为了三行字把全文读进内存，等于把「列表不带正文」
  //     这条规矩废掉。写入时算一次，之后一直用它。
  //
  //     ask_sessions 加 document_id / source_ids：会话要能跳到它整理出的那篇文档，
  //     「重新整理」也要知道当初喂了哪些碎片 —— 这两件事都不能靠现查，
  //     因为碎片可能已经被改过、合并过。
  `
  ALTER TABLE documents ADD COLUMN origin TEXT NOT NULL DEFAULT 'file';
  ALTER TABLE documents ADD COLUMN excerpt TEXT NOT NULL DEFAULT '';
  ALTER TABLE ask_sessions ADD COLUMN document_id INTEGER;
  ALTER TABLE ask_sessions ADD COLUMN source_ids TEXT;
  `,
  // v13：一次整理可以产出多篇文档（v0.17）。
  //
  //     document_id 保留（存第一篇），document_ids 存全部。
  //     为什么两列并存而不是把 document_id 改成 JSON：
  //     老版本写的行读出来是整数，直接改语义会让「已整理」的历史全部失效；
  //     而多一篇字段的代价只是一列可能为 NULL 的文本。
  `
  ALTER TABLE ask_sessions ADD COLUMN document_ids TEXT;
  `,
  // v14：哪些碎片已经整理过（v0.18.1）。
  //
  //     标签拆掉之后，时间轴上没有任何东西能说明「这条已经整理成文档了」，
  //     用户只能靠记忆，于是同一批碎片被反复整理。这一列只在**产出真正写进库**
  //     之后才置位 —— 草稿被放弃的那次不留痕迹，因为它什么都没留下。
  `
  ALTER TABLE fragments ADD COLUMN organized_at INTEGER;
  `,
  // v15：碎片配图（v0.19）。
  //
  //     image_path 只存相对名，绝对路径交回给文件层拼 —— 换机 / 迁移时
  //     前缀会变，存死路径等于让所有配图一起失效。
  //     image_text 是模型给的文字层：整理、问答、搜索都只读它，不再反复送图。
  //     **空串和 NULL 不是一回事**：NULL = 还没解析，'' = 解析过了但没读出内容。
  `
  ALTER TABLE fragments ADD COLUMN image_path TEXT;
  ALTER TABLE fragments ADD COLUMN image_text TEXT;
  `,
  // v16：一条碎片可以带多张图（v0.20）。
  //
  //     用户 2026-11-12：「目前只能放一张图进去，这些都要优化一下」。
  //     一张图有自己的一生 —— 文件、文字层、解析失败要单独重试、能单独删掉，
  //     塞进 fragments 的两个标量列里，第二张图连「它的字读出来没有」都没地方放。
  //
  //     v15 的 image_path / image_text **原样保留不删**：老设备上那些图已经
  //     落在私有目录里，删列等于让文件失去引用、永远查不到。这里只做搬运
  //     （一条老碎片 → 一行 fragment_images），之后代码只读新表。
  `
  CREATE TABLE IF NOT EXISTS fragment_images (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fragment_id INTEGER NOT NULL,
    path        TEXT    NOT NULL,
    text        TEXT,
    ordinal     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fragment_images_frag ON fragment_images(fragment_id, ordinal);

  INSERT INTO fragment_images (fragment_id, path, text, ordinal, created_at)
    SELECT id, image_path, image_text, 0, created_at
      FROM fragments
     WHERE image_path IS NOT NULL AND image_path <> '';
  `,
];

function migrate(d: SQLite.SQLiteDatabase) {
  const row = d.getFirstSync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    d.execSync(MIGRATIONS[i]);
    d.execSync(`PRAGMA user_version = ${i + 1}`);
  }
}

function pruneDoneTodos(d: SQLite.SQLiteDatabase) {
  d.runSync(
    `DELETE FROM todos
      WHERE merged_into IS NULL
        AND done = 1
        AND id NOT IN (
          SELECT id FROM todos
           WHERE merged_into IS NULL AND done = 1
           ORDER BY COALESCE(done_at, created_at) DESC, id DESC
           LIMIT ${DONE_TODO_KEEP}
        )`,
  );
}

interface FragmentRow {
  id: number;
  content: string;
  created_at: number;
  source: string;
  status: string;
  tags: string;
  project: string | null;
  merged_into: number | null;
  nature: string | null;
  organized_at: number | null;
}

/** 配图行。`text` 为 NULL = 还没读过，'' = 读过了但图里没字 */
interface ImageRow {
  id: number;
  fragment_id: number;
  path: string;
  text: string | null;
  ordinal: number;
  created_at: number;
}

function toFragmentImage(r: ImageRow): FragmentImage {
  return {
    id: r.id,
    path: r.path,
    text: r.text ?? null,
    createdAt: r.created_at,
  };
}

function toFragment(r: FragmentRow): Fragment {
  return {
    id: r.id,
    content: r.content,
    createdAt: r.created_at,
    source: (r.source as FragmentSource) ?? 'app',
    status: (r.status as FragmentStatus) ?? 'inbox',
    tags: parseTags(r.tags),
    project: r.project,
    mergedInto: r.merged_into,
    nature: (r.nature as FragmentNature) ?? null,
    organizedAt: r.organized_at ?? null,
    // 配图另行批量装配（见 attachImages）—— 列表动辄几百条，
    // 每条再查一次图就是几百次往返
    images: [],
  };
}

/**
 * 给一批碎片装配配图。**一次查询**（按 400 切，老 SQLite 绑定上限 999），
 * 不是逐条查。
 */
function attachImages(d: SQLite.SQLiteDatabase, list: Fragment[]): Fragment[] {
  if (!list.length) return list;
  const ids = list.map((f) => f.id);
  const byFragment = new Map<number, FragmentImage[]>();
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const rows = d.getAllSync<ImageRow>(
      `SELECT * FROM fragment_images WHERE fragment_id IN (${ph}) ORDER BY ordinal ASC, id ASC`,
      slice,
    );
    for (const r of rows) {
      const bucket = byFragment.get(r.fragment_id);
      if (bucket) bucket.push(toFragmentImage(r));
      else byFragment.set(r.fragment_id, [toFragmentImage(r)]);
    }
  }
  for (const f of list) f.images = byFragment.get(f.id) ?? [];
  return list;
}

/** 这一条现有的全部文字层（按加入顺序）。索引读它 */
function storedImageTexts(d: SQLite.SQLiteDatabase, fragmentId: number): string[] {
  return d
    .getAllSync<{ text: string | null }>(
      'SELECT text FROM fragment_images WHERE fragment_id = ? ORDER BY ordinal ASC, id ASC',
      [fragmentId],
    )
    .map((r) => (r.text ?? '').trim())
    .filter((t) => t.length > 0);
}

interface TodoRow {
  id: number;
  text: string;
  due_at: string | null;
  done: number;
  done_at: number | null;
  source_fragment_id: number | null;
  created_at: number;
  merged_into: number | null;
  parent_id: number | null;
}

/** 待办行 → 领域对象。三处查询都用它，免得字段映射各写一遍漏掉新字段 */
function toTodo(r: TodoRow): Todo {
  return {
    id: r.id,
    text: r.text,
    dueAt: r.due_at,
    done: r.done === 1,
    doneAt: r.done_at ?? null,
    sourceFragmentId: r.source_fragment_id,
    createdAt: r.created_at,
    mergedInto: r.merged_into,
    parentId: r.parent_id ?? null,
  };
}

interface NoteRow {
  id: number;
  type: string;
  title: string | null;
  body_md: string;
  period: string | null;
  created_at: number;
}

function toNote(r: NoteRow): Note {
  return {
    id: r.id,
    type: (r.type as Note['type']) ?? 'daily',
    title: r.title,
    bodyMd: r.body_md,
    period: r.period,
    createdAt: r.created_at,
  };
}

interface SessionRow {
  id: number;
  scope: string;
  pending_ids: string;
  cursor: number;
  plan_json: string;
  context_summary: string;
  finished: number;
  created_at: number;
  updated_at: number;
}

function parseIds(raw: unknown): number[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

function toSession(r: SessionRow): OrganizeSession {
  return {
    id: r.id,
    scope: (r.scope as OrganizeScope) ?? 'inbox',
    pendingIds: parseIds(r.pending_ids),
    cursor: Number(r.cursor) || 0,
    plan: normalizePlan(parseJson(r.plan_json, {})),
    contextSummary: r.context_summary ?? '',
    finished: r.finished === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function parseJson(raw: unknown, fallback: unknown): unknown {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw ?? fallback;
  } catch {
    return fallback;
  }
}

interface AskSessionRow {
  id: number;
  title: string;
  turns_json: string;
  scope_json: string | null;
  archived: number;
  fragment_id: number | null;
  document_id: number | null;
  document_ids: string | null;
  source_ids: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 会话行 → 领域对象。turns_json 坏掉时退回空数组，不要让一条脏数据拖垮整个历史列表。
 *
 * 但 `scope_json` 坏掉**不能**退回 records：那会把一场文档会话变成全库会话，
 * 用户点开历史时看到的范围就变了。这里的做法是标记成 records 但**记下**解析失败，
 * 由调用方决定拒绝打开 —— 见 `AskSession.scopeBroken`。
 */
function toAskSession(r: AskSessionRow): AskSession {
  const turns = parseJson(r.turns_json, []);
  const rawScope = parseJson(r.scope_json, null);
  const rawSources = parseJson(r.source_ids, []);
  const rawDocs = parseJson(r.document_ids, []);
  const documentIds = Array.isArray(rawDocs)
    ? rawDocs.filter((x): x is number => typeof x === 'number')
    : [];
  let scope: QaScope = { kind: 'records' };
  let scopeBroken = false;
  try {
    scope = normalizeQaScope(rawScope, true);
  } catch {
    scopeBroken = true;
  }
  return {
    id: r.id,
    title: r.title,
    turns: Array.isArray(turns) ? (turns as QaTurn[]) : [],
    scope,
    scopeBroken,
    archived: r.archived === 1,
    fragmentId: r.fragment_id,
    documentId: r.document_id ?? null,
    /*
     * 老会话只有 document_id 一列。那时一次只产一篇，所以它就是全部 ——
     * 不在这里回填的话，升级后打开历史会看到「已整理」却点不到文档。
     */
    documentIds: documentIds.length
      ? documentIds
      : r.document_id !== null && r.document_id !== undefined
        ? [r.document_id]
        : [],
    sourceIds: Array.isArray(rawSources)
      ? rawSources.filter((x): x is number => typeof x === 'number')
      : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface DocumentRow {
  id: number;
  name: string;
  ext: string;
  size: number;
  file_uri: string | null;
  body_md: string;
  pages: number | null;
  char_count: number;
  state: string;
  error: string | null;
  content_revision: number;
  indexed_revision: number;
  chunk_count: number;
  content_source: string | null;
  origin: string | null;
  excerpt: string | null;
  created_at: number;
  updated_at: number;
}

/** 列表用的映射：**故意丢掉 body_md**，只有 findDocument 才读正文 */
function toDocumentMeta(r: DocumentRow): DocumentMeta {
  return {
    id: r.id,
    name: r.name,
    ext: r.ext,
    size: r.size,
    fileUri: r.file_uri,
    pages: r.pages,
    charCount: r.char_count,
    state: (r.state as DocumentMeta['state']) ?? 'stored',
    error: r.error,
    contentRevision: r.content_revision ?? 0,
    indexedRevision: r.indexed_revision ?? 0,
    chunkCount: r.chunk_count ?? 0,
    contentSource: (r.content_source as DocumentMeta['contentSource']) ?? null,
    // 迁移前的老行没有这两列（值为 null）：一律当「导入的原件、没有摘要」，
    // 而不是当知识文档 —— 反过来会让所有老文档的卡片都变成空摘要
    origin: (r.origin as DocumentMeta['origin']) ?? 'file',
    excerpt: r.excerpt ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toDocument(r: DocumentRow): Document {
  return { ...toDocumentMeta(r), bodyMd: r.body_md ?? '' };
}

/** 切片行 → 领域对象。locator_json 坏掉时给一个空定位，不要整条丢弃 */
function toDocumentChunk(r: {
  id: number;
  document_id: number;
  content_revision: number;
  ordinal: number;
  text: string;
  locator_json: string;
}): DocumentChunk {
  const loc = parseJson(r.locator_json, {}) as DocumentLocator;
  return {
    id: r.id,
    documentId: r.document_id,
    contentRevision: r.content_revision,
    ordinal: r.ordinal,
    text: r.text,
    locator: loc && typeof loc === 'object' && 'kind' in loc ? loc : { kind: 'text' },
  };
}

/** 把一条碎片写进 FTS。先删后插，更新/打标签/加图都走它 */
function indexFragment(
  d: SQLite.SQLiteDatabase,
  id: number,
  content: string,
  tags: string[],
  project: string | null,
  imageTexts: string[] = [],
) {
  d.runSync('DELETE FROM fragment_fts WHERE rowid = ?', [id]);
  /*
   * 有配图时把文字层拼进索引。加不加分隔符都行，但加上之后
   * 用户在搜索结果里看到的命中位置不会把正文和图片文字连成一句。
   * 多张图各占一行：两张图的字连成一句会造出原文里没有的句子。
   * 正文里的 `![](img:12)` 是渲染用的定位标记，剥掉 —— 不该被搜到、也不该占索引体积。
   */
  const body = [stripImageTokens(content), ...imageTexts.map((t) => `[图片] ${t}`)].join('\n');
  d.runSync('INSERT INTO fragment_fts(rowid, text) VALUES (?, ?)', [
    id,
    indexText(body, tags, project),
  ]);
}

/**
 * 按库里的现状重建这一条的索引。
 *
 * 加图、删图、改正文、改图文字都要重算 —— 只是各自记得传对参数的话，
 * 迟早有一处漏传（v0.20 之前 imageText 就是这样在 applyTags 里丢掉的）。
 * 统一从这里读一遍现状，比让每个调用点自己拼更不容易错。
 */
function reindexFragment(d: SQLite.SQLiteDatabase, id: number) {
  const row = d.getFirstSync<FragmentRow>('SELECT * FROM fragments WHERE id = ?', [id]);
  if (!row) return;
  indexFragment(d, id, row.content, parseTags(row.tags), row.project, storedImageTexts(d, id));
}

/**
 * FTS 检索的实现。抽成模块函数而不是对象方法，是为了让自检能直接调它 ——
 * 走 `this` 在解构调用时会丢上下文。
 */
function searchIn(d: SQLite.SQLiteDatabase, query: string, limit: number): Fragment[] {
  const match = buildFtsQuery(query);
  if (match) {
    try {
      const rows = d.getAllSync<FragmentRow>(
        `SELECT f.*, bm25(fragment_fts) AS rank FROM fragment_fts
           JOIN fragments f ON f.id = fragment_fts.rowid
          WHERE fragment_fts MATCH ? AND f.merged_into IS NULL
          ORDER BY rank
          LIMIT ?`,
        [match, limit],
      );
      if (rows.length) return attachImages(d, rows.map(toFragment));
    } catch {
      /* FTS 语法/扩展异常时退回 LIKE，不能让问答整条挂掉 */
    }
  }

  const like = likeNeedle(query);
  if (!like) return [];
  const rows = d.getAllSync<FragmentRow>(
    `SELECT * FROM fragments
      WHERE merged_into IS NULL
        AND (content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\')
      ORDER BY created_at DESC LIMIT ?`,
    [like, like, like, limit],
  );
  return attachImages(d, rows.map(toFragment));
}

/** 按 200 条一页重建索引。迁移回填和设置页「重建索引」共用 */
function rebuildIndex(d: SQLite.SQLiteDatabase): number {
  d.execSync('DELETE FROM fragment_fts');
  // 图文字先一次性读进内存（按 fragment_id 归组）：重建时逐条查图，
  // 几千条碎片就是几千次查询，升级后第一次启动会明显卡
  const texts = new Map<number, string[]>();
  for (const r of d.getAllSync<ImageRow>(
    'SELECT * FROM fragment_images ORDER BY fragment_id ASC, ordinal ASC, id ASC',
  )) {
    const t = (r.text ?? '').trim();
    if (!t) continue;
    const bucket = texts.get(r.fragment_id);
    if (bucket) bucket.push(t);
    else texts.set(r.fragment_id, [t]);
  }

  let offset = 0;
  let indexed = 0;
  for (;;) {
    const rows = d.getAllSync<FragmentRow>(
      'SELECT * FROM fragments ORDER BY id ASC LIMIT 200 OFFSET ?',
      [offset],
    );
    if (!rows.length) break;
    d.execSync('BEGIN');
    try {
      for (const r of rows) {
        indexFragment(d, r.id, r.content, parseTags(r.tags), r.project, texts.get(r.id) ?? []);
        indexed++;
      }
      d.execSync('COMMIT');
    } catch (e) {
      d.execSync('ROLLBACK');
      throw e;
    }
    offset += rows.length;
  }
  return indexed;
}

/** 启动时对齐索引和碎片；不一致就重建。数据量大了只会在升级后第一次慢一下 */
function ensureSearchIndex(d: SQLite.SQLiteDatabase) {
  const total = d.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM fragments')?.n ?? 0;
  const indexed = d.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM fragment_fts')?.n ?? 0;
  if (total !== indexed) rebuildIndex(d);
}

function countOf(d: SQLite.SQLiteDatabase, sql: string, params: (string | number)[] = []): number {
  return d.getFirstSync<{ n: number }>(sql, params)?.n ?? 0;
}

export const repo: Repo = {
  async init() {
    const d = db();
    d.execSync('PRAGMA journal_mode = WAL;');
    d.execSync('PRAGMA foreign_keys = ON;');
    migrate(d);
    ensureSearchIndex(d);
  },

  async listFragments(limit = 500) {
    const d = db();
    const rows = d.getAllSync<FragmentRow>(
      'SELECT * FROM fragments ORDER BY created_at DESC LIMIT ?',
      [limit],
    );
    return attachImages(d, rows.map(toFragment));
  },

  async findFragmentsByIds(ids) {
    if (!ids.length) return [];
    const d = db();
    // 一次查完：ids 是「当初那批」，可能几十条，逐条查就是几十次往返
    const marks = ids.map(() => '?').join(',');
    const rows = d.getAllSync<FragmentRow>(
      `SELECT * FROM fragments WHERE id IN (${marks})`,
      ids,
    );
    return attachImages(d, rows.map(toFragment));
  },

  async listFragmentsBetween(from, to) {
    const d = db();
    const rows = d.getAllSync<FragmentRow>(
      'SELECT * FROM fragments WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC',
      [from, to],
    );
    return attachImages(d, rows.map(toFragment));
  },

  async listFragmentIds(scope) {
    const where = scope === 'all' ? 'merged_into IS NULL' : "status = 'inbox'";
    const rows = db().getAllSync<{ id: number }>(
      `SELECT id FROM fragments WHERE ${where} ORDER BY created_at ASC, id ASC`,
    );
    return rows.map((r) => r.id);
  },

  async listFragmentsByIds(ids) {
    const list = Array.from(new Set(ids.map(Number).filter((n) => Number.isFinite(n))));
    if (!list.length) return [];
    // SQLite 的绑定变量个数有上限（老版本 999），「全部重过」可能一次上千条，
    // 所以按 400 一批查。顺序由传进来的 ids 决定，SQL 的 IN 不保证顺序。
    const CHUNK = 400;
    const byId = new Map<number, Fragment>();
    for (let i = 0; i < list.length; i += CHUNK) {
      const slice = list.slice(i, i + CHUNK);
      const ph = slice.map(() => '?').join(',');
      const rows = db().getAllSync<FragmentRow>(
        `SELECT * FROM fragments WHERE id IN (${ph})`,
        slice,
      );
      for (const r of rows) byId.set(r.id, toFragment(r));
    }
    const out: Fragment[] = [];
    for (const id of list) {
      const f = byId.get(id);
      if (f) out.push(f);
    }
    return attachImages(db(), out);
  },

  async countFragments(scope) {
    const where = scope === 'all' ? 'merged_into IS NULL' : "status = 'inbox'";
    return countOf(db(), `SELECT COUNT(*) AS n FROM fragments WHERE ${where}`);
  },

  async insertFragment(content, source, createdAt, images) {
    const d = db();
    const text = content.trim();
    const row = createdAt ?? Date.now();
    /*
     * 正文和配图必须在同一个事务里：分开写的话，插完碎片那一步失败，
     * 库里就留一条「有图但图行没写进去」的碎片 —— 界面上是一个空白的
     * 图片位，而文件其实还在磁盘上。
     *
     * image_path / image_text 两列（v15）不再写入：配图改由 fragment_images 承载。
     */
    d.execSync('BEGIN');
    let id = 0;
    try {
      const res = d.runSync(
        'INSERT INTO fragments (content, created_at, source, status) VALUES (?, ?, ?, ?)',
        [text, row, source, 'inbox'],
      );
      id = Number(res.lastInsertRowId);
      (images ?? []).forEach((img, i) => {
        d.runSync(
          'INSERT INTO fragment_images (fragment_id, path, text, ordinal, created_at) VALUES (?, ?, ?, ?, ?)',
          [id, img.path, img.text ?? null, i, row],
        );
      });
      d.execSync('COMMIT');
    } catch (e) {
      d.execSync('ROLLBACK');
      throw e;
    }
    // 图里的文字也要进索引：不然「搜图里的报错码」永远搜不到
    reindexFragment(d, id);
    return id;
  },

  async insertFragmentImage(fragmentId, path) {
    const d = db();
    const next =
      d.getFirstSync<{ n: number | null }>(
        'SELECT MAX(ordinal) AS n FROM fragment_images WHERE fragment_id = ?',
        [fragmentId],
      )?.n ?? -1;
    const res = d.runSync(
      'INSERT INTO fragment_images (fragment_id, path, text, ordinal, created_at) VALUES (?, ?, NULL, ?, ?)',
      [fragmentId, path, next + 1, Date.now()],
    );
    reindexFragment(d, fragmentId);
    return Number(res.lastInsertRowId);
  },

  async setFragmentImageText(imageId, text) {
    const d = db();
    const mine = d.getFirstSync<{ fragment_id: number }>(
      'SELECT fragment_id FROM fragment_images WHERE id = ?',
      [imageId],
    );
    if (!mine) return;
    d.runSync('UPDATE fragment_images SET text = ? WHERE id = ?', [text, imageId]);
    // 重建索引：这段文字是这条碎片内容的一部分，必须能被搜到
    reindexFragment(d, mine.fragment_id);
  },

  async deleteFragmentImage(imageId) {
    const d = db();
    const mine = d.getFirstSync<{ fragment_id: number; path: string }>(
      'SELECT fragment_id, path FROM fragment_images WHERE id = ?',
      [imageId],
    );
    if (!mine) return null;
    d.runSync('DELETE FROM fragment_images WHERE id = ?', [imageId]);
    reindexFragment(d, mine.fragment_id);
    return mine.path;
  },

  async updateFragmentContent(id, content) {
    const d = db();
    const text = content.trim();
    d.runSync('UPDATE fragments SET content = ? WHERE id = ?', [text, id]);
    reindexFragment(d, id);
  },

  async markFragmentsOrganized(ids, at) {
    const list = Array.from(new Set(ids.map(Number).filter((n) => Number.isFinite(n))));
    if (!list.length) return;
    const d = db();
    // 一次整理的来源可能有几百条，按 400 切（老 SQLite 的绑定变量上限是 999）
    for (let i = 0; i < list.length; i += 400) {
      const slice = list.slice(i, i + 400);
      const ph = slice.map(() => '?').join(',');
      d.runSync(`UPDATE fragments SET organized_at = ? WHERE id IN (${ph})`, [at, ...slice]);
    }
  },

  async deleteFragment(id) {
    const d = db();
    // 先取配图名：删完这些行就再也查不到文件在哪了，图会永远占着空间
    const paths = d
      .getAllSync<{ path: string }>('SELECT path FROM fragment_images WHERE fragment_id = ?', [id])
      .map((r) => r.path);
    d.execSync('BEGIN');
    try {
      d.runSync('DELETE FROM fragment_images WHERE fragment_id = ?', [id]);
      d.runSync('DELETE FROM fragment_fts WHERE rowid = ?', [id]);
      d.runSync('DELETE FROM fragments WHERE id = ?', [id]);
      /*
       * 原来并进它的那几条落回未整理 —— 留着 merged_into 指向一个不存在的 id，
       * 再加 status='merged'，它们就既不在时间轴上、也不会被重新整理，等于凭空消失
       */
      d.runSync(
        "UPDATE fragments SET merged_into = NULL, status = 'inbox' WHERE merged_into = ?",
        [id],
      );
      d.execSync('COMMIT');
    } catch (e) {
      d.execSync('ROLLBACK');
      throw e;
    }
    return paths;
  },

  async applyTags(id, labels, project) {
    const d = db();
    // 存显示形式（保留 NAS/AI 的大小写），按归一化键去重
    const clean = dedupeTags(labels);
    // 已合并的碎片不能被「打标」这一步复活成 tagged
    d.runSync(
      `UPDATE fragments SET tags = ?, project = ?,
         status = CASE WHEN status = 'merged' THEN 'merged' ELSE 'tagged' END
       WHERE id = ?`,
      [JSON.stringify(clean), project, id],
    );
    reindexFragment(d, id);
  },

  async markMerged(dropIds, keepId) {
    if (!dropIds.length) return;
    const placeholders = dropIds.map(() => '?').join(',');
    db().runSync(
      `UPDATE fragments SET merged_into = ?, status = ? WHERE id IN (${placeholders})`,
      [keepId, 'merged', ...dropIds],
    );
  },

  async markStatus(ids, status) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    // 已被合并的条目不再被普遍状态覆盖
    db().runSync(
      `UPDATE fragments SET status = ? WHERE id IN (${placeholders}) AND status <> 'merged'`,
      [status, ...ids],
    );
  },

  async setFragmentNature(ids, nature) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    db().runSync(`UPDATE fragments SET nature = ? WHERE id IN (${placeholders})`, [nature, ...ids]);
  },

  async countInbox() {
    return countOf(db(), "SELECT COUNT(*) AS n FROM fragments WHERE status = 'inbox'");
  },

  async searchFragments(query, limit = 40) {
    return searchIn(db(), query, limit);
  },

  async searchIndexStats() {
    const d = db();
    return {
      indexed: countOf(d, 'SELECT COUNT(*) AS n FROM fragment_fts'),
      total: countOf(d, 'SELECT COUNT(*) AS n FROM fragments'),
    };
  },

  async selfTestSearch(samples = 5) {
    const d = db();
    // 只抽够长的碎片：太短的话取不出两段，测了也说明不了什么
    const rows = d.getAllSync<{ id: number; content: string }>(
      `SELECT id, content FROM fragments
        WHERE merged_into IS NULL AND length(content) >= 14
        ORDER BY id DESC LIMIT ?`,
      [samples],
    );

    let checked = 0;
    let hit = 0;
    let viaDuplicate = 0;
    const misses: { id: number; needle: string; foundIds: number[] }[] = [];

    for (const r of rows) {
      const chars = Array.from(r.content);
      /*
       * 取两段而不是一段。
       *
       * 单取第 4–9 字很容易撞上「明天上午」「这个事」这类高频词 —— 搜出来几十条，
       * 自己排在 limit 之外，于是被判成「搜不回」。那不是索引坏了，是自检方法太脆。
       * 第二段错开位置，只要有一段能定位到自己就说明索引是好的。
       */
      const needles = [chars.slice(3, 9).join(''), chars.slice(8, 14).join('')]
        .map((x) => x.trim())
        // 纯标点/emoji 的片段分词后是空的，搜不了 —— 这种不该算「能自检」
        .filter((x) => x && tokenizeText(x).length > 0);

      if (!needles.length) continue;
      checked++;

      let ok = false;
      let dup = false;
      let lastFound: number[] = [];

      for (const needle of needles) {
        // limit 给到 50：高频词在小库上也可能命中很多条
        const found = searchIn(d, needle, 50);
        if (found.some((f) => f.id === r.id)) {
          ok = true;
          break;
        }
        // 搜回了内容完全相同的另一条：这条内容确实进了索引，只是库里有两份一样的
        if (found.some((f) => f.content === r.content)) {
          ok = true;
          dup = true;
          break;
        }
        lastFound = found.slice(0, 3).map((f) => f.id);
      }

      if (ok) {
        hit++;
        if (dup) viaDuplicate++;
      } else {
        misses.push({ id: r.id, needle: needles[0], foundIds: lastFound });
      }
    }

    return { checked, hit, viaDuplicate, misses };
  },

  async rebuildSearchIndex() {
    const indexed = rebuildIndex(db());
    return { indexed };
  },

  async insertTodo(input) {
    const res = db().runSync(
      'INSERT INTO todos (text, due_at, done, source_fragment_id, created_at, parent_id) VALUES (?, ?, 0, ?, ?, ?)',
      [input.text, input.dueAt, input.sourceFragmentId, Date.now(), input.parentId],
    );
    /*
     * 给一条**已完成**的父项加子项，等于这件事还没完 —— 父项必须退回未完成。
     * 否则列表上会出现「父项打着勾、底下挂着一条没做的子项」，
     * 而这条状态没有任何操作能让它自洽（勾子项会把它顶成完成，看起来像没反应）。
     */
    if (input.parentId !== null) {
      db().runSync('UPDATE todos SET done = 0, done_at = NULL WHERE id = ? AND done = 1', [
        input.parentId,
      ]);
    }
    return Number(res.lastInsertRowId);
  },

  async updateTodo(id, patch) {
    if (patch.text !== undefined) {
      const text = patch.text.trim();
      // 空文字不写库：想删就删，把内容改成空只会留下一条看不见的待办。
      // 注意这里**不 return** —— 同一份 patch 里的日期修改还要生效。
      if (text) db().runSync('UPDATE todos SET text = ? WHERE id = ?', [text, id]);
    }
    if (patch.dueAt !== undefined) {
      // 清日期必须写 NULL 字面量，不能靠 ? 绑 JS null（见 AGENTS「SQL 里清空字段」）
      if (patch.dueAt === null) db().runSync('UPDATE todos SET due_at = NULL WHERE id = ?', [id]);
      else db().runSync('UPDATE todos SET due_at = ? WHERE id = ?', [patch.dueAt, id]);
    }
  },

  async listTodos() {
    const rows = db().getAllSync<TodoRow>(
      'SELECT * FROM todos WHERE merged_into IS NULL ORDER BY done ASC, COALESCE(done_at, created_at) DESC, id DESC',
    );
    return rows.map(toTodo);
  },

  async toggleTodo(id, done) {
    /*
     * 级联规则统一在 `planToggle` 里，这里只负责把结果写下去。
     * 查全表而不是只查这一条，是因为「子项全勾完父项自动完成」需要兄弟状态；
     * 待办是几百条量级，一次全表读远小于一次写错状态的代价。
     *
     * 必须过滤 merged_into —— 被合并掉的条目还在库里，把它们算进兄弟里，
     * 父项就可能永远差一条勾不完。
     */
    const rows = db().getAllSync<TodoRow>('SELECT * FROM todos WHERE merged_into IS NULL');
    const plan = planToggle(rows.map(toTodo), id, done);
    if (!plan.length) return;

    const now = Date.now();
    for (const step of plan) {
      if (step.done) {
        // 已经是完成的不刷新时间：「最近完成」的排序不该被重复点击推后
        db().runSync('UPDATE todos SET done = 1, done_at = COALESCE(done_at, ?) WHERE id = ?', [
          now,
          step.id,
        ]);
      } else {
        db().runSync('UPDATE todos SET done = 0, done_at = NULL WHERE id = ?', [step.id]);
      }
    }
    if (done) pruneDoneTodos(db());
  },

  async deleteTodo(id) {
    // 子项升为顶层而不是跟着删：「删掉这一条」不该连带删掉用户另外写的内容
    db().runSync('UPDATE todos SET parent_id = NULL WHERE parent_id = ?', [id]);
    db().runSync('DELETE FROM todos WHERE id = ?', [id]);
  },

  async mergeTodos(keepId, dropIds, text) {
    const drops = dropIds.filter((id) => id !== keepId);
    if (text) db().runSync('UPDATE todos SET text = ? WHERE id = ?', [text, keepId]);
    if (!drops.length) return;
    const marks = drops.map(() => '?').join(',');
    // 被合并的父项如果挂着子项，子项跟到保留项下面 —— 不搬的话它们会变成
    // parent_id 指向一条已隐藏条目的孤儿，界面上永远看不到，也勾不掉
    db().runSync(`UPDATE todos SET parent_id = ? WHERE parent_id IN (${marks})`, [
      keepId,
      ...drops,
    ]);
    db().runSync(`UPDATE todos SET merged_into = ? WHERE id IN (${marks})`, [keepId, ...drops]);
  },

  async listMergedTodos() {
    const rows = db().getAllSync<TodoRow>(
      'SELECT * FROM todos WHERE merged_into IS NOT NULL ORDER BY created_at DESC',
    );
    return rows.map(toTodo);
  },

  async unmergeTodos(keepId) {
    db().runSync('UPDATE todos SET merged_into = NULL WHERE merged_into = ?', [keepId]);
  },

  async listDoneTodoSourceIds() {
    const rows = db().getAllSync<{ source_fragment_id: number }>(
      'SELECT DISTINCT source_fragment_id FROM todos WHERE done = 1 AND source_fragment_id IS NOT NULL',
    );
    return rows.map((r) => r.source_fragment_id);
  },

  async insertNote(input) {
    const res = db().runSync(
      'INSERT INTO notes (type, title, body_md, period, created_at) VALUES (?, ?, ?, ?, ?)',
      [input.type, input.title, input.bodyMd, input.period, Date.now()],
    );
    return Number(res.lastInsertRowId);
  },

  async upsertNote(input) {
    // period 为空的没有「同一周期」的概念，直接新增
    if (input.period) {
      const hit = db().getFirstSync<{ id: number }>(
        'SELECT id FROM notes WHERE type = ? AND period = ? ORDER BY created_at DESC LIMIT 1',
        [input.type, input.period],
      );
      if (hit) {
        db().runSync('UPDATE notes SET title = ?, body_md = ?, created_at = ? WHERE id = ?', [
          input.title,
          input.bodyMd,
          Date.now(),
          hit.id,
        ]);
        return { id: hit.id, replaced: true };
      }
    }
    const res = db().runSync(
      'INSERT INTO notes (type, title, body_md, period, created_at) VALUES (?, ?, ?, ?, ?)',
      [input.type, input.title, input.bodyMd, input.period, Date.now()],
    );
    return { id: Number(res.lastInsertRowId), replaced: false };
  },

  async listNotes(limit = 30) {
    const rows = db().getAllSync<NoteRow>('SELECT * FROM notes ORDER BY created_at DESC LIMIT ?', [
      limit,
    ]);
    return rows.map(toNote);
  },

  async findNote(type, period) {
    const row = db().getFirstSync<NoteRow>(
      'SELECT * FROM notes WHERE type = ? AND period = ? ORDER BY created_at DESC LIMIT 1',
      [type, period],
    );
    return row ? toNote(row) : null;
  },

  async deleteNote(id) {
    db().runSync('DELETE FROM notes WHERE id = ?', [id]);
  },

  async saveOrganizeSession(input) {
    const now = Date.now();
    const res = db().runSync(
      `INSERT INTO organize_sessions
         (scope, pending_ids, cursor, plan_json, context_summary, finished, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.scope,
        JSON.stringify(input.pendingIds),
        input.cursor,
        JSON.stringify(input.plan),
        input.contextSummary,
        input.finished ? 1 : 0,
        now,
        now,
      ],
    );
    return Number(res.lastInsertRowId);
  },

  async updateOrganizeSession(id, patch) {
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (patch.cursor !== undefined) {
      sets.push('cursor = ?');
      params.push(patch.cursor);
    }
    if (patch.plan !== undefined) {
      sets.push('plan_json = ?');
      params.push(JSON.stringify(patch.plan));
    }
    if (patch.contextSummary !== undefined) {
      sets.push('context_summary = ?');
      params.push(patch.contextSummary);
    }
    if (patch.finished !== undefined) {
      sets.push('finished = ?');
      params.push(patch.finished ? 1 : 0);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(id);
    db().runSync(`UPDATE organize_sessions SET ${sets.join(', ')} WHERE id = ?`, params);
  },

  async findUnfinishedOrganizeSession() {
    const row = db().getFirstSync<SessionRow>(
      'SELECT * FROM organize_sessions WHERE finished = 0 ORDER BY updated_at DESC LIMIT 1',
    );
    return row ? toSession(row) : null;
  },

  async finishOrganizeSession(id) {
    db().runSync('UPDATE organize_sessions SET finished = 1, updated_at = ? WHERE id = ?', [
      Date.now(),
      id,
    ]);
  },

  async deleteOrganizeSession(id) {
    db().runSync('DELETE FROM organize_sessions WHERE id = ?', [id]);
  },

  async listAskSessions(includeArchived = false) {
    const rows = includeArchived
      ? db().getAllSync<AskSessionRow>(
          'SELECT * FROM ask_sessions ORDER BY updated_at DESC',
        )
      : db().getAllSync<AskSessionRow>(
          'SELECT * FROM ask_sessions WHERE archived = 0 ORDER BY updated_at DESC',
        );
    return rows.map(toAskSession);
  },

  async findAskSession(id) {
    const row = db().getFirstSync<AskSessionRow>('SELECT * FROM ask_sessions WHERE id = ?', [id]);
    return row ? toAskSession(row) : null;
  },

  async saveAskSession(input) {
    const now = Date.now();
    const turnsJson = JSON.stringify(input.turns);
    // 范围每次保存都写：会话范围是契约的一部分，不是创建时的临时选择。
    // 不写的话，一场文档会话重新打开后会退回 records。
    const scopeJson = JSON.stringify(normalizeQaScope(input.scope));

    if (input.id !== undefined) {
      // 只改传进来的字段：archived / fragmentId 为 undefined 时保持原值，
      // 否则「保存一下对话」会把归档状态和已整理标记一起抹掉。
      const sets = ['title = ?', 'turns_json = ?', 'scope_json = ?', 'updated_at = ?'];
      const params: (string | number | null)[] = [input.title, turnsJson, scopeJson, now];
      if (input.archived !== undefined) {
        sets.push('archived = ?');
        params.push(input.archived ? 1 : 0);
      }
      if (input.fragmentId !== undefined) {
        sets.push('fragment_id = ?');
        params.push(input.fragmentId);
      }
      params.push(input.id);
      db().runSync(`UPDATE ask_sessions SET ${sets.join(', ')} WHERE id = ?`, params);
      return input.id;
    }

    const res = db().runSync(
      `INSERT INTO ask_sessions (title, turns_json, scope_json, archived, fragment_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.title,
        turnsJson,
        scopeJson,
        input.archived ? 1 : 0,
        input.fragmentId ?? null,
        input.createdAt,
        now,
      ],
    );
    return Number(res.lastInsertRowId);
  },

  async setAskSessionArchived(id, archived) {
    // 故意不动 updated_at：归档一下会话就跳到列表最前面，用户会以为顺序乱了
    db().runSync('UPDATE ask_sessions SET archived = ? WHERE id = ?', [archived ? 1 : 0, id]);
  },

  async markAskSessionConverted(id, fragmentId) {
    db().runSync('UPDATE ask_sessions SET fragment_id = ? WHERE id = ?', [fragmentId, id]);
  },

  /**
   * 记下「这场会话整理出的那些文档」。
   *
   * `documentIds` 传空数组是「解绑」：文档在文档区被删了，会话上的徽标不能
   * 继续指着一个不存在的 id —— 点进去会是一片空白，用户会以为内容丢了。
   * document_id 存第一篇，是为了让只认这一个字段的老代码还能跳过去。
   */
  async markAskSessionDocument(id, documentIds, sourceIds) {
    const ids = documentIds ?? [];
    db().runSync(
      'UPDATE ask_sessions SET document_id = ?, document_ids = ?, source_ids = ? WHERE id = ?',
      [
        ids.length ? ids[0] : null,
        ids.length ? JSON.stringify(ids) : null,
        sourceIds && sourceIds.length ? JSON.stringify(sourceIds) : null,
        id,
      ],
    );
  },

  async deleteAskSession(id) {
    db().runSync('DELETE FROM ask_sessions WHERE id = ?', [id]);
  },

  async listDocuments() {
    // 不取 body_md：列表只需要标题和状态
    const rows = db().getAllSync<DocumentRow>(
      `SELECT id, name, ext, size, file_uri, pages, char_count, state, error,
              content_revision, indexed_revision, chunk_count, content_source,
              origin, excerpt, created_at, updated_at
         FROM documents ORDER BY updated_at DESC`,
    );
    return rows.map((r) => toDocumentMeta(r));
  },

  /**
   * 文档检索：标题、摘要、正文三处都查。
   *
   * 为什么不一上来就查切片索引：知识文档刚写进来时切片可能还没建完，
   * 而用户搜的是「我刚才整理的那篇」—— 用正文 LIKE 一定能搜到，
   * 索引只是更准，不该成为「搜不到」的原因。
   * 正文只在 LIKE 里用，**不返回**：返回体仍然只有 meta。
   */
  async searchDocuments(query, limit = 50) {
    const q = query.trim();
    const cols = `id, name, ext, size, file_uri, pages, char_count, state, error,
              content_revision, indexed_revision, chunk_count, content_source,
              origin, excerpt, created_at, updated_at`;
    // 空查询不与 LIKE '%%' 混在一起：那样索引用不上，几万篇文档时会明显卡
    if (!q) {
      return db()
        .getAllSync<DocumentRow>(
          `SELECT ${cols} FROM documents ORDER BY updated_at DESC LIMIT ?`,
          [limit],
        )
        .map((r) => toDocumentMeta(r));
    }
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const rows = db().getAllSync<DocumentRow>(
      `SELECT id, name, ext, size, file_uri, pages, char_count, state, error,
              content_revision, indexed_revision, chunk_count, content_source,
              origin, excerpt, created_at, updated_at
         FROM documents
        WHERE name LIKE ? ESCAPE '\\' OR excerpt LIKE ? ESCAPE '\\' OR body_md LIKE ? ESCAPE '\\'
        ORDER BY updated_at DESC
        LIMIT ?`,
      [like, like, like, limit],
    );
    return rows.map((r) => toDocumentMeta(r));
  },

  async findDocument(id) {
    const row = db().getFirstSync<DocumentRow>('SELECT * FROM documents WHERE id = ?', [id]);
    return row ? toDocument(row) : null;
  },

  async insertDocument(input) {
    const now = Date.now();
    const res = db().runSync(
      `INSERT INTO documents (name, ext, size, file_uri, body_md, pages, char_count, state, error,
                              origin, excerpt, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', NULL, 0, ?, NULL, ?, ?, ?, ?)`,
      [
        input.name,
        input.ext,
        input.size,
        input.fileUri,
        input.state,
        input.origin ?? 'file',
        input.excerpt ?? '',
        now,
        now,
      ],
    );
    return Number(res.lastInsertRowId);
  },

  async updateDocument(id, patch) {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.bodyMd !== undefined) {
      sets.push('body_md = ?', 'char_count = ?');
      params.push(patch.bodyMd, patch.bodyMd.length);
    }
    if (patch.excerpt !== undefined) {
      sets.push('excerpt = ?');
      params.push(patch.excerpt);
    }
    if (patch.pages !== undefined) {
      sets.push('pages = ?');
      params.push(patch.pages);
    }
    if (patch.state !== undefined) {
      sets.push('state = ?');
      params.push(patch.state);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      params.push(patch.error);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    params.push(Date.now(), id);
    db().runSync(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`, params);
  },

  async clearAskSessionDocuments(documentId) {
    /*
     * 一篇文档被删了，会话上的 document_ids 里也要把它摘掉 ——
     * 只清 document_id 的话，一篇三篇里有文档被删，徽标还会说「3 篇」，
     * 点进去有一篇打不开。摘完一篇不剩就把两列一起置空。
     */
    const rows = db().getAllSync<{ id: number; document_ids: string | null }>(
      'SELECT id, document_ids FROM ask_sessions WHERE document_ids IS NOT NULL',
    );
    for (const row of rows) {
      const ids = parseJson(row.document_ids, []);
      if (!Array.isArray(ids) || !ids.includes(documentId)) continue;
      const next = ids.filter((x): x is number => typeof x === 'number' && x !== documentId);
      db().runSync('UPDATE ask_sessions SET document_id = ?, document_ids = ? WHERE id = ?', [
        next.length ? next[0] : null,
        next.length ? JSON.stringify(next) : null,
        row.id,
      ]);
    }
    db().runSync('UPDATE ask_sessions SET document_id = NULL WHERE document_id = ?', [documentId]);
  },

  async deleteDocument(id) {
    // 切片和 FTS 必须一起删：只删主记录会留下孤儿切片，
    // searchDocumentChunks 明明限定了 documentIds 却仍能搜到已删文档的段落。
    // 放在一个事务里，避免删一半中断后留下不一致。
    const d = db();
    d.withTransactionSync(() => {
      const ids = d.getAllSync<{ id: number }>(
        'SELECT id FROM document_chunks WHERE document_id = ?',
        [id],
      );
      for (const row of ids) {
        d.runSync('DELETE FROM document_chunks_fts WHERE rowid = ?', [row.id]);
      }
      d.runSync('DELETE FROM document_chunks WHERE document_id = ?', [id]);
      d.runSync('DELETE FROM documents WHERE id = ?', [id]);
    });
  },

  async replaceDocumentContent(id, content, expectedRevision) {
    const d = db();
    let ok = false;

    d.withTransactionSync(() => {
      const cur = d.getFirstSync<{ content_revision: number }>(
        'SELECT content_revision FROM documents WHERE id = ?',
        [id],
      );
      // 文档没了、或版本已经被别人推进过 → 这次写入是迟到的，丢掉
      if (!cur || (cur.content_revision ?? 0) !== expectedRevision) return;

      const next = expectedRevision + 1;
      d.runSync(
        `UPDATE documents
            SET body_md = ?, char_count = ?, pages = ?, state = ?,
                content_revision = ?, indexed_revision = ?, chunk_count = ?,
                content_source = ?, error = NULL, updated_at = ?
          WHERE id = ?`,
        [
          content.bodyMd,
          content.bodyMd.length,
          content.pages,
          'done',
          next,
          next,
          content.chunks.length,
          content.source,
          Date.now(),
          id,
        ],
      );

      // 旧切片整批换掉：这是「内容版本」的物理含义，不是增量更新
      const old = d.getAllSync<{ id: number }>(
        'SELECT id FROM document_chunks WHERE document_id = ?',
        [id],
      );
      for (const row of old) {
        d.runSync('DELETE FROM document_chunks_fts WHERE rowid = ?', [row.id]);
      }
      d.runSync('DELETE FROM document_chunks WHERE document_id = ?', [id]);

      content.chunks.forEach((chunk, i) => {
        const res = d.runSync(
          `INSERT INTO document_chunks (document_id, content_revision, ordinal, text, locator_json)
           VALUES (?, ?, ?, ?, ?)`,
          [id, next, i, chunk.text, JSON.stringify(chunk.locator)],
        );
        d.runSync('INSERT INTO document_chunks_fts(rowid, text) VALUES (?, ?)', [
          Number(res.lastInsertRowId),
          tokenizeText(chunk.text).join(' '),
        ]);
      });

      ok = true;
    });

    return ok;
  },

  async listDocumentChunks(documentId) {
    const rows = db().getAllSync<{
      id: number;
      document_id: number;
      content_revision: number;
      ordinal: number;
      text: string;
      locator_json: string;
    }>(
      `SELECT c.* FROM document_chunks c
         JOIN documents d
           ON d.id = c.document_id AND d.content_revision = c.content_revision
        WHERE c.document_id = ?
        ORDER BY c.ordinal ASC`,
      [documentId],
    );
    return rows.map(toDocumentChunk);
  },

  async searchDocumentChunks(query, documentIds, limit = 40) {
    // 空集合就是「不查」，不能当成「没限制」
    if (!documentIds.length) return [];
    const match = buildFtsQuery(query);
    const ids = documentIds.join(',');

    if (match) {
      try {
        const rows = db().getAllSync<{
          id: number;
          document_id: number;
          content_revision: number;
          ordinal: number;
          text: string;
          locator_json: string;
        }>(
          `SELECT c.*, bm25(document_chunks_fts) AS rank
             FROM document_chunks_fts
             JOIN document_chunks c ON c.id = document_chunks_fts.rowid
             JOIN documents d
               ON d.id = c.document_id AND d.content_revision = c.content_revision
            WHERE document_chunks_fts MATCH ?
              AND c.document_id IN (${ids})
            ORDER BY rank
            LIMIT ?`,
          [match, limit],
        );
        if (rows.length) return rows.map(toDocumentChunk);
      } catch {
        /* FTS 异常退回 LIKE，和碎片检索一致：不能因为索引问题让问答整条挂掉 */
      }
    }

    const like = likeNeedle(query);
    if (!like) return [];
    const rows = db().getAllSync<{
      id: number;
      document_id: number;
      content_revision: number;
      ordinal: number;
      text: string;
      locator_json: string;
    }>(
      `SELECT c.* FROM document_chunks c
         JOIN documents d
           ON d.id = c.document_id AND d.content_revision = c.content_revision
        WHERE c.document_id IN (${ids}) AND c.text LIKE ? ESCAPE '\\'
        ORDER BY c.document_id, c.ordinal
        LIMIT ?`,
      [like, limit],
    );
    return rows.map(toDocumentChunk);
  },

  async saveRun(input) {
    const res = db().runSync(
      'INSERT INTO organize_runs (started_at, fragment_ids, model, result_json, applied) VALUES (?, ?, ?, ?, 0)',
      [input.startedAt, JSON.stringify(input.fragmentIds), input.model, input.resultJson],
    );
    return Number(res.lastInsertRowId);
  },

  async markRunApplied(id) {
    db().runSync('UPDATE organize_runs SET applied = 1 WHERE id = ?', [id]);
  },

  async getSetting(key) {
    const row = db().getFirstSync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
    return row?.value ?? null;
  },

  async setSetting(key, value) {
    db().runSync(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  },

  async stats() {
    const d = db();
    const total = countOf(d, 'SELECT COUNT(*) AS n FROM fragments');
    // 「还没整理」= 从没进过某次整理并落库。不是 status：v0.7 之后没人改它了
    const pending = countOf(
      d,
      'SELECT COUNT(*) AS n FROM fragments WHERE organized_at IS NULL AND merged_into IS NULL',
    );
    // 被合并掉的待办还在表里（只是隐藏了），不能算进「未完成」
    const todoOpen = countOf(
      d,
      'SELECT COUNT(*) AS n FROM todos WHERE done = 0 AND merged_into IS NULL',
    );
    return { total, pending, todoOpen };
  },
};
