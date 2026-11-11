import type {
  AskSession,
  Document,
  DocumentChunk,
  DocumentContentInput,
  DocumentMeta,
  Fragment,
  FragmentNature,
  FragmentSource,
  FragmentStatus,
  Note,
  OrganizePlan,
  OrganizeScope,
  OrganizeSession,
  QaScope,
  QaTurn,
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
   * 按 id 取碎片，顺序不保证。
   *
   * 存在的理由只有一个：会话要能「重新整理」当初那批碎片。
   * 用 `listFragments(limit)` 再自己筛是错的 —— limit 一旦小于总数，
   * 较早的碎片就查不到，重新整理会静默少一半材料。
   */
  findFragmentsByIds(ids: number[]): Promise<Fragment[]>;
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
  /**
   * 新记一条。`image` 有值时同时带上配图 —— 图和正文一起落库，
   * 免得「记录进去了、图没进」留下一条指向空文件的碎片。
   */
  insertFragment(
    content: string,
    source: FragmentSource,
    createdAt?: number,
    image?: { path: string; text?: string | null },
  ): Promise<number>;
  /** 图片解析完，把文字层写回去，并重建这一条的全文索引（图里的字要能搜到） */
  setFragmentImageText(id: number, text: string): Promise<void>;
  updateFragmentContent(id: number, content: string): Promise<void>;
  /** 删除。返回被删掉的那条配图文件名，调用方负责删文件（null = 没有图） */
  deleteFragment(id: number): Promise<string | null>;
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
  /**
   * 把这些碎片标成「已整理」。整理产出真正写进库之后才调。
   *
   * 传空数组什么都不做 —— 一条都没读过的时候不该整片刷新。
   */
  markFragmentsOrganized(ids: number[], at: number): Promise<void>;

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

  insertTodo(input: {
    text: string;
    dueAt: string | null;
    sourceFragmentId: number | null;
    /** null = 顶层待办；非 null = 挂在某条顶层待办下（只有两层） */
    parentId: number | null;
  }): Promise<number>;
  /** 只返回还在用的待办；被合并掉的（merged_into 非空）不在这里 */
  listTodos(): Promise<Todo[]>;
  /**
   * 改文字或到期日。传 `undefined` 的字段保持原样 —— 只需要能用一次改一项。
   * `dueAt: null` 是「清掉日期」，和 `undefined`（不动）必须分得开。
   */
  updateTodo(id: number, patch: { text?: string; dueAt?: string | null }): Promise<void>;
  /**
   * 勾选/取消勾选。**级联规则在 `util/todoTree.planToggle`，两份 repo 都调它**：
   * 勾父项连同子项、取消父项连同子项、子项全勾完父项自动完成。
   */
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

  /** 历史会话。默认只返回未归档的，按 updatedAt 倒序 */
  listAskSessions(includeArchived?: boolean): Promise<AskSession[]>;
  findAskSession(id: number): Promise<AskSession | null>;
  /**
   * 新建或更新一个会话。id 为空就 INSERT；有 id 就 UPDATE。
   * 返回会话 id。turns 变化时 updatedAt 自动更新。
   *
   * `scope` 必填：一场会话锁定一个范围，换集合必须开新会话。
   * 不给默认值是有意的 —— 默认成 records 会让文档会话在保存时被悄悄改回全库。
   */
  saveAskSession(input: {
    id?: number;
    title: string;
    turns: QaTurn[];
    scope: QaScope;
    createdAt: number;
    archived?: boolean;
    fragmentId?: number | null;
  }): Promise<number>;
  setAskSessionArchived(id: number, archived: boolean): Promise<void>;
  markAskSessionConverted(id: number, fragmentId: number): Promise<void>;
  /**
   * 记下这场会话整理出的知识文档（传空数组 = 解绑）。
   * v0.17 起一次整理可能产出多篇，所以传的是 id 列表。
   * `sourceIds` 是当初喂给模型的碎片，供「重新整理」复现同一批输入。
   */
  markAskSessionDocument(
    id: number,
    documentIds: number[],
    sourceIds?: number[],
  ): Promise<void>;
  deleteAskSession(id: number): Promise<void>;

  saveRun(input: { startedAt: number; fragmentIds: number[]; model: string; resultJson: string }): Promise<number>;
  markRunApplied(id: number): Promise<void>;

  /* ---- 文档（v0.10.0） ---- */
  /** 列表，按更新时间倒序。**不含正文** —— 文档的 Markdown 可能几十万字 */
  listDocuments(): Promise<DocumentMeta[]>;
  /**
   * 按关键词找文档：标题、摘要、正文三处都查。
   * 空查询等价于 `listDocuments()`，但走的是同一条 SQL，界面不用分支。
   */
  searchDocuments(query: string, limit?: number): Promise<DocumentMeta[]>;
  /** 取一篇文档的完整内容。不存在返回 null */
  findDocument(id: number): Promise<Document | null>;
  /**
   * 新建一条文档记录（原文件已经复制好，或者是整理产出的知识文档），返回 id。
   * 知识文档传 `origin: 'knowledge'` 且 `fileUri: null`，正文随后由
   * `replaceDocumentContent` 写进去（不在这里写，免得绕过切片与版本号）。
   */
  insertDocument(input: {
    name: string;
    ext: string;
    size: number;
    fileUri: string | null;
    state: DocumentMeta['state'];
    origin?: DocumentMeta['origin'];
    excerpt?: string;
  }): Promise<number>;
  /**
   * 更新解析结果。只传要改的字段。
   * `charCount` 由实现自己按 bodyMd 算，调用方不要传 —— 两处各算一次迟早对不上。
   */
  updateDocument(
    id: number,
    patch: {
      bodyMd?: string;
      excerpt?: string;
      pages?: number | null;
      state?: DocumentMeta['state'];
      error?: string | null;
    },
  ): Promise<void>;
  /** 删除文档记录。原文件由调用方删，repo 不碰文件系统 */
  deleteDocument(id: number): Promise<void>;
  /**
   * 文档被删之后，把指向它的会话标记解开。
   *
   * 不解的话历史行上那个「已写入文档」徽标还指着一条不存在的记录，
   * 点进去是一片空白 —— 用户会以为整理出来的内容丢了，其实只是文档被删了。
   */
  clearAskSessionDocuments(documentId: number): Promise<void>;

  /* ---- 文档内容与切片（v0.12） ---- */
  /**
   * 原子替换一篇文档的正文、内容版本与切片索引。
   *
   * `expectedRevision` 是调用方读到的版本号：版本对不上（另一个任务先写完了）
   * 或文档已删除时返回 false，**不覆盖**。迟到的解析结果不能盖掉新内容，
   * 这一条只能靠版本号保证，不能靠调用方记得先查。
   *
   * 正文、版本、切片、FTS 必须在同一个事务里：只写正文不写切片会让
   * 「正文就绪但索引还停在上一版」，问答拿旧切片去配新正文。
   */
  replaceDocumentContent(
    id: number,
    content: DocumentContentInput,
    expectedRevision: number,
  ): Promise<boolean>;
  /** 某篇文档当前版本的切片，按 ordinal 升序。供阅读器定位与调试 */
  listDocumentChunks(documentId: number): Promise<DocumentChunk[]>;
  /**
   * 在**指定文档**范围内检索切片。`documentIds` 为空返回空数组，
   * 绝不放宽成全库 —— 问答的「只查这几份」是契约，不是偏好。
   * 只返回就绪且索引版本等于内容版本的切片。
   */
  searchDocumentChunks(query: string, documentIds: number[], limit?: number): Promise<DocumentChunk[]>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  /**
   * 首页/设置页的数字。
   *
   * `pending` 是「还没整理过」的条数（`organized_at IS NULL`），不是旧的
   * `status='inbox'` —— v0.7 之后没有任何东西会把 status 改成 tagged，
   * 拿它当「待整理」等于永远等于总数，那个数字就是在骗人。
   */
  stats(): Promise<{ total: number; pending: number; todoOpen: number }>;
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
