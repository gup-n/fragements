/**
 * 把用户在结果页确认过的条目写进库。
 *
 * 单独成文件的原因：这段逻辑以前长在 `OrganizeScreen.apply()` 里，和
 * `setPhase` / 错误提示 / 页面状态混在一起，既没法单独验证，也没人敢改。
 * 现在它只依赖 repo 和一份「这一条被勾选了吗」的判定函数。
 *
 * 三条纪律（都写在代码里，不靠界面提示）：
 * - 只有 `accepted(key)` 为真的条目才会写
 * - 用户取消过的「归档这张卡」，即便触发了「新卡取代旧卡」也不能偷偷执行
 * - 返回值是**真正写进库的条数** —— 勾了但无事可做的项不算，
 *   否则「已写入 N 项」会骗人
 */
import type { Fragment, KnowledgeCard, OrganizeResult } from '../types';
import { repo } from './repo';
import { K } from '../util/resultItems';

export interface CommitOptions {
  result: OrganizeResult;
  /** 用户是否勾选了这一项 */
  accepted: (key: string) => boolean;
  /** 本轮碎片，用来组装 card_update 要追加的原文 */
  fragments: Fragment[];
  /** 打开结果页那一刻的卡片快照，用来判断「新卡取代了哪张旧卡」 */
  cards: KnowledgeCard[];
}

/**
 * 新卡和某张旧卡的来源碎片重叠 ≥ 50%，就认为这张新卡是旧卡的「替代版本」。
 * 重建构场景：同一段原文重新提炼，标题措辞变了，但讲的还是同一件事。
 */
function replacementOf(cards: KnowledgeCard[], sourceIds: number[]): KnowledgeCard | null {
  if (!sourceIds.length) return null;
  const incoming = new Set(sourceIds);
  let best: KnowledgeCard | null = null;
  let bestScore = 0;
  for (const c of cards) {
    if (!c.sourceIds.length) continue;
    const hit = c.sourceIds.filter((id) => incoming.has(id)).length;
    const score = hit / Math.min(c.sourceIds.length, sourceIds.length);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

export async function commitResult({
  result,
  accepted,
  fragments,
  cards,
}: CommitOptions): Promise<{ applied: number }> {
  const byId = new Map(fragments.map((f) => [f.id, f]));
  const cardById = new Map(cards.map((c) => [c.id, c]));
  let applied = 0;

  // ── 标签 ─────────────────────────────────────────────
  const tagItems = result.tags.filter((t) => accepted(K.tag(t.id)));
  for (const t of tagItems) {
    await repo.applyTags(t.id, t.labels, t.project);
    applied++;
  }

  // ── 新待办 ───────────────────────────────────────────
  for (const t of result.todos) {
    if (!accepted(K.todo(t.text))) continue;
    await repo.insertTodo({ text: t.text, dueAt: t.due, sourceFragmentId: t.id });
    applied++;
  }
  const todoSourceIds = result.todos
    .filter((t) => accepted(K.todo(t.text)))
    .map((t) => t.id)
    .filter((n): n is number => n !== null);
  if (todoSourceIds.length) await repo.setFragmentNature(todoSourceIds, 'todo');

  // ── 已有待办：标完成 / 删除 / 合并 ────────────────────
  for (const d of result.todo_done) {
    if (!accepted(K.done(d.todo_id))) continue;
    await repo.toggleTodo(d.todo_id, true);
    applied++;
  }
  for (const d of result.drop_todos) {
    if (!accepted(K.drop(d.todo_id))) continue;
    await repo.deleteTodo(d.todo_id);
    applied++;
  }
  for (const m of result.merge_todos) {
    if (!accepted(K.mergeTodo(m.keep_id))) continue;
    await repo.mergeTodos(m.keep_id, m.drop_ids, m.text);
    applied++;
  }

  // ── 知识卡：新建 / 补充 / 归档 ────────────────────────
  // 同一张旧卡可能被多张新卡判定为替代，只归档一次
  const archivedByReplacement = new Set<number>();
  // 用户明确取消勾选的「归档这张卡」，替代逻辑也不能偷偷把它归档掉
  const declinedArchive = new Set(
    result.archive_cards.filter((a) => !accepted(K.archive(a.card_id))).map((a) => a.card_id),
  );

  for (const k of result.knowledge) {
    if (!accepted(K.knowledge(k.topic, k.title))) continue;
    const replaced = replacementOf(cards, k.source_ids);
    await repo.insertKnowledgeCard({
      topic: k.topic,
      subtopic: k.subtopic,
      title: k.title,
      gist: k.gist,
      body: k.body,
      sourceIds: k.source_ids,
    });
    if (k.source_ids.length) await repo.setFragmentNature(k.source_ids, 'knowledge');
    if (replaced && !declinedArchive.has(replaced.id) && !archivedByReplacement.has(replaced.id)) {
      await repo.updateKnowledgeCard(replaced.id, { archived: true });
      archivedByReplacement.add(replaced.id);
    }
    applied++;
  }

  for (const c of result.card_update) {
    if (!accepted(K.card(c.card_id))) continue;
    const card = cardById.get(c.card_id);
    if (!card) continue;
    // 已经在卡里的不要再追加一次，否则同一段原文会重复出现
    const addedIds = c.add_source_ids.filter((id) => byId.has(id) && !card.sourceIds.includes(id));
    const addedText = addedIds
      .map((id) => byId.get(id)?.content.trim())
      .filter((s): s is string => !!s);
    if (!addedText.length) continue;
    await repo.updateKnowledgeCard(c.card_id, {
      sourceIds: Array.from(new Set([...card.sourceIds, ...addedIds])),
      body: `${card.body}\n\n${addedText.join('\n\n')}`,
      ...(c.title ? { title: c.title } : {}),
      ...(c.gist ? { gist: c.gist } : {}),
    });
    applied++;
  }

  for (const a of result.archive_cards) {
    if (!accepted(K.archive(a.card_id))) continue;
    await repo.updateKnowledgeCard(a.card_id, { archived: true });
    applied++;
  }

  // ── 主题归并（只改 topic 字段，一张卡都不会少）─────────
  // 放在新卡写入之后：本轮新建的卡如果落在被并掉的主题里，也一起搬过去
  for (const m of result.merge_topics) {
    if (!accepted(K.mergeTopic(m.to, m.from))) continue;
    const { moved } = await repo.retopicCards(m.from, m.to);
    if (moved > 0) applied++;
  }

  // ── 碎片去重（软合并，原文保留）──────────────────────
  for (const m of result.merge) {
    if (!accepted(K.merge(m.keep_id, m.drop_ids))) continue;
    await repo.markMerged(m.drop_ids, m.keep_id);
    applied++;
  }

  // 打标是这一轮唯一会改变碎片状态的步骤，放最后：
  // 中途失败时，碎片仍然留在待整理里，用户可以重跑一遍
  if (tagItems.length) {
    await repo.markStatus(
      tagItems.map((t) => t.id),
      'tagged',
    );
  }

  return { applied };
}
