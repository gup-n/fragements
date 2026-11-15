/** Dynamic appearance provider. Color values and pure normalization live in util/appearance. */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import {
  DEFAULT_METRICS,
  LIGHT,
  resolveAppearance,
  type Palette,
  type ThemeMetrics,
  type ThemeMode,
  type ThemeStyle,
} from './util/appearance';

export * from './util/appearance';
export { SPACE, TYPE, surfaceStroke } from './util/uiTokens';

/**
 * 唯一的遗留半径：`R.pill` 只表示「胶囊」。
 *
 * `R.card` / `R.btn` 早就没人用了 —— 圆角一律走 `metrics.cardRadius` /
 * `metrics.buttonRadius`，留着它们只会让人以为还有第二种圆角来源。
 */
export const R = { pill: 999 } as const;

interface ThemeValue {
  mode: ThemeMode;
  style: ThemeStyle;
  dark: boolean;
  c: Palette;
  metrics: ThemeMetrics;
  reduceMotion: boolean;
  saveError: string | null;
  setMode: (mode: ThemeMode) => void;
  setStyle: (style: ThemeStyle) => void;
}

const noop = () => {};
const ThemeContext = createContext<ThemeValue>({
  mode: 'system',
  style: 'default',
  dark: false,
  c: LIGHT,
  metrics: DEFAULT_METRICS,
  reduceMotion: false,
  saveError: null,
  setMode: noop,
  setStyle: noop,
});

interface ProviderProps {
  mode: ThemeMode;
  style?: ThemeStyle;
  systemDark: boolean;
  onChangeMode: (mode: ThemeMode) => void;
  onChangeStyle?: (style: ThemeStyle) => void;
  saveError?: string | null;
  children: React.ReactNode;
}

export function ThemeProvider({
  mode, style = 'default', systemDark, onChangeMode, onChangeStyle = noop,
  saveError = null, children,
}: ProviderProps) {
  const [systemReduceMotion, setSystemReduceMotion] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((next) => { if (alive) setSystemReduceMotion(next); })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setSystemReduceMotion);
    return () => { alive = false; subscription.remove(); };
  }, []);

  const setMode = useCallback((next: ThemeMode) => onChangeMode(next), [onChangeMode]);
  const setStyle = useCallback((next: ThemeStyle) => onChangeStyle(next), [onChangeStyle]);
  const value = useMemo<ThemeValue>(() => ({
    mode, style,
    ...resolveAppearance(mode, style, systemDark),
    reduceMotion: style === 'ink' || systemReduceMotion,
    saveError, setMode, setStyle,
  }), [mode, style, systemDark, systemReduceMotion, saveError, setMode, setStyle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

/** Rebuild styles for BOTH color and geometry changes without remounting page state. */
export function useThemedStyles<T>(factory: (c: Palette, metrics: ThemeMetrics) => T): {
  c: Palette; styles: T; metrics: ThemeMetrics;
} {
  const { c, metrics } = useTheme();
  const styles = useMemo(() => factory(c, metrics), [c, metrics, factory]);
  return useMemo(() => ({ c, styles, metrics }), [c, styles, metrics]);
}
