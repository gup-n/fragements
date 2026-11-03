/**
 * 纯文本编码判断。
 *
 * 为什么要做这一步：安卓上的 `.txt` 很可能是 GBK（Windows 记事本默认存 GBK
 * 存了二十年），而 `File.text()` 只会按 UTF-8 解。解错的输出**不是报错**，
 * 而是一屏 `锟斤拷` / `�` —— 用户会以为是 App 把文件读坏了。
 *
 * 能做的判断有限，但足够把「明显不是 UTF-8」拦下来并说清楚原因，
 * 而不是把乱码当正文存进库（存进去之后还会被切片、被提问，错得更远）。
 */
import { ReaderError } from './errors';

/** 单次判断最多看的字符数。4 MiB 的文本没必要整篇扫，开头几万字足够定性 */
const SAMPLE = 40_000;

export interface TextProblem {
  code: 'encoding';
  message: string;
}

/**
 * 返回 null 表示「看着是正常 UTF-8 文本」。
 *
 * 两条判据：
 * - 出现 NUL 字节：UTF-8 文本里不该有，基本是 UTF-16 或二进制被硬解；
 * - 替换字符（U+FFFD）既有一定数量、占比又高：说明解码时整片整片对不上。
 *   少量 `�` 可能是原文就有（比如 OCR 结果），不能一有就报错。
 */
export function textEncodingProblem(text: string): TextProblem | null {
  if (!text) return null;
  const head = text.length > SAMPLE ? text.slice(0, SAMPLE) : text;

  let nul = 0;
  let bad = 0;
  for (let i = 0; i < head.length; i++) {
    const code = head.charCodeAt(i);
    if (code === 0) nul++;
    else if (code === 0xfffd) bad++;
  }

  if (nul > 0) {
    return {
      code: 'encoding',
      message:
        '这个文件里有 NUL 字节，不像 UTF-8 文本（可能是 UTF-16 编码或其实是二进制文件）。' +
        '请另存为 UTF-8 后重新导入。',
    };
  }

  if (bad >= 4 && bad / head.length > 0.002) {
    return {
      code: 'encoding',
      message:
        '按 UTF-8 解码出现了大量乱码，这个文件很可能用的是 GBK 等其它编码。' +
        '请用记事本 / VS Code 另存为 UTF-8 后重新导入。',
    };
  }

  return null;
}

/** 把编码问题变成可抛出的错误。界面直接显示 message */
export function assertDecodableText(text: string): void {
  const p = textEncodingProblem(text);
  if (p) throw new ReaderError(p.code, p.message);
}

/** 去掉 UTF-8 BOM。`readPlainText` 已经剥过一次，这里再兜一层，纯函数便于断言 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
