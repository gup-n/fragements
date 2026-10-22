import type {
  AiConfig,
  ArchiveCardSuggestion,
  CardUpdateSuggestion,
  DropTodoSuggestion,
  Fragment,
  KnowledgeCard,
  KnowledgeSuggestion,
  MergeSuggestion,
  MergeTodoSuggestion,
  OrganizeResult,
  TagSuggestion,
  Todo,
  TodoDoneSuggestion,
  TodoSuggestion,
} from '../types';
import { AiError, parseJsonLoose, requestChat, type ChatMessage, type ChatProgress } from './chat';
import { SYSTEM_PROMPT, buildRefineContent, buildUserContent } from './prompt';

/** 日期格式 YYYY-MM-DD */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 收敛 `todo_done` / `card_update` 时需要知道哪些 id 真实存在 */
export interface NormalizeContext {
  /** 允许被标记为完成的待办 id */
  todoIds?: number[];
  /** 允许被补充内容的知识卡 id */
  cardIds?: number[];
}

/**
 * 把模型的自由输出收敛成可信结构：ID 必须存在于本次输入，
 * 日期必须合法，去重合并不得指向自己。任何不合规项直接丢弃。
 */
export function normalizeResult(
  raw: unknown,
  fragments: Fragment[],
  context: NormalizeContext = {},
): OrganizeResult {
  const valid = new Set(fragments.map((f) => f.id));
  const obj = (raw ?? {}) as Record<string, unknown>;

  const tagMap = new Map<number, TagSuggestion>();
  for (const item of Array.isArray(obj.tags) ? obj.tags : []) {
    const t = item as Record<string, unknown>;
    const id = Number(t?.id);
    if (!Number.isFinite(id) || !valid.has(id)) continue;
    const labels = (Array.isArray(t?.labels) ? t.labels : [])
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim().replace(/^#/, ''))
      .filter(Boolean)
      .slice(0, 4);
    const project = typeof t?.project === 'string' && t.project.trim() ? t.project.trim() : null;
    tagMap.set(id, { id, labels, project });
  }

  const seenTodo = new Set<string>();
  const todos: TodoSuggestion[] = [];
  for (const item of Array.isArray(obj.todos) ? obj.todos : []) {
    const t = item as Record<string, unknown>;
    const rawText = typeof t?.text === 'string' ? t.text.trim() : '';
    if (!rawText) continue;
    // 超长不整条丢弃 —— 丢掉等于让 AI 的产出凭空消失，截断保留更有用
    const text = rawText.length > 100 ? `${rawText.slice(0, 98)}…` : rawText;
    if (seenTodo.has(text)) continue;
    seenTodo.add(text);
    const due = typeof t?.due === 'string' && DATE_RE.test(t.due.trim()) ? t.due.trim() : null;
    const rawId = Number(t?.id);
    const id = Number.isFinite(rawId) && valid.has(rawId) ? rawId : null;
    todos.push({ text, due, id });
  }

  const merges: MergeSuggestion[] = [];
  for (const item of Array.isArray(obj.merge) ? obj.merge : []) {
    const m = item as Record<string, unknown>;
    const keep = Number(m?.keep_id);
    if (!Number.isFinite(keep) || !valid.has(keep)) continue;
    const drops = (Array.isArray(m?.drop_ids) ? m.drop_ids : [])
      .map(Number)
      .filter((n) => Number.isFinite(n) && valid.has(n) && n !== keep);
    if (!drops.length) continue;
    merges.push({
      keep_id: keep,
      drop_ids: Array.from(new Set(drops)),
      reason: typeof m?.reason === 'string' && m.reason.trim() ? m.reason.trim() : null,
    });
  }

  const byId = new Map(fragments.map((f) => [f.id, f]));
  const knowledge: KnowledgeSuggestion[] = [];
  for (const item of Array.isArray(obj.knowledge) ? obj.knowledge : []) {
    const k = item as Record<string, unknown>;
    const title = typeof k?.title === 'string' ? k.title.trim() : '';
    if (!title) continue;
    const topicRaw = typeof k?.topic === 'string' ? k.topic.trim() : '';
    const topic = (topicRaw || '未归类').slice(0, 20);
    const gist = typeof k?.gist === 'string' ? k.gist.trim() : '';
    const sourceIds = Array.from(
      new Set(
        (Array.isArray(k?.source_ids) ? k.source_ids : [])
          .map(Number)
          .filter((n) => Number.isFinite(n) && valid.has(n)),
      ),
    );

    // body 一律用碎片原文拼接，不用模型给的内容——
    // "原文保真"这条承诺必须由代码保证，不能寄希望于模型不说谎。
    const verbatim = sourceIds
      .map((id) => byId.get(id)?.content.trim())
      .filter(Boolean)
      .join('\n\n');
    const body = verbatim || (typeof k?.body === 'string' ? k.body.trim() : '');
    if (!body) continue;

    knowledge.push({ topic, title: title.slice(0, 60), gist, body, source_ids: sourceIds });
  }

  // 标记已有待办完成：只认「真实存在过的待办 id」，并且同一条只处理一次
  const validTodoIds = new Set(context.todoIds ?? []);
  const todoDone: TodoDoneSuggestion[] = [];
  const seenDone = new Set<number>();
  for (const item of Array.isArray(obj.todo_done) ? obj.todo_done : []) {
    const d = item as Record<string, unknown>;
    const todoId = Number(d?.todo_id);
    if (!Number.isFinite(todoId) || !validTodoIds.has(todoId) || seenDone.has(todoId)) continue;
    seenDone.add(todoId);
    todoDone.push({
      todo_id: todoId,
      reason: typeof d?.reason === 'string' && d.reason.trim() ? d.reason.trim() : null,
    });
  }

  // 补充已有知识卡：必须指向真实卡片，且至少要带上一条本轮碎片，否则这条建议没有意义
  const validCardIds = new Set(context.cardIds ?? []);
  const cardUpdate: CardUpdateSuggestion[] = [];
  const seenCard = new Set<number>();
  for (const item of Array.isArray(obj.card_update) ? obj.card_update : []) {
    const c = item as Record<string, unknown>;
    const cardId = Number(c?.card_id);
    if (!Number.isFinite(cardId) || !validCardIds.has(cardId) || seenCard.has(cardId)) continue;
    const addIds = Array.from(
      new Set(
        (Array.isArray(c?.add_source_ids) ? c.add_source_ids : [])
          .map(Number)
          .filter((n) => Number.isFinite(n) && valid.has(n)),
      ),
    );
    if (!addIds.length) continue;
    seenCard.add(cardId);
    cardUpdate.push({
      card_id: cardId,
      add_source_ids: addIds,
      title: typeof c?.title === 'string' && c.title.trim() ? c.title.trim().slice(0, 60) : null,
      gist: typeof c?.gist === 'string' && c.gist.trim() ? c.gist.trim() : null,
      reason: typeof c?.reason === 'string' && c.reason.trim() ? c.reason.trim() : null,
    });
  }

  // 建议归档的旧卡：必须真实存在，且不能和「补充到这张卡」自相矛盾
  const archiveCards: ArchiveCardSuggestion[] = [];
  const seenArchive = new Set<number>();
  for (const item of Array.isArray(obj.archive_cards) ? obj.archive_cards : []) {
    const a = item as Record<string, unknown>;
    const cardId = Number(a?.card_id);
    if (!Number.isFinite(cardId) || !validCardIds.has(cardId) || seenArchive.has(cardId)) continue;
    // 同一张卡又要补充又要归档，说明模型自己没想清楚，这条归档建议丢掉
    if (seenCard.has(cardId)) continue;
    seenArchive.add(cardId);
    archiveCards.push({
      card_id: cardId,
      reason: typeof a?.reason === 'string' && a.reason.trim() ? a.reason.trim() : null,
    });
  }

  // 建议删掉的待办
  const dropTodos: DropTodoSuggestion[] = [];
  const seenDrop = new Set<number>();
  for (const item of Array.isArray(obj.drop_todos) ? obj.drop_todos : []) {
    const d = item as Record<string, unknown>;
    const todoId = Number(d?.todo_id);
    if (!Number.isFinite(todoId) || !validTodoIds.has(todoId) || seenDrop.has(todoId)) continue;
    // 又要标完成又要删，同一条待办不能既生又死
    if (seenDone.has(todoId)) continue;
    seenDrop.add(todoId);
    dropTodos.push({
      todo_id: todoId,
      reason: typeof d?.reason === 'string' && d.reason.trim() ? d.reason.trim() : null,
    });
  }

  // 建议合并的重复待办
  const mergeTodos: MergeTodoSuggestion[] = [];
  const mergedAway = new Set<number>();
  for (const item of Array.isArray(obj.merge_todos) ? obj.merge_todos : []) {
    const m = item as Record<string, unknown>;
    const keepId = Number(m?.keep_id);
    if (!Number.isFinite(keepId) || !validTodoIds.has(keepId)) continue;
    if (seenDone.has(keepId) || seenDrop.has(keepId) || mergedAway.has(keepId)) continue;

    const drops: number[] = [];
    for (const raw of Array.isArray(m?.drop_ids) ? m.drop_ids : []) {
      const id = Number(raw);
      // 被合并的必须是真实存在、且没被别处用掉的待办；自己不能合并自己
      if (!Number.isFinite(id) || id === keepId) continue;
      if (!validTodoIds.has(id) || seenDone.has(id) || seenDrop.has(id) || mergedAway.has(id)) continue;
      if (drops.includes(id)) continue;
      drops.push(id);
    }
    if (!drops.length) continue;

    drops.forEach((id) => mergedAway.add(id));
    mergeTodos.push({
      keep_id: keepId,
      drop_ids: drops,
      text: typeof m?.text === 'string' && m.text.trim() ? m.text.trim().slice(0, 60) : null,
      reason: typeof m?.reason === 'string' && m.reason.trim() ? m.reason.trim() : null,
    });
  }

  return {
    tags: Array.from(tagMap.values()),
    todos,
    merge: merges,
    knowledge,
    todo_done: todoDone,
    card_update: cardUpdate,
    archive_cards: archiveCards,
    drop_todos: dropTodos,
    merge_todos: mergeTodos,
  };
}

/** 流式过程中的增量回调，传的都是**累积全文**，UI 直接覆盖显示 */
export type OrganizeProgress = ChatProgress;

export interface OrganizeOptions {
  fragments: Fragment[];
  config: AiConfig;
  /** 已有主题列表，传进去让模型优先复用，避免长出一堆同义主题 */
  topics?: string[];
  /** 已有知识卡，用于「把新碎片补进老卡」 */
  cards?: KnowledgeCard[];
  /** 已有待办，用于「标记已完成」；内部只取未完成的 */
  todos?: Todo[];
  /** 上一轮模型的原始输出。多轮追问时原样回传，模型才知道自己上次说了什么 */
  previousRaw?: string;
  /** 这一轮用户的追问。为空表示首轮 */
  instruction?: string;
  /** organize = 整理未读；refactor = 把已整理过的重新过一遍并和旧结果对照 */
  mode?: 'organize' | 'refactor';
  /** 流式进度。只用于界面展示，不参与任何解析 */
  onProgress?: (patch: OrganizeProgress) => void;
}

export interface OrganizeOutcome {
  result: OrganizeResult;
  /** 模型原始输出（正文），留着给下一轮追问回传 */
  raw: string;
  /** 思维链，仅用于展示。模型没开思考时为空串 */
  reasoning: string;
}

export async function organize(options: OrganizeOptions): Promise<OrganizeOutcome> {
  const {
    fragments,
    config,
    topics = [],
    cards = [],
    todos = [],
    previousRaw,
    instruction,
    mode = 'organize',
    onProgress,
  } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  if (!fragments.length) throw new AiError('format', '没有待整理的碎片');

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserContent({ fragments, topics, cards, todos, mode }) },
  ];
  if (previousRaw) messages.push({ role: 'assistant', content: previousRaw });
  if (instruction) messages.push({ role: 'user', content: buildRefineContent(instruction) });

  // 九类结果的输出必须走 json_object，追问回传的 raw 也是 JSON，靠它保证格式稳定
  const outcome = await requestChat(config, messages, onProgress, { json: true });

  if (!outcome.content.trim()) throw new AiError('format', '模型没有返回内容');

  const result = normalizeResult(parseJsonLoose(outcome.content), fragments, {
    todoIds: todos.filter((t) => !t.done).map((t) => t.id),
    cardIds: cards.map((c) => c.id),
  });
  return { result, raw: outcome.content, reasoning: outcome.reasoning };
}

