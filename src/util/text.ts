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

/** 两个短文本是否一个被另一个完整包含（用于标签近义提示） */
export function containsText(a: string, b: string): boolean {
  const x = normText(a);
  const y = normText(b);
  if (!x || !y) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 2 && long.includes(short);
}
