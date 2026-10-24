import type { AskLog, Fragment, FragmentNature, Note, Todo, FragmentSource, FragmentStatus, KnowledgeCard, WebHit } from '../types';

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
    subtopic?: string | null;
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
  /** 某个主题下的二级方向分布。`subtopic` 为 null 的那组是「没分小方向」的卡 */
  listKnowledgeSubtopics(topic: string): Promise<{ subtopic: string | null; count: number }[]>;
  /**
   * 把一批主题下的卡片整体改到另一个主题名下。
   * 合并多个主题和给单个主题改名是同一件事，所以只留一个方法。
   * 返回真正搬动的卡片数。
   */
  retopicCards(from: string[], to: string): Promise<{ moved: number }>;
  /** 把某主题下的一批二级方向改名 / 合并成另一个 */
  resubtopicCards(topic: string, from: (string | null)[], to: string | null): Promise<{ moved: number }>;
  updateKnowledgeCard(
    id: number,
    patch: {
      title?: string;
      gist?: string;
      body?: string;
      topic?: string;
      /** 传 null 表示清掉二级方向 */
      subtopic?: string | null;
      archived?: boolean;
      /** 合并进已有卡时必须同步更新来源 id，否则导出和后续合并都会错 */
      sourceIds?: number[];
    },
  ): Promise<void>;
  deleteKnowledgeCard(id: number): Promise<void>;

  insertTodo(input: { text: string; dueAt: string | null; sourceFragmentId: number | null }): Promise<number>;
  /** 只返回还在用的待办；被合并掉的（merged_into 非空）不在这里 */
  listTodos(): Promise<Todo[]>;
  toggleTodo(id: number, done: boolean): Promise<void>;
  deleteTodo(id: number): Promise<void>;
  /**
   * 合并重复待办：保留 keepId，其余写 merged_into 隐藏起来。
   * 合并错了可以 `unmergeTodos(keepId)` 撤回，所以这里不是 DELETE。
   */
  mergeTodos(keepId: number, dropIds: number[], text?: string | null): Promise<void>;
  /** 被合并掉的待办，回顾页的「已合并」入口用它，保证隐藏的内容找得回来 */
  listMergedTodos(): Promise<Todo[]>;
  /** 撤回一次合并：把指向 keepId 的那几条放回列表 */
  unmergeTodos(keepId: number): Promise<void>;
  /**
   * 已完成待办所对应的来源碎片 id。
   * 时间轴用它给碎片打「已完成」标记；整理时用它告诉模型哪些事已经做完了。
   */
  listDoneTodoSourceIds(): Promise<number[]>;

  insertNote(input: { type: Note['type']; title: string | null; bodyMd: string; period: string | null }): Promise<number>;
  /**
   * 写入小结，同 `(type, period)` 已存在就覆盖。
   *
   * 一个周期只该有一条小结：同一天重复生成（晚上又记了几条）时，
   * 不覆盖就会在时间轴上并排出现两条内容不同的「今日小结」。
   * `insertNote` 保留给「用户明确要另存一条」那个分支。
   */
  upsertNote(input: {
    type: Note['type'];
    title: string | null;
    bodyMd: string;
    period: string | null;
  }): Promise<{ id: number; replaced: boolean }>;
  listNotes(limit?: number): Promise<Note[]>;
  /**
   * 按 `(type, period)` 精确找一条小结。
   * 判断「这个周期是不是已经写过」必须用它，不能拿 `listNotes(200)` 再自己筛 ——
   * 笔记一多就会漏掉更早的那条，于是同一天又插一条出来。
   */
  findNote(type: Note['type'], period: string): Promise<Note | null>;
  deleteNote(id: number): Promise<void>;

  /**
   * 问答记录。`scope` 是 'all' 或主题名。
   *
   * 刻意**不提供**「把问答当卡片检索」的方法：问答和卡片是两种东西，
   * 混在一起会让卡片数虚高、检索捞出一堆一次性对话。
   */
  insertAskLog(input: {
    scope: string;
    question: string;
    answer: string;
    reasoning: string;
    citedIds: number[];
    web: WebHit[];
  }): Promise<number>;
  /** scope 传 null 表示全部主题，按时间倒序 */
  listAskLogs(scope: string | null, limit?: number): Promise<AskLog[]>;
  /** 只改提问原文。回答是当时的产物，改了就成了伪造记录 */
  updateAskLogQuestion(id: number, question: string): Promise<void>;
  deleteAskLog(id: number): Promise<void>;

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
