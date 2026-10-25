/**
 * DeepSeek chat/completions 的流式响应解析。
 *
 * 响应是标准 SSE：每行 `data: <json>`，以 `data: [DONE]` 收尾。
 * 两个 delta 字段的含义完全不同，必须分开累积：
 *
 *   delta.reasoning_content —— 模型在给出答案前的思维链，自然语言
 *   delta.content           —— 最终答案，本项目里是一段 JSON
 *
 * 千万别把两者拼进同一个缓冲区：思维链混进 JSON 会让解析当场失败。
 */

export interface StreamCallbacks {
  /** 思维链每增长一点就回调一次，传的是**累积后的全文**，UI 直接覆盖显示即可 */
  onReasoning?: (text: string) => void;
  /** 正文（JSON）每增长一点就回调一次，同样是累积全文 */
  onContent?: (text: string) => void;
}

/**
 * 输出为什么停下。**只有 'stop' 代表完整**。
 *
 * - `length` —— 撞到 max_tokens（**含思考链**）或上下文上限，被硬截断
 * - `insufficient_system_resource` —— 服务端推理资源不足，生成被打断
 * - `content_filter` / `aborted` / `tool_calls` —— 本项目基本不会遇到（不用 tools）
 */
export type FinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'insufficient_system_resource'
  | 'aborted';

export interface StreamResult {
  /** 拼完的正文，交给 parseJsonLoose 解析 */
  content: string;
  /** 思维链全文，只用于展示；模型没有思考模式时为空串 */
  reasoning: string;
  /**
   * 停止原因。拿不到就为 null（兼容不返回该字段的第三方兼容服务）。
   *
   * 这个字段以前整个丢掉了，代价是：思考链吃光 max_tokens 导致正文一个字都没出时，
   * 上层只能看到「content 为空」，于是报「模型没有返回内容」——
   * 把「输出被截断」误诊成「模型不干活」，排查时完全摸不着方向。
   */
  finishReason: FinishReason | null;
}

/** 流式响应不可用（拿不到 body），调用方应回退到非流式 */
export class NoStreamError extends Error {
  constructor() {
    super('stream unavailable');
    this.name = 'NoStreamError';
  }
}

/** 从一行 SSE 里取出 data 段的内容；不是 data 行返回 null */
function payloadOf(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return null; // 空行与注释
  if (!trimmed.startsWith('data:')) return null;
  return trimmed.slice(5).trim();
}

export async function readChatStream(
  response: Response,
  callbacks: StreamCallbacks = {},
): Promise<StreamResult> {
  const body = response.body;
  if (!body) throw new NoStreamError();

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reasoning = '';
  let content = '';
  let finishReason: FinishReason | null = null;

  const consume = (line: string) => {
    const payload = payloadOf(line);
    if (payload === null) return false;
    if (payload === '[DONE]') return true;

    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      // 单个畸形分片不该毁掉整轮整理，跳过它
      return false;
    }

    const choice = chunk?.choices?.[0];
    if (!choice) return false;

    // finish_reason 通常挂在**最后一个** chunk 上，而那个 chunk 的 delta 是空的。
    // 所以必须在读 delta 之前取，否则会被 `if (!delta) return` 整个跳过 ——
    // 那正是「截断被当成空回复」的原因。
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      finishReason = choice.finish_reason as FinishReason;
    }

    const delta = choice.delta;
    if (!delta) return false;

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      callbacks.onReasoning?.(reasoning);
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      callbacks.onContent?.(content);
    }
    return false;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // stream: true 让 decoder 保留跨分片的半个多字节字符
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      // 最后一段可能只是个半行，留到下一块再拼
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (consume(line)) return { content, reasoning, finishReason };
      }
    }

    // 收尾：把残留的 buffer 与 decoder 内部缓存都冲出来
    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) {
      if (consume(line)) break;
    }
  } finally {
    // 提前 return 或抛错时释放底层连接
    try {
      await reader.cancel();
    } catch {
      /* 已经结束的流 cancel 会抛，忽略 */
    }
  }

  return { content, reasoning, finishReason };
}
