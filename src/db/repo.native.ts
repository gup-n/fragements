import * as SQLite from 'expo-sqlite';
import type { Repo, OrganizeSessionPatch } from './types';
import { parseTags } from './types';
import type {
  Fragment,
  FragmentNature,
  FragmentSource,
  FragmentStatus,
  Note,
  OrganizePlan,
  OrganizeScope,
  OrganizeSession,
  TagStat,
  Todo,
} from '../types';
import { normalizePlan } from '../util/organizePlan';
import {
  buildFtsQuery,
  cleanTag,
  dedupeTags,
  indexText,
  likeNeedle,
  normalizeTag,
  sameTag,
} from '../util/tokenize';

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
];

function migrate(d: SQLite.SQLiteDatabase) {
  const row = d.getFirstSync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    d.execSync(MIGRATIONS[i]);
    d.execSync(`PRAGMA user_version = ${i + 1}`);
  }
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
  };
}

interface TodoRow {
  id: number;
  text: string;
  due_at: string | null;
  done: number;
  source_fragment_id: number | null;
  created_at: number;
  merged_into: number | null;
}

/** 待办行 → 领域对象。三处查询都用它，免得字段映射各写一遍漏掉新字段 */
function toTodo(r: TodoRow): Todo {
  return {
    id: r.id,
    text: r.text,
    dueAt: r.due_at,
    done: r.done === 1,
    sourceFragmentId: r.source_fragment_id,
    createdAt: r.created_at,
    mergedInto: r.merged_into,
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

/** 把一条碎片写进 FTS。先删后插，更新/打标签都走它 */
function indexFragment(
  d: SQLite.SQLiteDatabase,
  id: number,
  content: string,
  tags: string[],
  project: string | null,
) {
  d.runSync('DELETE FROM fragment_fts WHERE rowid = ?', [id]);
  d.runSync('INSERT INTO fragment_fts(rowid, text) VALUES (?, ?)', [
    id,
    indexText(content, tags, project),
  ]);
}

/** 按 200 条一页重建索引。迁移回填和设置页「重建索引」共用 */
function rebuildIndex(d: SQLite.SQLiteDatabase): number {
  d.execSync('DELETE FROM fragment_fts');
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
        indexFragment(d, r.id, r.content, parseTags(r.tags), r.project);
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
    const rows = db().getAllSync<FragmentRow>(
      'SELECT * FROM fragments ORDER BY created_at DESC LIMIT ?',
      [limit],
    );
    return rows.map(toFragment);
  },

  async listFragmentsBetween(from, to) {
    const rows = db().getAllSync<FragmentRow>(
      'SELECT * FROM fragments WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC',
      [from, to],
    );
    return rows.map(toFragment);
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
    return out;
  },

  async countFragments(scope) {
    const where = scope === 'all' ? 'merged_into IS NULL' : "status = 'inbox'";
    return countOf(db(), `SELECT COUNT(*) AS n FROM fragments WHERE ${where}`);
  },

  async insertFragment(content, source, createdAt) {
    const d = db();
    const text = content.trim();
    const row = createdAt ?? Date.now();
    const res = d.runSync(
      'INSERT INTO fragments (content, created_at, source, status) VALUES (?, ?, ?, ?)',
      [text, row, source, 'inbox'],
    );
    const id = Number(res.lastInsertRowId);
    indexFragment(d, id, text, [], null);
    return id;
  },

  async updateFragmentContent(id, content) {
    const d = db();
    const text = content.trim();
    d.runSync('UPDATE fragments SET content = ? WHERE id = ?', [text, id]);
    const row = d.getFirstSync<FragmentRow>('SELECT * FROM fragments WHERE id = ?', [id]);
    if (row) indexFragment(d, id, text, parseTags(row.tags), row.project);
  },

  async deleteFragment(id) {
    const d = db();
    d.runSync('DELETE FROM fragment_fts WHERE rowid = ?', [id]);
    d.runSync('DELETE FROM fragments WHERE id = ?', [id]);
    // 原来并进它的那几条落回未整理 —— 留着 merged_into 指向一个不存在的 id，
    // 再加 status='merged'，它们就既不在时间轴上、也不会被重新整理，等于凭空消失
    d.runSync(
      "UPDATE fragments SET merged_into = NULL, status = 'inbox' WHERE merged_into = ?",
      [id],
    );
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
    const row = d.getFirstSync<FragmentRow>('SELECT * FROM fragments WHERE id = ?', [id]);
    if (row) indexFragment(d, id, row.content, clean, project);
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
    const d = db();
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
        if (rows.length) return rows.map(toFragment);
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
    return rows.map(toFragment);
  },

  async listFragmentsByTag(tag, limit = 50) {
    const like = likeNeedle(tag);
    if (!like) return [];
    const rows = db().getAllSync<FragmentRow>(
      `SELECT * FROM fragments
        WHERE merged_into IS NULL AND tags LIKE ? ESCAPE '\\'
        ORDER BY created_at DESC LIMIT ?`,
      [like, limit],
    );
    return rows.map(toFragment);
  },

  async listTags() {
    const rows = db().getAllSync<{ tags: string }>(
      'SELECT tags FROM fragments WHERE merged_into IS NULL',
    );
    const map = new Map<string, { name: string; count: number }>();
    for (const r of rows) {
      for (const raw of parseTags(r.tags)) {
        const key = normalizeTag(raw);
        if (!key) continue;
        const hit = map.get(key);
        if (hit) hit.count += 1;
        else map.set(key, { name: raw, count: 1 });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  },

  async renameTag(from, to) {
    const target = cleanTag(to);
    if (!normalizeTag(target)) return { changed: 0 };
    return rewriteTags((tag) => (sameTag(tag, from) ? target : tag));
  },

  async deleteTag(name) {
    return rewriteTags((tag) => (sameTag(tag, name) ? null : tag));
  },

  async mergeTags(from, to) {
    const target = cleanTag(to);
    if (!normalizeTag(target) || !from.length) return { changed: 0 };
    const set = new Set(from.map(normalizeTag).filter(Boolean));
    return rewriteTags((tag) => (set.has(normalizeTag(tag)) ? target : tag));
  },

  async rebuildSearchIndex() {
    const indexed = rebuildIndex(db());
    return { indexed };
  },

  async insertTodo(input) {
    const res = db().runSync(
      'INSERT INTO todos (text, due_at, done, source_fragment_id, created_at) VALUES (?, ?, 0, ?, ?)',
      [input.text, input.dueAt, input.sourceFragmentId, Date.now()],
    );
    return Number(res.lastInsertRowId);
  },

  async listTodos() {
    const rows = db().getAllSync<TodoRow>(
      'SELECT * FROM todos WHERE merged_into IS NULL ORDER BY done ASC, created_at DESC',
    );
    return rows.map(toTodo);
  },

  async toggleTodo(id, done) {
    db().runSync('UPDATE todos SET done = ? WHERE id = ?', [done ? 1 : 0, id]);
  },

  async deleteTodo(id) {
    db().runSync('DELETE FROM todos WHERE id = ?', [id]);
  },

  async mergeTodos(keepId, dropIds, text) {
    const drops = dropIds.filter((id) => id !== keepId);
    if (text) db().runSync('UPDATE todos SET text = ? WHERE id = ?', [text, keepId]);
    if (!drops.length) return;
    const marks = drops.map(() => '?').join(',');
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
    const inbox = countOf(d, "SELECT COUNT(*) AS n FROM fragments WHERE status = 'inbox'");
    // 被合并掉的待办还在表里（只是隐藏了），不能算进「未完成」
    const todoOpen = countOf(
      d,
      'SELECT COUNT(*) AS n FROM todos WHERE done = 0 AND merged_into IS NULL',
    );
    const tags = await repo.listTags();
    return { total, inbox, todoOpen, tags: tags.length };
  },
};

/**
 * 标签改名/删除/合并的唯一实现。
 *
 * 标签不是实体表，而是 `fragments.tags` 里的字符串；所以只能逐条重写数组。
 * `map` 返回 null 表示删掉这个标签。写完顺手重建这一条的 FTS 文本 ——
 * 否则搜旧标签还能搜到，搜新标签搜不到。
 */
function rewriteTags(map: (tag: string) => string | null): { changed: number } {
  const d = db();
  const rows = d.getAllSync<FragmentRow>('SELECT * FROM fragments');
  let changed = 0;

  d.execSync('BEGIN');
  try {
    for (const row of rows) {
      const before = parseTags(row.tags);
      const after: string[] = [];
      const seen = new Set<string>();
      for (const tag of before) {
        const next = map(tag);
        if (!next) continue;
        const name = cleanTag(next);
        const key = normalizeTag(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        after.push(name);
      }
      if (before.length === after.length && before.every((t, i) => t === after[i])) continue;
      d.runSync('UPDATE fragments SET tags = ? WHERE id = ?', [JSON.stringify(after), row.id]);
      indexFragment(d, row.id, row.content, after, row.project);
      changed++;
    }
    d.execSync('COMMIT');
  } catch (e) {
    d.execSync('ROLLBACK');
    throw e;
  }
  return { changed };
}
