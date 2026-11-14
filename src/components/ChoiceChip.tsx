/** 可见选中图形 + 48dp 的选项控件，墨水模式不依赖底色区分。 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useThemedStyles, type Palette, type ThemeMetrics } from '../theme';

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
      style={({ pressed }) => [styles.base, selected && styles.selected, (pressed || focused) && styles.focused]}
    >
      <Ionicons name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={17} color={disabled ? c.text3 : selected ? c.accentText : c.text2} accessible={false} />
      <Text style={[styles.label, selected && styles.selectedText, disabled && styles.disabledText]}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  base: {
    minHeight: metrics.controlHeight, minWidth: metrics.controlHeight,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    paddingHorizontal: 13, paddingVertical: 9,
    borderRadius: metrics.buttonRadius, borderWidth: metrics.strokeWidth, borderColor: c.hair,
    backgroundColor: c.card,
  },
  selected: { borderColor: c.focus, backgroundColor: c.accentBg },
  focused: { borderColor: c.focus, borderWidth: 2 },
  label: { fontSize: 13, lineHeight: 20, color: c.text2, flexShrink: 1 },
  selectedText: { color: c.accentText, fontWeight: '600' },
  disabledText: { color: c.text3 },
});
