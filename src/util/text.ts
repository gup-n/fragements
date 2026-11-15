/** 纯文本小工具。判重、预览、截断都走这里，避免每个文件各写一份。 */

/** 归一化：去掉标点空白、统一小写。判重只看字面，不做语义 */
export function normText(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s，。、,.!！?？~～;；:：'"“”‘’()（）[\]【】\-—_/+]+/g, '');
}

/** 单行预览：换行压成空格，超长截断 */
export function shortPreview(text: string, max = 70): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 截断并加省略号。max 是含省略号的总长度 */
export function clip(text: string, max: number): string {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 显示宽度：中日韩与全角标点算 2，其余算 1。
 *
 * 表格列宽和 Markdown 表格对齐都要它。**这一份是唯一的** ——
 * 原来 `util/mdBlocks` 和 `documents/readers/SheetReader` 各写一份，
 * 两份的码点区间不同：表格里 emoji 算 2、表格阅读器里算 1，
 * 于是同一份内容在两处的列宽不一致。现在按并集取。
 */
export function visualLen(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0x303e) ||
      (c >= 0x3041 && c <= 0x33ff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xa000 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff);
    n += wide ? 2 : 1;
  }
  return n;
}

/** 两个短文本是否一个被另一个完整包含（用于标签近义提示） */
export function containsText(a: string, b: string): boolean {
  const x = normText(a);
  const y = normText(b);
  if (!x || !y) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 2 && long.includes(short);
}
