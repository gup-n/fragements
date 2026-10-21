export type FragmentSource = 'app' | 'notif' | 'share';
export type FragmentStatus = 'inbox' | 'tagged' | 'merged';
/** 内容性质，由 AI 在整理时判定，记录时不要求用户选 */
export type FragmentNature = 'todo' | 'knowledge' | 'event';

export interface Fragment {
  id: number;
  content: string;
  /** 毫秒时间戳 */
  createdAt: number;
  source: FragmentSource;
  status: FragmentStatus;
  tags: string[];
  project: string | null;
  /** 被合并到哪一条。为 null 表示没被合并 */
  mergedInto: number | null;
  /** AI 判定的内容性质，未整理时为 null */
  nature: FragmentNature | null;
}

export interface Todo {
  id: number;
  text: string;
  /** YYYY-MM-DD，可空 */
  dueAt: string | null;
  done: boolean;
  sourceFragmentId: number | null;
  createdAt: number;
}

export interface Note {
  id: number;
  type: 'daily' | 'weekly' | 'theme';
  title: string | null;
  bodyMd: string;
  period: string | null;
  createdAt: number;
}

/**
 * 知识卡：从碎片里沉淀出的「可复用结论」。
 * gist 是 AI 写的索引（几条要点），body 是原文保真，两者职责不同不能互相替代。
 */
export interface KnowledgeCard {
  id: number;
  /** 归类主题，如「NAS 维护」。AI 应优先复用已有主题 */
  topic: string;
  /** 一句话结论，8-15 字 */
  title: string;
  /** AI 提炼的 2-4 条要点，每行以 - 开头 */
  gist: string;
  /** 原始碎片原文，逐字保留，多条用空行分隔 */
  body: string;
  sourceIds: number[];
  createdAt: number;
  archived: boolean;
}

/** AI 一次调用返回的结果，字段顺序与契约一致 */
export interface OrganizeResult {
  tags: TagSuggestion[];
  todos: TodoSuggestion[];
  summary: { body_md: string } | null;
  merge: MergeSuggestion[];
  knowledge: KnowledgeSuggestion[];
  /** 建议把已有待办标记为完成（碎片里说了「已经做了」） */
  todo_done: TodoDoneSuggestion[];
  /** 建议把本轮碎片补充进已有的知识卡，而不是新建一张同题的 */
  card_update: CardUpdateSuggestion[];
  /** 建议归档的已有知识卡 —— 归档可恢复，不是删除 */
  archive_cards: ArchiveCardSuggestion[];
  /** 建议删掉的已有待办（过时、重复、不该存在） */
  drop_todos: DropTodoSuggestion[];
}

/**
 * 标记已有待办为完成。
 * 这是一条**破坏性较弱但仍需确认**的建议：误标会让用户漏掉事情，
 * 所以只在碎片明确写了「已经做完」时才允许出现。
 */
export interface TodoDoneSuggestion {
  todo_id: number;
  reason: string | null;
}

/**
 * 把本轮碎片并入已有知识卡。
 * 只做追加：原文按顺序接在后面，绝不覆盖卡片已有的正文。
 */
export interface CardUpdateSuggestion {
  card_id: number;
  add_source_ids: number[];
  /** 补进去之后更贴切的标题，null 表示沿用原标题 */
  title: string | null;
  /** 补进去之后更新的要点，null 表示沿用原要点 */
  gist: string | null;
  reason: string | null;
}

/**
 * 建议归档的已有知识卡。
 * 归档 ≠ 删除：卡片只是从知识库里折叠起来，随时可以恢复。
 * 重构场景下，被新卡完整取代的旧卡走这条。
 */
export interface ArchiveCardSuggestion {
  card_id: number;
  reason: string | null;
}

/**
 * 建议删掉的已有待办：过时了、重复了、或者本来就是随手记的不是真事。
 * 这是真删除，所以界面上默认不勾选。
 */
export interface DropTodoSuggestion {
  todo_id: number;
  reason: string | null;
}

export interface KnowledgeSuggestion {
  topic: string;
  title: string;
  gist: string;
  body: string;
  source_ids: number[];
}

export interface TagSuggestion {
  id: number;
  labels: string[];
  project: string | null;
}

export interface TodoSuggestion {
  text: string;
  due: string | null;
  id: number | null;
}

export interface MergeSuggestion {
  keep_id: number;
  drop_ids: number[];
  reason: string | null;
}

export interface AiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export const DEFAULT_AI_CONFIG = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
} as const;
