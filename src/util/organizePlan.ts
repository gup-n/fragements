/**
 * 多轮整理的「计划」：把每一批的模型输出合并成一份可确认、可写入的清单。
 *
 * 这一层是纯函数，不碰 repo、不碰 UI，方便直接跑断言。
 * 三条纪律：
 * - 所有 id 必须属于本批（tags/todos/merge）或现有待办（todo_done/drop/merge_todos）
 * - 待办按归一化文案去重，跨批也不会重复
 * - 同一条待办不能既标完成又删除，也不能出现在两条合并建议里
 */
import type {
  BatchResult,
  DropTodoSuggestion,
  MergeSuggestion,
  MergeTodoSuggestion,
  OrganizePlan,
  OrganizeReview,
  TagGroup,
  TagStat,
  Todo,
  TodoDoneSuggestion,
  TodoSuggestion,
} from '../types';
import { containsText, normText } from './text';
import { cleanTag, normalizeTag, sameTag } from './tokenize';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 日期既要「长得像」也要「真的存在」。
 * 只校验 `\d{4}-\d{2}-\d{2}` 会把 `2026-13-99` 放进库里，
 * 到期提示和周期筛选都会跟着出问题，而用户在界面上根本看不出哪里错了。
 */
function validDate(raw: string): string | null {
  const s = raw.trim();
  if (!DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return s;
}
const MAX_LABELS = 3;
const MAX_TODO_CHARS = 100;
const MAX_SUMMARY_CHARS = 240;
/** 跨批上下文最多留多少字。太长会稀释本轮碎片，太短会丢早先的约定 */
const MAX_CONTEXT_CHARS = 1500;

export function emptyPlan(): OrganizePlan {
  return {
    tags: [],
    todos: [],
    merge: [],
    todo_done: [],
    drop_todos: [],
    merge_todos: [],
    batchSummaries: [],
    processedIds: [],
    skippedIds: [],
    rounds: 0,
    rejected: 0,
  };
}

/** 从 session 的 plan_json 读回来；脏数据不能让整理页直接崩 */
export function normalizePlan(raw: unknown): OrganizePlan {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    tags: arr<TagSuggestionLike>(obj.tags).map((t) => ({
      id: Number(t?.id),
      labels: Array.isArray(t?.labels) ? t.labels.filter((x): x is string => typeof x === 'string') : [],
      project: typeof t?.project === 'string' && t.project.trim() ? t.project.trim() : null,
    })).filter((t) => Number.isFinite(t.id) && t.labels.length > 0),
    todos: arr<TodoSuggestion>(obj.todos).filter((t) => typeof t?.text === 'string' && t.text.trim()),
    merge: arr<MergeSuggestion>(obj.merge).filter((m) => Number.isFinite(Number(m?.keep_id))),
    todo_done: arr<TodoDoneSuggestion>(obj.todo_done).filter((d) => Number.isFinite(Number(d?.todo_id))),
    drop_todos: arr<DropTodoSuggestion>(obj.drop_todos).filter((d) => Number.isFinite(Number(d?.todo_id))),
    merge_todos: arr<MergeTodoSuggestion>(obj.merge_todos).filter((m) => Number.isFinite(Number(m?.keep_id))),
    batchSummaries: Array.isArray(obj.batchSummaries)
      ? obj.batchSummaries.filter((s): s is string => typeof s === 'string')
      : [],
    processedIds: Array.isArray(obj.processedIds)
      ? obj.processedIds.map(Number).filter((n) => Number.isFinite(n))
      : [],
    skippedIds: Array.isArray(obj.skippedIds)
      ? obj.skippedIds.map(Number).filter((n) => Number.isFinite(n))
      : [],
    rounds: Number.isFinite(Number(obj.rounds)) ? Number(obj.rounds) : 0,
    rejected: Number.isFinite(Number(obj.rejected)) ? Number(obj.rejected) : 0,
  };
}

interface TagSuggestionLike {
  id?: number;
  labels?: string[];
  project?: string | null;
}

/**
 * 当前待办的有效视图：把计划里已经要标完成 / 删除 / 合并的算进去。
 * 下一轮 prompt 用这份，模型不会反复对同一条待办提同样的建议。
 */
export function effectiveTodos(todos: Todo[], plan: OrganizePlan): Todo[] {
  const done = new Set(plan.todo_done.map((d) => d.todo_id));
  const dropped = new Set(plan.drop_todos.map((d) => d.todo_id));
  const merged = new Map<number, MergeTodoSuggestion>();
  for (const m of plan.merge_todos) {
    merged.set(m.keep_id, m);
    for (const id of m.drop_ids) dropped.add(id);
  }
  return todos
    .filter((t) => !dropped.has(t.id))
    .map((t) => {
      const m = merged.get(t.id);
      return {
        ...t,
        done: t.done || done.has(t.id),
        text: m?.text ?? t.text,
      };
    });
}

/** 本轮之前已经抽出的新待办文案。给模型看，避免换个说法再抽一遍 */
export function plannedTodoTexts(plan: OrganizePlan): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of plan.todos) {
    const key = normText(t.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t.text);
  }
  return out;
}

/**
 * 加上本轮计划里的新标签后的标签表，给**下一批**的 prompt 用。
 *
 * 不给这份的话，第 4 批会给第 1 批刚建的「装机」再造一个「装机记录」——
 * 模型只看得见库里的标签，看不见这一轮自己刚建的。
 * 次数只是给模型的强弱提示，不用精确：新标签按「有几条碎片用到」计数。
 */
export function effectiveTags(existing: TagStat[], plan: OrganizePlan): TagStat[] {
  const byKey = new Map<string, TagStat>();
  for (const t of existing) {
    const key = normalizeTag(t.name);
    if (key && !byKey.has(key)) byKey.set(key, { name: t.name, count: t.count });
  }
  const hits = new Map<string, number>();
  for (const item of plan.tags) {
    for (const label of item.labels) {
      const key = normalizeTag(label);
      if (!key) continue;
      hits.set(key, (hits.get(key) ?? 0) + 1);
      if (!byKey.has(key)) byKey.set(key, { name: label, count: 0 });
    }
  }
  return Array.from(byKey.values())
    .map((t) => {
      const extra = hits.get(normalizeTag(t.name)) ?? 0;
      return extra ? { ...t, count: t.count + extra } : t;
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export interface MergeContext {
  /** 本批碎片 id（校验 tags/todos/merge） */
  batchIds: number[];
  /** 已有标签，用于把新标签收敛到已有写法 */
  existingTags: TagStat[];
  /** 现有待办（含已完成），用于校验 todo_done/drop/merge_todos */
  todos: Todo[];
}

/**
 * 把一批模型输出并进计划。
 * 不做「静默丢弃」：非法条目计入 rejected，界面会如实显示。
 */
export function mergeBatchResult(
  plan: OrganizePlan,
  result: BatchResult,
  ctx: MergeContext,
): OrganizePlan {
  const validBatch = new Set(ctx.batchIds);
  let rejected = plan.rejected + (Number(result.rejected) || 0);

  // ── 标签 ───────────────────────────────────────────────
  const canonical = new Map<string, string>();
  for (const t of ctx.existingTags) {
    const key = normalizeTag(t.name);
    if (key) canonical.set(key, t.name);
  }
  for (const t of plan.tags) {
    for (const label of t.labels) {
      const key = normalizeTag(label);
      if (key && !canonical.has(key)) canonical.set(key, label);
    }
  }

  const tagById = new Map<number, { id: number; labels: string[]; project: string | null }>();
  for (const t of plan.tags) {
    tagById.set(t.id, { id: t.id, labels: [...t.labels], project: t.project });
  }

  for (const item of result.tags) {
    const id = Number(item?.id);
    if (!Number.isFinite(id) || !validBatch.has(id)) {
      rejected++;
      continue;
    }
    const seen = new Set<string>();
    const labels: string[] = [];
    for (const raw of Array.isArray(item?.labels) ? item.labels : []) {
      if (typeof raw !== 'string') continue;
      const key = normalizeTag(raw);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      // 已有写法优先，避免「NAS」「nas」并存
      labels.push(canonical.get(key) ?? cleanTag(raw));
      if (!canonical.has(key)) canonical.set(key, labels[labels.length - 1]);
      if (labels.length >= MAX_LABELS) break;
    }
    if (!labels.length) continue;
    const project =
      typeof item?.project === 'string' && item.project.trim() ? item.project.trim().slice(0, 20) : null;

    const prev = tagById.get(id);
    if (prev) {
      for (const label of labels) {
        const key = normalizeTag(label);
        if (!prev.labels.some((x) => normalizeTag(x) === key)) prev.labels.push(label);
      }
      prev.labels = prev.labels.slice(0, MAX_LABELS);
      prev.project = prev.project ?? project;
    } else {
      tagById.set(id, { id, labels: labels.slice(0, MAX_LABELS), project });
    }
  }

  // ── 新待办 ─────────────────────────────────────────────
  const knownTodoText = new Set<string>();
  for (const t of ctx.todos) {
    if (!t.done) knownTodoText.add(normText(t.text));
  }
  for (const t of plan.todos) knownTodoText.add(normText(t.text));

  const todos: TodoSuggestion[] = [...plan.todos];
  for (const item of result.todos) {
    const raw = typeof item?.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : '';
    if (!raw) {
      rejected++;
      continue;
    }
    const text = raw.length > MAX_TODO_CHARS ? `${raw.slice(0, MAX_TODO_CHARS - 1)}…` : raw;
    const key = normText(text);
    // 重复不是「非法」，不记 rejected；跨批去重本来就会命中
    if (!key || knownTodoText.has(key)) continue;
    knownTodoText.add(key);
    const due = typeof item?.due === 'string' ? validDate(item.due) : null;
    const rawId = Number(item?.id);
    todos.push({
      text,
      due,
      id: Number.isFinite(rawId) && validBatch.has(rawId) ? rawId : null,
    });
  }

  // ── 合并碎片 ───────────────────────────────────────────
  const merges: MergeSuggestion[] = plan.merge.map((m) => ({ ...m, drop_ids: [...m.drop_ids] }));
  for (const item of result.merge) {
    const keep = Number(item?.keep_id);
    if (!Number.isFinite(keep) || !validBatch.has(keep)) {
      rejected++;
      continue;
    }
    const drops = Array.from(
      new Set(
        (Array.isArray(item?.drop_ids) ? item.drop_ids : [])
          .map(Number)
          .filter((n) => Number.isFinite(n) && validBatch.has(n) && n !== keep),
      ),
    );
    if (!drops.length) {
      rejected++;
      continue;
    }
    const prev = merges.find((m) => m.keep_id === keep);
    if (prev) {
      for (const id of drops) if (!prev.drop_ids.includes(id)) prev.drop_ids.push(id);
      prev.reason ??= typeof item?.reason === 'string' && item.reason.trim() ? item.reason.trim() : null;
    } else {
      merges.push({
        keep_id: keep,
        drop_ids: drops,
        reason: typeof item?.reason === 'string' && item.reason.trim() ? item.reason.trim() : null,
      });
    }
  }

  // ── 待办操作：完成 / 删除 / 合并 ───────────────────────
  const open = ctx.todos.filter((t) => !t.done);
  const openIds = new Set(open.map((t) => t.id));

  const doneIds = new Set(plan.todo_done.map((d) => d.todo_id));
  const dropIds = new Set(plan.drop_todos.map((d) => d.todo_id));
  const mergeDrops = new Set(plan.merge_todos.flatMap((m) => m.drop_ids));
  const mergeKeeps = new Set(plan.merge_todos.map((m) => m.keep_id));

  const todoDone: TodoDoneSuggestion[] = [...plan.todo_done];
  for (const item of result.todo_done) {
    const id = Number(item?.todo_id);
    if (!Number.isFinite(id) || !openIds.has(id)) {
      rejected++;
      continue;
    }
    if (doneIds.has(id) || dropIds.has(id) || mergeDrops.has(id)) continue;
    doneIds.add(id);
    todoDone.push({
      todo_id: id,
      reason: typeof item?.reason === 'string' && item.reason.trim() ? item.reason.trim() : null,
    });
  }

  const dropTodos: DropTodoSuggestion[] = [...plan.drop_todos];
  for (const item of result.drop_todos) {
    const id = Number(item?.todo_id);
    if (!Number.isFinite(id) || !openIds.has(id)) {
      rejected++;
      continue;
    }
    if (doneIds.has(id) || dropIds.has(id) || mergeDrops.has(id) || mergeKeeps.has(id)) continue;
    dropIds.add(id);
    dropTodos.push({
      todo_id: id,
      reason: typeof item?.reason === 'string' && item.reason.trim() ? item.reason.trim() : null,
    });
  }

  const mergeTodos: MergeTodoSuggestion[] = plan.merge_todos.map((m) => ({
    ...m,
    drop_ids: [...m.drop_ids],
  }));
  for (const item of result.merge_todos) {
    const keep = Number(item?.keep_id);
    if (!Number.isFinite(keep) || !openIds.has(keep) || doneIds.has(keep) || dropIds.has(keep)) {
      rejected++;
      continue;
    }
    const drops: number[] = [];
    for (const raw of Array.isArray(item?.drop_ids) ? item.drop_ids : []) {
      const id = Number(raw);
      if (!Number.isFinite(id) || id === keep || !openIds.has(id)) continue;
      if (doneIds.has(id) || dropIds.has(id) || mergeDrops.has(id) || mergeKeeps.has(id)) continue;
      if (drops.includes(id)) continue;
      drops.push(id);
    }
    if (!drops.length) {
      rejected++;
      continue;
    }
    const prev = mergeTodos.find((m) => m.keep_id === keep);
    if (prev) {
      for (const id of drops) {
        if (!prev.drop_ids.includes(id)) prev.drop_ids.push(id);
        mergeDrops.add(id);
      }
      prev.text ??= typeof item?.text === 'string' && item.text.trim() ? item.text.trim().slice(0, 60) : null;
    } else {
      mergeTodos.push({
        keep_id: keep,
        drop_ids: drops,
        text: typeof item?.text === 'string' && item.text.trim() ? item.text.trim().slice(0, 60) : null,
        reason: typeof item?.reason === 'string' && item.reason.trim() ? item.reason.trim() : null,
      });
      mergeKeeps.add(keep);
      for (const id of drops) mergeDrops.add(id);
    }
  }

  const summary =
    typeof result.batch_summary === 'string'
      ? result.batch_summary.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS)
      : '';

  const processed = new Set(plan.processedIds);
  for (const id of ctx.batchIds) processed.add(id);

  return {
    tags: Array.from(tagById.values()),
    todos,
    merge: merges,
    todo_done: todoDone,
    drop_todos: dropTodos,
    merge_todos: mergeTodos,
    batchSummaries: summary ? [...plan.batchSummaries, summary] : plan.batchSummaries,
    processedIds: Array.from(processed),
    skippedIds: [...plan.skippedIds],
    rounds: plan.rounds + 1,
    rejected,
  };
}

/** 标签组：按名字聚合，新标签标出来，和已有标签很像的给提示 */
export function buildTagGroups(plan: OrganizePlan, existingTags: TagStat[]): TagGroup[] {
  const byLabel = new Map<string, { label: string; ids: Set<number> }>();
  for (const t of plan.tags) {
    for (const label of t.labels) {
      const key = normalizeTag(label);
      if (!key) continue;
      const hit = byLabel.get(key);
      if (hit) hit.ids.add(t.id);
      else byLabel.set(key, { label, ids: new Set([t.id]) });
    }
  }

  const groups: TagGroup[] = [];
  for (const { label, ids } of byLabel.values()) {
    const isNew = !existingTags.some((t) => sameTag(t.name, label));
    const similarTo = isNew
      ? existingTags.find((t) => !sameTag(t.name, label) && containsText(label, t.name))?.name ?? null
      : null;
    groups.push({
      label,
      isNew,
      similarTo,
      fragmentIds: Array.from(ids).sort((a, b) => a - b),
    });
  }

  groups.sort((a, b) => {
    // 需要人看一眼的排前面：新且疑似重复 > 新 > 旧
    const rank = (g: TagGroup) => (g.isNew ? (g.similarTo ? 0 : 1) : 2);
    return rank(a) - rank(b) || b.fragmentIds.length - a.fragmentIds.length || a.label.localeCompare(b.label);
  });
  return groups;
}

/** 跑完所有批次后，把计划收成确认页要的结构 */
export function finalizePlan(plan: OrganizePlan, existingTags: TagStat[]): OrganizeReview {
  const tags = buildTagGroups(plan, existingTags);
  return {
    tags,
    todos: [...plan.todos],
    merge: plan.merge.map((m) => ({ ...m, drop_ids: [...m.drop_ids] })),
    todo_done: [...plan.todo_done],
    drop_todos: [...plan.drop_todos],
    merge_todos: plan.merge_todos.map((m) => ({ ...m, drop_ids: [...m.drop_ids] })),
    newTagCount: tags.filter((g) => g.isNew).length,
    processedCount: plan.processedIds.length,
    skippedCount: plan.skippedIds.length,
    rounds: plan.rounds,
    rejected: plan.rejected,
  };
}

/**
 * 把这一批摘要接进跨批上下文。
 * 只留尾部：标签/待办清单每轮都会重新给全量，摘要的用处是「刚聊到哪了」。
 */
export function appendSummary(prev: string, next: string): string {
  const line = next.replace(/\s+/g, ' ').trim();
  if (!line) return prev;
  const merged = prev ? `${prev}\n${line}` : line;
  return merged.length > MAX_CONTEXT_CHARS ? merged.slice(-MAX_CONTEXT_CHARS) : merged;
}
