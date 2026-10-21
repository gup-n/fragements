import { Platform } from 'react-native';

const KEY = 'deepseek_api_key';

function web(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** API Key 在 Android 上走 Keystore 加密存储，浏览器预览退化为 localStorage。 */
export async function getApiKey(): Promise<string> {
  if (Platform.OS === 'web') return web()?.getItem(KEY) ?? '';
  try {
    const mod = require('expo-secure-store');
    const v = await mod.getItemAsync(KEY);
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

export async function setApiKey(value: string): Promise<void> {
  if (Platform.OS === 'web') {
    web()?.setItem(KEY, value);
    return;
  }
  try {
    const mod = require('expo-secure-store');
    if (value) await mod.setItemAsync(KEY, value);
    else await mod.deleteItemAsync(KEY);
  } catch {
    // 安全存储不可用时静默失败，设置页会提示未配置
  }
}
