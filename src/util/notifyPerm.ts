/**
 * 通知权限：两个入口（常驻「记一条」、小结提醒）问的是同一件事。
 *
 * 之前这段判断只写在 `quickRecord` 里。再加一个通知入口时如果照着抄一份，
 * 「权限被拒之后怎么解释」就会有两套文案，两边迟早对不上。
 */
import * as Notifications from 'expo-notifications';

export type NotifyPerm = { ok: true } | { ok: false; reason: string };

/**
 * 有权限就返回 ok；没有就**当场问一次**，被拒才返回原因。
 *
 * Android 13+ 弹过一次就不再弹，之后只能去系统设置里开 —— 所以返回的这句话
 * 必须写清去哪儿开，界面照原样显示，不假装成功。
 */
export async function ensureNotifyPermission(): Promise<NotifyPerm> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.status === 'granted') return { ok: true };
    const asked = await Notifications.requestPermissionsAsync();
    if (asked.status === 'granted') return { ok: true };
    return { ok: false, reason: '没有通知权限。到系统设置 → 应用 → 碎片 → 通知里打开' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : '问不到通知权限' };
  }
}
