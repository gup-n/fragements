/**
 * 统一图标按钮：视觉图形与触控槽分离，旧 diameter 只控制图形底。
 * 触控槽至少 48dp；主导航可带短标签，不依赖颜色或长按才能知道用途。
 */
import React, { useState } from 'react';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View, type AccessibilityState } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';

export type IoniconName = ComponentProps<typeof Ionicons>['name'];

interface Props {
  name: IoniconName;
  onPress: () => void;
  size?: number;
  color?: string;
  tone?: 'none' | 'soft' | 'accent' | 'primary';
  /** 图形底的直径，不会缩小实际触控槽。保留旧调用兼容。 */
  diameter?: number;
  badge?: number;
  disabled?: boolean;
  /** 图形下方的可见短标签，例如「文档」「问」。 */
  label?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: AccessibilityState;
}

function toneBg(c: Palette, tone: 'none' | 'soft' | 'accent' | 'primary') {
  if (tone === 'soft') return c.hairSoft;
  if (tone === 'accent') return c.accentBg;
  if (tone === 'primary') return c.accent;
  return 'transparent';
}

export function IconButton({
  name,
  onPress,
  size = 21,
  color,
  tone = 'none',
  diameter = 36,
  badge,
  disabled = false,
  label,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
}: Props) {
  const { c, styles, metrics } = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  const foreground = disabled ? c.text3 : color ?? (tone === 'primary' ? c.onAccent : tone === 'accent' ? c.accentText : c.text2);
  const labelColor = disabled ? c.text3 : tone === 'primary' ? c.accentText : foreground;
  const count = badge && badge > 0 ? (badge > 99 ? '99+' : String(badge)) : '';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label ?? name}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ ...accessibilityState, disabled }}
      accessibilityValue={count ? { text: `${count} 条` } : undefined}
      style={({ pressed }) => [
        styles.base,
        { minWidth: Math.max(metrics.controlHeight, diameter), minHeight: metrics.controlHeight },
        label && styles.withLabel,
        pressed && !disabled && styles.pressed,
        focused && styles.focused,
      ]}
    >
      <View
        style={[
          styles.face,
          {
            width: diameter,
            height: diameter,
            borderRadius: Math.min(diameter / 2, metrics.buttonRadius + 2),
            backgroundColor: toneBg(c, tone),
            borderColor: tone === 'none' ? 'transparent' : disabled ? c.hair : c.accentHair,
          },
          accessibilityState?.selected && styles.selected,
        ]}
        pointerEvents="none"
      >
        <Ionicons name={name} size={size} color={foreground} accessible={false} />
        {count ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{count}</Text>
          </View>
        ) : null}
      </View>
      {label ? <Text style={[styles.label, { color: labelColor }]}>{label}</Text> : null}
    </Pressable>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: metrics.buttonRadius,
    borderWidth: metrics.strokeWidth,
    borderColor: 'transparent',
  },
  withLabel: { paddingVertical: SPACE.xs, gap: SPACE.xxs },
  face: { alignItems: 'center', justifyContent: 'center', borderWidth: surfaceStroke(metrics) },
  pressed: { backgroundColor: c.hairSoft, borderColor: c.focus },
  focused: { borderColor: c.focus },
  selected: { borderColor: c.focus, borderWidth: 2 },
  label: { ...TYPE.label, textAlign: 'center' },
  badge: {
    position: 'absolute', top: -3, right: -4,
    minWidth: 18, minHeight: 18, borderRadius: 9, paddingHorizontal: 3,
    backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center',
    borderWidth: metrics.strokeWidth, borderColor: c.page,
  },
  badgeText: { fontSize: 10, lineHeight: 14, color: c.onAccent, fontWeight: '600' },
});
