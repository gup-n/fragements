/**
 * 「问」页的指令路由：这句话到底是要提问、整理碎片、整理待办，还是写月小结。
 *
 * 为什么不用模型判断意图：意图判断错一次的代价是不对称的 ——
 * 把「回答问题」误判成「整理」只是多花了钱；把「整理」误判成「回答」，
 * 用户会以为整理跑了、结果什么都没发生。所以这里用**确定性规则**：
 * 命中就进对应流程，界面上还能看到进了哪一个（有按钮可以改回提问）。
 *
 * 规则只认「动作词 + 对象词」同时出现。只说「整理」不够 ——
 * 「帮我整理一下这个问题」不是整理碎片。
 */

export type AskTask = 'answer' | 'organize' | 'todos' | 'digest';

export interface IntentResult {
  task: AskTask;
  /** 去掉指令词之后剩下的部分，整理时当补充要求用（可为空） */
  rest: string;
  /** 命中的词，界面用来解释「为什么进了整理」 */
  matched: string;
}

/** 整理动作词 */
const ORGANIZE_VERBS = ['整理', '提炼', '归纳', '梳理', '汇总', '总结一下', '复盘'];
/** 待办对象词 */
const TODO_WORDS = ['待办', '任务清单', 'to-do', 'todo', 'todolist'];
/** 碎片对象词 */
const FRAGMENT_WORDS = ['碎片', '记录', '笔记', '这些', '最近的', '最近', '今天', '本周'];
/** 月小结 */
const DIGEST_WORDS = ['月小结', '月总结', '这个月', '本月', '上个月', '月度'];

function has(text: string, words: string[]): string | null {
  for (const w of words) if (text.includes(w)) return w;
  return null;
}

/**
 * 路由一条输入。
 *
 * 顺序有讲究：月小结 → 待办 → 碎片整理 → 问答。
 * 月小结放最前，因为「整理这个月的碎片」同时命中「整理」和「这个月」，
 * 用户想清楚表达的显然是月小结；反过来先判「整理」，这句话就永远写不出月总结。
 */
export function routeAsk(raw: string): IntentResult {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const rest = text;

  if (!text) return { task: 'answer', rest: '', matched: '' };

  const digest = has(text, DIGEST_WORDS);
  if (digest && (has(text, ORGANIZE_VERBS) || text.includes('写') || text.includes('生成'))) {
    return { task: 'digest', rest, matched: digest };
  }

  const todo = has(lower, TODO_WORDS);
  if (todo) return { task: 'todos', rest, matched: todo };

  const verb = has(text, ORGANIZE_VERBS);
  if (verb) {
    const object = has(text, FRAGMENT_WORDS);
    // 「整理一下这段回答」这类没有对象词的不进整理流程，免得把问答吞掉
    if (object) return { task: 'organize', rest, matched: `${verb}·${object}` };
    // 只有动词但句子里明显在说碎片之外的（文档/回答/代码），也不进
    if (text.includes('文档') || text.includes('回答') || text.includes('代码')) {
      return { task: 'answer', rest, matched: '' };
    }
    // 「整理一下」这种光杆指令，默认就是整理碎片 —— 这是这一页最常用的动作
    if (text.replace(/[，。！？\s]/g, '').length <= 8) {
      return { task: 'organize', rest, matched: verb };
    }
  }

  return { task: 'answer', rest, matched: '' };
}

/**
 * 这句话是不是在说「全都整理」。
 *
 * 单独拎出来是因为它决定**读多少**：说「整理一下」取最近的一批，
 * 说「整理所有碎片」就得把库里剩下的都过一遍。用户 2026-11-11 报的问题
 * 正是这个 —— 他说了「所有」，结果只看了最近 40 条。
 */
export function wantsAll(text: string | undefined): boolean {
  if (!text) return false;
  return /所有|全部|一切|全库|整个库|每一条|每条|逐个/.test(text);
}

/** 三种任务在界面上的名字。统一在这里，免得两处写不一样的词 */
export const TASK_LABEL: Record<AskTask, string> = {
  answer: '回答问题',
  organize: '整理碎片',
  todos: '整理待办',
  digest: '写月小结',
};

/** 点一下提示框时填进输入框的默认指令 */
export const TASK_SEED: Record<Exclude<AskTask, 'answer'>, string> = {
  organize: '把这些碎片整理成一份知识文档',
  todos: '把这些碎片里能做的事整理成待办',
  digest: '帮我写这个月的月小结',
};

/**
 * 草稿开着的时候，用户新打的一句话算「改稿」还是「新的一轮整理」。
 *
 * 这是 v0.20.3 修「第二次说话没反应」时抽出来的判据 —— 它以前散在页面里，
 * 结果是**任何一句话都被当成改稿**：用户明明说「再整理一下待办」，
 * 模型却拿着一份文档草稿去改，改不出东西，看起来就像没生效。
 *
 * 三条规则：
 * 1. 明显说要整理 / 整理待办，且草稿里没有还没写入的东西 → 开新一轮；
 * 2. 明显说要整理，但草稿还没写入 → **挡住**，并告诉用户先写入或丢弃
 *    （直接覆盖等于把人家没保存的产出扔掉，那是不可逆的）；
 * 3. 其余一律当改稿 —— 「把第二段并进第一段」这种话，任何意图分类器都会判成问答。
 */
export type DraftInput =
  | { kind: 'revise' }
  | { kind: 'new'; mode: 'knowledge' | 'todos' }
  | { kind: 'blocked' };

export function planDraftInput(question: string, pending: number): DraftInput {
  const intent = routeAsk(question);
  if (intent.task !== 'organize' && intent.task !== 'todos') return { kind: 'revise' };
  if (pending > 0) return { kind: 'blocked' };
  return { kind: 'new', mode: intent.task === 'todos' ? 'todos' : 'knowledge' };
}
