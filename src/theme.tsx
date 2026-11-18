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
import { TYPE_SCALE_FACTOR, type TypeScale } from './util/uiTokens';

export * from './util/appearance';
export {
  SPACE,
  TYPE,
  TYPE_SCALE_FACTOR,
  TYPE_SCALE_LABEL,
  normalizeTypeScale,
  setTypeScale,
  surfaceStroke,
  type TypeScale,
} from './util/uiTokens';

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
  /** 字号档位（v0.26）。样式里的 `TYPE` 已经按它缩放好了 */
  typeScale: TypeScale;
  dark: boolean;
  c: Palette;
  metrics: ThemeMetrics;
  reduceMotion: boolean;
  saveError: string | null;
  setMode: (mode: ThemeMode) => void;
  setStyle: (style: ThemeStyle) => void;
  setTypeScale: (scale: TypeScale) => void;
}

const noop = () => {};
const ThemeContext = createContext<ThemeValue>({
  mode: 'system',
  style: 'default',
  typeScale: 'normal',
  dark: false,
  c: LIGHT,
  metrics: DEFAULT_METRICS,
  reduceMotion: false,
  saveError: null,
  setMode: noop,
  setStyle: noop,
  setTypeScale: noop,
});

interface ProviderProps {
  mode: ThemeMode;
  style?: ThemeStyle;
  /** 字号档位。真正的缩放由调用方在**渲染之前**调 `setTypeScale` 完成 */
  typeScale?: TypeScale;
  systemDark: boolean;
  onChangeMode: (mode: ThemeMode) => void;
  onChangeStyle?: (style: ThemeStyle) => void;
  onChangeTypeScale?: (scale: TypeScale) => void;
  saveError?: string | null;
  children: React.ReactNode;
}

export function ThemeProvider({
  mode, style = 'default', typeScale = 'normal', systemDark, onChangeMode, onChangeStyle = noop,
  onChangeTypeScale = noop, saveError = null, children,
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
  const setTypeScale = useCallback((next: TypeScale) => onChangeTypeScale(next), [onChangeTypeScale]);
  const value = useMemo<ThemeValue>(() => ({
    mode, style, typeScale,
    // metrics 带上倍数：样式工厂的 memo 以 metrics 为依赖，档位一变整页重建
    ...resolveAppearance(mode, style, systemDark, TYPE_SCALE_FACTOR[typeScale]),
    reduceMotion: style === 'ink' || systemReduceMotion,
    saveError, setMode, setStyle, setTypeScale,
  }), [mode, style, typeScale, systemDark, systemReduceMotion, saveError, setMode, setStyle, setTypeScale]);

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
