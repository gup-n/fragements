/** 纯文本小工具。判重、预览、截断都走这里，避免每个文件各写一份。 */

/** 归一化：去掉标点空白、统一小写。判重只看字面，不做语义 */
export function normText(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s，。、,.!！?？~～;；:：'"“”‘’()（）[\]【】\-—_/+]+/g, '');
}

/**
 * 把切点从代理对中间挪开。
 *
 * 中文 / emoji 在 JS 里按 UTF-16 存，一个 emoji 占两个 code unit。
 * 硬切在中间时两个 half 会各变成一个 `�`：界面看着像乱码，原字符也拼不回来，
 * 而这类字符串会被 `JSON.stringify` 后发给模型、或被写进引用快照长期留在库里。
 * 所有「按字数截断」的地方都先过这一道。
 */
export function safeCutIndex(s: string, at: number): number {
  if (at <= 0 || at >= s.length) return at;
  const high = s.charCodeAt(at - 1);
  // 高代理后面紧跟低代理 = 正好切在一对中间，往前让一格
  return high >= 0xd800 && high <= 0xdbff ? at - 1 : at;
}

/** 取前 max 个字符，但不切在代理对中间。截断给模型 / 存快照时用这一个 */
export function cutPrefix(text: string, max: number): string {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  return t.slice(0, safeCutIndex(t, Math.max(0, max)));
}

/**
 * 文档名的长度上限。
 *
 * 列表里一行放得下的量。新建、改名、AI 提案三条路都入库到这里 ——
 * 三处各写一个上限时，同一份文档名能有多长取决于它是怎么来的，
 * 提案那条路会产出 80 字的名字，把列表一行撑成三行。
 */
export const DOC_TITLE_MAX = 60;

/**
 * 标题单行化并截断。省略号**算在上限内**：截完总长正好 `max`。
 * 换行一律压成空格 —— 标题里带换行会把列表撑高。
 */
export function clampTitle(raw: string, max: number = DOC_TITLE_MAX): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, safeCutIndex(text, Math.max(0, max - 1)))}…`;
}

/**
 * 字数口径：按 Unicode 码点算，emoji 与生僻字算 1 个。
 *
 * 和 SQLite 的 `LENGTH()` 对 TEXT 的语义一致 —— 碎片用 SQL 数、文档用 JS 数，
 * 两边必须是同一套，否则同一条记录在日历、列表、回收站里显示三个数。
 */
export function countChars(value: string): number {
  return Array.from(String(value ?? '')).length;
}

/** 单行预览：换行压成空格，超长截断 */
export function shortPreview(text: string, max = 70): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, safeCutIndex(flat, max - 1))}…` : flat;
}

/** 截断并加省略号。max 是含省略号的总长度 */
export function clip(text: string, max: number): string {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  return `${t.slice(0, safeCutIndex(t, Math.max(0, max - 1)))}…`;
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
