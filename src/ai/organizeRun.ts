/**
 * 整理循环：程序控节奏，一批一批跑到完。
 *
 * 为什么不做成「模型自己调 tool 取碎片」：范围、装箱、游标全是确定的，
 * 模型没有可决策的空间。真 tool calls 只会多出流式 `tool_calls` 解析、
 * 模型忘调 / 死循环 / 参数错三层故障，收益为零（SPEC 0.3 末尾有完整说明）。
 * 这里的"agent 感"由两件事实现：**每批摘要接力** + **每批落库可续跑**。
 *
 * 分工：
 * - 本文件：会话、装箱、循环、失败拆分、进度
 * - `ai/deepseek.ts`：一次请求
 * - `util/organizePlan.ts`：合并与校验（唯一一份判据）
 * - `db/commit.ts`：用户确认之后才写库
 *
 * 只要没走到 `commitPlan`，用户的数据一个字都不会变。
 */
import type {
  AiConfig,
  Fragment,
  OrganizePlan,
  OrganizeScope,
  OrganizeSession,
  TagStat,
  Todo,
} from '../types';
import { AiError } from './chat';
import { organizeBatch } from './deepseek';
import { repo } from '../db/repo';
import { packFragments } from '../util/batch';
import {
  appendSummary,
  effectiveTags,
  effectiveTodos,
  emptyPlan,
  mergeBatchResult,
  plannedTodoTexts,
} from '../util/organizePlan';

/**
 * 单批上限：40 条 / 16,000 字。
 *
 * 比 v0.6 的 30 条 / 12,000 字放宽了，因为输出从「十类 + 卡片正文」缩到六类，
 * 单条碎片的输出成本降了一半。放宽的收益是批次数变少、跑完更快。
 * 真撞到 64K 上限也不会全废：`truncated` 会把这一批对半拆开重试。
 */
export const BATCH_LIMIT = 40;
export const BATCH_CHAR_BUDGET = 16_000;

export interface RunProgress {
  /** 已经跑完的碎片数（不含本批） */
  done: number;
  /** 这次要跑的总条数 */
  total: number;
  /** 当前批次序号（从 1 开始，可能因拆分而大于估算值） */
  round: number;
  /** 按装箱估算的总批次数 */
  totalRounds: number;
  /** 本批条数 */
  batchCount: number;
  /** 流式思维链（累积全文），仅展示 */
  reasoning: string;
  /** 流式正文（累积全文），仅展示 */
  content: string;
  plan: OrganizePlan;
}

export interface RunOptions {
  session: OrganizeSession;
  config: AiConfig;
  /** 已有标签表（开始时的快照） */
  existingTags: TagStat[];
  /** 现有待办（含已完成） */
  todos: Todo[];
  onProgress?: (update: RunProgress) => void;
  /** 用户点了「停止」：当前批跑完就收，已跑的批次全部保留 */
  shouldStop?: () => boolean;
}

/**
 * 某一批彻底失败（重试过、拆过还是不行）。
 *
 * 不用异常中断整次整理：跑了一半的结果要保住，让用户选
 * 「重试这一批 / 跳过这一批 / 放弃本次」。界面拿到它之后调
 * `skipBatch` 再 `runOrganize` 续跑，而不是在 catch 里硬撑一个状态机。
 */
export class BatchFailure extends Error {
  readonly cause: Error;
  /** 已经保存到库的会话（plan 里含失败之前所有批次的结果） */
  readonly session: OrganizeSession;
  readonly batchIds: number[];
  readonly round: number;
  readonly totalRounds: number;

  constructor(
    cause: Error,
    session: OrganizeSession,
    batchIds: number[],
    round: number,
    totalRounds: number,
  ) {
    super(cause.message);
    this.name = 'BatchFailure';
    this.cause = cause;
    this.session = session;
    this.batchIds = batchIds;
    this.round = round;
    this.totalRounds = totalRounds;
  }

  get code(): string {
    return this.cause instanceof AiError ? this.cause.code : 'unknown';
  }
}

/** 开一次新会话：取 id 快照，之后所有批次都从这份快照切 */
export async function startSession(scope: OrganizeScope): Promise<OrganizeSession> {
  const pendingIds = await repo.listFragmentIds(scope);
  const plan = emptyPlan();
  const now = Date.now();
  const id = await repo.saveOrganizeSession({
    scope,
    pendingIds,
    cursor: 0,
    plan,
    contextSummary: '',
    finished: false,
  });
  return {
    id,
    scope,
    pendingIds,
    cursor: 0,
    plan,
    contextSummary: '',
    finished: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** 上次没跑完的会话，进页面时用来显示「继续上次」 */
export function findUnfinished(): Promise<OrganizeSession | null> {
  return repo.findUnfinishedOrganizeSession();
}

/** 放弃：直接把会话删掉，不留「继续上次」的残影。碎片状态不受影响 */
export function abandonSession(id: number): Promise<void> {
  return repo.deleteOrganizeSession(id);
}

/** 收尾：标记会话完成，之后不会再提示续跑 */
export function finishSession(id: number): Promise<void> {
  return repo.finishOrganizeSession(id);
}

/**
 * 跳过某一批：把这些 id 记进 `skippedIds`，**不标记碎片状态**。
 * 下次整理它们还在 inbox 里 —— 跳过的是「这一次的请求」，不是这些内容。
 */
export async function skipBatch(
  session: OrganizeSession,
  batchIds: number[],
): Promise<OrganizeSession> {
  const skipped = Array.from(new Set([...session.plan.skippedIds, ...batchIds]));
  const plan: OrganizePlan = { ...session.plan, skippedIds: skipped };
  await repo.updateOrganizeSession(session.id, { plan, cursor: session.cursor });
  return { ...session, plan };
}

/** 按装箱规则估算总批次数，只用于进度条 */
function estimateRounds(list: Fragment[]): number {
  let rounds = 0;
  let rest = list;
  while (rest.length) {
    const batch = packFragments(rest, BATCH_LIMIT, BATCH_CHAR_BUDGET);
    if (!batch.length) break;
    rounds++;
    rest = rest.slice(batch.length);
  }
  return rounds;
}

/**
 * 跑（或续跑）一次整理，直到快照里的碎片全部处理完。
 *
 * 返回的 session 还没 `finished` —— 要不要写库、写哪些，是用户在确认页决定的。
 */
export async function runOrganize({
  session,
  config,
  existingTags,
  todos,
  onProgress,
  shouldStop,
}: RunOptions): Promise<OrganizeSession> {
  const processed = new Set(session.plan.processedIds);
  const skipped = new Set(session.plan.skippedIds);
  // 用「快照 - 已处理 - 已跳过」算剩余，而不是靠一个 offset 游标。
  // v0.6 的翻车点就在这：游标和池子各算一次，第二次点「继续」拿到的还是同一批。
  const remainingIds = session.pendingIds.filter((id) => !processed.has(id) && !skipped.has(id));
  if (!remainingIds.length) return session;

  // 一次把剩余碎片取全：装箱要按字数算，边取边装会把长碎片留到最后单独成批。
  // 上千条也只是几百 KB，比反复查库省事得多。
  const rows = await repo.listFragmentsByIds(remainingIds);
  const byId = new Map(rows.map((f) => [f.id, f]));
  let pool: Fragment[] = remainingIds
    .map((id) => byId.get(id))
    .filter((f): f is Fragment => !!f);

  const totalRounds = estimateRounds(pool);
  const total = session.pendingIds.length;
  let plan = session.plan;
  let summary = session.contextSummary;
  // 「已处理」用计划里的记录算，不要用 total - 池子长度：
  // 池子会漏掉那些已经被删掉的碎片，相减会把它们也算成"处理过"
  let done = plan.processedIds.length + plan.skippedIds.length;
  let round = 0;
  let latest: OrganizeSession = session;

  /** 每批结果的落库。游标这里存的是「已处理条数」，纯展示用，不参与切分 */
  const persist = async () => {
    await repo.updateOrganizeSession(session.id, {
      plan,
      contextSummary: summary,
      cursor: plan.processedIds.length + plan.skippedIds.length,
    });
    latest = { ...latest, plan, contextSummary: summary };
  };

  /**
   * 处理一批。`truncated` 时对半拆开再试 —— 拆到只剩一条还截断，
   * 那就是这条碎片本身太长或模型额度太小，只能如实报错让人处理。
   */
  const handle = async (batch: Fragment[]): Promise<void> => {
    try {
      const outcome = await organizeBatch({
        fragments: batch,
        config,
        // 前几批刚建的新标签也要让这一批看见，否则会再造近义词
        existingTags: effectiveTags(existingTags, plan),
        // prompt 里给「有效视图」：本计划里已标完成/已删除的不再出现
        todos: effectiveTodos(todos, plan),
        plannedTodos: plannedTodoTexts(plan),
        summaries: summary,
        round: round + 1,
        total: totalRounds,
        refactor: session.scope === 'all',
        onProgress: (patch) =>
          onProgress?.({
            done,
            total,
            round: round + 1,
            totalRounds,
            batchCount: batch.length,
            reasoning: patch.reasoning ?? '',
            content: patch.content ?? '',
            plan,
          }),
      });

      plan = mergeBatchResult(plan, outcome.batch, {
        batchIds: batch.map((f) => f.id),
        existingTags,
        // 校验必须用**原始**待办表：计划里的变更还没落库，用它校验会把 id 判掉
        todos,
      });
      summary = appendSummary(summary, outcome.batch.batch_summary);
      round++;
      done += batch.length;
      await persist();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (err instanceof AiError && err.code === 'truncated' && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        await handle(batch.slice(0, mid));
        await handle(batch.slice(mid));
        return;
      }
      throw new BatchFailure(err, latest, batch.map((f) => f.id), round + 1, totalRounds);
    }
  };

  while (pool.length) {
    if (shouldStop?.()) break;
    const batch = packFragments(pool, BATCH_LIMIT, BATCH_CHAR_BUDGET);
    if (!batch.length) break;
    pool = pool.slice(batch.length);
    await handle(batch);
  }

  return latest;
}
