/**
 * 月度小结的提醒（v0.25）。
 *
 * 「欠了几个月小结」这件事 `ReviewScreen` 页头已经写着了，但那要用户自己切到回顾页
 * 才看得见。这个模块把它做成一条**定时本地通知**：有欠账就在晚上 8 点响一次。
 *
 * ## 为什么不每次启动都重排
 *
 * 重排会把触发时刻往后推 —— 天天打开 App 的人就永远收不到。所以触发时刻一旦排定、
 * 且还在未来，就只更新内容不动时刻（见 `util/digestReminder.planDigestReminder`）。
 *
 * ## 为什么内容要重写
 *
 * 欠账的月份和条数会变（新记的碎片、刚写完的小结）。用固定 id 重排一次
 * 等于「换掉那条通知的内容」—— 系统只留一条，不会叠出好几条一样的提醒。
 *
 * ## 冷启动那一次
 *
 * 和 `quickRecord` 同一个坑：从通知点进来时 React 还没挂监听，
 * 必须补 `getLastNotificationResponseAsync` 捞一次。两个监听各认各的 `kind`，
 * 互不干扰（谁都不清别人的响应）。
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { repo } from './db/repo';
import { missingDigests } from './util/digest';
import { planDigestReminder, reminderBody } from './util/digestReminder';
import { ensureNotifyPermission } from './util/notifyPerm';
import type { Fragment, Note } from './types';

/** 固定 id：同时只有一条，重排就是换内容 */
export const DIGEST_ID = 'fragments-digest-reminder';
const CHANNEL_ID = 'digest-reminder';
const SETTING_KEY = 'digest_reminder';
/** 上一次排定的触发时刻（毫秒）。0 = 没排过 */
const AT_KEY = 'digest_reminder_at';

const enabled = Platform.OS === 'android';

export type ReminderResult = { ok: true } | { ok: false; reason: string };

/** 设置里那个开关的当前值。默认关 —— 提醒该是用户主动开的 */
export async function isDigestReminderEnabled(): Promise<boolean> {
  try {
    return (await repo.getSetting(SETTING_KEY)) === '1';
  } catch {
    return false;
  }
}

/**
 * 建通道。
 *
 * 用 DEFAULT 而不是快捷入口那个 MIN：MIN 不出声也不弹横幅，用户根本不会注意到；
 * 而「小结没写」这件事本身就是要被看见一次，才谈得上「提醒」。
 */
async function ensureChannel(): Promise<void> {
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: '小结提醒',
    importance: Notifications.AndroidImportance.DEFAULT,
    showBadge: true,
  });
}

/** 撤掉已排的那条并清掉记录的时刻。没排过也照常执行，不会报错 */
async function cancelReminder(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(DIGEST_ID);
  } catch {
    /* 系统里没有这条时不同版本行为不一致，都不影响「下次不再提醒」 */
  }
  try {
    await repo.setSetting(AT_KEY, '0');
  } catch {
    /* 记不上最多多提醒一次，比开关失灵轻 */
  }
}

/**
 * 打开/关闭提醒。
 *
 * 打开时**先要权限再落库**：反过来会出现「开关显示开着、其实永远发不出来」——
 * 那种状态用户是查不出来的，只能靠这里挡住。
 */
export async function setDigestReminderEnabled(on: boolean): Promise<ReminderResult> {
  if (!enabled) return { ok: false, reason: '只有安卓有通知栏提醒' };
  if (on) {
    try {
      await ensureChannel();
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : '建不了通知通道' };
    }
    const perm = await ensureNotifyPermission();
    if (!perm.ok) return perm;
  }
  try {
    await repo.setSetting(SETTING_KEY, on ? '1' : '0');
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : '保存失败' };
  }
  if (!on) await cancelReminder();
  return { ok: true };
}

/**
 * 按当前数据对齐那条通知。
 *
 * 三个调用时机：启动读完数据、每次数据变化（记了新的、写了小结）、开关切换。
 * 全程静默 —— 排不上一条提醒，不该让启动流程或一次保存失败。
 */
export async function syncDigestReminder(
  fragments: Fragment[],
  notes: Note[],
  now = Date.now(),
): Promise<void> {
  if (!enabled) return;

  let on = false;
  let storedAt = 0;
  try {
    on = (await repo.getSetting(SETTING_KEY)) === '1';
    storedAt = Number(await repo.getSetting(AT_KEY)) || 0;
  } catch {
    return;
  }
  // 开关关着、也从没排过：连算都不用算（省掉一次全量扫描）
  if (!on && storedAt === 0) return;

  const plan = planDigestReminder({
    enabled: on,
    backlog: missingDigests(fragments, notes, 1, now),
    storedAt,
    now,
  });
  if (plan.action === 'keep') return;

  try {
    if (plan.action === 'cancel') {
      await cancelReminder();
      return;
    }

    await ensureChannel();
    // 权限可能被用户在系统里关掉了：这时不排，也不记时刻，下次进来还会再试
    if (!(await ensureNotifyPermission()).ok) return;

    await Notifications.scheduleNotificationAsync({
      identifier: DIGEST_ID,
      content: {
        title: '这个月的小结还没写',
        body: reminderBody(plan),
        data: { kind: 'digest-reminder' },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: plan.at,
        channelId: CHANNEL_ID,
      },
    });
    await repo.setSetting(AT_KEY, String(plan.at));
  } catch {
    /* 排不上就等下一次数据变化；不因为一条提醒把保存流程弄出错误 */
  }
}

/** 点通知进来要去的页面。返回取消函数 */
export function watchDigestReminder(onTap: () => void): () => void {
  if (!enabled) return () => {};

  const kindOf = (res: Notifications.NotificationResponse | null) =>
    (res?.notification.request.content.data as { kind?: string } | null)?.kind;

  const sub = Notifications.addNotificationResponseReceivedListener((res) => {
    if (kindOf(res) === 'digest-reminder') onTap();
  });

  void Notifications.getLastNotificationResponseAsync()
    .then((res) => {
      if (kindOf(res) !== 'digest-reminder') return;
      onTap();
      return Notifications.clearLastNotificationResponseAsync();
    })
    .catch(() => {
      /* 拿不到就只靠 listener */
    });

  return () => sub.remove();
}
