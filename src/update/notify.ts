/**
 * 下载进度的通知栏提示。
 *
 * ## 先说清限制
 *
 * Android 上 Expo **没有前台服务**。下载跑在 `expo-file-system` 的 OkHttp 里：
 * 只要进程不被系统杀掉，切到后台后传输会继续；但 JS 线程在后台被挂起，
 * `onProgress` 不再回调 —— 通知也就停在切走那一刻的数字。
 *
 * 所以这里的通知只承诺两件事：
 *
 * 1. 下载开始时让通知栏出现「正在下载」，用户知道它真的开始了，不是卡住
 * 2. 回到应用后数字立刻恢复更新；下载完成换成「下载完成，回来安装」
 *
 * 想要真正实时的后台进度，只能写原生前台服务（ForegroundService +
 * 自己调 NotificationManager 更新），代价是引入并长期维护原生模块。
 * 这一版不做 —— 通知栏的价值是「状态可见」，不是「数字实时」。
 *
 * ## 为什么所有失败都吞掉
 *
 * 通知发不出去（没授权、渠道被禁、系统把通知关了）不该影响下载。
 * 用户要的是「下载能完成」，通知只是附加信息。
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { versionLabel } from '../util/semver';

/** 同一时间只有一个下载，用固定 id 更新而不是叠一堆通知 */
const NOTIFY_ID = 'fragments-update-download';
const CHANNEL_ID = 'update-download';

let ready = false;
let allowed = false;

/** 只在 Android 上工作；web 端没有任何通知能力 */
const enabled = Platform.OS === 'android';

/**
 * 初始化：注册前台展示策略 + 建低打扰渠道 + 请求一次权限。
 *
 * 幂等 —— 下载面板可能被反复打开，这里只会真正执行一次。
 */
export async function initNotify(): Promise<boolean> {
  if (!enabled) return false;
  if (ready) return allowed;
  ready = true;

  try {
    // 不设这个 handler，前台收到的通知默认不会出现在通知栏
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });

    // LOW：不出声、不弹横幅，只安静地挂在通知栏
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: '应用更新',
      importance: Notifications.AndroidImportance.LOW,
      showBadge: false,
      enableVibrate: false,
      sound: null,
    });

    // Android 13+ 要运行时授权。没给就静默降级成「没有通知」，
    // 下载本身照常进行
    const cur = await Notifications.getPermissionsAsync();
    if (cur.status === 'granted') {
      allowed = true;
    } else {
      const req = await Notifications.requestPermissionsAsync();
      allowed = req.status === 'granted';
    }
  } catch {
    allowed = false;
  }

  return allowed;
}

/** 进度通知。调用方负责节流（一秒一次足够，太频繁会闪） */
export async function notifyProgress(
  version: string,
  sub: string,
  percent: number | null,
): Promise<void> {
  if (!enabled || !allowed) return;
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFY_ID,
      content: {
        title: `正在下载 ${versionLabel(version)}`,
        body:
          percent === null
            ? `${sub} · 离开应用会继续下载，但进度要回来才更新`
            : `${sub} · ${percent}% · 离开应用会继续下载，但进度要回来才更新`,
        // sticky：常驻通知栏，划不掉。下载这种「有明确终点」的任务值得占这个位置
        sticky: true,
        autoDismiss: false,
        data: { kind: 'update-download' },
        ...(Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {}),
      },
      trigger: null,
    });
  } catch {
    /* 发不出通知不影响下载 */
  }
}

/** 下载完成：换成可点击的「回来安装」，并去掉 sticky */
export async function notifyReady(version: string): Promise<void> {
  if (!enabled || !allowed) return;
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFY_ID,
      content: {
        title: `${versionLabel(version)} 已下载`,
        body: '回到「碎片」点「立即安装」完成更新',
        sticky: false,
        autoDismiss: true,
        data: { kind: 'update-ready' },
        ...(Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {}),
      },
      trigger: null,
    });
  } catch {
    /* 同上 */
  }
}

/** 取消 / 失败 / 装完后清掉通知 */
export async function clearNotify(): Promise<void> {
  if (!enabled) return;
  try {
    await Notifications.dismissNotificationAsync(NOTIFY_ID);
  } catch {
    /* 已经没了也算清掉 */
  }
}
