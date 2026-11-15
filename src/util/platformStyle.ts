import { Platform } from 'react-native';

/**
 * Web 上 `<TextInput>` 默认有一圈系统蓝色的 focus outline，和这套调色板完全不搭。
 *
 * RN 的类型里 `outlineStyle` 只允许 `solid | dotted | dashed`（没有 `none`），
 * 所以这里必须显式退出类型检查 —— **只在这一处 `any`**，好过在五个样式表里
 * 各写一遍 `Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}`：
 * 那种写法要加一个属性（比如 `outlineWidth: 0`）就得记得改五遍。
 *
 * 原生平台上的空对象就是「什么都不做」，所以调用方统一写 `...WEB_INPUT_RESET`。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WEB_INPUT_RESET: any = Platform.OS === 'web' ? { outlineStyle: 'none' } : {};
