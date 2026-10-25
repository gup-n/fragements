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

/**
 * 新卡是不是某张旧卡的「替代版本」—— 重构时用它决定要不要归档旧卡。
 *
 * 判据是来源碎片的 **Jaccard ≥ 0.5**，即两张卡的来源「大部分重合」。
 *
 * 这里曾经写成 `命中数 / min(旧来源数, 新来源数)`，看着更宽松，实际是个坑：
 * 一张只引用 1 条原文的新卡，只要那条原文也在某张有 10 条来源的旧卡里，
 * 得分就是 1/1 = 1.0 —— 一张窄卡把一张大卡判成「被取代」，直接归档。
 * 小分母放大了交集，越大越不准；Jaccard 两边都算进分母，才不会反向惩罚大卡。
 *
 * 显示（`ResultSections`）和写入（`commitResult`）必须共用这一个函数，
 * 否则界面说「会归档这张」，实际归档的是另一张。
 */
export function replacementOf(cards: KnowledgeCard[], sourceIds: number[]): KnowledgeCard | null {
  if (!sourceIds.length) return null;
  let best: KnowledgeCard | null = null;
  let bestScore = 0;
  for (const c of cards) {
    if (!c.sourceIds.length) continue;
    const score = overlap(c.sourceIds, sourceIds);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

/**
 * 同一条卡片的补充建议合并成一条。
 *
 * 两个来源会撞到同一张卡：模型自己给的 `card_update`，和降噪时把重复新卡
 * 转成的 `card_update`。不合并的话，界面上两条用同一个 key（React 会告警、
 * 勾选状态互相串），写入时两条都用**同一份**卡片快照算「要追加哪些原文」，
 * 同一段原文会被拼进正文两遍 —— 内容没丢，但是重复了，而且看不出来为什么。
 */
export function mergeCardUpdates(list: CardUpdateSuggestion[]): CardUpdateSuggestion[] {
  const byCard = new Map<number, CardUpdateSuggestion>();
  for (const c of list) {
    const prev = byCard.get(c.card_id);
    if (!prev) {
      byCard.set(c.card_id, { ...c, add_source_ids: [...c.add_source_ids] });
      continue;
    }
    for (const id of c.add_source_ids) {
      if (!prev.add_source_ids.includes(id)) prev.add_source_ids.push(id);
    }
    // 标题/要点只保留第一个非空值：两条建议都改了它时，以先出现的为准，
    // 至少不会出现「界面上显示 A、写进去是 B」
    prev.title ??= c.title;
    prev.gist ??= c.gist;
    prev.reason ??= c.reason;
  }
  return Array.from(byCard.values());
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
      card_update: mergeCardUpdates([...res.card_update, ...extraUpdates]),
    },
    droppedCards,
    droppedTodos,
  };
}
