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
 * 默认浅色：三层灰阶，不靠边框分层。
 *
 * **这里曾经有个真问题：`page` 和 `card` 都是 `#FFFFFF`。**
 * 所有「白底卡片」（设置子页的分组、文档卡、待办分组、整理产出卡）
 * 都白叠白，只剩一圈 0.5px 的 `hair` —— 在手机屏上等于不存在。
 * 页面看上去就是一堆没有边界的文字。
 *
 * 现在改成三层，**每两层的对比度都在 1.1:1 以上**（这是「能不能看出边界」的下限，
 * iOS 的 grouped list 也在 1.08~1.14 这个量级）：
 *
 * | 层 | 值 | 对 page 的对比 | 用在哪 |
 * |---|---|---|---|
 * | `card` | `#FFFFFF` | 1.09 | 卡片、弹层、底栏这类「浮起来」的块 |
 * | `page` | `#F4F5F9` | — | 页面底色 |
 * | `hairSoft` | `#E6E9F1` | 1.10 | 输入框、胶囊、悬停态这类「凹下去」的块 |
 * | `hair` | `#DDE0E8` | 1.18 | 只做分隔线（0.5px，密度低，所以可以比块深一点） |
 *
 * 卡片和输入块分别落在页面色的两侧（更亮 / 更暗），一眼能分出
 * 「这是一块卡片」和「这是一个输入框」。
 *
 * 页底不再是纯白之后，`text3` 跟着加深一档：`#6B7280` 落在 `#F4F5F9` 上
 * 只有 4.2:1，过不了辅助文字的 4.5 线。
 */
export const LIGHT: Palette = {
  page: '#F4F5F9',
  card: '#FFFFFF',
  text: '#16181D',
  text2: '#5A6070',
  // 背景退了一档灰，辅助文字就得补回对比度（5.1:1）
  text3: '#626878',
  /** 分隔线：比输入块再深一档，细线才不会糊进块里 */
  hair: '#DDE0E8',
  /** 凹块：输入框、胶囊、悬停态。比 page 深 1.10，比 hair 浅 */
  hairSoft: '#E6E9F1',
  accent: '#3F5EE8',
  accentBg: '#E7EDFE',
  accentText: '#2F4FCB',
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
  /** 桌面预览的外壳：比页面再深一档，页面才像「装在壳里」 */
  shell: '#EBEDF3',
  shellBorder: '#DDE0E8',
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
  // 深色同样三层：页面最暗、卡片亮一档、输入块再亮一档。
  // 原来 page #1A1A1A / card #242424 只差 10 个色阶，去掉边框之后卡片边界也糊了。
  page: '#17181B',
  card: '#202226',
  text: '#F2F3F5',
  text2: '#B6B9C0',
  text3: '#8E9298',
  hair: '#34373D',
  hairSoft: '#2A2D33',
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
  shell: '#111215',
  shellBorder: '#34373D',
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
  /*
   * 选中态的底。原来是 #EFEFEF，和 hairSoft #F2F2F2 只差 3 个色阶 ——
   * 去掉黑色描边之后，「这个被选中了」在墨水主题下就没有任何信号了。
   * 现在比 hairSoft 深 14 个色阶，灰阶里读得出「按下去了」。
   */
  accentBg: '#E4E4E4',
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
  // 比 accentBg 再深一档：文本选中要能和「选中的控件」分开
  selection: '#D8D8D8',
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
  accentBg: '#333333',
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
  selection: '#3E3E3E',
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
