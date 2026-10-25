/**
 * 整理的一批：把一批碎片交给模型，收敛成 `BatchResult`。
 *
 * v0.7 起这里**只做一件事**：一次一整批。循环、游标、断点续跑、失败拆分
 * 全在 `db/organizeLoop.ts` 里，本文件不碰数据库也不持有状态 ——
 * 上一版把「第几批」「上一次的原始输出」混进这里，导致谁也说不清一次请求的边界。
 *
 * 业务校验（id 属于本批、日期合法、待办互斥）**不在这里**，
 * 全部在 `util/organizePlan.ts` 的 `mergeBatchResult` 里做一份。
 * 两处各校验一遍的历史教训是：判据一歪，界面说的和写库的就对不上。
 */
import type { AiConfig, BatchResult, Fragment, ReasoningEffort, TagStat, Todo } from '../types';
import { AiError, parseJsonLoose, requestChat, type ChatMessage, type ChatProgress } from './chat';
import { SYSTEM_PROMPT, buildUserContent } from './prompt';

/** 流式回调，传的是**累积全文**，界面直接覆盖显示 */
export type BatchProgress = ChatProgress;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number => Number(v);

/**
 * 只收敛「形状」，不做业务判断：把 unknown 摊平成 BatchResult 的字段类型。
 * 非法条目照样往下传，由 `mergeBatchResult` 统一计入 `rejected` ——
 * 在这里悄悄丢掉，用户就永远不知道模型给了什么。
 */
export function coerceBatch(raw: unknown): BatchResult {
  const root = obj(raw);

  const tags = arr(root.tags).map((item) => {
    const t = obj(item);
    return {
      id: num(t.id),
      labels: arr(t.labels).filter((x): x is string => typeof x === 'string'),
      project: text(t.project) || null,
    };
  });

  const todos = arr(root.todos).map((item) => {
    const t = obj(item);
    return {
      text: text(t.text),
      due: text(t.due) || null,
      id: Number.isFinite(num(t.id)) ? num(t.id) : null,
    };
  });

  const merge = arr(root.merge).map((item) => {
    const m = obj(item);
    return {
      keep_id: num(m.keep_id),
      drop_ids: arr(m.drop_ids).map(num),
      reason: text(m.reason) || null,
    };
  });

  const todoDone = arr(root.todo_done).map((item) => {
    const d = obj(item);
    return { todo_id: num(d.todo_id), reason: text(d.reason) || null };
  });

  const dropTodos = arr(root.drop_todos).map((item) => {
    const d = obj(item);
    return { todo_id: num(d.todo_id), reason: text(d.reason) || null };
  });

  const mergeTodos = arr(root.merge_todos).map((item) => {
    const m = obj(item);
    return {
      keep_id: num(m.keep_id),
      drop_ids: arr(m.drop_ids).map(num),
      text: text(m.text) || null,
      reason: text(m.reason) || null,
    };
  });

  return {
    tags,
    todos,
    merge,
    todo_done: todoDone,
    drop_todos: dropTodos,
    merge_todos: mergeTodos,
    batch_summary: text(root.batch_summary),
    rejected: 0,
  };
}

/**
 * 这一批该用多强的思考。
 *
 * 官方 `high` 不只是「想久一点」——它在 prompt 最前面插了一段
 * 「穷举所有边界情况和对抗性场景，写出每个中间步骤」。对「给四十条笔记打标签」
 * 这种机械抽取纯属浪费：思考链能从 3K 涨到 15K，而额度是思考链和正文共用的，
 * 这正是当初「思考到一半就停住」的推手之一。
 *
 * 所以小额批次给 `low`（官方 low 的实现是**不加任何前缀**，模型按自己节奏思考）。
 * v0.6 里「重构模式一律 high」那条规则在这里取消了：那时是要和旧知识卡逐项比对，
 * 现在没有卡片，旧标签已经直接列在 prompt 里，比对成本降下来了。
 */
const SMALL_BATCH = 15;

function pickEffort(count: number): ReasoningEffort {
  return count <= SMALL_BATCH ? 'low' : 'high';
}

export interface BatchOptions {
  fragments: Fragment[];
  config: AiConfig;
  existingTags: TagStat[];
  todos: Todo[];
  plannedTodos: string[];
  summaries: string;
  round: number;
  total: number;
  refactor: boolean;
  onProgress?: (patch: BatchProgress) => void;
}

export interface BatchOutcome {
  batch: BatchResult;
  /** 模型原始输出，排查问题时留着看 */
  raw: string;
  /** 思维链，只用于展示 */
  reasoning: string;
  /** 实际用的思考强度，失败重试时要原样复用 */
  effort: ReasoningEffort;
}

export async function organizeBatch(options: BatchOptions): Promise<BatchOutcome> {
  const { fragments, config, onProgress, ...context } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  if (!fragments.length) throw new AiError('format', '这一批没有碎片');

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserContent({ fragments, ...context }) },
  ];

  const effort = pickEffort(fragments.length);
  const outcome = await requestChat(config, messages, onProgress, { json: true, effort });

  // 正文非空但撞了额度：JSON 必然是残的。不先拦下来的话，
  // parseJsonLoose 会报「不是合法 JSON，再试一次」—— 而同样的输入重试必然同样失败。
  // 抛 `truncated` 让循环层把这批对半拆开重试（SPEC 0.3 第 8 条）。
  if (outcome.finishReason === 'length') {
    throw new AiError(
      'truncated',
      `这一批的输出被截断了（${fragments.length} 条碎片）。会把这批拆小再试。`,
    );
  }

  const batch = coerceBatch(parseJsonLoose(outcome.content));
  return { batch, raw: outcome.content, reasoning: outcome.reasoning, effort };
}
