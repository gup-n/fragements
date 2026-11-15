/** 可见选中图形 + 48dp 的选项控件，墨水模式不依赖底色区分。 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';

interface Props {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  role?: 'radio' | 'tab' | 'switch';
  accessibilityLabel?: string;
}

export function ChoiceChip({ label, selected, onPress, disabled = false, role = 'radio', accessibilityLabel }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected, disabled, checked: role !== 'tab' ? selected : undefined }}
      /*
       * 按下只换底色，**不描边**。
       *
       * 原来这里是 `(pressed || focused) && styles.focused`，而 focused 是
       * 2px 的 `c.focus`；墨水主题的 focus 是纯黑 —— 于是每点一下明暗或风格选项，
       * 按钮四周就闪出一个黑框。用户 2026-11-15 报的「点击控件会有黑框」
       * 主要就是这里（设置页的选项全是这个组件）。
       *
       * 描边只留给键盘/读屏那种「需要持续可见」的焦点态。
       */
      style={({ pressed }) => [
        styles.base,
        selected && styles.selected,
        pressed && !disabled && styles.pressed,
        focused && styles.focused,
      ]}
    >
      <Ionicons name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={17} color={disabled ? c.text3 : selected ? c.accentText : c.text2} accessible={false} />
      <Text style={[styles.label, selected && styles.selectedText, disabled && styles.disabledText]}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  base: {
    minHeight: metrics.controlHeight, minWidth: metrics.controlHeight,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs,
    paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs,
    borderRadius: metrics.buttonRadius, borderWidth: surfaceStroke(metrics), borderColor: c.hair,
    backgroundColor: c.hairSoft,
  },
  /** 选中：淡蓝底 + 蓝字 + 实心图标。底色负责表达，不用加粗的描边 */
  selected: { borderColor: c.accentHair, backgroundColor: c.accentBg },
  pressed: { backgroundColor: c.hair },
  /** 只给键盘/读屏焦点：2px 是「持续可见」的规格，不能拿来做按下反馈 */
  focused: { borderColor: c.focus, borderWidth: 2 },
  label: { ...TYPE.label, color: c.text2, flexShrink: 1 },
  selectedText: { color: c.accentText, fontWeight: '600' },
  disabledText: { color: c.text3 },
});
