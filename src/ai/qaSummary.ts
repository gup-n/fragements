/**
 * 把一场问答提炼成一条碎片的「精要版」。
 *
 * 为什么不直接存全文：用户的原话是「保留精要，虽然会花销点 token，但总比直接保存好」。
 * 全文转录适合兜底，不适合平时沉淀 —— 一场几轮下来几千字，整理时一条就吃掉一批预算。
 *
 * 三条纪律：
 * - **只依据对话内容**，不补外部知识；
 * - **不输出 `[F12]` 这类引用编号**：碎片脱离会话后这些编号没有意义；
 * - **输出是给人读的 Markdown**，不是给程序解析的 JSON。
 */
import type { AiConfig, QaTurn } from '../types';
import { AiError, requestChat, type ChatProgress } from './chat';
import { stripCiteMarkers } from '../util/qaNote';

/** 单条回答进 prompt 的上限。超长的回答只保留前面这部分，避免一场会话撑爆上下文 */
const MAX_ANSWER = 4_000;
/** 整段对话的总预算。超过就从最早的一轮开始丢，并在结果里报告丢了几轮 */
const MAX_TOTAL = 48_000;

const SYSTEM_PROMPT = `你是一个私人记录整理助手。用户刚完成一场关于自己记录（碎片）的问答，请把整段对话提炼成一条可以存进时间轴的「碎片」。

【保留什么】
- 结论、关键步骤、数字 / 型号 / 时间、注意事项、不同方案的取舍
- 明确做过的决定、待办、还没解决的问题
- 用户真正关心的那件事，不要平均分配篇幅

【删掉什么】
- 寒暄、重复、模型的推理过程、对资料的复述
- [F12] / [N3] / [T5] / [W1] 这类引用编号
- 「根据你提供的对话」这类开场

【格式】
- Markdown；开头一句话结论，下面 2-5 条要点（用 - 列表）
- 有步骤时用有序列表；多个话题可用 ## 小标题分开，最多 3 个
- 300-800 字；内容确实多时可以到 1200 字，但不要为了凑字数重复

【纪律】
- 只依据对话内容，不编造对话里没有的时间、型号、金额、人名
- 对话里没有的结论就写「还没结论」，不要替用户补完`;

interface Transcript {
  text: string;
  /** 因为预算被丢掉的最早轮数 */
  omittedTurns: number;
}

/**
 * 从最新一轮往前装填。会话很长时优先保留最近的内容 ——
 * 用户刚问完的事，通常比半小时前的铺垫更重要。
 */
function buildTranscript(turns: QaTurn[]): Transcript {
  const kept = turns.filter((t) => t.question.trim() && t.answer.trim());
  const chunks: string[] = [];
  let used = 0;
  let omittedTurns = 0;

  for (let i = kept.length - 1; i >= 0; i--) {
    const t = kept[i];
    const answer =
      t.answer.length > MAX_ANSWER ? `${t.answer.slice(0, MAX_ANSWER)}\n（回答较长，后面省略）` : t.answer;
    const chunk = `第 ${i + 1} 轮\n问：${t.question.trim()}\n答：${stripCiteMarkers(answer)}`;
    // 至少收一轮：否则第一条超长会话会永远装不进去
    if (chunks.length && used + chunk.length > MAX_TOTAL) {
      omittedTurns = i + 1;
      break;
    }
    chunks.unshift(chunk);
    used += chunk.length;
  }

  const head =
    omittedTurns > 0
      ? `（对话较长，下面只包含最近 ${chunks.length} 轮；更早的 ${omittedTurns} 轮未放入，请基于现有内容整理）\n\n`
      : '';
  return { text: `${head}${chunks.join('\n\n')}`, omittedTurns };
}

export interface QaSummaryOptions {
  turns: QaTurn[];
  config: AiConfig;
  /** 是否开思考；和「问」页当前开关一致 */
  thinking: boolean;
  onProgress?: (patch: ChatProgress) => void;
}

export interface QaSummaryResult {
  /** 模型提炼的 Markdown 正文，已去掉引用标记 */
  summary: string;
  /** 输入太长时被丢掉的最早轮数；界面上要如实提示 */
  omittedTurns: number;
}

export async function summarizeQaSession(options: QaSummaryOptions): Promise<QaSummaryResult> {
  const { turns, config, thinking, onProgress } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没配置 API Key，无法调用模型整理');
  if (!turns.some((t) => t.question.trim() && t.answer.trim())) {
    throw new AiError('format', '这场会话没有可整理的内容');
  }

  const transcript = buildTranscript(turns);
  const outcome = await requestChat(
    { ...config, thinking },
    [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${transcript.text}\n\n请把上面的对话提炼成一条碎片。`,
      },
    ],
    onProgress,
    // 必须是纯文本：开 json_object 会把整篇 Markdown 压成一个字符串
    { json: false, effort: thinking ? 'high' : undefined },
  );

  if (outcome.finishReason === 'length') {
    throw new AiError('truncated', '提炼结果被输出上限截断，点「重新生成」再试一次');
  }

  const summary = stripCiteMarkers(outcome.content).trim();
  if (!summary) throw new AiError('format', '模型没有返回摘要，再试一次');

  return { summary, omittedTurns: transcript.omittedTurns };
}
