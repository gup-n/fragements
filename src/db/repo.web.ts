import type { Repo } from './types';
import { DONE_TODO_KEEP } from '../types';
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
import { emptyPlan, normalizePlan } from '../util/organizePlan';
import { cleanTag, dedupeTags, normalizeTag, sameTag, tokenizeText } from '../util/tokenize';

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
}

function empty(): WebDb {
  return { seq: 1, fragments: [], todos: [], notes: [], runs: [], settings: {}, sessions: [] };
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
    }));
    pruneDone(cache!);
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

  async listFragmentsByTag(tag, limit = 50) {
    return active(load())
      .filter((f) => f.tags.some((t) => sameTag(t, tag)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  },

  async listTags(): Promise<TagStat[]> {
    const map = new Map<string, { name: string; count: number }>();
    for (const f of active(load())) {
      for (const raw of f.tags) {
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
    const set = new Set(from.map(normalizeTag).filter(Boolean));
    if (!normalizeTag(target) || !set.size) return { changed: 0 };
    return rewriteTags((tag) => (set.has(normalizeTag(tag)) ? target : tag));
  },

  async rebuildSearchIndex() {
    return { indexed: active(load()).length };
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
    });
    persist();
    return id;
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
    const t = d.todos.find((x) => x.id === id);
    if (t) {
      t.done = done;
      t.doneAt = done ? Date.now() : null;
    }
    if (done) pruneDone(d);
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
      tags: (await this.listTags()).length,
    };
  },
};

function rewriteTags(map: (tag: string) => string | null): { changed: number } {
  const d = load();
  let changed = 0;
  for (const f of d.fragments) {
    const before = [...f.tags];
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
    f.tags = after;
    changed++;
  }
  if (changed) persist();
  return { changed };
}
