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
  /**
   * 被合并到哪一条。为 null 表示这条还在用。
   * 合并走「隐藏」而不是真删 —— 合错了能在回顾页的「已合并」里撤回。
   */
  mergedInto: number | null;
}

export interface Note {
  id: number;
  /** daily = 今日小结 / daily/weekly/monthly = 周期总结 / theme = 按主题 */
  type: 'daily' | 'weekly' | 'monthly' | 'theme';
  title: string | null;
  bodyMd: string;
  /** daily 存 2026-10-22；weekly 存 2026-W43；monthly 存 2026-10 */
  period: string | null;
  createdAt: number;
}

/** 周期总结的粒度 */
export type DigestKind = 'daily' | 'weekly' | 'monthly';

/**
 * 整理的两个入口：
 * - organize = 处理还没整理过的碎片
 * - refactor = 把碎片重新过一遍，结果与旧标签 / 旧知识卡逐项对照
 */
export type OrganizeMode = 'organize' | 'refactor';

/**
 * 知识卡：从碎片里沉淀出的「可复用结论」。
 * gist 是 AI 写的索引（几条要点），body 是原文保真，两者职责不同不能互相替代。
 */
export interface KnowledgeCard {
  id: number;
  /** 归类主题，如「NAS 维护」。AI 应优先复用已有主题 */
  topic: string;
  /**
   * 二级方向，如「NAS 维护」下的「换盘」。
   *
   * 主题不是独立实体，只是卡片上的字符串；所以两级都靠字段而不是外键。
   * 这一列刻意可空 —— 大多数主题下只有两三张卡，硬分小方向反而更碎。
   */
  subtopic: string | null;
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

/**
 * AI 一次调用返回的结果，字段顺序与契约一致。
 *
 * 这里**没有**小结 —— 整理只处理碎片本身。小结走独立的周期总结面板
 * （`components/SummarySheet.tsx`），因为一条小结要覆盖整个周期，
 * 而整理一次只看 60 条、可能只是这个周期的一部分，在这里顺手写必然写残。
 * 整理页只负责列出「哪些周期还没有小结」。
 */
export interface OrganizeResult {
  tags: TagSuggestion[];
  todos: TodoSuggestion[];
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
  /** 建议把几条重复的已有待办并成一条（被合并的隐藏，可撤回） */
  merge_todos: MergeTodoSuggestion[];
  /** 建议把几个方向相近的已有主题并成一个 */
  merge_topics: MergeTopicSuggestion[];
}

/**
 * 合并方向相近的主题。
 *
 * 这是「越整理越碎」的治本项：主题只是卡片上的字符串，
 * 模型新建一个主题的成本为零，于是「工具」「资讯」各占一个，
 * 而它们其实都是「AI」。这条建议把这类碎片收回去。
 *
 * 不设「改名」—— 改名是纯用户意图，由知识库的主题管理入口直接做。
 */
export interface MergeTopicSuggestion {
  /** 被并掉的主题名，至少两个 */
  from: string[];
  /** 合并后的主题名。可以是 from 之一，也可以是新名字 */
  to: string;
  reason: string | null;
}

/**
 * 合并重复待办。
 * 保留 `keep_id`，其余被打上 merged_into 标记不再显示；
 * `text` 有值时用合并后的文案替换保留那条 —— 两条各说了半句的情况很常见。
 */
export interface MergeTodoSuggestion {
  keep_id: number;
  drop_ids: number[];
  /** 合并后更完整的文案，null 表示沿用保留那条的原文 */
  text: string | null;
  reason: string | null;
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
  /** 二级方向，可空。只在同一个主题下确实有多种细分时才填 */
  subtopic: string | null;
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

/**
 * 思考强度。DeepSeek 会把请求值映射到实际强度：
 * low→low、high→high、max→max，中间档（minimal/medium/xhigh）向上取。
 */
export type ReasoningEffort = 'low' | 'high' | 'max';

export interface AiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 开启思考模式：模型先输出思维链再给答案。关掉更快更便宜，但看不到过程、质量略降 */
  thinking: boolean;
  /** 思考强度，仅在 thinking 为 true 时发送 */
  effort: ReasoningEffort;
}

/**
 * 默认模型是 `deepseek-flash`（DeepSeek-V4.1-Flash）。
 *
 * 曾经的 `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 15:59 UTC 永久停用，
 * 调用直接报错、没有软跳转。两者当时都对应 V4-Flash 的非思考 / 思考模式，
 * 所以迁到 `deepseek-flash` 价格不变。想要更强能力可手动换成 `deepseek-v4-pro`（约 3.1 倍价）。
 */
export const DEFAULT_AI_CONFIG = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
  thinking: true,
  effort: 'high' as ReasoningEffort,
} as const;

/** 已停用的模型名 → 新名字。用于把老配置自动迁移过来，避免用户升级后仍然调不通 */
export const RETIRED_MODELS: Record<string, string> = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
};

