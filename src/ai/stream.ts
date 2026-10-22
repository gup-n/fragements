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

export interface StreamResult {
  /** 拼完的正文，交给 parseJsonLoose 解析 */
  content: string;
  /** 思维链全文，只用于展示；模型没有思考模式时为空串 */
  reasoning: string;
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

    const delta = chunk?.choices?.[0]?.delta;
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
        if (consume(line)) return { content, reasoning };
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

  return { content, reasoning };
}
