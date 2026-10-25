/**
 * 整理 / 重构产物的降噪。
 *
 * 模型看不见「这张卡已经存在」，尤其重构时它会把同样的内容重新提炼一遍：
 * 同一段原文、同样的结论，标题措辞换几个字，就成了一张「新卡」。
 * 而 `commitResult` 判断「新卡取代旧卡」只看来源碎片重叠 ≥ 50%，
 * 两次整理的来源集合写法稍有不同就认不出来 —— 旧卡留着、新卡又多一张，
 * 重构几轮之后知识库里全是近义标题的孪生卡片。
 *
 * 所以判重放在写入之前、用更宽的三条判据（同主题 + 标题相同/包含/来源高度重叠），
 * 并且**不丢内容**：重复的新卡会转成 `card_update`，把旧卡没有的来源补进去。
 *
 * 另外重构不再重复抽待办 —— 这些碎片上次整理时已经抽过一遍了。
 *
 * 抽成独立文件的目的很明确：这几个函数是纯的，能直接跑断言验证；
 * 留在 OrganizeScreen 里就只能靠肉眼读。
 */
import type {
  CardUpdateSuggestion,
  KnowledgeCard,
  KnowledgeSuggestion,
  OrganizeResult,
  Todo,
} from '../types';

/** 归一化标题/主题：去掉标点和空白，统一小写。判重只看字面，不做语义 */
export function normText(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s，。、,.!！?？~～;；:：'"“”‘’()（）[\]【】\-—_/]/g, '');
}

/** 判重时只关心这四个字段 */
export interface CardShape {
  topic: string;
  subtopic: string | null;
  title: string;
  sourceIds: number[];
}

/**
 * 两个来源列表的重合度（Jaccard）。任一边为空时返回 0 ——
 * 没有来源的卡不能靠它判重，否则所有空来源的卡会互相「重复」。
 */
export function overlap(a: number[], b: number[]) {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let hit = 0;
  for (const id of A) if (B.has(id)) hit++;
  return hit / (A.size + B.size - hit);
}

/**
 * 两张卡是不是同一件事。
 *
 * 三条判据依次是「标题一模一样」「短标题被长标题完整包含」「来源碎片高度重叠」。
 * 第二条要求短标题至少 6 个字：否则「换盘」会把整个主题下的卡都吃掉。
 */
export function sameCard(a: CardShape, b: CardShape) {
  if (normText(a.topic) !== normText(b.topic)) return false;
  // 两个方向都填了、且不是同一个 —— 明确是两张不同的卡
  if (a.subtopic && b.subtopic && normText(a.subtopic) !== normText(b.subtopic)) return false;

  const ta = normText(a.title);
  const tb = normText(b.title);
  if (!ta || !tb) return false;
  if (ta === tb) return true;

  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length >= 6 && long.includes(short)) return true;

  return overlap(a.sourceIds, b.sourceIds) >= 0.7;
}

export interface PruneReport {
  result: OrganizeResult;
  /** 因为跟已有卡片重复而被收起的张数 */
  droppedCards: number;
  /** 因为跟已有待办重复而被收起的条数 */
  droppedTodos: number;
}

/**
 * 整理/重构之后的降噪。**一条内容都不丢**：
 * - 与已有卡重复的新卡 → 转成 `card_update` 把新来源补进旧卡（旧卡已有这些来源就直接收起）
 * - 与本批另一张重复的新卡 → 合并来源，只留一张
 * - 重构不再重复抽待办
 *
 * 被收起的数量要如实报给界面。悄悄少掉几张卡，用户只会觉得「它又乱来了」。
 */
export function pruneResult(
  res: OrganizeResult,
  opts: { cards: KnowledgeCard[]; todos: Todo[]; refactor: boolean },
): PruneReport {
  const knowledge: KnowledgeSuggestion[] = [];
  const extraUpdates: CardUpdateSuggestion[] = [];
  let droppedCards = 0;

  // 下标必须和 opts.cards 对齐：下面命中后要拿 opts.cards[oldIdx] 取 id。
  // 所以新卡**不能**往这个数组里塞，同批重复交给 knowledge 那条判据。
  const existing: CardShape[] = opts.cards.map((c) => ({
    topic: c.topic,
    subtopic: c.subtopic,
    title: c.title,
    sourceIds: c.sourceIds,
  }));

  for (const k of res.knowledge) {
    const shape: CardShape = {
      topic: k.topic,
      subtopic: k.subtopic,
      title: k.title,
      sourceIds: k.source_ids,
    };

    // 1) 跟已有卡片重复 → 把旧卡没有的来源补进去，不新建
    const oldIdx = existing.findIndex((c) => sameCard(shape, c));
    if (oldIdx >= 0) {
      const old = opts.cards[oldIdx];
      const missing = k.source_ids.filter((id) => !old.sourceIds.includes(id));
      if (missing.length) {
        extraUpdates.push({
          card_id: old.id,
          add_source_ids: missing,
          title: null,
          gist: null,
          reason: '这张卡知识库里已经有了，把新来源补进去',
        });
      }
      droppedCards++;
      continue;
    }

    // 2) 跟本批另一张重复 → 合并来源，只留一张
    const twin = knowledge.find((x) =>
      sameCard(shape, {
        topic: x.topic,
        subtopic: x.subtopic,
        title: x.title,
        sourceIds: x.source_ids,
      }),
    );
    if (twin) {
      for (const id of k.source_ids) if (!twin.source_ids.includes(id)) twin.source_ids.push(id);
      droppedCards++;
      continue;
    }

    knowledge.push(k);
  }

  let todos = res.todos;
  let droppedTodos = 0;
  if (opts.refactor) {
    const seenText = new Set(opts.todos.map((t) => normText(t.text)));
    const seenSource = new Set(
      opts.todos.map((t) => t.sourceFragmentId).filter((n): n is number => n !== null),
    );
    const kept = todos.filter(
      (t) => !seenText.has(normText(t.text)) && !(t.id !== null && seenSource.has(t.id)),
    );
    droppedTodos = todos.length - kept.length;
    todos = kept;
  }

  return {
    result: {
      ...res,
      knowledge,
      todos,
      card_update: [...res.card_update, ...extraUpdates],
    },
    droppedCards,
    droppedTodos,
  };
}
