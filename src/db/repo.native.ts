import * as SQLite from 'expo-sqlite';
import type { Repo } from './types';
import { parseTags } from './types';
import type { Fragment, FragmentNature, FragmentSource, FragmentStatus, KnowledgeCard, Note, Todo } from '../types';

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
  // v2：引入内容性质与知识卡
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
}

interface CardRow {
  id: number;
  topic: string;
  title: string;
  gist: string;
  body: string;
  source_ids: string;
  created_at: number;
  archived: number;
}

function parseIds(raw: unknown): number[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

function toCard(r: CardRow): KnowledgeCard {
  return {
    id: r.id,
    topic: r.topic,
    title: r.title,
    gist: r.gist,
    body: r.body,
    sourceIds: parseIds(r.source_ids),
    createdAt: r.created_at,
    archived: r.archived === 1,
  };
}

export const repo: Repo = {
  async init() {
    const d = db();
    d.execSync('PRAGMA journal_mode = WAL;');
    d.execSync('PRAGMA foreign_keys = ON;');
    migrate(d);
  },

  async listFragments(limit = 500) {
    const rows = db().getAllSync<FragmentRow>(
      'SELECT * FROM fragments ORDER BY created_at DESC LIMIT ?',
      [limit],
    );
    return rows.map(toFragment);
  },

  async insertFragment(content, source, createdAt) {
    const res = db().runSync(
      'INSERT INTO fragments (content, created_at, source, status) VALUES (?, ?, ?, ?)',
      [content.trim(), createdAt ?? Date.now(), source, 'inbox'],
    );
    return Number(res.lastInsertRowId);
  },

  async updateFragmentContent(id, content) {
    db().runSync('UPDATE fragments SET content = ? WHERE id = ?', [content.trim(), id]);
  },

  async deleteFragment(id) {
    db().runSync('DELETE FROM fragments WHERE id = ?', [id]);
    db().runSync('UPDATE fragments SET merged_into = NULL WHERE merged_into = ?', [id]);
  },

  async applyTags(id, labels, project) {
    db().runSync('UPDATE fragments SET tags = ?, project = ?, status = ? WHERE id = ?', [
      JSON.stringify(labels),
      project,
      'tagged',
      id,
    ]);
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

  async insertKnowledgeCard(input) {
    const res = db().runSync(
      'INSERT INTO knowledge_cards (topic, title, gist, body, source_ids, created_at, archived) VALUES (?, ?, ?, ?, ?, ?, 0)',
      [input.topic, input.title, input.gist, input.body, JSON.stringify(input.sourceIds), Date.now()],
    );
    return Number(res.lastInsertRowId);
  },

  async listKnowledgeCards(topic) {
    const rows = topic
      ? db().getAllSync<CardRow>(
          'SELECT * FROM knowledge_cards WHERE topic = ? AND archived = 0 ORDER BY created_at DESC',
          [topic],
        )
      : db().getAllSync<CardRow>(
          'SELECT * FROM knowledge_cards WHERE archived = 0 ORDER BY topic ASC, created_at DESC',
        );
    return rows.map(toCard);
  },

  async listArchivedKnowledgeCards() {
    const rows = db().getAllSync<CardRow>(
      'SELECT * FROM knowledge_cards WHERE archived = 1 ORDER BY created_at DESC',
    );
    return rows.map(toCard);
  },

  async listKnowledgeTopics() {
    const rows = db().getAllSync<{ topic: string; n: number }>(
      'SELECT topic, COUNT(*) AS n FROM knowledge_cards WHERE archived = 0 GROUP BY topic ORDER BY n DESC, topic ASC',
    );
    return rows.map((r) => ({ topic: r.topic, count: r.n }));
  },

  async updateKnowledgeCard(id, patch) {
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.gist !== undefined) {
      sets.push('gist = ?');
      params.push(patch.gist);
    }
    if (patch.body !== undefined) {
      sets.push('body = ?');
      params.push(patch.body);
    }
    if (patch.topic !== undefined) {
      sets.push('topic = ?');
      params.push(patch.topic);
    }
    if (patch.archived !== undefined) {
      sets.push('archived = ?');
      params.push(patch.archived ? 1 : 0);
    }
    if (patch.sourceIds !== undefined) {
      sets.push('source_ids = ?');
      params.push(JSON.stringify(patch.sourceIds));
    }
    if (!sets.length) return;
    params.push(id);
    db().runSync(`UPDATE knowledge_cards SET ${sets.join(', ')} WHERE id = ?`, params);
  },

  async deleteKnowledgeCard(id) {
    db().runSync('DELETE FROM knowledge_cards WHERE id = ?', [id]);
  },

  async countInbox() {
    const row = db().getFirstSync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM fragments WHERE status = 'inbox'",
    );
    return row?.n ?? 0;
  },

  async insertTodo(input) {
    const res = db().runSync(
      'INSERT INTO todos (text, due_at, done, source_fragment_id, created_at) VALUES (?, ?, 0, ?, ?)',
      [input.text, input.dueAt, input.sourceFragmentId, Date.now()],
    );
    return Number(res.lastInsertRowId);
  },

  async listTodos() {
    const rows = db().getAllSync<TodoRow>('SELECT * FROM todos ORDER BY done ASC, created_at DESC');
    return rows.map<Todo>((r) => ({
      id: r.id,
      text: r.text,
      dueAt: r.due_at,
      done: r.done === 1,
      sourceFragmentId: r.source_fragment_id,
      createdAt: r.created_at,
    }));
  },

  async toggleTodo(id, done) {
    db().runSync('UPDATE todos SET done = ? WHERE id = ?', [done ? 1 : 0, id]);
  },

  async deleteTodo(id) {
    db().runSync('DELETE FROM todos WHERE id = ?', [id]);
  },

  async insertNote(input) {
    const res = db().runSync(
      'INSERT INTO notes (type, title, body_md, period, created_at) VALUES (?, ?, ?, ?, ?)',
      [input.type, input.title, input.bodyMd, input.period, Date.now()],
    );
    return Number(res.lastInsertRowId);
  },

  async listNotes(limit = 30) {
    const rows = db().getAllSync<{
      id: number;
      type: string;
      title: string | null;
      body_md: string;
      period: string | null;
      created_at: number;
    }>('SELECT * FROM notes ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows.map<Note>((r) => ({
      id: r.id,
      type: (r.type as Note['type']) ?? 'daily',
      title: r.title,
      bodyMd: r.body_md,
      period: r.period,
      createdAt: r.created_at,
    }));
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
    const total = db().getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM fragments')?.n ?? 0;
    const inbox = db().getFirstSync<{ n: number }>("SELECT COUNT(*) AS n FROM fragments WHERE status = 'inbox'")?.n ?? 0;
    const todoOpen = db().getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM todos WHERE done = 0')?.n ?? 0;
    return { total, inbox, todoOpen };
  },
};
