import type { Fragment, FragmentNature, Note, Todo, FragmentSource, FragmentStatus, KnowledgeCard } from '../types';

/**
 * 存储层契约。native 走 SQLite，web 走 localStorage（仅供桌面预览）。
 * 上层业务代码只依赖这个接口，不感知具体实现。
 */
export interface Repo {
  init(): Promise<void>;

  listFragments(limit?: number): Promise<Fragment[]>;
  /**
   * 取出 `[from, to)` 区间内的全部碎片，按时间升序。
   * 周期总结必须拿到该周期的**完整**内容，用 limit 截断会漏掉月初的记录。
   */
  listFragmentsBetween(from: number, to: number): Promise<Fragment[]>;
  insertFragment(content: string, source: FragmentSource, createdAt?: number): Promise<number>;
  updateFragmentContent(id: number, content: string): Promise<void>;
  deleteFragment(id: number): Promise<void>;
  applyTags(id: number, labels: string[], project: string | null): Promise<void>;
  markMerged(dropIds: number[], keepId: number): Promise<void>;
  markStatus(ids: number[], status: FragmentStatus): Promise<void>;
  setFragmentNature(ids: number[], nature: FragmentNature): Promise<void>;
  countInbox(): Promise<number>;

  insertKnowledgeCard(input: {
    topic: string;
    title: string;
    gist: string;
    body: string;
    sourceIds: number[];
  }): Promise<number>;
  listKnowledgeCards(topic?: string): Promise<KnowledgeCard[]>;
  /** 关键字检索：标题 / 要点 / 原文 / 主题四个字段都查 */
  searchKnowledgeCards(keyword: string): Promise<KnowledgeCard[]>;
  /** 已归档的卡片；归档必须可逆，所以界面上要能看到并恢复 */
  listArchivedKnowledgeCards(): Promise<KnowledgeCard[]>;
  listKnowledgeTopics(): Promise<{ topic: string; count: number }[]>;
  updateKnowledgeCard(
    id: number,
    patch: {
      title?: string;
      gist?: string;
      body?: string;
      topic?: string;
      archived?: boolean;
      /** 合并进已有卡时必须同步更新来源 id，否则导出和后续合并都会错 */
      sourceIds?: number[];
    },
  ): Promise<void>;
  deleteKnowledgeCard(id: number): Promise<void>;

  insertTodo(input: { text: string; dueAt: string | null; sourceFragmentId: number | null }): Promise<number>;
  listTodos(): Promise<Todo[]>;
  toggleTodo(id: number, done: boolean): Promise<void>;
  deleteTodo(id: number): Promise<void>;
  /**
   * 已完成待办所对应的来源碎片 id。
   * 时间轴用它给碎片打「已完成」标记；整理时用它告诉模型哪些事已经做完了。
   */
  listDoneTodoSourceIds(): Promise<number[]>;

  insertNote(input: { type: Note['type']; title: string | null; bodyMd: string; period: string | null }): Promise<number>;
  listNotes(limit?: number): Promise<Note[]>;
  deleteNote(id: number): Promise<void>;

  saveRun(input: { startedAt: number; fragmentIds: number[]; model: string; resultJson: string }): Promise<number>;
  markRunApplied(id: number): Promise<void>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  stats(): Promise<{ total: number; inbox: number; todoOpen: number }>;
}

export function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}
