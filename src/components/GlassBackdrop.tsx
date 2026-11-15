/**
 * 毛玻璃垫层。**只有墨水风格用**（用户 2026-11-15 第 8 条）。
 *
 * 用法：卡片的 `backgroundColor` 在墨水风格下必须是透明的，然后在里面第一层放它。
 * 不透明底会直接盖住模糊效果 —— 那样等于什么都没做。
 *
 * 为什么给墨水加、不给默认主题加：默认主题是「纸」，纸不会透；墨水是「屏幕上的字」，
 * 让下方滚动的内容隐约透出来是它的语言。默认主题加了反而脏。
 *
 * 三条实现约束：
 *
 * 1. **Android 必须用 dimezis**。expo-blur 在 Android 上默认走的是一个假的「半透明白」，
 *    看起来和普通半透明没有区别。`experimentalBlurMethod="dimezisBlurView"` 才是真模糊
 *    （需要 RN 0.76+，本项目 0.88）。
 * 2. **必须叠一层底色**。纯模糊在高对比正文底下会糊成一片灰，字读不出来。
 *    这里叠 72%（面板）/ 86%（底栏），透出来的是「底色动了」而不是「字糊了」。
 * 3. **圆角要跟宿主一致**。BlurView 自己不吃父级的 borderRadius，露直角是常见翻车点，
 *    所以由调用方把半径传进来。
 */
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { useTheme } from '../theme';

interface Props {
  /** 和它垫着的那块同圆角。直角区域传 0 */
  radius: number;
  /**
   * `panel` = 输入卡、浮层这类内容块，透 28%；
   * `bar` = 底栏，字多且小，要更实，透 14%。
   */
  tone?: 'panel' | 'bar';
  style?: StyleProp<ViewStyle>;
}

/** #RRGGBB → rgba()。调色板里都是六位十六进制，这里不为别的格式做兜底 */
function withAlpha(hex: string, alpha: number): string {
  const raw = hex.replace('#', '');
  if (raw.length !== 6) return hex;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function GlassBackdrop({ radius, tone = 'panel', style }: Props) {
  const { style: themeStyle, dark, c } = useTheme();
  // 默认主题是纸面，不透 —— 这里直接不渲染，省掉一层离屏合成
  if (themeStyle !== 'ink') return null;
  const veil = tone === 'bar' ? 0.86 : 0.72;
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }, style]}
    >
      <BlurView
        experimentalBlurMethod="dimezisBlurView"
        intensity={tone === 'bar' ? 30 : 42}
        tint={dark ? 'dark' : 'light'}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(c.page, veil) }]} />
    </View>
  );
}

/** 墨水风格下卡片要让出底色给毛玻璃；其余风格保持原来的实底 */
export function glassable(metrics: { outline: number }, solid: string): string {
  return metrics.outline > 0 ? 'transparent' : solid;
}
