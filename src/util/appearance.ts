/** Pure appearance contract: safe to validate in Node without loading React Native. */
export type ThemeMode = 'light' | 'dark' | 'system';
export type ThemeStyle = 'default' | 'ink';

export interface Palette {
  page: string;
  card: string;
  text: string;
  text2: string;
  text3: string;
  hair: string;
  hairSoft: string;
  accent: string;
  accentBg: string;
  accentText: string;
  purpleBg: string;
  purpleText: string;
  tealBg: string;
  tealText: string;
  amberBg: string;
  amberText: string;
  coralBg: string;
  coralText: string;
  danger: string;
  dangerBg: string;
  accentHair: string;
  scrim: string;
  shell: string;
  shellBorder: string;
  onAccent: string;
  onDanger: string;
  mediaBackground: string;
  mediaForeground: string;
  mediaScrim: string;
  controlThumb: string;
  selection: string;
  focus: string;
}

export interface ThemeMetrics {
  cardRadius: number;
  buttonRadius: number;
  strokeWidth: number;
  controlHeight: number;
  pagePadding: number;
  /**
   * 1 = 这个风格用边线表达结构（墨水：卡片、控件都要看得见边界）；
   * 0 = 靠底色和留白分层（默认：边线只在必要处出现，且只有 0.5 的极细线）。
   *
   * 单独列出来是因为它无法从别的字段推出来。以前拿 `cardRadius <= 4` 反推，
   * 圆角一改就静默失效。
   */
  outline: number;
}

/**
 * 默认浅色：DeepSeek 的白。
 *
 * 三处和「纸感」不同的地方，都是刻意的：
 *
 * 1. **纯白底**（`#FFFFFF`），不再带暖调。纸张的米黄在长列表里会显脏，
 *    而 DeepSeek 那种白让文字成为页面上唯一有重量的东西。
 * 2. **分层靠浅灰底，不靠边框**。`hairSoft` 是输入卡、胶囊、悬停态的共用底色，
 *    `hair` 只留给真正必要的分隔线，而且浅到几乎看不见。
 * 3. **单一蓝色主调**（`#3F5EE8`）。状态语义（完成 / 到期 / 危险）仍用独立颜色，
 *    但「可以点」这件事全用同一个蓝，不再有第二套强调色分散注意力。
 */
export const LIGHT: Palette = {
  page: '#FFFFFF',
  card: '#FFFFFF',
  text: '#16181D',
  text2: '#5A6070',
  // 辅助文字仍要过 4.5:1，所以比 DeepSeek 的视觉灰再深一档
  text3: '#6B7280',
  hair: '#ECEDF1',
  hairSoft: '#F4F5F7',
  accent: '#3F5EE8',
  accentBg: '#EDF1FE',
  accentText: '#3255D8',
  purpleBg: '#EFEEFC',
  purpleText: '#4A3E96',
  // 「已完成」不用绿色、也不跟主色同蓝：灰蓝，读起来是「已归档」而不是「成功」
  tealBg: '#EBEEF2',
  tealText: '#556070',
  amberBg: '#FBF1DA',
  amberText: '#6B4A0E',
  coralBg: '#FBEDE7',
  coralText: '#7A3824',
  danger: '#C0392B',
  dangerBg: '#FCECEA',
  accentHair: '#C9D3FA',
  scrim: 'rgba(0,0,0,0.40)',
  shell: '#F4F5F7',
  shellBorder: '#E5E7EB',
  onAccent: '#FFFFFF',
  onDanger: '#FFFFFF',
  mediaBackground: '#101010',
  mediaForeground: '#FFFFFF',
  mediaScrim: 'rgba(0,0,0,0.70)',
  controlThumb: '#FFFFFF',
  selection: '#DCE4FF',
  focus: '#3F5EE8',
};

export const DARK: Palette = {
  // 深色也跟着走中性灰 + 同一个蓝：不像纯黑那么硬，也不会把蓝色衬得发紫
  page: '#1A1A1A',
  card: '#242424',
  text: '#F2F3F5',
  text2: '#B6B9C0',
  text3: '#8E9298',
  hair: '#333438',
  hairSoft: '#26272A',
  accent: '#8FA6FF',
  accentBg: '#232B45',
  accentText: '#B7C6FF',
  purpleBg: '#2A2745',
  purpleText: '#CFC8FA',
  tealBg: '#262A31',
  tealText: '#B3BCC9',
  amberBg: '#3A2F1C',
  amberText: '#F4D79B',
  coralBg: '#3A2922',
  coralText: '#F1B8A1',
  danger: '#F08A80',
  dangerBg: '#3B2422',
  accentHair: '#3C4A7A',
  scrim: 'rgba(0,0,0,0.72)',
  shell: '#141414',
  shellBorder: '#333438',
  onAccent: '#0F1533',
  onDanger: '#2A1210',
  mediaBackground: '#101010',
  mediaForeground: '#FFFFFF',
  mediaScrim: 'rgba(0,0,0,0.76)',
  controlThumb: '#F2F3F5',
  selection: '#2E3A63',
  focus: '#B7C6FF',
};

/**
 * 墨水浅色：灰度，但**不靠中灰线撑结构**。
 *
 * 原来的设计是 4 圆角 + 1.25px `#767676` 中灰框，结果是整页像一张表格 ——
 * 用户 2026-11-15 的原话是「边线太清晰，清晰后显得有点难看」。
 *
 * 现在的做法是把结构交给**底色差**：页面纯白、卡片 `#F7F7F7`，
 * 边线降成 `#E4E4E4`（几乎看不见，只在交界处描出一道影子）。
 * 「墨水」要的是无色，不是高对比描边。
 */
export const INK_LIGHT: Palette = {
  page: '#FFFFFF',
  card: '#F7F7F7',
  text: '#1A1A1A',
  text2: '#494949',
  text3: '#6B6B6B',
  hair: '#E4E4E4',
  hairSoft: '#F2F2F2',
  accent: '#1A1A1A',
  accentBg: '#EFEFEF',
  accentText: '#1A1A1A',
  purpleBg: '#EFEFEF',
  purpleText: '#2A2A2A',
  tealBg: '#EFEFEF',
  tealText: '#2A2A2A',
  amberBg: '#E2E2E2',
  amberText: '#2A2A2A',
  coralBg: '#EFEFEF',
  coralText: '#2A2A2A',
  danger: '#1A1A1A',
  dangerBg: '#E8E8E8',
  accentHair: '#D6D6D6',
  scrim: 'rgba(0,0,0,0.55)',
  shell: '#F2F2F2',
  shellBorder: '#DDDDDD',
  onAccent: '#FFFFFF',
  onDanger: '#FFFFFF',
  mediaBackground: '#101010',
  mediaForeground: '#FFFFFF',
  mediaScrim: 'rgba(0,0,0,0.82)',
  controlThumb: '#FFFFFF',
  selection: '#E0E0E0',
  focus: '#1A1A1A',
};

export const INK_DARK: Palette = {
  page: '#121212',
  card: '#1B1B1B',
  text: '#F2F2F2',
  text2: '#C2C2C2',
  text3: '#9A9A9A',
  hair: '#333333',
  hairSoft: '#232323',
  accent: '#F2F2F2',
  accentBg: '#2C2C2C',
  accentText: '#F2F2F2',
  purpleBg: '#2C2C2C',
  purpleText: '#EDEDED',
  tealBg: '#2C2C2C',
  tealText: '#EDEDED',
  amberBg: '#3A3A3A',
  amberText: '#EDEDED',
  coralBg: '#2C2C2C',
  coralText: '#EDEDED',
  danger: '#F2F2F2',
  dangerBg: '#2C2C2C',
  accentHair: '#3B3B3B',
  scrim: 'rgba(0,0,0,0.82)',
  shell: '#121212',
  shellBorder: '#333333',
  onAccent: '#141414',
  onDanger: '#141414',
  mediaBackground: '#101010',
  mediaForeground: '#FFFFFF',
  mediaScrim: 'rgba(0,0,0,0.82)',
  controlThumb: '#F2F2F2',
  selection: '#3A3A3A',
  focus: '#F2F2F2',
};

export const DEFAULT_METRICS: ThemeMetrics = {
  // 20/14：DeepSeek 那套圆角的量级。方一点会显旧，再圆就成药丸了
  cardRadius: 20,
  buttonRadius: 14,
  strokeWidth: 1,
  controlHeight: 48,
  pagePadding: 16,
  outline: 0,
};
export const INK_METRICS: ThemeMetrics = {
  ...DEFAULT_METRICS,
  // 4 是「硬方角」，配合满页 1px 中灰线读起来像表单。8 仍是方意，只是不扎眼。
  cardRadius: 8,
  buttonRadius: 8,
  strokeWidth: 1,
  outline: 1,
};

export const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  light: '浅色', dark: '深色', system: '跟随系统',
};
export const THEME_STYLE_LABEL: Record<ThemeStyle, string> = {
  default: '默认', ink: '墨水',
};

export function normalizeThemeMode(raw: unknown): ThemeMode {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}
export function normalizeThemeStyle(raw: unknown): ThemeStyle {
  return raw === 'ink' ? 'ink' : 'default';
}

export function resolveAppearance(mode: ThemeMode, style: ThemeStyle, systemDark: boolean) {
  const dark = mode === 'dark' || (mode === 'system' && systemDark);
  const ink = style === 'ink';
  return {
    dark,
    c: ink ? (dark ? INK_DARK : INK_LIGHT) : (dark ? DARK : LIGHT),
    metrics: ink ? INK_METRICS : DEFAULT_METRICS,
  };
}
