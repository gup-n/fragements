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

export const LIGHT: Palette = {
  page: '#FAFAF8',
  card: '#FFFFFF',
  text: '#1D1E22',
  text2: '#565A61',
  text3: '#6A6E76',
  hair: '#E0E0DC',
  hairSoft: '#F1F1EE',
  /*
   * 主色是靛蓝，不是绿。绿色在整页铺开时（胶囊、徽标、按钮底）会读成「状态色」，
   * 而这套界面里绝大多数着重号只是「这里可以点」，不需要携带语义 ——
   * 蓝灰读起来是中性着重，才不会和「已完成」那种真状态抢意思。
   */
  accent: '#2F4C7D',
  accentBg: '#E8EDF6',
  accentText: '#274168',
  purpleBg: '#EEEDFA',
  purpleText: '#443B80',
  // 「已完成」原先是浅青绿。主色转蓝之后留着它，整页就还是绿的，所以一起转蓝灰。
  tealBg: '#E6EBF4',
  tealText: '#2A3F5E',
  amberBg: '#F4E8CD',
  amberText: '#64420B',
  coralBg: '#F7E9E2',
  coralText: '#7A3824',
  danger: '#A32D2D',
  dangerBg: '#F9E8E8',
  accentHair: '#C3CCDC',
  scrim: 'rgba(0,0,0,0.40)',
  shell: '#ECECE8',
  shellBorder: '#D2D3CE',
  onAccent: '#FFFFFF',
  onDanger: '#FFFFFF',
  mediaBackground: '#101010',
  mediaForeground: '#FFFFFF',
  mediaScrim: 'rgba(0,0,0,0.70)',
  controlThumb: '#FFFFFF',
  selection: '#DCE3EF',
  focus: '#2F4C7D',
};

export const DARK: Palette = {
  page: '#111113',
  card: '#1C1D20',
  text: '#F1F1F2',
  text2: '#BFC2C8',
  text3: '#A2A6AE',
  hair: '#464A52',
  hairSoft: '#282A2E',
  accent: '#9CB4E4',
  accentBg: '#1B2436',
  accentText: '#C4D4EE',
  purpleBg: '#2A2741',
  purpleText: '#CBC5F4',
  tealBg: '#1B2334',
  tealText: '#A9BFDF',
  amberBg: '#3C301C',
  amberText: '#F4D08F',
  coralBg: '#3B2820',
  coralText: '#F1B8A1',
  danger: '#F1A0A0',
  dangerBg: '#3E2424',
  accentHair: '#42506A',
  scrim: 'rgba(0,0,0,0.72)',
  shell: '#09090B',
  shellBorder: '#464A52',
  onAccent: '#101B2C',
  onDanger: '#291313',
  mediaBackground: '#101010',
  mediaForeground: '#FFFFFF',
  mediaScrim: 'rgba(0,0,0,0.76)',
  controlThumb: '#F0F0EC',
  selection: '#39445A',
  focus: '#C4D4EE',
};

/** Grayscale UI only. Original media are not filtered or inverted. */
export const INK_LIGHT: Palette = {
  page: '#FFFFFF',
  // 卡片比纸面低一档灰：这样卡片边界靠底色就能读出来，不必再给每一块都套一圈线
  card: '#FBFBFB',
  text: '#111111',
  text2: '#363636',
  text3: '#595959',
  // 边线仍要够辨识（3:1），但中灰改浅灰后，同样 1px 不再像表格线
  hair: '#8A8A8A',
  hairSoft: '#F2F2F2',
  accent: '#111111',
  accentBg: '#EAEAEA',
  accentText: '#111111',
  purpleBg: '#EEEEEE',
  purpleText: '#262626',
  tealBg: '#EEEEEE',
  tealText: '#262626',
  amberBg: '#D5D5D5',
  amberText: '#262626',
  coralBg: '#EEEEEE',
  coralText: '#262626',
  danger: '#111111',
  dangerBg: '#E5E5E5',
  accentHair: '#8A8A8A',
  scrim: 'rgba(0,0,0,0.55)',
  shell: '#E5E5E5',
  shellBorder: '#8A8A8A',
  onAccent: '#FFFFFF',
  onDanger: '#FFFFFF',
  mediaBackground: '#101010',
  mediaForeground: '#FFFFFF',
  mediaScrim: 'rgba(0,0,0,0.82)',
  controlThumb: '#FFFFFF',
  selection: '#D5D5D5',
  focus: '#111111',
};

export const INK_DARK: Palette = {
  page: '#101010',
  card: '#191919',
  text: '#FAFAFA',
  text2: '#DADADA',
  text3: '#BEBEBE',
  hair: '#808080',
  hairSoft: '#292929',
  accent: '#F3F3F3',
  accentBg: '#303030',
  accentText: '#F3F3F3',
  purpleBg: '#2A2A2A',
  purpleText: '#E8E8E8',
  tealBg: '#2A2A2A',
  tealText: '#E8E8E8',
  amberBg: '#414141',
  amberText: '#F3F3F3',
  coralBg: '#2A2A2A',
  coralText: '#E8E8E8',
  danger: '#FAFAFA',
  dangerBg: '#303030',
  accentHair: '#808080',
  scrim: 'rgba(0,0,0,0.82)',
  shell: '#101010',
  shellBorder: '#808080',
  onAccent: '#141414',
  onDanger: '#141414',
  mediaBackground: '#101010',
  mediaForeground: '#FFFFFF',
  mediaScrim: 'rgba(0,0,0,0.82)',
  controlThumb: '#FAFAFA',
  selection: '#505050',
  focus: '#FAFAFA',
};

export const DEFAULT_METRICS: ThemeMetrics = {
  cardRadius: 16,
  buttonRadius: 12,
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
