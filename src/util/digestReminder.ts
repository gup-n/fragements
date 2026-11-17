/**
 * 「有月份的小结还没写」什么时候该提醒一次。
 *
 * 判据本身在 `util/digest.missingDigests` 里早就有了，缺的是「什么时候推给用户」。
 * 这个文件只做决定，不发通知、不读库 —— 那样才好在断言里把每种情况都跑一遍。
 *
 * ## 为什么不是「月底那天提醒」
 *
 * 月底提醒看着最自然，实际很容易空转：用户在 29 号已经写完，30 号那条提醒
 * 就是纯噪音；反过来，如果他整月没打开过 App，那条提醒也排不进去。
 * 所以改成**看欠账**：只要还有没写小结的月份，就在最近的一个晚上 8 点提醒一次。
 * 有账才提醒，没账自然不提醒。
 *
 * ## 为什么要有 3 天冷却
 *
 * 提醒过一次、用户没管，隔天打开 App 又排一条，就是「天天催」。
 * 3 天是一个不催命、又不至于忘掉的长度。冷却只按「上次排定的时刻」算，
 * 不另存一张表 —— 少一个状态就少一处不一致。
 */
import type { Backlog } from './digest';
import { periodLabel } from './date';

/** 两次提醒之间至少隔 3 天 */
export const REMIND_GAP_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * 提醒时刻：晚上 8 点。
 *
 * 白天在上班，推送会被顺手划掉；太晚（22 点后）又会变成睡前打扰。
 */
export const REMIND_HOUR = 20;

export type ReminderPlan =
  /** 什么都不用做：已经排好了，或者刚刚才排过 */
  | { action: 'keep' }
  /** 把已排的撤掉（开关关了，或者账已经清了） */
  | { action: 'cancel' }
  | { action: 'schedule'; at: number; period: string; fragments: number; months: number };

/** `now` 之后最近的那个晚上 8 点（本地时区） */
export function nextRemindAt(now: number): number {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), REMIND_HOUR, 0, 0, 0).getTime();
  return today > now ? today : today + 24 * 60 * 60 * 1000;
}

/**
 * 该不该排、排在哪一刻。
 *
 * `storedAt` 是**上一次排定的触发时刻**（不是「上次提醒的时间」）。用它同时判两件事：
 * 还在未来 → 已经排好了，不要重复排；在过去但不到 3 天 → 刚提醒过，先别催。
 */
export function planDigestReminder(input: {
  enabled: boolean;
  backlog: Backlog;
  storedAt: number;
  now: number;
}): ReminderPlan {
  const { enabled, backlog, storedAt, now } = input;

  // 关掉开关、或者账已经清了：撤掉排着的那条。没排过就什么都不用做
  if (!enabled || backlog.total === 0) {
    return storedAt > 0 ? { action: 'cancel' } : { action: 'keep' };
  }

  // 已经排在未来了 —— 时刻不动，内容由调用方按最新数据重写
  if (storedAt > now) return { action: 'keep' };
  if (storedAt > 0 && now - storedAt < REMIND_GAP_MS) return { action: 'keep' };

  const latest = backlog.items[0];
  if (!latest) return { action: 'keep' };

  return {
    action: 'schedule',
    at: nextRemindAt(now),
    period: latest.period,
    fragments: latest.count,
    months: backlog.total,
  };
}

/**
 * 通知正文。
 *
 * 说**最近欠的那个月**，因为它是用户最可能想起来的那一段；再补一句总共欠几个月，
 * 免得他以为只有一个月。只有一个月时不补那半句 —— 「一共 1 个月欠着」是废话。
 */
export function reminderBody(input: { period: string; fragments: number; months: number }): string {
  const head = `${periodLabel(input.period)}有 ${input.fragments} 条碎片，还没写小结`;
  return input.months > 1 ? `${head}；一共 ${input.months} 个月欠着` : head;
}
