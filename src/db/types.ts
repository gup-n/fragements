import type {
  Fragment,
  FragmentNature,
  FragmentSource,
  FragmentStatus,
  Note,
  OrganizePlan,
  OrganizeScope,
  OrganizeSession,
  TagStat,
  Todo,
} from '../types';

/** 整理会话的增量更新。只传要改的字段 */
export interface OrganizeSessionPatch {
  cursor?: number;
  plan?: OrganizePlan;
  contextSummary?: string;
  finished?: boolean;
}

/**
 * 存储层契约。native 走 SQLite，web 走 localStorage（仅供桌面编译校验）。
 * 上层业务代码只依赖这个接口，不感知具体实现。
 */
/**
 * 搜索自检的结果。
 *
 * 原来只返回 `{ checked, hit }`，界面只能说「N 条里 M 条能搜回」——
 * 用户看到 4/5 完全不知道要不要管。现在把「为什么」也带出来。
 */
export interface SearchProbe {
  /** 能自检的条数。纯标点/emoji 的片段分词后没有检索词，不计入 */
  checked: number;
  /** 搜回自己（或内容相同的另一条）的条数 */
  hit: number;
  /**
   * 其中「搜回了内容完全相同的另一条」的条数。
   *
   * 这不算索引坏了：那条碎片的内容确实被索引了，只是库里有两份一样的。
   * 单独计数是为了让界面能说清「5 条都能搜到，其中 1 条内容重复」，
   * 而不是含糊地说「4/5，可能不准」。
   */
  viaDuplicate: number;
  /** 真的搜不回的。有值才说明索引可能有问题 */
  misses: { id: number; needle: string; foundIds: number[] }[];
}

export interface Repo {
  init(): Promise<void>;

  listFragments(limit?: number): Promise<Fragment[]>;
  /**
   * 取出 `[from, to)` 区间内的全部碎片，按时间升序。
   * 周期总结必须拿到该周期的**完整**内容，用 limit 截断会漏掉月初的记录。
   */
  listFragmentsBetween(from: number, to: number): Promise<Fragment[]>;
  /**
   * 整理范围的碎片 id 快照，按时间升序。
   * 开始整理时取一次，之后每批都从这份快照切 —— 不每轮重新查，避免边跑边记导致漂移。
   */
  listFragmentIds(scope: OrganizeScope): Promise<number[]>;
  /** 按给定 id 取碎片。返回顺序与传入的 ids 一致（SQL 的 IN 不保证顺序） */
  listFragmentsByIds(ids: number[]): Promise<Fragment[]>;
  /** 某个整理范围有多少条 */
  countFragments(scope: OrganizeScope): Promise<number>;
  insertFragment(content: string, source: FragmentSource, createdAt?: number): Promise<number>;
  updateFragmentContent(id: number, content: string): Promise<void>;
  deleteFragment(id: number): Promise<void>;
  applyTags(id: number, labels: string[], project: string | null): Promise<void>;
  markMerged(dropIds: number[], keepId: number): Promise<void>;
  markStatus(ids: number[], status: FragmentStatus): Promise<void>;
  setFragmentNature(ids: number[], nature: FragmentNature): Promise<void>;
  countInbox(): Promise<number>;

  /**
   * 本地全文检索。native 走 FTS5（中文 bigram），web 走 includes。
   * 结果已按相关度排序；调用方不再自己排序。
   */
  searchFragments(query: string, limit?: number): Promise<Fragment[]>;
  /** 某个标签下的碎片，按时间倒序。问「工作标签下有什么」时用 */
  listFragmentsByTag(tag: string, limit?: number): Promise<Fragment[]>;

  /**
   * 标签列表与使用次数。
   * v0.7 不建 tags 表 —— 标签仍然是 fragments.tags 里的字符串，
   * 但这里提供唯一入口，避免各处自己 GROUP BY / JSON.parse。
   */
  listTags(): Promise<TagStat[]>;
  /** 改名：把 from 换成 to。只改标签数组，不动正文 */
  renameTag(from: string, to: string): Promise<{ changed: number }>;
  /** 删除一个标签：从所有碎片里移除它 */
  deleteTag(name: string): Promise<{ changed: number }>;
  /** 合并：把 from 里的所有标签换成 to（to 已存在就是合并，不存在就是改名） */
  mergeTags(from: string[], to: string): Promise<{ changed: number }>;
  /**
   * 重建全文索引。迁移回填失败或数据异常时由设置页兜底。
   * 返回重建完的索引条数 —— 界面上要和库里总数对比，
   * 只说「成功」等于没说，用户看不出它到底修了什么。
   */
  rebuildSearchIndex(): Promise<{ indexed: number }>;
  /** 索引健康度：fts 里有多少条 / 库里有多少条。两者不等就说明有碎片没进索引 */
  searchIndexStats(): Promise<{ indexed: number; total: number }>;
  /**
   * 搜索自检：抽最近几条碎片，拿正文中间一小段去搜，看能不能搜回它自己。
   * 索引建没建对，这是唯一能拿出来的证据。
   *
   * 判定口径在 v0.8.5 收紧过一次，因为原来的「必须搜回同一条」会产生误报：
   * 库里内容重复时搜回的是另一条，索引其实是好的。详见 `SearchProbe`。
   */
  selfTestSearch(samples?: number): Promise<SearchProbe>;

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
   * 一个周期只该有一条小结：同一天重复生成时，不覆盖就会在时间轴上并排出现两条。
   */
  upsertNote(input: {
    type: Note['type'];
    title: string | null;
    bodyMd: string;
    period: string | null;
  }): Promise<{ id: number; replaced: boolean }>;
  listNotes(limit?: number): Promise<Note[]>;
  /** 按 `(type, period)` 精确找一条小结，不能用 listNotes 自己筛 */
  findNote(type: Note['type'], period: string): Promise<Note | null>;
  deleteNote(id: number): Promise<void>;

  /** 新建一次整理会话，返回 id */
  saveOrganizeSession(input: {
    scope: OrganizeScope;
    pendingIds: number[];
    cursor: number;
    plan: OrganizePlan;
    contextSummary: string;
    finished: boolean;
  }): Promise<number>;
  /** 每批结束后更新游标/计划/摘要。只传要改的字段 */
  updateOrganizeSession(id: number, patch: OrganizeSessionPatch): Promise<void>;
  /** 最近一次未完成的会话；没有就返回 null */
  findUnfinishedOrganizeSession(): Promise<OrganizeSession | null>;
  finishOrganizeSession(id: number): Promise<void>;
  deleteOrganizeSession(id: number): Promise<void>;

  saveRun(input: { startedAt: number; fragmentIds: number[]; model: string; resultJson: string }): Promise<number>;
  markRunApplied(id: number): Promise<void>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  stats(): Promise<{ total: number; inbox: number; todoOpen: number; tags: number }>;
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
