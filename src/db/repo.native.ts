import * as SQLite from 'expo-sqlite';
import type { Repo } from './types';
import { parseTags } from './types';
import { DONE_TODO_KEEP } from '../types';
import type {
  AskSession,
  DocProposal,
  DocTag,
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
  QaScope,
  QaTurn,
  Todo,
  TrashEntry,
  TrashRef,
} from '../types';
import { normalizeQaScope } from '../util/qaScope';
import { countChars } from '../util/text';
import { docTagKey, normalizeTagName } from '../util/docTags';
import { parseProposalPayload, serializeProposalPayload } from '../util/proposal';
import { planToggle } from '../util/todoTree';
import { trashDetail, trashTitle } from '../util/trash';
import { buildFtsQuery, dedupeTags, indexText, likeNeedle, tokenizeText } from '../util/tokenize';
import { docImageNames, removeImageToken, resolvePendingTokens, stripImageTokens } from '../util/inlineImages';
import { fragmentSearchText } from '../util/fragmentText';
import { commitDraftEntries, draftCommitKey, positiveIds, readDraftReceipt, serializeDraftReceipt, validateDraftCommit } from './draftCommit';
import {
  cleanupRestoreLeftovers,
  createBackup,
  listSafetyCopies as readSafetyCopies,
  peekBackup as peekBackupFile,
  recoverInterruptedRestore,
  restoreBackup as restoreBackupFile,
  restoreOldDatabase,
  restoreSafetyCopy as restoreSafetyCopyFile,
  snapshotBeforeMigration,
} from './backup';

let _db: SQLite.SQLiteDatabase | null = null;

function db(): SQLite.SQLiteDatabase {
  if (!_db) _db = SQLite.openDatabaseSync('fragments.db');
  return _db;
}

/** 打开连接并设好库级 pragma。启动与恢复回退共用，别再各写一遍 */
function openAndPrepare(): SQLite.SQLiteDatabase {
  const d = db();
  d.execSync('PRAGMA journal_mode = WAL;');
  d.execSync('PRAGMA foreign_keys = ON;');
  return d;
}

/**
 * 把当前库写成一份一致的快照文件（完整备份用）。
 *
 * 为什么用 `VACUUM INTO` 而不是复制 `fragments.db`：应用在跑的时候库里有
 * 未落盘的 WAL，直接拷主文件会得到「少最近几条」的库；VACUUM INTO 在事务里
 * 重写一份，既不阻塞读写，也不用关连接。
 *
 * 目标文件必须不存在 —— 调用方要先清掉同名残留。
 */
function snapshotDatabaseTo(targetFsPath: string): void {
  db().execSync(`VACUUM INTO '${targetFsPath.replace(/'/g, "''")}'`);
}

/** 恢复备份时要先把连接关掉，否则替换文件之后读到的还是旧句柄 */
function closeDatabase(): void {
  if (!_db) return;
  try {
    _db.closeSync();
  } catch {
    /* 关不掉也要把单例置空，下次重新打开 */
  }
  _db = null;
}

/** 库当前迁移到第几版。恢复前用它拒绝「来自更新版本的备份」 */
function databaseSchemaVersion(): number {
  const row = db().getFirstSync<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
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

  -- v0.16 起整理改成一次对话 + 草稿，不再有「多轮计划」这种中间产物；
  -- 这两张表（organize_sessions / organize_runs）与 plan_json 列都**不再有任何读写**。
  -- 表留着不删：旧设备的行是历史证据，删表也不会让用户多出一点空间。
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
  // v17：回收站、个人文档、平铺标签、AI 提案（v0.28）。
  //
  //     回收站**不建 trash 表**，三张表各加一列 `deleted_at`：
  //     设计稿里提过「payload 存整行 JSON」的方案，但那张表本身就是第二份真相 ——
  //     恢复时要把关联的图片行、切片行一起搬回来，漏一行就是一条半个碎片。
  //     加一列之后，「看不见」只有一处判据（`deleted_at IS NULL`），
  //     恢复就是把它置空，文件也不用挪（磁盘上的配图和原件 30 天内不动）。
  //
  //     代价是**所有列表查询都要补这个条件** —— 这是这次改动唯一的系统性风险，
  //     所以 `scripts/assert_recycle.cjs` 会逐条扫源码把它钉住。
  //
  //     文档标签是平铺的（用户 2026-11-18 定）。名字 UNIQUE：
  //     两个「工作」用户分不出来。`state` 让 AI 提的新标签先挂着等确认。
  //
  //     `stage` 只有 library / archived，**没有 draft**：新写的文档自动入库，
  //     草稿是它默认挂的标签，不是另一块存放区。
  `
  ALTER TABLE fragments ADD COLUMN deleted_at INTEGER;
  ALTER TABLE documents ADD COLUMN deleted_at INTEGER;
  ALTER TABLE ask_sessions ADD COLUMN deleted_at INTEGER;
  CREATE INDEX IF NOT EXISTS idx_fragments_live ON fragments(deleted_at, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_documents_live ON documents(deleted_at, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ask_sessions_live ON ask_sessions(deleted_at, updated_at DESC);

  ALTER TABLE documents ADD COLUMN origin_id INTEGER;
  ALTER TABLE documents ADD COLUMN stage TEXT NOT NULL DEFAULT 'library';

  CREATE TABLE IF NOT EXISTS doc_tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    state      TEXT    NOT NULL DEFAULT 'approved',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS doc_tag_links (
    document_id INTEGER NOT NULL,
    tag_id      INTEGER NOT NULL,
    PRIMARY KEY (document_id, tag_id)
  );
  CREATE INDEX IF NOT EXISTS idx_doc_tag_links_tag ON doc_tag_links(tag_id);

  CREATE TABLE IF NOT EXISTS doc_proposals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT    NOT NULL,
    document_id INTEGER,
    payload     TEXT    NOT NULL,
    state       TEXT    NOT NULL DEFAULT 'pending',
    created_at  INTEGER NOT NULL,
    decided_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_doc_proposals_state ON doc_proposals(state, created_at DESC);
  `,
  // v18：月总结删除进回收站（v0.36）。
  //      notes 之前 `deleteNote` 是物理 DELETE —— 小结是要长期留着的档案，
  //      手滑删掉就再也找不回来。现在和碎片/文档/会话一样加 `deleted_at`，
  //      删除进回收站，30 天后悔期内能恢复。
  `
  ALTER TABLE notes ADD COLUMN deleted_at INTEGER;
  CREATE INDEX IF NOT EXISTS idx_notes_live ON notes(deleted_at, created_at DESC);
  `,
];

/**
 * 逐版迁移。
 *
 * 每一版（SQL + user_version）必须包在**同一个事务**里：迁移里有多条
 * `ALTER TABLE ADD COLUMN`，而它们不可重入。原来两句分开执行，进程若在
 * 两者之间被杀，版本号停在旧值、列却已加上，下次启动重跑就报
 * `duplicate column name` —— 而 App 启动时把 init 的错误只 warn 掉，
 * 于是应用照常打开、跑在一个半截的库上，且永远不会自愈。
 *
 * `PRAGMA user_version` 是事务内的写，失败时跟着一起回滚。
 */
function migrate(d: SQLite.SQLiteDatabase) {
  const row = d.getFirstSync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    d.withTransactionSync(() => {
      d.execSync(MIGRATIONS[i]);
      d.execSync(`PRAGMA user_version = ${i + 1}`);
    });
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
  deleted_at: number | null;
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
  origin_id: number | null;
  stage: string | null;
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
    originId: r.origin_id ?? null,
    stage: (r.stage as DocumentMeta['stage']) ?? 'library',
    // 标签由 attachDocTags 一次补齐：列表几十篇逐篇查链接就是几十次往返
    tags: [],
    excerpt: r.excerpt ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 给一批文档补上标签（v0.28）。
 *
 * 一次 IN 查完再在内存里归组：列表里几十篇逐篇查链接就是几十次往返，
 * 而文档页每次拿到任务进度都会重读一次列表。
 *
 * 只取 `approved`：AI 提的、用户还没点头的标签不该参与分类 ——
 * 拿它筛会筛出一批用户从没创建过的分类。待确认的标签在文档详情里显示。
 */
function attachDocTags(d: SQLite.SQLiteDatabase, metas: DocumentMeta[]): DocumentMeta[] {
  if (!metas.length) return metas;
  const byDoc = new Map<number, DocumentMeta['tags']>();
  const ids = metas.map((m) => m.id);
  for (let i = 0; i < ids.length; i += 400) {
    const slice = ids.slice(i, i + 400);
    const ph = slice.map(() => '?').join(',');
    const rows = d.getAllSync<{ document_id: number; id: number; name: string; state: string; created_at: number }>(
      `SELECT l.document_id AS document_id, t.id AS id, t.name AS name,
              t.state AS state, t.created_at AS created_at
         FROM doc_tag_links l
         JOIN doc_tags t ON t.id = l.tag_id
        WHERE l.document_id IN (${ph}) AND t.state = 'approved'
        ORDER BY t.name`,
      slice,
    );
    for (const row of rows) {
      const bucket = byDoc.get(row.document_id) ?? [];
      bucket.push({
        id: row.id,
        name: row.name,
        state: row.state === 'pending' ? 'pending' : 'approved',
        createdAt: row.created_at,
        count: 0,
      });
      byDoc.set(row.document_id, bucket);
    }
  }
  return metas.map((meta) => ({ ...meta, tags: byDoc.get(meta.id) ?? [] }));
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
  /* trash:ok 按 id 读一行，是恢复之后再建索引的唯一入口；这一步必须先能读到已删的行 */
  const row = d.getFirstSync<FragmentRow>('SELECT * FROM fragments WHERE id = ?', [id]);
  if (!row) return;
  indexFragment(d, id, row.content, parseTags(row.tags), row.project, storedImageTexts(d, id));
}

/**
 * FTS 检索的实现。抽成模块函数而不是对象方法，是为了让自检能直接调它 ——
 * 走 `this` 在解构调用时会丢上下文。
 */
function searchIn(d: SQLite.SQLiteDatabase, query: string, limit: number, offset: number): Fragment[] {
  const match = buildFtsQuery(query);
  if (match) {
    try {
      const rows = d.getAllSync<FragmentRow>(
        `SELECT f.*, bm25(fragment_fts) AS rank FROM fragment_fts
           JOIN fragments f ON f.id = fragment_fts.rowid
          WHERE fragment_fts MATCH ? AND f.merged_into IS NULL AND f.deleted_at IS NULL
          ORDER BY rank, f.id
          LIMIT ? OFFSET ?`,
        [match, limit, offset],
      );
      // offset > 0 时 0 行就是「后面没有了」，不能退回 LIKE 再从头捞一遍
      if (rows.length || offset > 0) return attachImages(d, rows.map(toFragment));
    } catch {
      /* FTS 语法/扩展异常时退回 LIKE，不能让问答整条挂掉 */
    }
  }

  const like = likeNeedle(query);
  if (!like) return [];
  const rows = d.getAllSync<FragmentRow>(
    `SELECT f.* FROM fragments f
      WHERE f.merged_into IS NULL AND f.deleted_at IS NULL
        AND (f.content LIKE ? ESCAPE '\\' OR f.project LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM fragment_images i WHERE i.fragment_id = f.id AND i.text LIKE ? ESCAPE '\\'))
      ORDER BY f.created_at DESC, f.id DESC`,
    [like, like, like],
  );
  const needle = query.trim().toLowerCase();
  return attachImages(d, rows.map(toFragment))
    .filter((f) => fragmentSearchText(f).toLowerCase().includes(needle))
    .slice(offset, offset + limit);
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
      'SELECT * FROM fragments WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 200 OFFSET ?',
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
  d.runSync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [SEARCH_PROJECTION_KEY, SEARCH_PROJECTION_VERSION]);
  return indexed;
}

const SEARCH_PROJECTION_KEY = 'search.fragment.projection';
const SEARCH_PROJECTION_VERSION = '2';

/** 条数与投影版本都一致才可复用；不改变数据库 schema 或历史原文。 */
function ensureSearchIndex(d: SQLite.SQLiteDatabase) {
  // 条数只数「在时间轴上看得见的」：回收站里的碎片不进索引，
  // 用全表条数去比会让每次启动都以为索引缺了东西，白重建一遍
  const total = d.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM fragments WHERE deleted_at IS NULL')?.n ?? 0;
  const indexed = d.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM fragment_fts')?.n ?? 0;
  const projection = d.getFirstSync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SEARCH_PROJECTION_KEY])?.value;
  if (total !== indexed || projection !== SEARCH_PROJECTION_VERSION) rebuildIndex(d);
}

function countOf(d: SQLite.SQLiteDatabase, sql: string, params: (string | number)[] = []): number {
  return d.getFirstSync<{ n: number }>(sql, params)?.n ?? 0;
}

/*
 * 只写「还在库里的」文档：删除是软删，`content_revision` 不动，
 * 所以一篇已进回收站的文档仍会通过版本号校验。云解析迟到的结果一旦写进去，
 * 用户恢复它时看到的是一份「删除那一刻并不存在」的正文。
 * 刚恢复的文档 `deleted_at` 已回到 NULL，不会误挡。
 */
function replaceDocumentContentIn(
  d: SQLite.SQLiteDatabase, id: number, content: DocumentContentInput, expectedRevision: number,
): boolean {
  const cur = d.getFirstSync<{ content_revision: number }>(
    'SELECT content_revision FROM documents WHERE id = ? AND deleted_at IS NULL', [id],
  );
  if (!cur || (cur.content_revision ?? 0) !== expectedRevision) return false;
  const next = expectedRevision + 1;
  d.runSync(
    `UPDATE documents SET body_md = ?, char_count = ?, pages = ?, state = ?,
       content_revision = ?, indexed_revision = ?, chunk_count = ?, content_source = ?,
       error = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    [content.bodyMd, countChars(content.bodyMd), content.pages, 'done', next, next,
      content.chunks.length, content.source, Date.now(), id],
  );
  const old = d.getAllSync<{ id: number }>('SELECT id FROM document_chunks WHERE document_id = ?', [id]);
  for (const row of old) d.runSync('DELETE FROM document_chunks_fts WHERE rowid = ?', [row.id]);
  d.runSync('DELETE FROM document_chunks WHERE document_id = ?', [id]);
  content.chunks.forEach((chunk, ordinal) => {
    const inserted = d.runSync(
      `INSERT INTO document_chunks (document_id, content_revision, ordinal, text, locator_json) VALUES (?, ?, ?, ?, ?)`,
      [id, next, ordinal, chunk.text, JSON.stringify(chunk.locator)],
    );
    d.runSync('INSERT INTO document_chunks_fts(rowid, text) VALUES (?, ?)', [
      Number(inserted.lastInsertRowId), tokenizeText(chunk.text).join(' '),
    ]);
  });
  return true;
}

/**
 * 彻底删除一批条目。**唯一不可逆的一段**，恢复不走这里。
 *
 * 调用方已经开好事务（`purgeTrash` 与 `purgeExpiredTrash` 共用这一份）：
 * 两处各写一遍的话，30 天自动清掉的那些迟早会漏删切片或配图行。
 *
 * 返回要删的文件名。repo 不碰文件系统 —— 删文件失败不该让数据库回滚。
 */
function purgeRefs(d: SQLite.SQLiteDatabase, refs: TrashRef[]): string[] {
  const files: string[] = [];
  const idsOf = (kind: TrashRef['kind']) =>
    refs.filter((r) => r.kind === kind).map((r) => r.id).filter((n) => Number.isFinite(n));

  for (let i = 0, list = idsOf('fragment'); i < list.length; i += 400) {
    const slice = list.slice(i, i + 400);
    const ph = slice.map(() => '?').join(',');
    for (const row of d.getAllSync<{ path: string }>(
      `SELECT path FROM fragment_images WHERE fragment_id IN (${ph})`,
      slice,
    )) files.push(row.path);
    d.runSync(`DELETE FROM fragment_images WHERE fragment_id IN (${ph})`, slice);
    for (const id of slice) d.runSync('DELETE FROM fragment_fts WHERE rowid = ?', [id]);
    d.runSync(`DELETE FROM fragments WHERE id IN (${ph})`, slice);
  }

  const docIds = idsOf('document');
  for (const id of docIds) {
    // 切片与 FTS 一起删：只删主记录会留下孤儿切片，
    // searchDocumentChunks 明明限定了 documentIds 却仍能搜到已删文档的段落
    for (const row of d.getAllSync<{ id: number }>('SELECT id FROM document_chunks WHERE document_id = ?', [id])) {
      d.runSync('DELETE FROM document_chunks_fts WHERE rowid = ?', [row.id]);
    }
    d.runSync('DELETE FROM document_chunks WHERE document_id = ?', [id]);
    /* trash:ok 真删的时候才取原件路径与正文，这一行读的正是要删的那条 */
    const row = d.getFirstSync<{ file_uri: string | null; body_md: string }>(
      'SELECT file_uri, body_md FROM documents WHERE id = ?', [id],
    );
    if (row?.file_uri) files.push(row.file_uri);
    /*
     * 文档内嵌图（v0.29）没有数据库行指着它们，只在正文里留了文件名。
     * 正文一删就再也没人知道这些文件存在 —— 所以必须在删行之前扫出来。
     */
    if (row?.body_md) for (const name of docImageNames(row.body_md)) files.push(name);
    d.runSync('DELETE FROM doc_tag_links WHERE document_id = ?', [id]);
    d.runSync('DELETE FROM documents WHERE id = ?', [id]);
  }
  if (docIds.length) detachSessionsFromDocs(d, docIds);

  const sessionIds = idsOf('ask_session');
  for (let i = 0; i < sessionIds.length; i += 400) {
    const slice = sessionIds.slice(i, i + 400);
    const ph = slice.map(() => '?').join(',');
    d.runSync(`DELETE FROM ask_sessions WHERE id IN (${ph})`, slice);
  }

  const noteIds = idsOf('note');
  for (let i = 0; i < noteIds.length; i += 400) {
    const slice = noteIds.slice(i, i + 400);
    const ph = slice.map(() => '?').join(',');
    d.runSync(`DELETE FROM notes WHERE id IN (${ph})`, slice);
  }
  return files;
}

/**
 * 一篇（或几篇）文档被删了，会话上指向它们的 id 要摘掉。
 *
 * 只清 `document_id` 的话，一次整理三篇、其中一篇被删，徽标还会说「3 篇」，
 * 点进去有一篇打不开。摘完一篇不剩就把两列一起置空。
 *
 * 回收站的软删**不**调它：文档还在库里，恢复之后会话徽标应该照旧。
 * 只有 `purgeRefs`（真删）才需要把关联打断。
 */
function detachSessionsFromDocs(d: SQLite.SQLiteDatabase, documentIds: number[]) {
  const gone = new Set(documentIds);
  /* trash:ok 回收站里的会话同样要摘掉指向已删文档的 id，不能只处理在用的那些 */
  const rows = d.getAllSync<{ id: number; document_ids: string | null }>(
    'SELECT id, document_ids FROM ask_sessions WHERE document_ids IS NOT NULL',
  );
  for (const row of rows) {
    const ids = parseJson(row.document_ids, []);
    if (!Array.isArray(ids) || !ids.some((x) => typeof x === 'number' && gone.has(x))) continue;
    const next = ids.filter((x): x is number => typeof x === 'number' && !gone.has(x));
    d.runSync('UPDATE ask_sessions SET document_id = ?, document_ids = ? WHERE id = ?', [
      next.length ? next[0] : null,
      next.length ? JSON.stringify(next) : null,
      row.id,
    ]);
  }
  for (const id of documentIds) {
    d.runSync('UPDATE ask_sessions SET document_id = NULL WHERE document_id = ?', [id]);
  }
}

function toDocTag(row: { id: number; name: string; state: string; created_at: number; n?: number }): DocTag {
  return {
    id: row.id,
    name: row.name,
    state: row.state === 'pending' ? 'pending' : 'approved',
    createdAt: row.created_at,
    count: row.n ?? 0,
  };
}

/**
 * 按名字确保标签存在，返回那一行。**调用方拥有事务**。
 *
 * 查重走 `docTagKey`（全半角、大小写折叠），但不改已有那条的写法 ——
 * 显示形式是用户的（NAS 不该变成 nas），比较键只用来认「这是同一件事」。
 * 标签总量是几十条，整表读出来在 JS 里比，比在 SQL 里写一堆 lower()/replace() 可靠。
 */
function ensureDocTagIn(
  d: SQLite.SQLiteDatabase,
  name: string,
  state: 'approved' | 'pending',
): { id: number; name: string; state: string; created_at: number } {
  const rows = d.getAllSync<{ id: number; name: string; state: string; created_at: number }>(
    'SELECT id, name, state, created_at FROM doc_tags',
  );
  const key = docTagKey(name);
  const hit = rows.find((row) => docTagKey(row.name) === key);
  if (hit) return hit;
  const createdAt = Date.now();
  const res = d.runSync('INSERT INTO doc_tags (name, state, created_at) VALUES (?, ?, ?)', [
    name,
    state,
    createdAt,
  ]);
  return { id: Number(res.lastInsertRowId), name, state, created_at: createdAt };
}

interface ProposalRow {
  id: number;
  kind: string;
  document_id: number | null;
  payload: string;
  state: string;
  created_at: number;
  decided_at: number | null;
}

function toProposal(r: ProposalRow): DocProposal {
  return {
    id: r.id,
    kind: (['optimize', 'tag', 'retag', 'batch'].includes(r.kind) ? r.kind : 'optimize') as DocProposal['kind'],
    documentId: r.document_id,
    payload: parseProposalPayload(r.payload),
    state: r.state === 'approved' || r.state === 'rejected' ? r.state : 'pending',
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

export const repo: Repo = {
  async init() {
    /*
     * 恢复被打断时留下的半截文件要在**打开库之前**收拾：
     * 主库不在、`.old` 还在，就先退回旧库；否则 open 会新建一个空库，
     * 迁移再跑一遍，用户看到的就是一份空记录。
     */
    recoverInterruptedRestore();
    let d: SQLite.SQLiteDatabase;
    try {
      d = openAndPrepare();
    } catch (e) {
      // 主库坏了但 `.old` 还在：换回旧库再开一次
      if (!restoreOldDatabase()) throw e;
      d = openAndPrepare();
    }
    const fromVersion = d.getFirstSync<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
    if (fromVersion > 0 && fromVersion < MIGRATIONS.length) {
      try {
        snapshotBeforeMigration(fromVersion, snapshotDatabaseTo);
      } catch (e) {
        /*
         * 快照没写成就不要迁移：迁移里的 DELETE/UPDATE 一旦提交就不可逆，
         * 而这正是「升级后数据不对」最难查的一类。宁可停在 ErrorScreen。
         */
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(`升级前没能留下库快照，已停止迁移（数据没有改动）：${reason}`);
      }
    }
    try {
      migrate(d);
    } catch (e) {
      /*
       * 换进来的新库迁移失败：把旧库换回来再迁移一次。
       * 旧库本来就在当前版本（或更低），这次迁移要么成功，要么真的坏。
       */
      closeDatabase();
      if (!restoreOldDatabase()) throw e;
      d = openAndPrepare();
      migrate(d);
    }
    cleanupRestoreLeftovers();
    ensureSearchIndex(d);
  },

  async commitDraft(input) {
    validateDraftCommit(input);
    const d = db();
    const key = draftCommitKey(input.draftId);
    let receipt = readDraftReceipt(null);
    d.withTransactionSync(() => {
      const raw = d.getFirstSync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value;
      receipt = readDraftReceipt(raw);
      const before = receipt.documents.length + receipt.todos.length;
      const now = Date.now();
      commitDraftEntries(input, receipt, {
        insertDocument: (doc) => {
          const inserted = d.runSync(
            `INSERT INTO documents (name, ext, size, file_uri, body_md, pages, char_count, state, error,
               origin, excerpt, created_at, updated_at)
             VALUES (?, 'md', ?, NULL, '', NULL, 0, 'parsing', NULL, 'knowledge', ?, ?, ?)`,
            [doc.title.trim(), doc.content.bodyMd.length, doc.excerpt, now, now],
          );
          const id = Number(inserted.lastInsertRowId);
          if (!replaceDocumentContentIn(d, id, doc.content, 0)) throw new Error('文档写入版本冲突');
          return id;
        },
        insertTodo: (text, dueAt, parentId) => Number(d.runSync(
          `INSERT INTO todos (text, due_at, done, source_fragment_id, created_at, parent_id)
           VALUES (?, ?, 0, NULL, ?, ?)`, [text, dueAt, now, parentId],
        ).lastInsertRowId),
        findTodo: (id) => {
          const row = d.getFirstSync<{ parent_id: number | null; merged_into: number | null }>(
            'SELECT parent_id, merged_into FROM todos WHERE id = ?', [id],
          );
          return row ? { parentId: row.parent_id, mergedInto: row.merged_into } : null;
        },
        reopenTodo: (id) => { d.runSync('UPDATE todos SET done = 0, done_at = NULL WHERE id = ?', [id]); },
      });
      if (receipt.documents.length + receipt.todos.length > before) {
        const sourceIds = positiveIds(input.sourceIds);
        for (let i = 0; i < sourceIds.length; i += 400) {
          const ids = sourceIds.slice(i, i + 400);
          d.runSync(`UPDATE fragments SET organized_at = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL`, [now, ...ids]);
        }
        if (input.sessionId !== null) {
          /* trash:ok 按 id 读会话；下面那句注释说的就是「已删的会话不能被迟到的提交复活」 */
          const session = d.getFirstSync<{ document_id: number | null; document_ids: string | null; source_ids: string | null }>(
            'SELECT document_id, document_ids, source_ids FROM ask_sessions WHERE id = ?', [input.sessionId],
          );
          // A deleted history session is not silently recreated by a late commit.
          if (session) {
            const ids = positiveIds([
              ...positiveIds(parseJson(session.document_ids, [])), session.document_id,
              ...receipt.documents.map((doc) => doc.id),
            ]).filter((id) => !!d.getFirstSync(
              'SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL', [id],
            ));
            const sources = positiveIds([...positiveIds(parseJson(session.source_ids, [])), ...sourceIds]);
            if (ids.length) {
              d.runSync('UPDATE ask_sessions SET document_id = ?, document_ids = ?, source_ids = ? WHERE id = ?',
                [ids[0], JSON.stringify(ids), JSON.stringify(sources), input.sessionId]);
            } else {
              d.runSync('UPDATE ask_sessions SET document_id = NULL, document_ids = ?, source_ids = ? WHERE id = ?',
                ['[]', JSON.stringify(sources), input.sessionId]);
            }
          }
        }
      }
      d.runSync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, serializeDraftReceipt(receipt)]);
    });
    return receipt;
  },

  async listAllFragments() {
    const d = db();
    return attachImages(d, d.getAllSync<FragmentRow>(
      'SELECT * FROM fragments WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC',
    ).map(toFragment));
  },

  async totalFragments() {
    return countOf(db(), 'SELECT COUNT(*) AS n FROM fragments WHERE deleted_at IS NULL');
  },

  async listFragmentsPage(offset, limit) {
    const d = db();
    const rows = d.getAllSync<FragmentRow>(
      'SELECT * FROM fragments WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      [limit, offset],
    );
    return attachImages(d, rows.map(toFragment));
  },

  /*
   * 聚合查询的两个口径说明（改了这里就要同步 web 侧，否则两端对不上）：
   * - `created_at` 是毫秒时间戳，先除 1000 再交给 `unixepoch`；
   * - `'localtime'` 必不可少。不带它 SQLite 按 UTC 分组，UTC+8 的夜里
   *   记的东西会被算到前一天/前一月 —— 日历上「今天明明记了」却没有点。
   */
  async dayCounts() {
    /*
     * 一条查询同时给「几条」和「多少字」：它们永远是同一批行上的两个数，
     * 分两次查在并发写入时会互相打架（条数变了字没变）。
     * `LENGTH()` 对 TEXT 返回**字符数**（不是字节），中文一个字算一个。
     */
    const rows = db().getAllSync<{ day: string; n: number; c: number | null }>(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS n,
              SUM(LENGTH(content)) AS c
         FROM fragments
        WHERE deleted_at IS NULL
        GROUP BY day
        ORDER BY day`,
    );
    return rows.map((r) => ({ day: r.day, count: r.n, chars: r.c ?? 0 }));
  },

  async monthCounts() {
    const rows = db().getAllSync<{ month: string; n: number }>(
      `SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch', 'localtime') AS month,
              COUNT(*) AS n
         FROM fragments
        WHERE deleted_at IS NULL
        GROUP BY month
        ORDER BY month DESC`,
    );
    return rows.map((r) => ({ month: r.month, count: r.n }));
  },

  async listFragments(limit = 500) {
    const d = db();
    const rows = d.getAllSync<FragmentRow>(
      'SELECT * FROM fragments WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?',
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
      `SELECT * FROM fragments WHERE id IN (${marks}) AND deleted_at IS NULL`,
      ids,
    );
    return attachImages(d, rows.map(toFragment));
  },

  async listFragmentsBetween(from, to) {
    const d = db();
    const rows = d.getAllSync<FragmentRow>(
      'SELECT * FROM fragments WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL ORDER BY created_at ASC',
      [from, to],
    );
    return attachImages(d, rows.map(toFragment));
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
        `SELECT * FROM fragments WHERE id IN (${ph}) AND deleted_at IS NULL`,
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

  async insertFragment(content, source, createdAt, images) {
    const d = db();
    const text = content.trim();
    const pictures = images ?? [];
    if (!text && !pictures.length) throw new Error('记录没有正文或图片');
    if (pictures.length > 9 || pictures.some((img) => !img.path)) throw new Error('配图数量或路径无效');
    const at = createdAt ?? Date.now();
    let id = 0;
    d.withTransactionSync(() => {
      const result = d.runSync(
        'INSERT INTO fragments (content, created_at, source, status) VALUES (?, ?, ?, ?)',
        [text, at, source, 'inbox'],
      );
      id = Number(result.lastInsertRowId);
      const mapping: { key: string; imageId: number }[] = [];
      pictures.forEach((image, ordinal) => {
        const inserted = d.runSync(
          'INSERT INTO fragment_images (fragment_id, path, text, ordinal, created_at) VALUES (?, ?, ?, ?, ?)',
          [id, image.path, image.text ?? null, ordinal, at],
        );
        if (image.key) mapping.push({ key: image.key, imageId: Number(inserted.lastInsertRowId) });
      });
      const resolved = resolvePendingTokens(text, mapping);
      if (resolved !== text) d.runSync('UPDATE fragments SET content = ? WHERE id = ?', [resolved, id]);
      // FTS failure rolls back the record as well; there is no post-COMMIT rejecting write.
      reindexFragment(d, id);
    });
    return id;
  },

  async insertImportedFragment(content, createdAt, tags) {
    const d = db();
    const text = content.trim();
    if (!text || !Number.isFinite(createdAt)) throw new Error('导入内容或时间无效');
    const clean = dedupeTags(tags);
    let id = 0;
    d.withTransactionSync(() => {
      const inserted = d.runSync(
        'INSERT INTO fragments (content, created_at, source, status, tags) VALUES (?, ?, ?, ?, ?)',
        [text, createdAt, 'import', clean.length ? 'tagged' : 'inbox', JSON.stringify(clean)],
      );
      id = Number(inserted.lastInsertRowId);
      reindexFragment(d, id);
    });
    return id;
  },

  async insertFragmentImages(fragmentId, images) {
    if (!images.length) return [];
    const d = db();
    const added: FragmentImage[] = [];
    d.withTransactionSync(() => {
      /* trash:ok 按 id 读，判断这条碎片还在不在（加图要先确认它还活着，不是回收站里的） */
      if (!d.getFirstSync('SELECT id FROM fragments WHERE id = ? AND deleted_at IS NULL', [fragmentId])) {
        throw new Error('这条碎片已经不存在，或已在回收站');
      }
      const total = countOf(d, 'SELECT COUNT(*) AS n FROM fragment_images WHERE fragment_id = ?', [fragmentId]);
      if (total + images.length > 9 || images.some((img) => !img.path)) throw new Error('一条碎片最多9张有效配图');
      const ordinal = d.getFirstSync<{ n: number | null }>(
        'SELECT MAX(ordinal) AS n FROM fragment_images WHERE fragment_id = ?', [fragmentId],
      )?.n ?? -1;
      const at = Date.now();
      images.forEach((image, i) => {
        const inserted = d.runSync(
          'INSERT INTO fragment_images (fragment_id, path, text, ordinal, created_at) VALUES (?, ?, ?, ?, ?)',
          [fragmentId, image.path, image.text ?? null, ordinal + i + 1, at],
        );
        added.push({ id: Number(inserted.lastInsertRowId), path: image.path, text: image.text ?? null, createdAt: at });
      });
      reindexFragment(d, fragmentId);
    });
    return added;
  },

  async setFragmentImageText(imageId, text) {
    const d = db();
    d.withTransactionSync(() => {
      /*
       * 读图是异步的：用户可能在这一步之前把碎片删了。软删之后还写文字层、
       * 还 reindex，会把一条指向回收站碎片的 FTS 行插回去 —— 下次启动
       * `indexed > total`，白重建一遍全量索引；恢复时也会看到「删除之后才有的」文字。
       */
      const mine = d.getFirstSync<{ fragment_id: number }>(
        `SELECT i.fragment_id AS fragment_id
           FROM fragment_images i
           JOIN fragments f ON f.id = i.fragment_id
          WHERE i.id = ? AND f.deleted_at IS NULL`,
        [imageId],
      );
      if (!mine) return;
      d.runSync('UPDATE fragment_images SET text = ? WHERE id = ?', [text, imageId]);
      reindexFragment(d, mine.fragment_id);
    });
  },

  async deleteFragmentImage(imageId) {
    const d = db();
    let path: string | null = null;
    d.withTransactionSync(() => {
      const mine = d.getFirstSync<{ fragment_id: number; path: string }>(
        'SELECT fragment_id, path FROM fragment_images WHERE id = ?', [imageId],
      );
      if (!mine) return;
      /* trash:ok 按 id 读，删一张图要顺带把正文里的图片占位符去掉 */
      const fragment = d.getFirstSync<{ content: string }>('SELECT content FROM fragments WHERE id = ?', [mine.fragment_id]);
      d.runSync('DELETE FROM fragment_images WHERE id = ?', [imageId]);
      if (fragment) d.runSync('UPDATE fragments SET content = ? WHERE id = ?', [removeImageToken(fragment.content, imageId), mine.fragment_id]);
      reindexFragment(d, mine.fragment_id);
      path = mine.path;
    });
    return path;
  },

  async updateFragmentContent(id, content) {
    const d = db();
    d.withTransactionSync(() => {
      // 已进回收站的碎片不再接受编辑：详情页可能停在删除之前的那一版上
      const res = d.runSync(
        'UPDATE fragments SET content = ? WHERE id = ? AND deleted_at IS NULL',
        [content.trim(), id],
      );
      if (res.changes === 0) throw new Error('这条碎片不存在或已在回收站，改动没有保存');
      reindexFragment(d, id);
    });
  },

  async markFragmentsOrganized(ids, at) {
    const list = Array.from(new Set(ids.map(Number).filter((n) => Number.isFinite(n))));
    if (!list.length) return;
    const d = db();
    // 一次整理的来源可能有几百条，按 400 切（老 SQLite 的绑定变量上限是 999）
    for (let i = 0; i < list.length; i += 400) {
      const slice = list.slice(i, i + 400);
      const ph = slice.map(() => '?').join(',');
      // 整理期间被删掉的来源不要再打「已整理」：恢复时会看到删除之后才有的标记
      d.runSync(`UPDATE fragments SET organized_at = ? WHERE id IN (${ph}) AND deleted_at IS NULL`, [at, ...slice]);
    }
  },

  /*
   * 删除 = 移到回收站（v0.28）。
   *
   * 不再删行、不再删文件：
   * - 行留着，「恢复」就是 `deleted_at = NULL`；
   * - 配图文件留着，30 天内恢复还看得见图；真删发生在 `purgeTrash`。
   *
   * 索引行要删：FTS 是投影，留着会让「索引条数 = 碎片条数」这条自检永远不等，
   * 每次启动都白重建一遍。恢复时用 `reindexFragment` 补回来。
   *
   * 并进它的那几条仍然落回未整理：软删之后它们指向的目标虽然还在库里，
   * 但已经不在时间轴上 —— 留着 `merged_into` 就是「看不见、也没法重新整理」。
   * 这一条与恢复不冲突：恢复回来的是这条碎片本身，合并关系不回来。
   */
  async deleteFragment(id) {
    const d = db();
    d.withTransactionSync(() => {
      d.runSync('DELETE FROM fragment_fts WHERE rowid = ?', [id]);
      d.runSync('UPDATE fragments SET deleted_at = ? WHERE id = ?', [Date.now(), id]);
      d.runSync(
        "UPDATE fragments SET merged_into = NULL, status = 'inbox' WHERE merged_into = ?",
        [id],
      );
    });
    // 软删不动磁盘上的配图，调用方不需要删任何文件
    return [];
  },

  async applyTags(id, labels, project) {
    const d = db();
    // 存显示形式（保留 NAS/AI 的大小写），按归一化键去重
    const clean = dedupeTags(labels);
    /*
     * 改标签与重建索引必须同一事务：`reindexFragment` 是先 DELETE 后 INSERT，
     * 中途失败会把这条碎片的索引整行删掉 —— 正文还在，但从此搜不到，
     * 只能等下次启动按条数差发现再全量重建。
     */
    d.withTransactionSync(() => {
      // 已合并的碎片不能被「打标」这一步复活成 tagged
      d.runSync(
        `UPDATE fragments SET tags = ?, project = ?,
           status = CASE WHEN status = 'merged' THEN 'merged' ELSE 'tagged' END
         WHERE id = ? AND deleted_at IS NULL`,
        [JSON.stringify(clean), project, id],
      );
      reindexFragment(d, id);
    });
  },

  async searchFragments(query, limit = 40, offset = 0) {
    return searchIn(db(), query, limit, offset);
  },

  async searchIndexStats() {
    const d = db();
    return {
      indexed: countOf(d, 'SELECT COUNT(*) AS n FROM fragment_fts'),
      total: countOf(d, 'SELECT COUNT(*) AS n FROM fragments WHERE deleted_at IS NULL'),
    };
  },

  async selfTestSearch(samples = 5) {
    const d = db();
    // 只抽够长的碎片：太短的话取不出两段，测了也说明不了什么
    const rows = d.getAllSync<{ id: number; content: string }>(
      `SELECT id, content FROM fragments
        WHERE merged_into IS NULL AND deleted_at IS NULL AND length(content) >= 14
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
        const found = searchIn(d, needle, 50, 0);
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
    /*
     * INSERT 与「父项退回未完成」必须同一事务：分开写时中途失败会留下
     * 「父项打着勾、底下挂着一条没做的子项」，而这条状态没有任何操作能让它自洽。
     */
    let id = 0;
    db().withTransactionSync(() => {
      const res = db().runSync(
        'INSERT INTO todos (text, due_at, done, source_fragment_id, created_at, parent_id) VALUES (?, ?, 0, ?, ?, ?)',
        [input.text, input.dueAt, input.sourceFragmentId, Date.now(), input.parentId],
      );
      id = Number(res.lastInsertRowId);
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
    });
    return id;
  },

  async updateTodo(id, patch) {
    db().withTransactionSync(() => {
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
    });
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

    // 多条 UPDATE 必须同一个事务：中途失败会留下「父项完成、子项没完成」，
    // 而那正是 planToggle 要防的自相矛盾态
    db().withTransactionSync(() => {
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
    });
  },

  async deleteTodo(id) {
    // 子项升为顶层而不是跟着删：「删掉这一条」不该连带删掉用户另外写的内容。
    // 两句分开写的话，中间失败会让子项升了级、父项还在 —— 同一件事出现两次。
    db().withTransactionSync(() => {
      db().runSync('UPDATE todos SET parent_id = NULL WHERE parent_id = ?', [id]);
      db().runSync('DELETE FROM todos WHERE id = ?', [id]);
    });
  },

  async mergeTodos(keepId, dropIds, text) {
    const drops = dropIds.filter((id) => id !== keepId);
    db().withTransactionSync(() => {
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
    });
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
        'SELECT id FROM notes WHERE type = ? AND period = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1',
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
    const rows = db().getAllSync<NoteRow>(
      'SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?',
      [limit],
    );
    return rows.map(toNote);
  },

  async findNote(type, period) {
    const row = db().getFirstSync<NoteRow>(
      'SELECT * FROM notes WHERE type = ? AND period = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [type, period],
    );
    return row ? toNote(row) : null;
  },

  async deleteNote(id) {
    // 软删：小结进回收站，30 天内能从设置 → 回收站恢复
    db().runSync('UPDATE notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [Date.now(), id]);
  },

  async listAskSessions(includeArchived = false) {
    const rows = includeArchived
      ? db().getAllSync<AskSessionRow>(
          'SELECT * FROM ask_sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC',
        )
      : db().getAllSync<AskSessionRow>(
          'SELECT * FROM ask_sessions WHERE archived = 0 AND deleted_at IS NULL ORDER BY updated_at DESC',
        );
    return rows.map(toAskSession);
  },

  async findAskSession(id) {
    const row = db().getFirstSync<AskSessionRow>(
      'SELECT * FROM ask_sessions WHERE id = ? AND deleted_at IS NULL',
      [id],
    );
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
      /*
       * `changes === 0` 说明这一行已经进了回收站（软删不动 id）。
       * 不能假装存成功：轮次会写进一条界面上看不到的会话，用户恢复它时
       * 发现里面多出几轮自己没见过的对话。抛出去，让调用方知道这次没落库。
       */
      const res = db().runSync(`UPDATE ask_sessions SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, params);
      if (res.changes === 0) throw new Error('这场会话已被删除，这次回答没能保存');
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

  /** 删除会话 = 进回收站（v0.28）。轮次全文都还在，30 天内恢复就是原样 */
  async deleteAskSession(id) {
    db().runSync('UPDATE ask_sessions SET deleted_at = ? WHERE id = ?', [Date.now(), id]);
  },

  async listDocuments() {
    // 不取 body_md：列表只需要标题和状态
    const rows = db().getAllSync<DocumentRow>(
      `SELECT id, name, ext, size, file_uri, pages, char_count, state, error,
              content_revision, indexed_revision, chunk_count, content_source,
              origin, origin_id, stage, excerpt, created_at, updated_at
         FROM documents WHERE deleted_at IS NULL ORDER BY updated_at DESC`,
    );
    return attachDocTags(db(), rows.map((r) => toDocumentMeta(r)));
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
              origin, origin_id, stage, excerpt, created_at, updated_at`;
    // 空查询不与 LIKE '%%' 混在一起：那样索引用不上，几万篇文档时会明显卡
    if (!q) {
      const all = db()
        .getAllSync<DocumentRow>(
          `SELECT ${cols} FROM documents WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
          [limit],
        )
        .map((r) => toDocumentMeta(r));
      return attachDocTags(db(), all);
    }
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const rows = db().getAllSync<DocumentRow>(
      `SELECT ${cols}
         FROM documents
        WHERE deleted_at IS NULL
          AND (name LIKE ? ESCAPE '\\' OR excerpt LIKE ? ESCAPE '\\' OR body_md LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC
        LIMIT ?`,
      [like, like, like, limit],
    );
    return attachDocTags(db(), rows.map((r) => toDocumentMeta(r)));
  },

  async findDocument(id) {
    const row = db().getFirstSync<DocumentRow>(
      'SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL',
      [id],
    );
    if (!row) return null;
    const meta = attachDocTags(db(), [toDocumentMeta(row)])[0];
    return { ...meta, bodyMd: row.body_md ?? '' };
  },

  async insertDocument(input) {
    const now = Date.now();
    const res = db().runSync(
      `INSERT INTO documents (name, ext, size, file_uri, body_md, pages, char_count, state, error,
                              origin, origin_id, stage, excerpt, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', NULL, 0, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.ext,
        input.size,
        input.fileUri,
        input.state,
        input.origin ?? 'file',
        input.originId ?? null,
        input.stage ?? 'library',
        input.excerpt ?? '',
        now,
        now,
      ],
    );
    return Number(res.lastInsertRowId);
  },

  async createDocumentWithContent(input) {
    /*
     * 记录、正文+切片、标签在**同一个事务**里落。分成三步调用时，第二步失败会
     * 留下一篇空壳：它在列表里看得见、点开是空的，也没有任何任务会去补它
     * （`state` 已经是 parsing 的话任务会扫到，但那时正文本来就是空的）。
     */
    const d = db();
    // withTransactionSync 不回传任务的值，id 从闭包里带出来
    let id = 0;
    d.withTransactionSync(() => {
      const now = Date.now();
      const res = d.runSync(
        `INSERT INTO documents (name, ext, size, file_uri, body_md, pages, char_count, state, error,
                                origin, origin_id, stage, excerpt, created_at, updated_at)
         VALUES (?, ?, ?, NULL, '', NULL, 0, 'parsing', NULL, ?, ?, 'library', ?, ?, ?)`,
        [
          input.name,
          input.ext,
          input.size,
          input.origin ?? 'authored',
          input.originId ?? null,
          input.excerpt ?? '',
          now,
          now,
        ],
      );
      id = Number(res.lastInsertRowId);
      // 刚插的记录版本号必然是 0；走不到 false，走到了说明有人并发改了它
      if (!replaceDocumentContentIn(d, id, input.content, 0)) {
        throw new Error('文档刚被改过，正文没有写进去');
      }
      for (const raw of input.tagNames ?? []) {
        const name = normalizeTagName(raw);
        if (!name) continue;
        const tag = ensureDocTagIn(d, name, input.tagState ?? 'approved');
        d.runSync('INSERT OR IGNORE INTO doc_tag_links (document_id, tag_id) VALUES (?, ?)', [
          id,
          tag.id,
        ]);
      }
    });
    return id;
  },

  async updateDocument(id, patch) {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name.trim() || '未命名文档');
    }
    if (patch.bodyMd !== undefined) {
      sets.push('body_md = ?', 'char_count = ?');
      params.push(patch.bodyMd, countChars(patch.bodyMd));
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
    // 回收站里的文档不再接受改名 / 改正文：一次迟到的 AI 提案写进去，
    // 用户恢复它时看到的是一份「删掉之后才有的」内容
    db().runSync(`UPDATE documents SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, params);
  },

  async clearAskSessionDocuments(documentId) {
    detachSessionsFromDocs(db(), [documentId]);
  },

  /*
   * 删除 = 移到回收站（v0.28）。切片与 FTS **留着**：
   * 它们是可重建的投影，留着恢复之后立刻能问；而检索时那条 SQL 会 join
   * `documents` 并加上 `deleted_at IS NULL`，所以回收站里的文档搜不出来。
   * 真删（含切片与原件文件）在 `purgeTrash`。
   */
  async deleteDocument(id) {
    db().runSync('UPDATE documents SET deleted_at = ? WHERE id = ?', [Date.now(), id]);
  },

  /* ---------------- 回收站（v0.28） ---------------- */

  async listTrash() {
    const d = db();
    const rows = d.getAllSync<{
      kind: string; id: number; deleted_at: number; title: string | null; num: number | null; extra: string | null;
    }>(
      // 三类混在一起查，因为它们对用户来说是同一件事：「我刚删的、还没彻底没」。
      // 三条分别查再拼，排序就得在 JS 里再做一遍，而且「最近删的那条」会算错。
      `SELECT 'fragment' AS kind, id AS id, deleted_at AS deleted_at,
              substr(content, 1, 200) AS title, length(content) AS num, '' AS extra
         FROM fragments WHERE deleted_at IS NOT NULL
       UNION ALL
       SELECT 'document', id, deleted_at, name, char_count, COALESCE(file_uri, '')
         FROM documents WHERE deleted_at IS NOT NULL
       UNION ALL
       SELECT 'ask_session', id, deleted_at, COALESCE(title, ''), length(turns_json), turns_json
         FROM ask_sessions WHERE deleted_at IS NOT NULL
       UNION ALL
       SELECT 'note', id, deleted_at, COALESCE(title, substr(body_md, 1, 200)), length(body_md), ''
         FROM notes WHERE deleted_at IS NOT NULL
       ORDER BY deleted_at DESC, id DESC`,
    );
    if (!rows.length) return [];

    // 彻底删除时要一起删的文件。恢复不需要它们 —— 软删没动过磁盘
    const imageFiles = new Map<number, string[]>();
    const fragmentIds = rows.filter((r) => r.kind === 'fragment').map((r) => r.id);
    for (let i = 0; i < fragmentIds.length; i += 400) {
      const slice = fragmentIds.slice(i, i + 400);
      const ph = slice.map(() => '?').join(',');
      for (const row of d.getAllSync<{ fragment_id: number; path: string }>(
        `SELECT fragment_id, path FROM fragment_images WHERE fragment_id IN (${ph})`,
        slice,
      )) {
        const bucket = imageFiles.get(row.fragment_id) ?? [];
        bucket.push(row.path);
        imageFiles.set(row.fragment_id, bucket);
      }
    }

    return rows.map((row): TrashEntry => {
      const kind = (row.kind === 'document' ? 'document' : row.kind === 'ask_session' ? 'ask_session' : row.kind === 'note' ? 'note' : 'fragment');
      const extra = row.extra ?? '';
      const parsed = parseJson(extra, []);
      const turns = kind === 'ask_session' && Array.isArray(parsed) ? parsed.length : 0;
      return {
        kind,
        id: row.id,
        title: trashTitle(kind, row.title ?? ''),
        detail: trashDetail(kind, row.num ?? 0, turns),
        deletedAt: row.deleted_at,
        files: kind === 'fragment' ? imageFiles.get(row.id) ?? [] : kind === 'document' && extra ? [extra] : [],
      };
    });
  },

  async trashCount() {
    const d = db();
    // trash:ok 这三个数就是回收站里的条数，本来就要数 deleted_at 非空的
    return countOf(d, `SELECT (SELECT COUNT(*) FROM fragments WHERE deleted_at IS NOT NULL)
        + (SELECT COUNT(*) FROM documents WHERE deleted_at IS NOT NULL)
        + (SELECT COUNT(*) FROM ask_sessions WHERE deleted_at IS NOT NULL)
        + (SELECT COUNT(*) FROM notes WHERE deleted_at IS NOT NULL) AS n`);
  },

  async restoreTrash(refs) {
    if (!refs.length) return 0;
    const d = db();
    let restored = 0;
    d.withTransactionSync(() => {
      for (const [kind, table] of [
        ['fragment', 'fragments'],
        ['document', 'documents'],
        ['ask_session', 'ask_sessions'],
        ['note', 'notes'],
      ] as const) {
        const ids = refs.filter((r) => r.kind === kind).map((r) => r.id).filter((n) => Number.isFinite(n));
        for (let i = 0; i < ids.length; i += 400) {
          const slice = ids.slice(i, i + 400);
          const ph = slice.map(() => '?').join(',');
          // trash:ok 恢复的动作就是把 deleted_at 置空，条件必须是「非空」才叫恢复
          const res = d.runSync(
            `UPDATE ${table} SET deleted_at = NULL WHERE id IN (${ph}) AND deleted_at IS NOT NULL`,
            slice,
          );
          restored += res.changes;
          /*
           * 软删时删掉了索引行，恢复要补回来，否则搜不到刚找回的内容。
           * 只补**真的恢复成功**的那几条：传进来的 id 里可能有本来就不在
           * 回收站的（重复点击、界面与库不同步），给它们插索引会让
           * `indexed > total`，每次启动都白重建一遍全量索引。
           */
          if (kind === 'fragment') {
            const live = d.getAllSync<{ id: number }>(
              `SELECT id FROM fragments WHERE id IN (${ph}) AND deleted_at IS NULL`, slice,
            );
            for (const row of live) reindexFragment(d, row.id);
          }
        }
      }
    });
    return restored;
  },

  async purgeTrash(refs) {
    if (!refs.length) return [];
    const d = db();
    let files: string[] = [];
    d.withTransactionSync(() => { files = purgeRefs(d, refs); });
    return files;
  },

  async purgeExpiredTrash(before) {
    const d = db();
    const refs = d.getAllSync<TrashRef>(
      `SELECT 'fragment' AS kind, id FROM fragments WHERE deleted_at IS NOT NULL AND deleted_at < ?
       UNION ALL SELECT 'document', id FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < ?
       UNION ALL SELECT 'ask_session', id FROM ask_sessions WHERE deleted_at IS NOT NULL AND deleted_at < ?
       UNION ALL SELECT 'note', id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
      [before, before, before, before],
    );
    if (!refs.length) return [];
    let files: string[] = [];
    d.withTransactionSync(() => { files = purgeRefs(d, refs); });
    return files;
  },

  /* ---------------- 文档标签（v0.28，平铺） ---------------- */

  async listDocTags() {
    /*
     * count 只数「在库里」的文档：归档的与回收站里的不算。
     * 否则一个标签会永远挂着 3，点进去只有 1 篇，用户会以为内容丢了。
     */
    const rows = db().getAllSync<{ id: number; name: string; state: string; created_at: number; n: number }>(
      `SELECT t.id AS id, t.name AS name, t.state AS state, t.created_at AS created_at,
              (SELECT COUNT(*) FROM doc_tag_links l
                 JOIN documents d ON d.id = l.document_id
                WHERE l.tag_id = t.id AND d.deleted_at IS NULL AND d.stage = 'library') AS n
         FROM doc_tags t
        ORDER BY n DESC, t.name`,
    );
    return rows.map(toDocTag);
  },

  async createDocTag(name, state = 'approved') {
    const clean = normalizeTagName(name);
    if (!clean) throw new Error('标签名不能为空');
    // 重名直接把已有那条返回：用户第二次输入「工作」要的就是那个「工作」。
    // 比较键折叠全半角与大小写，否则「ＡＩ」会新造一条，而它和「AI」在列表里是同一件事。
    return toDocTag({ ...ensureDocTagIn(db(), clean, state), n: 0 });
  },

  async deleteDocTag(id) {
    const d = db();
    d.withTransactionSync(() => {
      d.runSync('DELETE FROM doc_tag_links WHERE tag_id = ?', [id]);
      d.runSync('DELETE FROM doc_tags WHERE id = ?', [id]);
    });
  },

  async setDocumentTags(documentId, tagIds) {
    const d = db();
    const want = Array.from(new Set(tagIds.filter((n) => Number.isFinite(n))));
    d.withTransactionSync(() => {
      const have = d.getAllSync<{ tag_id: number }>(
        'SELECT tag_id FROM doc_tag_links WHERE document_id = ?',
        [documentId],
      ).map((r) => r.tag_id);
      const keep = new Set(want);
      for (const tagId of have) {
        if (!keep.has(tagId)) d.runSync('DELETE FROM doc_tag_links WHERE document_id = ? AND tag_id = ?', [documentId, tagId]);
      }
      for (const tagId of want) {
        if (have.includes(tagId)) continue;
        d.runSync('INSERT OR IGNORE INTO doc_tag_links (document_id, tag_id) VALUES (?, ?)', [documentId, tagId]);
      }
    });
  },

  async setDocumentStage(id, stage) {
    db().runSync('UPDATE documents SET stage = ?, updated_at = ? WHERE id = ?', [stage, Date.now(), id]);
  },

  /* ---------------- AI 提案（v0.28） ---------------- */

  async insertProposal(input) {
    const res = db().runSync(
      'INSERT INTO doc_proposals (kind, document_id, payload, state, created_at) VALUES (?, ?, ?, ?, ?)',
      [input.kind, input.documentId, serializeProposalPayload(input.payload), 'pending', Date.now()],
    );
    return Number(res.lastInsertRowId);
  },

  async findProposal(id) {
    const row = db().getFirstSync<ProposalRow>('SELECT * FROM doc_proposals WHERE id = ?', [id]);
    return row ? toProposal(row) : null;
  },

  async decideProposal(id, state) {
    db().runSync('UPDATE doc_proposals SET state = ?, decided_at = ? WHERE id = ?', [state, Date.now(), id]);
  },

  async replaceDocumentContent(id, content, expectedRevision) {
    const d = db();
    let ok = false;
    d.withTransactionSync(() => { ok = replaceDocumentContentIn(d, id, content, expectedRevision); });
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
        WHERE c.document_id = ? AND d.deleted_at IS NULL
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
              AND d.deleted_at IS NULL
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
        WHERE c.document_id IN (${ids}) AND c.text LIKE ? ESCAPE '\\' AND d.deleted_at IS NULL
        ORDER BY c.document_id, c.ordinal
        LIMIT ?`,
      [like, limit],
    );
    return rows.map(toDocumentChunk);
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
    // 回收站里的不算数：设置页那个「总条数」要和时间轴上数得出来的对得上
    const total = countOf(d, 'SELECT COUNT(*) AS n FROM fragments WHERE deleted_at IS NULL');
    // 「还没整理」= 从没进过某次整理并落库。不是 status：v0.7 之后没人改它了
    const pending = countOf(
      d,
      'SELECT COUNT(*) AS n FROM fragments WHERE organized_at IS NULL AND merged_into IS NULL AND deleted_at IS NULL',
    );
    // 被合并掉的待办还在表里（只是隐藏了），不能算进「未完成」
    const todoOpen = countOf(
      d,
      'SELECT COUNT(*) AS n FROM todos WHERE done = 0 AND merged_into IS NULL',
    );
    return { total, pending, todoOpen };
  },

  /* ---------------- 完整备份 ---------------- */

  async exportBackup(appVersion) {
    const d = db();
    return createBackup({
      appVersion,
      counts: {
        /* trash:ok 备份装的是整个库，回收站里的行也在包里；这里要的是真实行数 */
        fragments: countOf(d, 'SELECT COUNT(*) AS n FROM fragments'),
        images: countOf(d, 'SELECT COUNT(*) AS n FROM fragment_images'),
        documents: countOf(d, 'SELECT COUNT(*) AS n FROM documents'),
      },
      snapshot: snapshotDatabaseTo,
      schemaVersion: databaseSchemaVersion,
    });
  },

  async restoreBackup(zipUri) {
    return restoreBackupFile(zipUri, {
      snapshot: snapshotDatabaseTo,
      close: closeDatabase,
      schemaVersion: databaseSchemaVersion,
      /*
       * 恢复的库可能来自更低的版本：db() 会重新打开，但不会自己补迁移。
       * 手动跑一次 migrate —— 它按 user_version 只补缺的那几段，跑到当前版本就停。
       */
      reopen: async () => {
        migrate(openAndPrepare());
      },
    });
  },

  async peekBackup(zipUri) {
    return peekBackupFile(zipUri, databaseSchemaVersion());
  },
  async restoreSafetyCopy(name) {
    return restoreSafetyCopyFile(name, {
      snapshot: snapshotDatabaseTo,
      close: closeDatabase,
      schemaVersion: databaseSchemaVersion,
      reopen: async () => {
        migrate(openAndPrepare());
      },
    });
  },

  async listSafetyCopies() {
    return readSafetyCopies();
  },
};
