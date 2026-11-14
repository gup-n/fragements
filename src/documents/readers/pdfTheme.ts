/**
 * 调色板 → WebView 主题。保持纯转换，不在这里导入 RN 运行时。
 * PDF 的原稿始终画在白纸上；搜索/选区必须用纸面专用深色半透明墨，
 * 不能套用深色界面的白色 accent，也不能用实心底色盖住 canvas 的字。
 */
import type { Palette, ThemeMetrics } from '../../theme';
import type { PdfTheme } from './pdfProtocol';
import { withAlpha } from './color';

/** 原件例外：PDF.js 未指定纸色的页面仍按白纸呈现，不随界面反相。 */
const PDF_PAPER = '#FFFFFF';

export function pdfThemeOf(c: Palette, metrics?: ThemeMetrics, reduceMotion = false): PdfTheme {
  const paperInk = c.mediaBackground;
  return {
    page: c.page,
    text: c.text,
    text2: c.text2,
    text3: c.text3,
    hair: c.hair,
    accent: c.accent,
    accentText: c.accentText,
    paper: PDF_PAPER,
    surface: c.hairSoft,
    // 同一灰墨在浅/深界面的白纸上都看得见；保留字形的绝大部分对比度。
    hitBg: withAlpha(paperInk, 0.12),
    hitCurrent: withAlpha(paperInk, 0.18),
    hitOutline: paperInk,
    selection: withAlpha(paperInk, 0.24),
    strokeWidth: metrics?.strokeWidth ?? 1,
    radius: metrics?.cardRadius ?? 14,
    reduceMotion,
    danger: c.danger,
  };
}
