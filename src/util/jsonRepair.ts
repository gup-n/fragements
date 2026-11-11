/**
 * 模型输出的 JSON 解析：宽容 + 说清「哪一字不对」。
 *
 * 为什么不能只用 `JSON.parse`：模型写知识文档时，正文里全是 Markdown，
 * 最容易出事的恰恰是**正文里的反斜杠**——Windows 共享路径 `\\server\queue`、
 * 正则、文件路径。模型时常少转义一个，于是 `"\N"` 成了非法转义，整段解析失败，
 * 而这份内容本身是好东西（v0.18.1 用户报的就是这个：报错原文看起来完全合法）。
 *
 * 所以这里做两件事，顺序不能反：
 * 1. **先原样解析**。别急着"修复"合法的东西 —— 修补本身有风险，
 *    能原样读出来的就一个字都不要改。
 * 2. 失败了才修：只在字符串内部把非法转义、裸控制字符补成合法形式，
 *    **不动结构**（不做"自动补右括号"）。半截 JSON 补出来的是一篇缺尾巴的文档，
 *    用户看到的是「写成了但内容不对」，比明确报错更难发现。
 *
 * 修完还是不行，就报出**位置和附近原文**：只说「不是合法 JSON」时，
 * 用户只能把四五千字原文发过来；说「第 1240 字附近：‘\N’」就能直接定位。
 */

/** 一段文字里哪一处坏了 */
export interface JsonProblem {
  /** 相对「被解析的那段」的字符下标 */
  at: number;
  /** 那一带原文，报错时贴给人看 */
  near: string;
  /** 一句人话原因 */
  reason: string;
}

export type JsonParseResult =
  | { ok: true; value: unknown; repaired: boolean }
  | { ok: false; problem: JsonProblem };

/**
 * 剥掉外层噪音：BOM、代码围栏、前后的解释文字。
 *
 * 用括号配对扫出 JSON 本体，而不是 `lastIndexOf('}')` ——
 * 后者遇到「后面还跟了一段带花括号的说明」时会切错位置。
 */
export function extractJsonSpan(text: string): string {
  const s = text.replace(/^\uFEFF/, '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : s).trim();
  const start = body.indexOf('{');
  if (start < 0) return body;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  // 没配平：多半是输出被截断。原样返回，交给解析去报「哪一字没了」
  return body.slice(start);
}

const VALID_ESCAPES = '"\\/bfnrt';

/**
 * 修字符串内部的非法转义与裸控制字符。结构一律不动。
 *
 * 只在**引号里**动手：字符串外的反斜杠不存在，改了也没意义。
 * 引号内的 `\x`（x 不是合法转义符）改成 `\\x` —— 这是最保守的修法：
 * 模型本来想表达的就是一个字面反斜杠。
 */
export function repairJson(src: string): { text: string; changed: boolean } {
  let out = '';
  let inStr = false;
  let changed = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (!inStr) {
      if (ch === '"') inStr = true;
      // 尾逗号（`{"a":1,}`）：模型很常见的笔误，删掉逗号不动结构
      if (ch === ',') {
        let j = i + 1;
        while (j < src.length && /\s/.test(src[j])) j += 1;
        if (src[j] === '}' || src[j] === ']') {
          changed = true;
          continue;
        }
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inStr = false;
      out += ch;
      continue;
    }

    if (ch === '\\') {
      const next = src[i + 1] ?? '';
      if (next === 'u') {
        const hex = src.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += `\\u${hex}`;
          i += 5;
          continue;
        }
        // \u 后面不是四位十六进制：当成字面反斜杠
        out += '\\\\';
        changed = true;
        continue;
      }
      if (!next) {
        // 结尾一个孤立反斜杠（截断）：补成字面反斜杠
        out += '\\\\';
        changed = true;
        continue;
      }
      if (VALID_ESCAPES.includes(next)) {
        out += ch + next;
        i += 1;
        continue;
      }
      // `\N` `\w` `\d` 这类：模型本想写字面反斜杠，少转义了一次
      out += '\\\\';
      changed = true;
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      // 字符串里出现裸换行 / 制表符：JSON 不允许，补成转义
      out +=
        ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`;
      changed = true;
      continue;
    }

    out += ch;
  }

  return { text: out, changed };
}

/** 解析失败时，把 V8 报的位置换算成「附近原文 + 原因」 */
function describeFailure(src: string, err: unknown): JsonProblem {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /position (\d+)/i.exec(msg);
  const at = m ? Math.min(Number(m[1]), Math.max(0, src.length - 1)) : 0;
  const from = Math.max(0, at - 40);
  const near = src.slice(from, Math.min(src.length, at + 40));
  let reason = msg;
  if (/Unterminated string/i.test(msg) || /Unexpected end of JSON input/i.test(msg)) {
    reason = '内容在末尾断掉了（多半是输出被截断）';
  } else if (/Bad control character/i.test(msg)) {
    reason = '字符串里有没转义的换行 / 制表符';
  } else if (/Bad escaped character|Bad Unicode escape/i.test(msg)) {
    reason = '字符串里有非法的反斜杠转义';
  }
  return { at, near, reason };
}

/**
 * 宽容解析。先原样，修过再试一次；都不行就返回问题所在。
 *
 * 返回值带 `repaired`：修过的那份内容**可能和模型原意有细微差别**
 * （比如一个本该是 `\n` 的换行被当成字面 `\n`），调用方据此可以提示一句。
 */
export function parseJsonLenient(text: string): JsonParseResult {
  const span = extractJsonSpan(text);

  try {
    return { ok: true, value: JSON.parse(span), repaired: false };
  } catch (first) {
    const fixed = repairJson(span);
    if (fixed.changed) {
      try {
        return { ok: true, value: JSON.parse(fixed.text), repaired: true };
      } catch (second) {
        return { ok: false, problem: describeFailure(fixed.text, second) };
      }
    }
    return { ok: false, problem: describeFailure(span, first) };
  }
}
