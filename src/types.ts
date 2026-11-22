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

export interface PendingFragmentImage {
  /** 在本次 App 生命周期内唯一的待发键，形如 p123 */
  key: string;
  uri: string;
}

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
  /**
   * 被哪一次整理读过、并且用户把那次的产出写进了库（毫秒时间戳）。null = 没整理过。
   *
   * 为什么需要这个字段（v0.18.1）：标签拆掉之后，时间轴上就再也看不出
   * 「哪些已经整理过了」—— 用户只能靠记忆，于是同一批东西被反复整理。
   * 它记的是「落库」而不是「读过」：草稿被放弃的那次不算，
   * 因为一个字都没留下，说它「已整理」是在骗人。
   */
  organizedAt: number | null;
  /**
   * 配图，按加入顺序。空数组 = 纯文字碎片。
   *
   * v0.20 之前是 `imagePath` + `imageText` 两个标量字段，一条碎片只能带一张图。
   * 用户 2026-11-12 明确要求「目前只能放一张图进去，这些都要优化一下」，
   * 所以拆成独立表：一张图有自己的一生（文件、文字层、解析失败要单独重试），
   * 硬塞进两个标量字段里，第二张图就没有位置放它的状态了。
   */
  images: FragmentImage[];
}

/**
 * 碎片的一张配图。
 *
 * 只存文件名不存绝对路径：换机、迁移、App 私有目录前缀变化时，
 * 绝对路径会集体失效，而文件名永远能拼回去。
 */
export interface FragmentImage {
  id: number;
  /** 文件名（相对 `fragment-images/` 目录） */
  path: string;
  /**
   * 这张图的文字层：模型把图里的字抄下来 / 描述画面。null = 还没解析过。
   *
   * 空字符串是**有意义的**：表示「解析过了，图里确实没读出东西」。
   * 这两种状态在界面上必须区分 —— 前者可以重试，后者重试也没用。
   */
  text: string | null;
  createdAt: number;
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
  /**
   * 父待办的 id。null 表示这是一条顶层待办。
   *
   * 只有两层：子项的 `parentId` 指向顶层，顶层的 `parentId` 恒为 null。
   * 不做任意层级，原因有两个：三级以上的缩进在手机宽度里已经看不清哪条属于哪条；
   * 而「子项全勾完父项自动完成」这条规则一旦递归，就会出现「孙项没勾、
   * 父项却被判完成」的中间态，用户没有别的地方能看见它。
   *
   * 子项是**真正的一条待办**，不是父项的附属文字：它能独立勾选、改日期、
   * 被单独合并。只有这样「把一件事拆成几步」才有意义。
   */
  parentId: number | null;
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

/**
 * 周期总结的粒度。v0.15 起只剩「月」。
 *
 * 日、周两种粒度被删掉是用户 2026-11-10 明确要求的，原因在真实使用里很明显：
 * 一天记三五条碎片，压出来的那段话基本就是原文的缩写，读回来的价值低于它占据的
 * 时间轴位置；攒几十篇之后，想找上个月的月总结要一直往下翻。日/周小结还算得上
 * 「每天都得生成一次」的负担，而真正需要回顾的尺度是一个月。
 *
 * 这里**收窄类型**而不是留一个用不到的 `'daily' | 'weekly'`：
 * 留着枚举值，早晚会有某条路径把它接回来。旧数据里仍可能有 daily/weekly 的
 * note 行（迁移会清掉），但代码不再有任何生成入口。
 */

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
  /**
   * 给模型读的正文。
   *
   * 搜索结果是官方那 600–800 字摘要；`kind: 'page'` 时是整页 Markdown
   * （`/v1/tools/fetch` 读回来的），长得多 —— 所以拼资料时按 kind 给不同额度。
   */
  summary: string;
  /** 相关度分。官方说明 ≥1.5 算优质；服务端没给、以及整页抓取的都是 0 */
  score: number;
  /**
   * `'page'` = 用户给了链接、我们去读了那一页；不填 = 搜索结果。
   *
   * 这个区分是必须的：两种内容的体量差一个数量级（摘要 800 字 vs 整页上万字），
   * 拼资料时给一样的额度，要么整页被砍成摘要，要么摘要占了整页的地方。
   */
  kind?: 'search' | 'page';
}

/** 文档范围是会话契约，不是“优先检索”的提示。空白名单不得回退全库。 */
export type QaScope = { kind: 'records' } | { kind: 'documents'; documentIds: number[] };
export const MAX_ASK_DOCUMENTS = 8;

/** 问答引用类型：碎片 / 小结 / 待办 / 网页 / 文档片段 */
export type QaCiteKind = 'F' | 'N' | 'T' | 'W' | 'D';

/** 来源位置必须来自原件或提取结果；旧 Markdown 不得猜原页码。 */
export interface DocumentLocator {
  kind: 'text' | 'markdown' | 'pdf' | 'sheet';
  page?: number;
  sheet?: string;
  cellRange?: string;
  rowStart?: number;
  rowEnd?: number;
  lineStart?: number;
  lineEnd?: number;
  section?: string;
}

/** 一条可展开的引用。D/W 的 id 是本轮别名，不是持久数据 id。 */
export interface QaCitation {
  kind: QaCiteKind;
  id: number;
  label: string;
  /** 本轮实际交给模型的片段快照，历史不依赖原件仍存在。 */
  body: string;
  url?: string;
  /** 仅 D：稳定身份，不能用跨轮重复的 D1 代替。 */
  documentId?: number;
  contentRevision?: number;
  chunkId?: number;
  locator?: DocumentLocator;
}

/**
 * 一轮回答的**一个版本**（v0.33）。
 *
 * 为什么要版本：用户问完不满意，只有「重新生成」和「改问题重问」两条路；
 * 原来两条路都是覆盖 —— 原来那版答案就没了，想对照一下都没办法。
 * 现在每次重答都追加一版，界面底部给 `‹ 2/3 ›` 切回去。
 *
 * 一个版本带着自己那一版的问题：改问题重问之后，两个版本的问题文本不一样，
 * 切换版本时上面的气泡也要跟着换。
 */
export interface QaVariant {
  question: string;
  answer: string;
  sourceIds: number[];
  citations?: QaCitation[];
  webSources?: { title: string; url: string }[];
  reasoning?: string;
  truncated?: boolean;
  documentCoverage?: DocumentCoverage[];
  /** 这一版是什么时候生成的。切版本时给人看先后 */
  at: number;
}

/** sourceIds 仍只代表碎片，文档来源使用 citations 的稳定身份。 */
export interface QaTurn {
  /*
   * v0.33：新写入的数据都带 `variants` + `active`。
   *
   * 下面那批同名字段是**兼容层**：`variants[active]` 会被镜像回这里，
   * 这样两件事不用改 —— 问答上下文（ai/qa.ts 只读 question/answer），
   * 以及用户回退到旧版 APK 时旧代码还能读出这一轮。
   * 镜像只有 `ai/variants.ts` 一处实现，别在别处手写。
   */
  variants?: QaVariant[];
  /** 当前显示第几版（0 起）。缺省 0 */
  active?: number;

  question: string;
  answer: string;
  sourceIds: number[];
  citations?: QaCitation[];
  /**
   * 这一轮联网查到的网页（标题 + 链接），**不管模型有没有引用**。
   *
   * 引用列表只收模型真写了 `[W1]` 的那几条 —— 但它经常只用内容不带标记，
   * 于是用户看得见「联网补了 8 条」，却找不到一条能点的链接。
   * 这个字段专门给「网页来源」那一块用，点一下直接开浏览器。
   * 只存标题和 url，不存正文：正文在 citations 的快照里已经有了，重复存会把会话撑大。
   */
  webSources?: { title: string; url: string }[];
  reasoning?: string;
  truncated?: boolean;
  documentCoverage?: DocumentCoverage[];
  /**
   * v0.18：这一轮是「整理」而不是问答。
   *
   * 整理也必须进历史 —— 否则用户整理完退出，下次回来只看到一堆问答，
   * 那场整理就像没发生过。但要和问答分开：
   * - 问答把它当上下文会污染答案（模型会以为用户问过这个）；
   * - 界面上它该显示成一条整理记录，不是一问一答两个气泡。
   * 老数据没有这个字段，一律当 `qa`。
   */
  kind?: 'qa' | 'organize';
}

export interface DocumentCoverage {
  documentId: number;
  name: string;
  includedChunks: number;
  totalChunks: number;
  usedChars: number;
  totalChars: number;
}

/** 一次问答的结果，旧记录问答与限定文档问答共享展示层。 */
export interface QaOutcome {
  answer: string;
  reasoning: string;
  fragments: Fragment[];
  cited: Fragment[];
  notes: Note[];
  todos: Todo[];
  web: WebHit[];
  citations: QaCitation[];
  truncated: boolean;
  webError: string | null;
  scanned: number;
  scope: QaScope;
  documentCoverage?: DocumentCoverage[];
  inputTruncated?: boolean;
}

/** 「问」页的持久会话，范围与 turns 一起保存。 */
export interface AskSession {
  id: number;
  title: string;
  turns: QaTurn[];
  scope: QaScope;
  /**
   * 存下来的范围读不出来（脏数据、或者将来出现不认识的 kind）。
   *
   * 这时 `scope` 是 records 的占位值，**不能直接拿来用** ——
   * 打开这场会话会把文档会话变成全库会话。界面应当拒绝打开并说明原因，
   * 而不是悄悄按 records 恢复。
   */
  scopeBroken?: boolean;
  archived: boolean;
  fragmentId: number | null;
  /**
   * 这场会话整理出并写入文档区的那篇知识文档。
   *
   * 存 id 不存标题：标题可能在文档区被改，会话行上的徽标要跟着变。
   * 跳转也用它 —— 没有这个字段，用户看到「已整理」却不知道整理到哪去了。
   *
   * v0.17 起一次整理可以产出多篇，这里保存**第一篇**（老字段照旧可读），
   * 全部 id 在 `documentIds` 里。
   */
  documentId: number | null;
  /** 这场会话写进去的全部文档 id，顺序即整理时的顺序。空数组 = 没写过 */
  documentIds: number[];
  /** 这次整理真正喂给模型的碎片 id，重跑「重新整理」要用；空表示没整理过 */
  sourceIds: number[];
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* 文档工作区：原件、内容版本与索引彼此独立                               */
/* ------------------------------------------------------------------ */

/** stored 是正常成功状态；失败/重试不得销毁上一次可用内容。 */
export type DocState = 'stored' | 'local' | 'parsing' | 'done' | 'failed';
export type DocumentContentSource = 'text' | 'markdown' | 'pdf' | 'excel' | 'mineru' | 'legacy';

/**
 * 一篇文档从哪来。
 *
 * `file` = 用户导入的原件（有 file_uri，读的时候要么本地读、要么云解析）；
 * `knowledge` = AI 整理碎片产出、经用户审阅后写入的知识文档（**没有原件**）；
 * `authored` = 用户自己在文档页里写的（v0.28）。
 *
 * 为什么必须有这个字段，而不是「file_uri 为空就当知识」：
 * 导入的原件被用户清掉之后 file_uri 也会变空，那时它是「原件没了但正文还在」，
 * 和「本来就是整理出来的」是两件事 —— 前者要提示重新导入，后者要显示来源会话。
 * 用一个字段同时表达两种状态，最后一定是两处判据对不上。
 *
 * 为什么 `authored` 是**扩这一列**而不是新加一列 `source`：
 * 设计稿里提过加 `source = upload | authored | derived`，但那与 `origin` 是同一个问题
 * （「这行从哪来」）的两个答案，`knowledge` 就等于 `derived`。两列并存之后，
 * 「这不是原件」要判两次，迟早有一次只判了一边（v0.23 删掉 465 行就是这个原因）。
 * `knowledge` + `originId` 已经能表达「由哪篇派生的」，不需要第三个名字。
 */
export type DocumentOrigin = 'file' | 'knowledge' | 'authored';

/**
 * 文档放在哪一段。
 *
 * 只有两段：`library`（在库里）与 `archived`（AI 重新整理后旧的被换下来，可查可恢复）。
 *
 * **没有 `draft`**：用户 2026-11-18 定的是「自动入库」—— 新建的文档直接进库，
 * 草稿是它默认挂的标签（`DEFAULT_DOC_TAG`），不是另一块存放区。
 * 留一个永远不会被写入的枚举值，只会让「这篇在哪」多一条分支。
 */
export type DocStage = 'library' | 'archived';

/**
 * 文档标签（v0.28）。**平铺，没有父子**。
 *
 * 用户 2026-11-18 定的是平铺。真要做分类/子分类，那是另一张带 `parent_id` 的表，
 * 和「标签」是两个概念，混在一起会两头都不讨好（设计稿第七节）。
 *
 * `pending` 只出现在 AI 新建的标签上：AI 可以提议新标签，但要用户点一下才算数。
 */
export interface DocTag {
  id: number;
  name: string;
  state: 'approved' | 'pending';
  createdAt: number;
  /** 还挂着几篇文档（不算归档与回收站里的）。标签栏按它排序，也用它显示条数 */
  count: number;
}

/** 回收站里的四种东西。四种都只是「原表那一行加了 deleted_at」 */
export type TrashKind = 'fragment' | 'document' | 'ask_session' | 'note';

export interface TrashRef {
  kind: TrashKind;
  id: number;
}

export interface TrashEntry extends TrashRef {
  /** 一行能认出来的字：碎片首行 / 文档名 / 会话标题 */
  title: string;
  /** 量化信息：「128 字」「12 页」「8 轮」 */
  detail: string;
  deletedAt: number;
  /** 彻底删除时要一起删掉的文件名。恢复不需要它 —— 软删没动文件 */
  files: string[];
}

export type ProposalKind = 'optimize' | 'tag' | 'retag' | 'batch';

/**
 * 一条 AI 提案的内容。
 *
 * **提案不存应用结果**：通过之后真正写进 `documents` / `doc_tag_links`，
 * 提案只留审计（设计稿第二节）。否则「这篇文档是哪个提案生成的」会有两套答案。
 */
export interface DocProposalPayload {
  /** optimize / retag：建议正文 */
  bodyMd?: string;
  /** optimize / retag：建议标题；不填就沿用原题 */
  title?: string;
  /** tag / retag：建议挂上的标签名（不存在的会先建成 pending） */
  tags?: string[];
  /** 一句话说明模型为什么这么改，审批时要显示 */
  note?: string;
}

export interface DocProposal {
  id: number;
  kind: ProposalKind;
  /** batch 时为 null，明细在 util/docBatch 的进度里 */
  documentId: number | null;
  payload: DocProposalPayload;
  state: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  decidedAt: number | null;
}

export interface DocumentMeta {
  id: number;
  name: string;
  ext: string;
  size: number;
  fileUri: string | null;
  pages: number | null;
  charCount: number;
  state: DocState;
  error: string | null;
  contentRevision: number;
  indexedRevision: number;
  chunkCount: number;
  contentSource: DocumentContentSource | null;
  origin: DocumentOrigin;
  /**
   * `knowledge` 文档是从哪篇文档派生的（AI 优化/重新整理的来源）。
   * null = 不是派生出来的。原稿一个字都不动，只靠这一列指回去。
   */
  originId: number | null;
  stage: DocStage;
  /** 挂着的标签（平铺）。列表接口一起带出来，免得每行再查一次 */
  tags: DocTag[];
  /**
   * 列表里那一行摘要。**正文不进列表接口**（可能几十万字），
   * 所以摘要必须在写入时就算好存下来；现算等于每次打开文档页把全文读一遍。
   */
  excerpt: string;
  createdAt: number;
  updatedAt: number;
}

export interface Document extends DocumentMeta {
  bodyMd: string;
}

export interface DocumentChunkInput {
  text: string;
  locator: DocumentLocator;
}

export interface DocumentChunk extends DocumentChunkInput {
  id: number;
  documentId: number;
  contentRevision: number;
  ordinal: number;
}

/** 只有完整、受限且有真实位置的提取结果才提交；不得把静默截断当完整。 */
export interface DocumentContentInput {
  bodyMd: string;
  chunks: DocumentChunkInput[];
  source: DocumentContentSource;
  pages: number | null;
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
