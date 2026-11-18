/**
 * 回顾页日历的纯日期网格。
 *
 * 只回答两个问题：「这个月 1 号是周几」和「往前/往后一个月是哪个月」。
 * 不引日期库 —— 这两件事两行原生 Date 就能算，引一个 20KB 的库
 * 换来的只是把时区行为再解释一遍。
 *
 * **固定 6 行（42 格）**，不按需 4~6 行：翻月时格子高度不跳，
 * 点「上一月」不会看到下面整块内容往上蹿一截。多出来的格子属于相邻月份，
 * 照样能点 —— 点它就跳到那个月并选中，比「点了没反应」好。
 *
 * 一周从**周一**开始：中文日历的通行排法，也让「周一~周五」连成一块。
 */

export interface CalendarCell {
  /** YYYY-MM-DD，和 `util/date.dayKey` 同一个格式，可以直接拿去比 */
  key: string;
  year: number;
  /** 1–12（不是 Date 的 0–11） */
  month: number;
  day: number;
  /** 是否属于当前正在看的这个月。false = 前后补齐的那几天 */
  inMonth: boolean;
}

/**
 * 「这一天有几条碎片」。
 *
 * 日历的格子上只画点，画点只需要个数 —— 42 个格子各筛一遍全部碎片是纯浪费。
 * v0.26 起这个数由 SQL 一条 `GROUP BY` 给出，`count` 的含义与
 * 「在碎片数组里数一遍」完全一致（同一个本地时区口径）。
 */
export interface DayCount {
  /** YYYY-MM-DD，和 `dayKey` 同一个格式 */
  day: string;
  count: number;
  /** 这天的正文一共多少字（v0.27）。日历用它调点阵深浅、顶部用它显示「今天写了多少」 */
  chars: number;
}

export interface MonthRef {
  year: number;
  /** 1–12 */
  month: number;
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** 本地时区的 YYYY-MM-DD。不经过 toISOString —— 那个是 UTC，会把夜里记的东西挪到前一天 */
export function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function monthCells(year: number, month: number): CalendarCell[] {
  const first = new Date(year, month - 1, 1);
  // getDay 是 0=周日；换成「周一为 0」的列号
  const lead = (first.getDay() + 6) % 7;
  const out: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month - 1, 1 - lead + i);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const dd = d.getDate();
    out.push({ key: dateKey(y, m, dd), year: y, month: m, day: dd, inMonth: y === year && m === month });
  }
  return out;
}

/** 翻月。跨年交给 Date 自己算，别手写 12→1 的分支 */
export function shiftMonth({ year, month }: MonthRef, delta: number): MonthRef {
  const d = new Date(year, month - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

/** 某月第一天 00:00 的时间戳，用来判断「今天是不是在这个月」 */
export function monthStartOf({ year, month }: MonthRef): number {
  return new Date(year, month - 1, 1).getTime();
}

/**
 * `YYYY-MM-DD` → 当天 00:00 的本地时间戳。
 *
 * 不要用 `new Date('2026-11-15')`：那个按 UTC 解析，在东八区会退到前一天 08:00 之前的
 * 时间轴上，日期标签就会差一天。这里逐段取数字再交给本地构造。
 */
export function keyToTs(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}

/** `2026 年 11 月`。日历头那一行，不写 `2026-11` */
export function monthTitle({ year, month }: MonthRef): string {
  return `${year} 年 ${month} 月`;
}

/** 周一到周日的单字表头。和 `monthCells` 的列序必须一致 */
export const WEEKDAY_HEADS = ['一', '二', '三', '四', '五', '六', '日'] as const;
