import type {
  AskSession,
  DocProposal,
  DocProposalPayload,
  DocStage,
  DocTag,
  Document,
  DocumentChunk,
  DocumentContentInput,
  DocumentMeta,
  Fragment,
  FragmentSource,
  Note,
  ProposalKind,
  QaScope,
  QaTurn,
  Todo,
  TrashEntry,
  TrashRef,
} from '../types';
import type { BackupCounts, BackupManifest } from '../util/backupPlan';
import type { DayCount } from '../util/calendar';
import type { MonthCount } from '../util/digest';

/** 完整备份的结果。`bytes` 是**压缩后**的体积，界面显示这个数字 */
export interface BackupResult {
  uri: string;
  name: string;
  bytes: number;
  counts: BackupCounts;
}

/**
 * 恢复的结果。
 *
 * `safetyName` 是覆盖前那份当前库的文件名（在 App 私有目录 `backups/` 下），
 * 永远有值 —— 拿不出退路的恢复不该被执行。
 */
export interface RestoreResult {
  counts: BackupCounts;
  safetyName: string;
  safetyBytes: number;
  /** 清单里有、包里却没有的条目。非空时界面要提示「这次恢复不完整」 */
  missing: string[];
}

export interface SafetyCopy {
  name: string;
  bytes: number;
  at: number;
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

export interface DraftCommitDocument {
  key: string;
  title: string;
  excerpt: string;
  content: DocumentContentInput;
}

export interface DraftCommitTodo {
  key: string;
  text: string;
  dueAt: string | null;
  children: { key: string; text: string; dueAt: string | null }[];
}

export interface DraftCommitInput {
  draftId: string;
  documents: DraftCommitDocument[];
  todos: DraftCommitTodo[];
  sourceIds: number[];
  sessionId: number | null;
}

/** 包含这份草稿至今所有已提交条目；key 是稳定本地身份，不是数组下标。 */
export interface DraftCommitReceipt {
  documents: { key: string; id: number; name: string }[];
  todos: { key: string; id: number }[];
}

export interface Repo {
  init(): Promise<void>;

  listFragments(limit?: number): Promise<Fragment[]>;
  /** 完整读取，不受首页窗口上限影响；导出不能用 listFragments 默认值。 */
  listAllFragments(): Promise<Fragment[]>;

  /*
   * 下面四个是「大库」的那一半（v0.26）。
   *
   * 以前首页 `listAllFragments()` 把整库读进内存，日历和「欠几个月小结」
   * 再在这个数组上各扫一遍 —— 几千条时启动要等，切页也要顿。
   * 现在：
   * - 列表按页读（`listFragmentsPage`），首屏只要一页；
   * - 要计数的地方走聚合（`totalFragments` / `dayCounts` / `monthCounts`），
   *   不再为了画 42 个点把全文捞出来。
   *
   * **口径必须一致**：`day` 用 `dayKey`、`month` 用 `monthKey`，都是本地时区。
   * SQL 里靠 `'localtime'` 对齐，web 侧靠同一个 JS 函数 —— 两边算出来的数
   * 必须能互相替换（断言在 `test:docs`/`test:todos` 里守着）。
   */

  /** 碎片总条数（含已合并的行，与列表口径一致） */
  totalFragments(): Promise<number>;
  /** 按时间倒序取一页。`offset` 从 0 起，首页「加载更早的」用它 */
  listFragmentsPage(offset: number, limit: number): Promise<Fragment[]>;
  /** 每天几条碎片（本地时区）。日历只用它画点，点开某天才去读正文 */
  dayCounts(): Promise<DayCount[]>;
  /** 每月几条碎片（本地时区）。「欠着几个月小结」只用它判断 */
  monthCounts(): Promise<MonthCount[]>;
  /** 内容、切片、待办与幂等凭据一次提交；同 draftId/key 重试不复制。 */
  commitDraft(input: DraftCommitInput): Promise<DraftCommitReceipt>;
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
   * 按给定 id 取碎片。返回顺序与传入的 ids 一致（SQL 的 IN 不保证顺序）
   */
  listFragmentsByIds(ids: number[]): Promise<Fragment[]>;
  /**
   * 新记一条。`images` 有值时同时带上配图 —— 图和正文一起落库，
   * 免得「记录进去了、图没进」留下一条指向空文件的碎片。
   */
  insertFragment(
    content: string,
    source: FragmentSource,
    createdAt?: number,
    images?: { path: string; text?: string | null; key?: string }[],
  ): Promise<number>;
  /** Markdown恢复的正文、旧标签与索引原子写入，不标记新的 organizedAt。 */
  insertImportedFragment(content: string, createdAt: number, tags: string[]): Promise<number>;
  /** 同一碎片的一批图片与索引原子加入；失败不留下部分图片行。 */
  insertFragmentImages(fragmentId: number, images: { path: string; text?: string | null }[]): Promise<import('../types').FragmentImage[]>;
  /** 给已有碎片补一张图，返回这张图的 id（详情页「加一张」用） */
  insertFragmentImage(fragmentId: number, path: string): Promise<number>;
  /** 某张图解析完：把文字层写回去，并重建这一条的全文索引（图里的字要能搜到） */
  setFragmentImageText(imageId: number, text: string): Promise<void>;
  /** 删掉一张图，返回它的文件名（调用方负责删文件）；这张图不存在返回 null */
  deleteFragmentImage(imageId: number): Promise<string | null>;
  updateFragmentContent(id: number, content: string): Promise<void>;
  /**
   * 删除 = **移到回收站**（v0.28），不是物理删。
   *
   * 返回空数组是常态：软删不动磁盘上的配图，30 天内恢复还看得见图。
   * 真正删文件发生在 `purgeTrash` / `purgeExpiredTrash`。
   *
   * 为什么改签名而没换名字：所有调用点要的语义就是「这条不要了」，
   * 改叫 `trashFragment` 会让每个调用点都得判断「到底删不删文件」——
   * 而这件事从今天起只有回收站管。
   */
  deleteFragment(id: number): Promise<string[]>;
  applyTags(id: number, labels: string[], project: string | null): Promise<void>;

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
  /** 删除会话。**进回收站**（v0.28） */
  deleteAskSession(id: number): Promise<void>;

  /* ---- 回收站（v0.28） ---- */
  /**
   * 回收站里的全部条目，按删除时间倒序 —— 三类对象混在一起，
   * 因为它们对用户来说是同一件事：「我刚删的、还没彻底没」。
   */
  listTrash(): Promise<TrashEntry[]>;
  /** 回收站条数。设置页那一行要显示它，不必把三条 SELECT 的正文都读出来 */
  trashCount(): Promise<number>;
  /** 批量恢复。返回真的恢复了几条（已经不在回收站的、已被彻底删的不计入） */
  restoreTrash(refs: TrashRef[]): Promise<number>;
  /**
   * 批量彻底删除。返回要删的文件名，调用方负责删文件 —— repo 不碰文件系统。
   *
   * 这是唯一不可逆的删除。界面上必须先二次确认，并且说清「图片和原件也会没」。
   */
  purgeTrash(refs: TrashRef[]): Promise<string[]>;
  /**
   * 30 天到期清理，App 启动时跑一次。
   * `before` 是截止时间戳（毫秒）：`deleted_at < before` 的才清。
   * 同样返回文件名，交调用方删。
   */
  purgeExpiredTrash(before: number): Promise<string[]>;

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
    /** 派生文档的来源文档 id（优化/重新整理之后新写的那篇要用） */
    originId?: number | null;
    stage?: DocStage;
    excerpt?: string;
  }): Promise<number>;
  /**
   * 更新解析结果。只传要改的字段。
   * `charCount` 由实现自己按 bodyMd 算，调用方不要传 —— 两处各算一次迟早对不上。
   */
  updateDocument(
    id: number,
    patch: {
      /** 改标题。用户权限最高：任何一篇都能改名（含导入的原件） */
      name?: string;
      bodyMd?: string;
      excerpt?: string;
      pages?: number | null;
      state?: DocumentMeta['state'];
      error?: string | null;
    },
  ): Promise<void>;
  /** 删除文档记录。**进回收站**（v0.28），原件留在磁盘上等 30 天后才真删 */
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

  /* ---- 文档标签（v0.28，平铺） ---- */
  /**
   * 全部标签，按「挂着几篇」倒序、同名按名字。
   *
   * `count` 只算**在库里**的文档：归档的与回收站里的不计数 ——
   * 否则一个标签会永远挂着 3，点进去只有 1 篇，用户会以为内容丢了。
   */
  listDocTags(): Promise<DocTag[]>;
  /**
   * 新建标签。**重名不报错，直接把已有的那条返回** ——
   * 用户第二次输入「工作」时想要的就是那个「工作」，弹一句「已存在」只会让人再点一次。
   *
   * `state` 只给 AI 用：AI 提议的新标签传 `'pending'`，用户点过才算数。
   */
  createDocTag(name: string, state?: 'approved' | 'pending'): Promise<DocTag>;
  /** 删标签。只删标签本身与挂链，文档一篇都不动 */
  deleteDocTag(id: number): Promise<void>;
  /** 一篇文档挂哪些标签。**整体替换**（多选改标签也是它），传空数组 = 全摘掉 */
  setDocumentTags(documentId: number, tagIds: number[]): Promise<void>;

  /* ---- 个人文档（v0.28） ---- */
  /*
   * 「新建一篇自己写的文档」走 `createDocumentWithContent`，**不要**在调用侧
   * 拼 `insertDocument` + `replaceDocumentContent` + `setDocumentTags`。
   * 那三步各自是一个事务，第二步失败会留下一篇「列表里看得见、点开是空的、
   * 也没有任务会去补」的文档（v0.35 修的正是这个）。
   *
   * 切片规则不在 repo 里：调用方用 `contentFromText` 切好传进来，
   * 这样「怎么切」仍然只有一份实现，repo 只保证「三样要么都在、要么都没有」。
   */
  createDocumentWithContent(input: {
    name: string;
    ext: string;
    size: number;
    excerpt?: string;
    origin?: DocumentMeta['origin'];
    originId?: number | null;
    /** 已经切好的正文与切片 */
    content: DocumentContentInput;
    /** 按名字挂标签，不存在就建。重名按 `docTagKey` 复用已有那条 */
    tagNames?: string[];
    /** 只给 AI 提议的标签用 `'pending'` */
    tagState?: 'approved' | 'pending';
  }): Promise<number>;
  /** 换一段：library / archived。归档是「AI 重新整理后旧的让位」，可查可恢复 */
  setDocumentStage(id: number, stage: DocStage): Promise<void>;

  /* ---- AI 提案（v0.28） ---- */
  insertProposal(input: { kind: ProposalKind; documentId: number | null; payload: DocProposalPayload }): Promise<number>;
  listProposals(state?: DocProposal['state']): Promise<DocProposal[]>;
  findProposal(id: number): Promise<DocProposal | null>;
  decideProposal(id: number, state: 'approved' | 'rejected'): Promise<void>;

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

  /**
   * 完整备份：数据库快照 + 配图 + 文档原件，打成一个 zip 放在 cache 目录。
   * 调用方负责把 `uri` 交给系统分享。
   *
   * 用 `VACUUM INTO` 取快照而不是拷主文件：应用在跑的时候库里有未落盘的 WAL，
   * 直接拷会得到「少最近几条」的包。
   */
  exportBackup(appVersion: string): Promise<BackupResult>;

  /**
   * 从备份包恢复。**会覆盖当前数据库与同名文件**。
   *
   * 覆盖之前一定会把当前库留一份到 `backups/pre-restore-*.db`，
   * 返回值里带上它的名字与体积 —— 界面必须如实说出来，否则用户没有退路。
   */
  restoreBackup(zipUri: string): Promise<RestoreResult>;

  /**
   * 只读备份包的清单，不动任何数据。
   *
   * 恢复不可逆，所以「这份包里是什么」要在按下确认之前说清：哪天的包、
   * 多少条、来自哪个版本、有没有缺文件。
   */
  peekBackup(zipUri: string): Promise<{
    manifest: BackupManifest;
    bytes: number;
    blockedReason: string | null;
  }>;
  /** 恢复点列表。设置页用它告诉用户「上一份库还在哪」 */
  listSafetyCopies(): Promise<SafetyCopy[]>;

  /**
   * 用一份恢复点覆盖当前库。
   *
   * 覆盖前会再留一份当前库（`backups/pre-restore-*.db`），返回值里带上它的名字与体积。
   * 文件名由 `listSafetyCopies()` 给出，调用方不要自己拼路径。
   */
  restoreSafetyCopy(name: string): Promise<{ safetyName: string; safetyBytes: number }>;
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
