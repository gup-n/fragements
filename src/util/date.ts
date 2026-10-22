const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 内部补零，不对外暴露 */
function pad(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}

export function weekdayCN(d: Date) {
  return WEEK[d.getDay()];
}

export function formatTime(ts: number) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** YYYY-MM-DD，按本地时区 */
export function dayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 内部用：把时间戳归到当天零点，仅供 dayLabel 算天数差 */
function startOfDay(ts: number) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function todayISO() {
  return dayKey(Date.now());
}

/** 分组标题：今天 / 昨天 / 前天 / 10月18日 周六 */
export function dayLabel(ts: number) {
  const diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  return daySubLabel(ts);
}

export function daySubLabel(ts: number) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${weekdayCN(d)}`;
}

// ── 周期（日 / 周 / 月）───────────────────────────────────────────────
// 周期总结存的是 period 字符串，时间轴要按它把总结插回正确的日期，
// 所以这里既要有「时间戳 → period」，也要有「period → 锚点时间戳」。

/** 该周周一 00:00（ISO 以周一为一周起点） */
export function weekStart(ts: number) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** 该月 1 日 00:00 */
export function monthStart(ts: number) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

/** ISO 周号：2026-W43 */
export function weekKey(ts: number) {
  const d = new Date(weekStart(ts));
  // 用该周的周四定年份 —— 跨年的那一周要靠它归属正确的年份
  d.setDate(d.getDate() + 3);
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${d.getFullYear()}-W${pad(week)}`;
}

/** 2026-10 */
export function monthKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/**
 * period → 时间轴上的锚点（当天/当周/当月最后一刻）。
 * 总结条目按这个时间落位，就会排在该周期的末尾而不是生成的那天。
 */
export function periodAnchor(period: string | null): number | null {
  if (!period) return null;

  const day = period.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) {
    const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59, 0, 0);
    return d.getTime();
  }

  const week = period.match(/^(\d{4})-W(\d{2})$/);
  if (week) {
    const firstThursday = new Date(Number(week[1]), 0, 4);
    firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3);
    // 第 1 周的周四是 Jan 4 所在周的周四，往前推出该周周一，再走到第 N 周
    const monday = new Date(firstThursday.getTime() - 3 * 86400000 + (Number(week[2]) - 1) * 7 * 86400000);
    monday.setHours(23, 59, 0, 0);
    monday.setDate(monday.getDate() + 6); // 周日
    return monday.getTime();
  }

  const month = period.match(/^(\d{4})-(\d{2})$/);
  if (month) {
    // 下个月 0 号 = 本月最后一天
    const d = new Date(Number(month[1]), Number(month[2]), 0, 23, 59, 0, 0);
    return d.getTime();
  }

  return null;
}

/**
 * period → `[from, to)` 毫秒区间，周期总结取数据用。
 * 周按 ISO 规则（周一起点、周四定年份），和 weekKey 必须一致，
 * 否则「本周总结」会拿到上一周的碎片。
 */
export function periodRange(period: string): { from: number; to: number } | null {
  const day = period.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) {
    const from = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
    const to = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + 1).getTime();
    return { from, to };
  }

  const week = period.match(/^(\d{4})-W(\d{2})$/);
  if (week) {
    const firstThursday = new Date(Number(week[1]), 0, 4);
    firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3);
    firstThursday.setHours(0, 0, 0, 0);
    const week1Monday = new Date(firstThursday.getTime() - 3 * 86400000);
    const from = new Date(week1Monday.getTime() + (Number(week[2]) - 1) * 7 * 86400000).getTime();
    return { from, to: from + 7 * 86400000 };
  }

  const month = period.match(/^(\d{4})-(\d{2})$/);
  if (month) {
    const from = new Date(Number(month[1]), Number(month[2]) - 1, 1).getTime();
    const to = new Date(Number(month[1]), Number(month[2]), 1).getTime();
    return { from, to };
  }

  return null;
}

/** 最近 count 个周期键，从当前这个往前推，用于生成入口的选项列表 */
export function recentPeriods(kind: 'daily' | 'weekly' | 'monthly', count: number, now = Date.now()) {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    if (kind === 'daily') {
      out.push(dayKey(now - i * 86400000));
    } else if (kind === 'weekly') {
      out.push(weekKey(now - i * 7 * 86400000));
    } else {
      const d = new Date(now);
      out.push(monthKey(new Date(d.getFullYear(), d.getMonth() - i, 1).getTime()));
    }
  }
  return out;
}

/** period 的中文标签，用于小结卡片与时间轴 */
export function periodLabel(period: string | null): string {
  if (!period) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    const [y, m, d] = period.split('-').map(Number);
    return `${m}月${d}日 ${weekdayCN(new Date(y, m - 1, d))}`;
  }
  if (/^\d{4}-W\d{2}$/.test(period)) {
    const anchor = periodAnchor(period);
    if (anchor === null) return period;
    const end = new Date(anchor);
    const start = new Date(anchor - 6 * 86400000);
    const week = period.slice(-2);
    return `第 ${Number(week)} 周 · ${start.getMonth() + 1}/${start.getDate()}–${end.getMonth() + 1}/${end.getDate()}`;
  }
  if (/^\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.split('-');
    return `${y} 年 ${Number(m)} 月`;
  }
  return period;
}

