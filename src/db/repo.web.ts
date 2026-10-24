import type { Repo } from './types';
import { parseTags } from './types';
import type { Fragment, FragmentNature, FragmentSource, FragmentStatus, KnowledgeCard, Note, Todo } from '../types';

/**
 * 浏览器预览用的存储实现，数据落在 localStorage。
 * 只服务于桌面端调试/预览，真机走 repo.native.ts 的 SQLite。
 * 行为与 native 版保持语义一致，方便对照排查问题。
 */

const KEY = 'fragments.webdb.v1';

interface WebDb {
  seq: number;
  fragments: Fragment[];
  todos: Todo[];
  notes: Note[];
  runs: { id: number; startedAt: number; fragmentIds: number[]; model: string; resultJson: string; applied: number }[];
  settings: Record<string, string>;
  knowledgeCards: KnowledgeCard[];
}

function empty(): WebDb {
  return { seq: 1, fragments: [], todos: [], notes: [], runs: [], settings: {}, knowledgeCards: [] };
}

let cache: WebDb | null = null;

function load(): WebDb {
  if (cache) return cache;
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    cache = raw ? { ...empty(), ...JSON.parse(raw) } : empty();
    // v0.4.1 之前的卡片没有 subtopic 字段，补成 null，
    // 否则下游拿到 undefined，`subtopic === null` 的分组判断会漏掉这批卡
    cache!.knowledgeCards = (cache!.knowledgeCards ?? []).map((c) => ({
      ...c,
      subtopic: c.subtopic ?? null,
    }));
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

export const repo: Repo = {
  async init() {
    load();
  },

  async listFragments(limit = 500) {
    return [...load().fragments].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  },

  async listFragmentsBetween(from: number, to: number) {
    return load()
      .fragments.filter((f) => f.createdAt >= from && f.createdAt < to)
      .sort((a, b) => a.createdAt - b.createdAt);
  },

  async insertFragment(content, source: FragmentSource, createdAt?: number) {
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
    });
    persist();
    return id;
  },

  async updateFragmentContent(id, content) {
    const d = load();
    const f = d.fragments.find((x) => x.id === id);
    if (f) f.content = content.trim();
    persist();
  },

  async deleteFragment(id) {
    const d = load();
    d.fragments = d.fragments.filter((x) => x.id !== id);
    // 并进它的那几条落回未整理，否则会变成「指向不存在的 id + status=merged」的孤儿
    d.fragments.forEach((x) => {
      if (x.mergedInto === id) {
        x.mergedInto = null;
        x.status = 'inbox';
      }
    });
    persist();
  },

  async applyTags(id, labels, project) {
    const d = load();
    const f = d.fragments.find((x) => x.id === id);
    if (f) {
      f.tags = labels;
      f.project = project;
      f.status = 'tagged';
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

  async countInbox() {
    return load().fragments.filter((f) => f.status === 'inbox').length;
  },

  async setFragmentNature(ids, nature: FragmentNature) {
    const d = load();
    d.fragments.forEach((f) => {
      if (ids.includes(f.id)) f.nature = nature;
    });
    persist();
  },

  async insertKnowledgeCard(input) {
    const d = load();
    const id = nextId(d);
    d.knowledgeCards.push({
      id,
      topic: input.topic,
      subtopic: input.subtopic ?? null,
      title: input.title,
      gist: input.gist,
      body: input.body,
      sourceIds: input.sourceIds,
      createdAt: Date.now(),
      archived: false,
    });
    persist();
    return id;
  },

  async listKnowledgeCards(topic) {
    const cards = load().knowledgeCards.filter((c) => !c.archived && (!topic || c.topic === topic));
    return cards.sort((a, b) => a.topic.localeCompare(b.topic) || b.createdAt - a.createdAt);
  },

  async searchKnowledgeCards(keyword) {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return [];
    return load()
      .knowledgeCards.filter(
        (c) =>
          !c.archived &&
          [c.title, c.gist, c.body, c.topic].some((s) => s.toLowerCase().includes(kw)),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  async listArchivedKnowledgeCards() {
    return load()
      .knowledgeCards.filter((c) => c.archived)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  async listKnowledgeTopics() {
    const map = new Map<string, number>();
    for (const c of load().knowledgeCards) {
      if (c.archived) continue;
      map.set(c.topic, (map.get(c.topic) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
  },

  async listKnowledgeSubtopics(topic) {
    const map = new Map<string | null, number>();
    for (const c of load().knowledgeCards) {
      if (c.archived || c.topic !== topic) continue;
      const key = c.subtopic ?? null;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([subtopic, count]) => ({ subtopic, count }))
      .sort((a, b) => b.count - a.count || (a.subtopic ?? '').localeCompare(b.subtopic ?? ''));
  },

  async retopicCards(from, to) {
    const list = new Set(from.filter((t) => !!t && t !== to));
    if (!list.size) return { moved: 0 };
    let moved = 0;
    // 归档的一起改，否则恢复后会多出一个只含归档卡的主题
    for (const c of load().knowledgeCards) {
      if (!list.has(c.topic)) continue;
      c.topic = to;
      moved++;
    }
    if (moved) persist();
    return { moved };
  },

  async resubtopicCards(topic, from, to) {
    const list = from.filter((s) => s !== to);
    if (!list.length) return { moved: 0 };
    let moved = 0;
    for (const c of load().knowledgeCards) {
      if (c.topic !== topic || !list.includes(c.subtopic ?? null)) continue;
      c.subtopic = to;
      moved++;
    }
    if (moved) persist();
    return { moved };
  },

  async updateKnowledgeCard(id, patch) {
    const d = load();
    const c = d.knowledgeCards.find((x) => x.id === id);
    if (!c) return;
    if (patch.title !== undefined) c.title = patch.title;
    if (patch.gist !== undefined) c.gist = patch.gist;
    if (patch.body !== undefined) c.body = patch.body;
    if (patch.topic !== undefined) c.topic = patch.topic;
    // 传 null 是「清掉二级方向」，不能用 || 判断
    if (patch.subtopic !== undefined) c.subtopic = patch.subtopic;
    if (patch.archived !== undefined) c.archived = patch.archived;
    if (patch.sourceIds !== undefined) c.sourceIds = patch.sourceIds;
    persist();
  },

  async deleteKnowledgeCard(id) {
    const d = load();
    d.knowledgeCards = d.knowledgeCards.filter((c) => c.id !== id);
    persist();
  },

  async insertTodo(input) {
    const d = load();
    const id = nextId(d);
    d.todos.push({
      id,
      text: input.text,
      dueAt: input.dueAt,
      done: false,
      sourceFragmentId: input.sourceFragmentId,
      createdAt: Date.now(),
      mergedInto: null,
    });
    persist();
    return id;
  },

  async listTodos() {
    return load()
      .todos.filter((t) => t.mergedInto === null)
      .sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
  },

  async toggleTodo(id, done) {
    const d = load();
    const t = d.todos.find((x) => x.id === id);
    if (t) t.done = done;
    persist();
  },

  async deleteTodo(id) {
    const d = load();
    d.todos = d.todos.filter((x) => x.id !== id);
    persist();
  },

  async mergeTodos(keepId, dropIds, text) {
    const d = load();
    const keep = d.todos.find((t) => t.id === keepId);
    if (keep && text) keep.text = text;
    for (const t of d.todos) {
      if (dropIds.includes(t.id) && t.id !== keepId) t.mergedInto = keepId;
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
      inbox: d.fragments.filter((f) => f.status === 'inbox').length,
      // 被合并掉的待办不算「未完成」，和 native 版口径保持一致
      todoOpen: d.todos.filter((t) => !t.done && t.mergedInto === null).length,
    };
  },
};

// parseTags 在此实现中不参与（web 版直接存数组），保留导入以避免 tree-shaking 弃用告警
void parseTags;
