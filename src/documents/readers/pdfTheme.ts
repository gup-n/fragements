/**
 * 调色板 → WebView 主题。
 *
 * 单独一个文件是为了让 `color.ts` 保持「不依赖 react-native」——
 * 那个文件要能被 node 直接跑断言，一 import `theme.tsx` 就连带把 React Native
 * 拖进编译单元，断言脚本就得配 jsx / rn 类型，纯函数层也就不纯了。
 */
import type { Palette } from '../../theme';
import type { PdfTheme } from './pdfProtocol';
import { withAlpha } from './color';

export function pdfThemeOf(c: Palette): PdfTheme {
  return {
    page: c.page,
    text: c.text,
    text2: c.text2,
    text3: c.text3,
    hair: c.hair,
    accent: c.accent,
    accentText: c.accentText,
    // 半透明：PDF 页面是白底画布，实色高亮会把字整块盖住
    hitBg: withAlpha(c.amberText, 0.22),
    hitCurrent: withAlpha(c.amberText, 0.55),
    danger: c.danger,
  };
}
