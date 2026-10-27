/**
 * 视觉常量与主题。
 *
 * 两套调色板（浅色 / 深色）字段完全一致，组件只认字段名，不认具体色值。
 * 深色不是把浅色取反：纸白的 `page` 对应的是「比卡片还暗一档」的近黑，
 * 而 `card` 要略亮于 `page`，靠这点亮度差代替浅色下的白卡片。
 *
 * 改造前这里导出的是一个 `as const` 的静态对象，`StyleSheet.create` 在模块
 * 加载时就把色值固化下来了 —— 所以切主题必须重建样式表，见 `useThemedStyles`。
 */

import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { StyleSheet } from 'react-native';

export interface Palette {
  /** 页面底色 */
  page: string;
  /** 卡片底色，比 page 亮/暗一档 */
  card: string;
  text: string;
  text2: string;
  text3: string;
  /** 分隔线 */
  hair: string;
  /** 比 hair 更淡的块状底（统计块、代码块） */
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

  /** accentBg 卡片内部的分隔线（半透明，跟着 accent 走） */
  accentHair: string;
  /** 弹层遮罩。深色页面上黑色 32% 几乎看不见，得压得更重 */
  scrim: string;

  /** 浏览器预览时 App 外面的那圈底色 */
  shell: string;
  shellBorder: string;
  /** 实心按钮上的文字色（深色下 accent 变亮，字要压深） */
  onAccent: string;
}

export const LIGHT: Palette = {
  page: '#FBFBF9',
  card: '#FFFFFF',
  text: '#1B1B19',
  text2: '#6E6E68',
  text3: '#A6A69F',
  hair: '#ECECE7',
  hairSoft: '#F3F3EF',

  accent: '#185FA5',
  accentBg: '#E6F1FB',
  accentText: '#0C447C',

  purpleBg: '#EEEDFE',
  purpleText: '#3C3489',
  tealBg: '#E1F5EE',
  tealText: '#085041',
  amberBg: '#FAEEDA',
  amberText: '#633806',
  coralBg: '#FAECE7',
  coralText: '#712B13',

  danger: '#A32D2D',
  dangerBg: '#FCEBEB',

  accentHair: 'rgba(12,68,124,0.12)',
  scrim: 'rgba(0,0,0,0.32)',

  shell: '#EDEDE7',
  shellBorder: '#DEDED6',
  onAccent: '#FFFFFF',
};

/**
 * 深色的取法：不用纯黑（OLED 上纯黑和近黑切换会有拖影，且纯黑配白字太刺），
 * page 用 #121211，card 抬到 #1C1C1A，靠 8 级亮度差分层。
 * 彩色底一律压到 20% 明度左右，字色取同色系的高明度版本 —— 这样标签在深色下
 * 仍然靠色相区分，不会糊成一片灰。
 */
export const DARK: Palette = {
  page: '#121211',
  card: '#1C1C1A',
  text: '#EDEDE9',
  text2: '#B3B3AC',
  text3: '#85857E',
  hair: '#2C2C29',
  hairSoft: '#242422',

  accent: '#5B9BD8',
  accentBg: '#16324A',
  accentText: '#A8CDF0',

  purpleBg: '#262447',
  purpleText: '#C0B9F5',
  tealBg: '#12332C',
  tealText: '#7FD9C0',
  amberBg: '#3B2A12',
  amberText: '#F0C084',
  coralBg: '#3A1F16',
  coralText: '#F0A88C',

  danger: '#E88A8A',
  dangerBg: '#3A1A1A',

  accentHair: 'rgba(168,205,240,0.16)',
  scrim: 'rgba(0,0,0,0.62)',

  shell: '#0A0A09',
  shellBorder: '#2C2C29',
  onAccent: '#0B2033',
};

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};

export function normalizeThemeMode(raw: string | null): ThemeMode {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

/** 同一个标签在全局永远拿到同一个颜色，便于用颜色记忆分类。 */
export function tagColor(c: Palette, label: string) {
  let h = 7;
  for (let i = 0; i < label.length; i++) {
    h = (h * 31 + label.charCodeAt(i)) % 100003;
  }
  const palette = [
    { bg: c.accentBg, fg: c.accentText },
    { bg: c.purpleBg, fg: c.purpleText },
    { bg: c.tealBg, fg: c.tealText },
    { bg: c.amberBg, fg: c.amberText },
    { bg: c.coralBg, fg: c.coralText },
  ];
  return palette[h % palette.length];
}

export const R = {
  card: 12,
  btn: 8,
  pill: 999,
} as const;

interface ThemeValue {
  mode: ThemeMode;
  /** 当前实际渲染的是不是深色（mode=system 时由系统决定） */
  dark: boolean;
  c: Palette;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeValue>({
  mode: 'system',
  dark: false,
  c: LIGHT,
  setMode: () => {},
});

interface ProviderProps {
  mode: ThemeMode;
  /** 系统当前是不是深色。App 用 useColorScheme 拿到后传进来 */
  systemDark: boolean;
  onChangeMode: (mode: ThemeMode) => void;
  children: React.ReactNode;
}

export function ThemeProvider({ mode, systemDark, onChangeMode, children }: ProviderProps) {
  const dark = mode === 'dark' || (mode === 'system' && systemDark);
  const setMode = useCallback((next: ThemeMode) => onChangeMode(next), [onChangeMode]);

  const value = useMemo<ThemeValue>(
    () => ({ mode, dark, c: dark ? DARK : LIGHT, setMode }),
    [mode, dark, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

/**
 * 把「按调色板生成样式表」的工厂变成 hook。
 *
 * 每个界面文件的写法是：
 *   const makeStyles = (c: Palette) => StyleSheet.create({...});
 *   const { c, styles } = useThemedStyles(makeStyles);
 *
 * 工厂是模块级常量、身份稳定，所以 useMemo 的依赖只有 c —— 切主题时重算一次，
 * 平时一帧都不重算。之所以不把 styles 定义成模块常量，是因为 StyleSheet.create
 * 会在加载时把色值定死，换主题后旧样式表不会跟着变。
 */
export function useThemedStyles<T>(factory: (c: Palette) => T): { c: Palette; styles: T } {
  const { c } = useTheme();
  const styles = useMemo(() => factory(c), [c, factory]);
  return useMemo(() => ({ c, styles }), [c, styles]);
}
