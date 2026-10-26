/**
 * 已完成待办保留上限。超出时物理清理最旧的完成项（用户 2026-10-26 明确要求）。
 *
 * 放在这里是因为有**三处**要读它：native / web 两个 repo 的清理逻辑，
 * 以及回顾页那行「已完成 N 条 · 只保留最近 5 条」。各写一份迟早对不上。
 */
export const DONE_TODO_KEEP = 5;

export type FragmentSource = 'app' | 'notif' | 'share' | 'import';
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
  /** AI 判定的内容性质，未整理时为 null。v0.7 起不再写 knowledge，保留字段兼容旧数据 */
  nature: FragmentNature | null;
}

export interface Todo {
  id: number;
  text: string;
  /** YYYY-MM-DD，可空 */
  dueAt: string | null;
  done: boolean;
  /**
   * 标记完成的时间。未完成时为 null；旧数据在 v7 迁移里用 createdAt 回填。
   * 「已完成只保留最近 5 条」按它排序，不能拿 createdAt 代替 ——
   * 很早创建、今天才勾掉的事项会因此被误判成「旧」。
   */
  doneAt: number | null;
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
  /** daily / weekly / monthly；theme 只为兼容旧数据保留，v0.7 起不再生成 */
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
 * 整理范围：
 * - inbox = 只处理还没整理过的碎片
 * - all   = 把所有未合并的碎片重新过一遍（重新判标签、重新看待办）
 */
export type OrganizeScope = 'inbox' | 'all';

/**
 * 整理的一批输出。v0.7 起**没有知识卡/主题** ——
 * 模型只做四件事：打标签、抽待办、处理已有待办、合并重复碎片。
 */
export interface BatchResult {
  tags: TagSuggestion[];
  todos: TodoSuggestion[];
  merge: MergeSuggestion[];
  /** 建议把已有待办标记为完成（碎片里说了「已经做了」） */
  todo_done: TodoDoneSuggestion[];
  /** 建议删掉的已有待办（过时、重复、不该存在） */
  drop_todos: DropTodoSuggestion[];
  /** 建议把几条重复的已有待办并成一条（被合并的隐藏，可撤回） */
  merge_todos: MergeTodoSuggestion[];
  /** 这一批做了什么的一句话摘要，拼进下一轮上下文 */
  batch_summary: string;
  /** 被代码校验丢掉的条数。界面要如实报，不能静默消失 */
  rejected: number;
}

/** 多轮循环累积出来的完整计划。确认页和应用都读它 */
export interface OrganizePlan {
  tags: TagSuggestion[];
  todos: TodoSuggestion[];
  merge: MergeSuggestion[];
  todo_done: TodoDoneSuggestion[];
  drop_todos: DropTodoSuggestion[];
  merge_todos: MergeTodoSuggestion[];
  /** 每批摘要，按顺序累积；给下一轮做上下文 */
  batchSummaries: string[];
  /** 真正交给模型处理过的碎片 id */
  processedIds: number[];
  /** 失败后被用户跳过的碎片 id，不标记整理状态 */
  skippedIds: number[];
  /** 跑了几批 */
  rounds: number;
  /** 被代码校验丢掉的条目总数（id 不在本批、日期非法等） */
  rejected: number;
}

/**
 * 一次整理会话。每批结束落库，App 被杀/用户返回后能续跑。
 * `pendingIds` 是开始时的快照 —— 不每轮重新查，避免边跑边记导致游标漂移。
 */
export interface OrganizeSession {
  id: number;
  scope: OrganizeScope;
  pendingIds: number[];
  cursor: number;
  plan: OrganizePlan;
  contextSummary: string;
  finished: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 标签及其使用次数，标签页和整理 prompt 都用它 */
export interface TagStat {
  name: string;
  count: number;
}

/**
 * 确认页里的一组标签。
 * 按标签名分组而不是按碎片列 —— 200 条标签如果逐条列，用户根本审不过来。
 */
export interface TagGroup {
  label: string;
  /** 已有标签表里没有它 = 这次新建的 */
  isNew: boolean;
  /** 和已有标签高度相似时给个提示，避免又裂出一个近义词 */
  similarTo: string | null;
  fragmentIds: number[];
}

/** 整理完成后交给确认页的汇总 */
export interface OrganizeReview {
  tags: TagGroup[];
  todos: TodoSuggestion[];
  merge: MergeSuggestion[];
  todo_done: TodoDoneSuggestion[];
  drop_todos: DropTodoSuggestion[];
  merge_todos: MergeTodoSuggestion[];
  newTagCount: number;
  processedCount: number;
  skippedCount: number;
  rounds: number;
  rejected: number;
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
 * 标记已有待办为完成。
 * 这是一条**破坏性较弱但仍需确认**的建议：误标会让用户漏掉事情，
 * 所以只在碎片明确写了「已经做完」时才允许出现。
 */
export interface TodoDoneSuggestion {
  todo_id: number;
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
 * 联网搜索命中的一条。字段取自 DeepSeek `/v1/tools/search`，
 * 只留问答用得到的三个：标题、链接、摘要。
 */
export interface WebHit {
  title: string;
  url: string;
  summary: string;
  /** 相关度分。官方说明 ≥1.5 算优质；服务端没给就是 0 */
  score: number;
}

/** 问答会话里的一轮。sourceIds 只用于把上一轮引用过的碎片带进下一轮 */
export interface QaTurn {
  question: string;
  answer: string;
  sourceIds: number[];
}

/** 一次问答的结果 */
export interface QaOutcome {
  /** Markdown 回答 */
  answer: string;
  /** 思维链，仅展示 */
  reasoning: string;
  /** 本轮实际装进上下文的碎片 */
  fragments: Fragment[];
  /** 本轮引用到的碎片（回答里出现 [F12] 的那些） */
  cited: Fragment[];
  /** 本轮装进上下文的小结 */
  notes: Note[];
  /** 未完成待办 + 最近完成待办 */
  todos: Todo[];
  /** 本轮网络资料，没联网就是空数组 */
  web: WebHit[];
  /** 回答被输出上限截断 */
  truncated: boolean;
  /** 联网搜失败的原因；没开联网或搜成功就是 null */
  webError: string | null;
  /** 实际读了几条碎片 */
  scanned: number;
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
