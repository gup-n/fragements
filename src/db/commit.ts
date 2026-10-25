/**
 * 应用整理结果：把用户在确认页勾过的条目写进库。
 *
 * v0.7 的重写要点：
 * - 入参从「一批的模型输出」变成「整次循环累积出的 `OrganizePlan`」，
 *   因为现在会跑很多批、最后才统一确认。逐批写库会让「用户改主意」无从下手。
 * - 标签的勾选粒度是**一整组同名标签**（`工作 32 条`），不是逐条碎片 ——
 *   200 条标签逐条列，用户根本审不过来。分组由 `buildTagGroups` 算，
 *   本文件重新算一遍而**不接收界面传来的分组**：判据只有一份，
 *   界面显示的和实际写入的必然是同一个结果。
 * - **没有勾选的标签，不会把碎片原有标签洗掉**。一条碎片的标签全被取消时
 *   直接跳过，不写空数组 —— 静默清空是那种「事后才发现、且找不回来」的破坏。
 *
 * 三条纪律（写在代码里，不靠界面提示）：
 * - 只有 `accepted(key)` 为真的条目才会写
 * - 返回值是**真正写进库的条数**，勾了但无事可做的项不算
 * - 碎片合并放在倒数第二步，标 `tagged` 放最后：中途失败时碎片仍在原状态，可重跑
 */
import type { OrganizePlan, TagStat } from '../types';
import { repo } from './repo';
import { K } from '../util/resultItems';
import { buildTagGroups } from '../util/organizePlan';
import { normText } from '../util/text';

export interface CommitOptions {
  plan: OrganizePlan;
  /** 已有标签表，用来重建分组（必须和确认页用的是同一份快照） */
  existingTags: TagStat[];
  /** 用户是否勾选了这一项。key 由 `util/resultItems.ts` 的 K 生成 */
  accepted: (key: string) => boolean;
  /**
   * 真正交给模型处理过的碎片 id。
   *
   * 只要用户点了「应用」，这一批就算**过了一遍**，全部标成 tagged ——
   * 以前只标「AI 给了标签且被勾选」的那几条，剩下没抽到标签的仍留在 inbox，
   * 而批次永远从池子头部装填，于是下一轮「继续整理」拿到的还是同一批。
   * 标 tagged 只是表示不再算未读，内容一个字都不动，`all` 模式照样能再处理它们。
   */
  processedIds: number[];
}

export interface CommitOutcome {
  /** 打了标签的碎片条数 */
  tags: number;
  /** 新建的待办条数 */
  todos: number;
  /** 标成完成的待办条数 */
  done: number;
  /** 真删掉的待办条数 */
  dropped: number;
  /** 合并掉的待办**组**数 */
  mergedTodos: number;
  /** 合并掉的碎片**组**数 */
  mergedFragments: number;
  /** 标成已整理的碎片条数 */
  marked: number;
  /** 上面六项的真实总和，就是「已写入 N 项」 */
  applied: number;
}

export async function commitPlan({
  plan,
  existingTags,
  accepted,
  processedIds,
}: CommitOptions): Promise<CommitOutcome> {
  const groups = buildTagGroups(plan, existingTags);

  // ── 标签 ─────────────────────────────────────────────
  // 一个碎片可能同时属于「工作」和「报销」两组，合并成一条 labels 一次写入，
  // 否则后一次 applyTags 会把前一次的标签整个覆盖掉。
  const labelsById = new Map<number, string[]>();
  const projectById = new Map<number, string | null>();
  for (const g of groups) {
    if (!accepted(K.tagGroup(g.label))) continue;
    for (const id of g.fragmentIds) {
      const list = labelsById.get(id) ?? [];
      if (!list.includes(g.label)) list.push(g.label);
      labelsById.set(id, list);
    }
  }
  for (const t of plan.tags) {
    const project = t.project?.trim();
    if (!project) continue;
    // 同一碎片被两批各给了 project，先到先得，不来回改
    if (!projectById.has(t.id)) projectById.set(t.id, project);
  }

  let tags = 0;
  for (const [id, labels] of labelsById) {
    // 全被取消 → 保留原标签，不清空
    if (!labels.length) continue;
    await repo.applyTags(id, labels, projectById.get(id) ?? null);
    tags++;
  }

  // ── 新待办 ───────────────────────────────────────────
  // 先读一遍已有待办再插，两个作用：
  // 1. 建议里可能有和库里同名的（换了个批次又抽了一遍）——重复插入是纯噪音
  // 2. 上一次「应用」中途失败、用户点了重试时，已经插进去的不会被插第二遍
  let knownTodo = new Set<string>();
  try {
    knownTodo = new Set((await repo.listTodos()).map((t) => normText(t.text)));
  } catch {
    /* 读不到就当作空，宁可重复也不丢 */
  }

  let todos = 0;
  for (const t of plan.todos) {
    if (!accepted(K.todo(t.text))) continue;
    const key = normText(t.text);
    if (key && knownTodo.has(key)) continue;
    await repo.insertTodo({ text: t.text, dueAt: t.due, sourceFragmentId: t.id });
    if (key) knownTodo.add(key);
    todos++;
  }
  // 注意：不再写 fragments.nature。v0.7 里没有任何地方读它，
  // 写进去只会让「哪些碎片抽出了待办」变成一份没人维护的影子数据。

  // ── 已有待办：标完成 / 删除 / 合并 ────────────────────
  let done = 0;
  for (const d of plan.todo_done) {
    if (!accepted(K.done(d.todo_id))) continue;
    await repo.toggleTodo(d.todo_id, true);
    done++;
  }

  let dropped = 0;
  for (const d of plan.drop_todos) {
    if (!accepted(K.drop(d.todo_id))) continue;
    await repo.deleteTodo(d.todo_id);
    dropped++;
  }

  // 同一条待办在多批里都被建议合并时，keep_id 可能重复：并起来只写一次
  const mergeTodoGroups = new Map<number, { drops: Set<number>; text: string | null }>();
  for (const m of plan.merge_todos) {
    if (!accepted(K.mergeTodo(m.keep_id))) continue;
    const hit = mergeTodoGroups.get(m.keep_id);
    if (hit) {
      for (const id of m.drop_ids) hit.drops.add(id);
      hit.text ??= m.text;
    } else {
      mergeTodoGroups.set(m.keep_id, { drops: new Set(m.drop_ids), text: m.text });
    }
  }
  let mergedTodos = 0;
  for (const [keepId, { drops, text }] of mergeTodoGroups) {
    const dropIds = Array.from(drops).filter((id) => id !== keepId);
    if (!dropIds.length) continue;
    await repo.mergeTodos(keepId, dropIds, text);
    mergedTodos++;
  }

  // ── 碎片合并（软合并，原文保留）──────────────────────
  const mergeGroups = new Map<number, Set<number>>();
  for (const m of plan.merge) {
    if (!accepted(K.merge(m.keep_id))) continue;
    const set = mergeGroups.get(m.keep_id) ?? new Set<number>();
    for (const id of m.drop_ids) if (id !== m.keep_id) set.add(id);
    mergeGroups.set(m.keep_id, set);
  }
  let mergedFragments = 0;
  for (const [keepId, drops] of mergeGroups) {
    if (!drops.size) continue;
    await repo.markMerged(Array.from(drops), keepId);
    mergedFragments++;
  }

  // 打标是唯一会改变碎片状态的步骤，放最后：中途失败时碎片仍留在待整理里
  let marked = 0;
  const mergedAway = new Set<number>();
  for (const drops of mergeGroups.values()) for (const id of drops) mergedAway.add(id);
  const ids = Array.from(new Set(processedIds));
  if (ids.length) {
    await repo.markStatus(ids, 'tagged');
    // 报数要和实际一致：这一次被合并掉的碎片 markStatus 会跳过，
    // 把它们算进「已整理」就是虚报。合并的碎片本身已经有 merged 状态。
    marked = ids.filter((id) => !mergedAway.has(id)).length;
  }

  return {
    tags,
    todos,
    done,
    dropped,
    mergedTodos,
    mergedFragments,
    marked,
    applied: tags + todos + done + dropped + mergedTodos + mergedFragments,
  };
}
