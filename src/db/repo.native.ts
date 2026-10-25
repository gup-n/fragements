import * as SQLite from 'expo-sqlite';
import type { Repo } from './types';
import { parseTags } from './types';
import type { AskLog, Fragment, FragmentNature, FragmentSource, FragmentStatus, KnowledgeCard, Note, Todo, WebHit } from '../types';

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
  // v3：待办可以「合并」——被合并的那条留痕而不是删掉，合错了能撤回
  `
  ALTER TABLE todos ADD COLUMN merged_into INTEGER;
  CREATE INDEX IF NOT EXISTS idx_todos_merged ON todos(merged_into);
  `,
  // v4：知识卡支持二级方向。主题仍然只是字符串（没有 topics 表），
  // 这一列解决的是「大方向一致却各占一个主题」和「一个主题下挤了十几张卡」两件事
  `
  ALTER TABLE knowledge_cards ADD COLUMN subtopic TEXT;
  CREATE INDEX IF NOT EXISTS idx_cards_subtopic ON knowledge_cards(topic, subtopic);
  `,
  // v5：问答记录独立成表。它不是知识卡 —— 混进 knowledge_cards 会让卡片数虚高、
  // 检索捞出一堆一次性对话，而且「删掉这条问答」和「删掉一张沉淀下来的结论」完全是两回事
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

interface CardRow {
  id: number;
  topic: string;
  subtopic: string | null;
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
    subtopic: r.subtopic ?? null,
    title: r.title,
    gist: r.gist,
    body: r.body,
    sourceIds: parseIds(r.source_ids),
    createdAt: r.created_at,
    archived: r.archived === 1,
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

interface AskRow {
  id: number;
  scope: string;
  question: string;
  answer: string;
  reasoning: string;
  cited_ids: string;
  web_json: string;
  created_at: number;
}

function toAskLog(r: AskRow): AskLog {
  let web: WebHit[] = [];
  try {
    const v = JSON.parse(r.web_json);
    if (Array.isArray(v)) web = v;
  } catch {
    /* 脏数据当没有，不能因为一条记录解析失败就让整个列表空白 */
  }
  return {
    id: r.id,
    scope: r.scope,
    question: r.question,
    answer: r.answer,
    reasoning: r.reasoning ?? '',
    citedIds: parseIds(r.cited_ids),
    web,
    createdAt: r.created_at,
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

  async listFragmentsBetween(from, to) {
    const rows = db().getAllSync<FragmentRow>(
      'SELECT * FROM fragments WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC',
      [from, to],
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
    // 原来并进它的那几条落回未整理 —— 留着 merged_into 指向一个不存在的 id，
    // 再加 status='merged'，它们就既不在时间轴上、也不会被重新整理，等于凭空消失
    db().runSync(
      "UPDATE fragments SET merged_into = NULL, status = 'inbox' WHERE merged_into = ?",
      [id],
    );
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
      'INSERT INTO knowledge_cards (topic, subtopic, title, gist, body, source_ids, created_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
      [
        input.topic,
        input.subtopic ?? null,
        input.title,
        input.gist,
        input.body,
        JSON.stringify(input.sourceIds),
        Date.now(),
      ],
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

  async searchKnowledgeCards(keyword) {
    const kw = keyword.trim();
    if (!kw) return [];
    // 转义 LIKE 的通配符，否则用户输个 % 就把整库捞出来了
    const like = `%${kw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = db().getAllSync<CardRow>(
      `SELECT * FROM knowledge_cards
        WHERE archived = 0
          AND (title LIKE ? ESCAPE '\\' OR gist LIKE ? ESCAPE '\\'
               OR body LIKE ? ESCAPE '\\' OR topic LIKE ? ESCAPE '\\')
        ORDER BY created_at DESC`,
      [like, like, like, like],
    );
    return rows.map(toCard);
  },

  async listKnowledgeTopics() {
    const rows = db().getAllSync<{ topic: string; n: number; d: number }>(
      // COUNT(DISTINCT subtopic) 天然忽略 NULL，正好是「已分出去几个方向」
      `SELECT topic, COUNT(*) AS n, COUNT(DISTINCT subtopic) AS d
         FROM knowledge_cards WHERE archived = 0
        GROUP BY topic ORDER BY n DESC, topic ASC`,
    );
    return rows.map((r) => ({ topic: r.topic, count: r.n, dirs: r.d }));
  },

  async listKnowledgeSubtopics(topic) {
    const rows = db().getAllSync<{ subtopic: string | null; n: number }>(
      `SELECT subtopic, COUNT(*) AS n FROM knowledge_cards
        WHERE archived = 0 AND topic = ?
        GROUP BY subtopic
        ORDER BY n DESC, subtopic ASC`,
      [topic],
    );
    return rows.map((r) => ({ subtopic: r.subtopic ?? null, count: r.n }));
  },

  async retopicCards(from, to) {
    // 改名到自己、或者空列表，都不做任何事（否则会白跑一趟 UPDATE）
    const list = Array.from(new Set(from.filter((t) => !!t && t !== to)));
    if (!list.length) return { moved: 0 };
    const ph = list.map(() => '?').join(',');
    // 归档的卡片一起改：否则恢复之后会凭空多出一个只含归档卡的主题
    const res = db().runSync(`UPDATE knowledge_cards SET topic = ? WHERE topic IN (${ph})`, [
      to,
      ...list,
    ]);
    return { moved: res.changes };
  },

  async resubtopicCards(topic, from, to) {
    const conds: string[] = [];
    const fromParams: string[] = [];
    for (const s of from) {
      if (s === to) continue;
      if (s === null || s === '') {
        conds.push('subtopic IS NULL');
      } else {
        conds.push('subtopic = ?');
        fromParams.push(s);
      }
    }
    if (!conds.length) return { moved: 0 };
    // 同上：目标是空的时候走 NULL 字面量，别指望 ? 能绑 null
    const clear = to === null || to === '';
    const res = db().runSync(
      `UPDATE knowledge_cards SET ${clear ? 'subtopic = NULL' : 'subtopic = ?'} WHERE topic = ? AND (${conds.join(' OR ')})`,
      clear ? [topic, ...fromParams] : [to, topic, ...fromParams],
    );
    return { moved: res.changes };
  },

  async setCardSubtopic(ids, subtopic) {
    const list = Array.from(new Set(ids.filter((n) => Number.isFinite(n))));
    if (!list.length) return { changed: 0 };
    const ph = list.map(() => '?').join(',');
    // 清空方向必须把 NULL 写进 SQL 字面量，不能靠 `?` 绑定 null。
    // expo-sqlite 在部分版本上会把 JS null 当成「没给参数」或绑成字符串，
    // 结果是 UPDATE 改 0 行却正常返回 —— 表现就是「方向设得上、删不掉」。
    // NULL 在这里是 SQL 关键字不是用户数据，没有注入面。
    if (subtopic === null || subtopic === '') {
      const res = db().runSync(`UPDATE knowledge_cards SET subtopic = NULL WHERE id IN (${ph})`, list);
      return { changed: res.changes };
    }
    const res = db().runSync(`UPDATE knowledge_cards SET subtopic = ? WHERE id IN (${ph})`, [
      subtopic,
      ...list,
    ]);
    return { changed: res.changes };
  },

  async updateKnowledgeCard(id, patch) {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
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
    // 显式传 null 是「清掉二级方向」，和「不传」含义不同，所以不能用 || 判断。
    // 清空时写 NULL 字面量，理由同 setCardSubtopic —— 空方向必须真的变成 NULL，
    // 否则会留下一个叫空字符串的方向组。
    if (patch.subtopic !== undefined) {
      if (patch.subtopic === null || patch.subtopic === '') {
        sets.push('subtopic = NULL');
      } else {
        sets.push('subtopic = ?');
        params.push(patch.subtopic);
      }
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
    // period 为空的（主题总结之类）没有「同一周期」的概念，直接新增
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

  async insertAskLog(input) {
    const res = db().runSync(
      'INSERT INTO ask_logs (scope, question, answer, reasoning, cited_ids, web_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        input.scope,
        input.question,
        input.answer,
        input.reasoning,
        JSON.stringify(input.citedIds),
        JSON.stringify(input.web),
        Date.now(),
      ],
    );
    return Number(res.lastInsertRowId);
  },

  async listAskLogs(scope, limit = 60) {
    const rows = scope
      ? db().getAllSync<AskRow>(
          'SELECT * FROM ask_logs WHERE scope = ? ORDER BY created_at DESC LIMIT ?',
          [scope, limit],
        )
      : db().getAllSync<AskRow>('SELECT * FROM ask_logs ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows.map(toAskLog);
  },

  async updateAskLogQuestion(id, question) {
    db().runSync('UPDATE ask_logs SET question = ? WHERE id = ?', [question.trim(), id]);
  },

  async deleteAskLog(id) {
    db().runSync('DELETE FROM ask_logs WHERE id = ?', [id]);
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
    const inbox =
      db().getFirstSync<{ n: number }>("SELECT COUNT(*) AS n FROM fragments WHERE status = 'inbox'")
        ?.n ?? 0;
    // 被合并掉的待办还在表里（只是隐藏了），不能算进「未完成」，
    // 否则合并越多、首页那个数字越虚高
    const todoOpen =
      db().getFirstSync<{ n: number }>(
        'SELECT COUNT(*) AS n FROM todos WHERE done = 0 AND merged_into IS NULL',
      )?.n ?? 0;
    return { total, inbox, todoOpen };
  },
};
