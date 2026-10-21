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

/** AI 一次调用返回的五类结果，字段顺序与契约一致 */
export interface OrganizeResult {
  tags: TagSuggestion[];
  todos: TodoSuggestion[];
  summary: { body_md: string } | null;
  merge: MergeSuggestion[];
  knowledge: KnowledgeSuggestion[];
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
