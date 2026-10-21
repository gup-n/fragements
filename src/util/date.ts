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
