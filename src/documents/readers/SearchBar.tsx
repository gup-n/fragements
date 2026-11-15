/** 阅读器查找：确定性字面匹配，99+ 明示上限，不把索引中说成零命中。 */
import React, { useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../../theme';
import { IconButton } from '../../components/IconButton';

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** -1 表示还没算出来；只接受确定性字面命中数。 */
  total: number;
  /** 从1起，0表示没有当前命中。 */
  current: number;
  onPrev: () => void;
  onNext: () => void;
  disabled?: boolean;
  /** 索引中仍可输入；与确实没有文字的 disabled 分开。 */
  busy?: boolean;
  note?: string;
  placeholder?: string;
}

function countLabel(total: number, current: number, note?: string): string {
  if (total < 0) return '正在查找…';
  if (total === 0) return '没有找到';
  const shown = total > 99 ? '99+' : String(total);
  return `${current > 0 ? `第 ${current} / ${shown} 处` : `共 ${shown} 处`}${note ? ` · ${note}` : ''}`;
}

export function SearchBar({
  value, onChange, total, current, onPrev, onNext, disabled = false,
  busy = false, note, placeholder = '在文档里查找',
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  const trimmed = value.trim();
  const canPrev = !disabled && !busy && total > 0 && current > 1;
  const canNext = !disabled && !busy && total > 0 && current > 0 && current < total;

  return (
    <View style={styles.wrap}>
      <View style={[styles.box, focused && styles.boxFocused, disabled && styles.boxDisabled]}>
        <Ionicons name="search-outline" size={18} color={c.text2} accessible={false} />
        <TextInput
          value={value}
          onChangeText={onChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={disabled ? '这篇没有可查找的文字' : placeholder}
          placeholderTextColor={c.text3}
          accessibilityLabel={placeholder}
          accessibilityState={{ disabled, busy }}
          style={styles.input}
          editable={!disabled}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          selectionColor={c.selection}
        />
        {value ? (
          <IconButton
            name="close" size={18} diameter={28} color={c.text2}
            onPress={() => onChange('')} accessibilityLabel="清除查找"
          />
        ) : null}
      </View>

      {trimmed ? (
        <View style={styles.hitRow}>
          <View style={styles.hitInfo}>
            <Text style={styles.hitText} accessibilityLiveRegion="polite">
              {busy ? '正在索引文字…' : countLabel(total, current)}
            </Text>
            {!busy && total > 0 && note ? <Text style={styles.hitNote}>{note}</Text> : null}
          </View>
          <View style={styles.hitBtns}>
            <IconButton
              name="chevron-up" size={18} tone="soft" diameter={32}
              color={c.text2} disabled={!canPrev} onPress={onPrev} accessibilityLabel="上一处命中"
            />
            <IconButton
              name="chevron-down" size={18} tone="soft" diameter={32}
              color={c.text2} disabled={!canNext} onPress={onNext} accessibilityLabel="下一处命中"
            />
          </View>
        </View>
      ) : busy ? <Text style={styles.indexing}>正在索引文字，可以先输入查找词</Text> : null}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  wrap: {
    paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.sm, paddingBottom: SPACE.xs,
    borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair, backgroundColor: c.page,
  },
  box: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: metrics.controlHeight, backgroundColor: c.card,
    borderWidth: surfaceStroke(metrics), borderColor: c.hair, borderRadius: metrics.buttonRadius,
    paddingLeft: SPACE.md, paddingRight: SPACE.xxs,
  },
  /**
   * 聚焦只换颜色，不换宽度 —— 墨水主题的 `focus` 是纯黑，拿它描一圈就是黑框；
   * 而且把 0.5 换成 1 会让整条搜索框在聚焦那一刻跳 1px。
   */
  boxFocused: { borderColor: c.accentHair },
  boxDisabled: { backgroundColor: c.hairSoft },
  input: {
    flex: 1, minWidth: 0, minHeight: metrics.controlHeight, ...TYPE.body, color: c.text,
    paddingVertical: SPACE.xs, paddingHorizontal: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as unknown as undefined } : {}),
  },
  hitRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginTop: SPACE.xs },
  hitInfo: { flex: 1, minWidth: 0, gap: SPACE.xxs },
  hitText: { ...TYPE.body, color: c.text, fontWeight: '600', fontVariant: ['tabular-nums'] },
  hitNote: { ...TYPE.meta, color: c.text2 },
  hitBtns: { flexDirection: 'row', gap: SPACE.xxs },
  indexing: { ...TYPE.body, color: c.text2, marginTop: SPACE.xs },
});
