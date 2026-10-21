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
    d.fragments.forEach((x) => {
      if (x.mergedInto === id) x.mergedInto = null;
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

  async updateKnowledgeCard(id, patch) {
    const d = load();
    const c = d.knowledgeCards.find((x) => x.id === id);
    if (!c) return;
    if (patch.title !== undefined) c.title = patch.title;
    if (patch.gist !== undefined) c.gist = patch.gist;
    if (patch.body !== undefined) c.body = patch.body;
    if (patch.topic !== undefined) c.topic = patch.topic;
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
    });
    persist();
    return id;
  },

  async listTodos() {
    return [...load().todos].sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
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

  async insertNote(input) {
    const d = load();
    const id = nextId(d);
    d.notes.push({ id, ...input, createdAt: Date.now() });
    persist();
    return id;
  },

  async listNotes(limit = 30) {
    return [...load().notes].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
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
      todoOpen: d.todos.filter((t) => !t.done).length,
    };
  },
};

// parseTags 在此实现中不参与（web 版直接存数组），保留导入以避免 tree-shaking 弃用告警
void parseTags;
