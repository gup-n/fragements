/**
 * 通知栏的常驻「记一条」入口。
 *
 * ## 先说清做不到的部分
 *
 * Expo 托管工作流下**做不到通知栏内直接输入**（那要原生 `RemoteInput`）。
 * 所以这个入口只做一件事：一条划不掉的常驻通知，点一下回到 App 并把光标
 * 放进输入框。省掉的是「解锁 → 找图标 → 点开 → 点输入框」这四步。
 *
 * ## 两个容易做错的地方
 *
 * 1. **冷启动收不到点击**。从通知点进来时 React 还没挂监听，只挂
 *    `addNotificationResponseReceivedListener` 会漏掉那一次 —— 用户点了却没进
 *    输入框，入口就是坏的。所以必须补 `getLastNotificationResponseAsync`。
 * 2. **权限被拒要能说清**。Android 13+ 弹过一次就不再弹，之后只能去系统设置里开。
 *    这里返回原因，界面照原样显示，不假装成功。
 *
 * ## 为什么用 MIN 优先级
 *
 * 常驻通知最烦人的地方是它一直躺在通知栏。MIN 不发声、不弹横幅、不亮屏，
 * 只在通知栏里静静待着；觉得碍事可以在设置里关掉。
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { repo } from './db/repo';
import { ensureNotifyPermission, hasNotifyPermission } from './util/notifyPerm';

/** 固定 id：同一时间只有一条，重复调用不会叠出一排 */
export const QUICK_ID = 'fragments-quick-record';
const CHANNEL_ID = 'quick-record';
const SETTING_KEY = 'quick_record';

const enabled = Platform.OS === 'android';

export type QuickResult = { ok: true } | { ok: false; reason: string };

/** 设置里那个开关的当前值。默认关 —— 常驻通知该是用户主动开的 */
export async function isQuickRecordEnabled(): Promise<boolean> {
  try {
    return (await repo.getSetting(SETTING_KEY)) === '1';
  } catch {
    return false;
  }
}

/**
 * 开关开着、但系统里已经把通知关掉了。
 *
 * 常驻通知和提醒一样，用户去系统设置里关一次权限，App 里那个开关还显示「开启」——
 * 那种状态只能靠设置页说出来，否则用户只会觉得「这个入口坏了」。
 */
export async function isQuickRecordBlocked(): Promise<boolean> {
  if (!enabled) return false;
  try {
    if ((await repo.getSetting(SETTING_KEY)) !== '1') return false;
  } catch {
    return false;
  }
  return (await hasNotifyPermission()) === false;
}

export async function setQuickRecordEnabled(on: boolean): Promise<QuickResult> {
  try {
    await repo.setSetting(SETTING_KEY, on ? '1' : '0');
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : '保存失败' };
  }
  return on ? showQuickRecord() : (await hideQuickRecord(), { ok: true });
}

/** 把常驻通知放上去。重复调用不会叠；已经有一条时按 identifier 覆盖 */
export async function showQuickRecord(): Promise<QuickResult> {
  if (!enabled) return { ok: false, reason: '只有安卓有通知栏入口' };
  try {
    // LOW/MIN 都不出声。MIN 还会连状态栏图标都省掉，最适合常驻
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: '快捷记录',
      importance: Notifications.AndroidImportance.MIN,
      showBadge: false,
      enableVibrate: false,
      sound: null,
    });

    // 权限判断和文案只有一份（util/notifyPerm），别在这里再抄一遍
    const perm = await ensureNotifyPermission();
    if (!perm.ok) return perm;

    await Notifications.scheduleNotificationAsync({
      identifier: QUICK_ID,
      content: {
        title: '记一条',
        body: '点一下回到碎片，光标已经在输入框里',
        // sticky：常驻，划不掉。它是个入口，不是一条会被读完的消息
        sticky: true,
        autoDismiss: false,
        data: { kind: 'quick-record' },
        ...(Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {}),
      },
      trigger: null,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : '发不出通知' };
  }
}

export async function hideQuickRecord(): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(QUICK_ID);
  } catch {
    /* 撤不掉不影响别的（比如系统已经把通知清了） */
  }
}

/**
 * 点击监听。返回取消函数。
 *
 * 冷启动那一次点进来必须单独捞：`getLastNotificationResponseAsync` 拿到之后
 * 立刻清掉，否则每次冷启动都会再「聚焦」一次。
 */
export function watchQuickRecord(onTap: () => void): () => void {
  if (!enabled) return () => {};

  const sub = Notifications.addNotificationResponseReceivedListener((res) => {
    const kind = (res.notification.request.content.data as { kind?: string } | null)?.kind;
    if (kind === 'quick-record') onTap();
  });

  void Notifications.getLastNotificationResponseAsync()
    .then((res) => {
      const kind = (res?.notification.request.content.data as { kind?: string } | null)?.kind;
      if (kind !== 'quick-record') return;
      onTap();
      return Notifications.clearLastNotificationResponseAsync();
    })
    .catch(() => {
      /* 拿不到就只靠 listener，不比整个入口崩掉差 */
    });

  return () => sub.remove();
}
