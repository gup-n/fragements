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
}

export const LIGHT: Palette = {
  page: '#FBFBF9',
  card: '#FFFFFF',
  text: '#20211F',
  text2: '#595E58',
  text3: '#6C716A',
  hair: '#DCDDD5',
  hairSoft: '#F0F1EC',
  accent: '#185FA5',
  accentBg: '#E6F0F9',
  accentText: '#164A7B',
  purpleBg: '#EEEDFA',
  purpleText: '#443B80',
  tealBg: '#E4F1EA',
  tealText: '#18533F',
  amberBg: '#F4E8CD',
  amberText: '#64420B',
  coralBg: '#F7E9E2',
  coralText: '#7A3824',
  danger: '#A32D2D',
  dangerBg: '#F9E8E8',
  accentHair: '#B9CDDF',
  scrim: 'rgba(0,0,0,0.40)',
  shell: '#EDEEE7',
  shellBorder: '#D2D5C9',
  onAccent: '#FFFFFF',
  onDanger: '#FFFFFF',
  mediaBackground: '#101010',
  mediaForeground: '#FFFFFF',
  mediaScrim: 'rgba(0,0,0,0.70)',
  controlThumb: '#FFFFFF',
  selection: '#CFDFEE',
  focus: '#185FA5',
};

export const DARK: Palette = {
  page: '#121211',
  card: '#1C1C1A',
  text: '#F0F0EC',
  text2: '#C0C2BA',
  text3: '#A3A69B',
  hair: '#484B42',
  hairSoft: '#282A25',
  accent: '#88B6E2',
  accentBg: '#18364D',
  accentText: '#B4D5F2',
  purpleBg: '#292641',
  purpleText: '#CBC5F4',
  tealBg: '#18382E',
  tealText: '#94DDC1',
  amberBg: '#3C301C',
  amberText: '#F4D08F',
  coralBg: '#3B2820',
  coralText: '#F1B8A1',
  danger: '#F1A0A0',
  dangerBg: '#3E2424',
  accentHair: '#466883',
  scrim: 'rgba(0,0,0,0.72)',
  shell: '#0A0A09',
  shellBorder: '#484B42',
  onAccent: '#0A2236',
  onDanger: '#291313',
  mediaBackground: '#101010',
  mediaForeground: '#FFFFFF',
  mediaScrim: 'rgba(0,0,0,0.76)',
  controlThumb: '#F0F0EC',
  selection: '#3E5264',
  focus: '#B4D5F2',
};

/** Grayscale UI only. Original media are not filtered or inverted. */
export const INK_LIGHT: Palette = {
  page: '#FFFFFF',
  card: '#FFFFFF',
  text: '#111111',
  text2: '#363636',
  text3: '#595959',
  hair: '#767676',
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
  accentHair: '#767676',
  scrim: 'rgba(0,0,0,0.55)',
  shell: '#E5E5E5',
  shellBorder: '#767676',
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
  hair: '#909090',
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
  accentHair: '#909090',
  scrim: 'rgba(0,0,0,0.82)',
  shell: '#101010',
  shellBorder: '#909090',
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
  cardRadius: 14,
  buttonRadius: 10,
  strokeWidth: 1,
  controlHeight: 48,
  pagePadding: 16,
};
export const INK_METRICS: ThemeMetrics = {
  ...DEFAULT_METRICS,
  cardRadius: 4,
  buttonRadius: 4,
  strokeWidth: 1.25,
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
