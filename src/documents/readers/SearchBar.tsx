/**
 * 阅读器内的查找栏。
 *
 * 计数口径：**只用确定性字面匹配**（`util/highlight.findHits` 或 WebView 里同一套
 * 规则的实现），不用全文检索的 OR/topK 结果 —— 那只能给「相关片段」，
 * 给不出「一共几处」，显示出来就是骗人的。
 *
 * 超过 99 处显示 `99+`：既不让两位数字把这一行挤爆，也不能假装「总共 99 处」。
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { R, useThemedStyles, type Palette } from '../../theme';
import { IconButton } from '../../components/IconButton';

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** 全量命中数；-1 表示还没算出来 */
  total: number;
  /** 当前第几处（1 起）；0 表示没有可选中的命中 */
  current: number;
  onPrev: () => void;
  onNext: () => void;
  /** 关闭输入（比如 PDF 没有文字层） */
  disabled?: boolean;
  /** 「当前工作表」「第 12 行」这类补充说明，跟在计数后面 */
  note?: string;
  placeholder?: string;
}

function countLabel(total: number, current: number, note?: string): string {
  if (total < 0) return '正在查找…';
  if (total === 0) return '没有找到';
  const shown = total > 99 ? '99+' : String(total);
  const at = current > 0 ? `${current} / ` : '';
  return `第 ${at}${shown} 处${note ? ` · ${note}` : ''}`;
}

export function SearchBar({
  value,
  onChange,
  total,
  current,
  onPrev,
  onNext,
  disabled,
  note,
  placeholder = '在文档里查找',
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const trimmed = value.trim();
  const canPrev = total > 0 && current > 1;
  const canNext = total > 0 && current > 0 && current < total;

  return (
    <View style={styles.wrap}>
      <View style={[styles.box, disabled && styles.boxDisabled]}>
        <Ionicons name="search" size={15} color={c.text3} />
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={disabled ? '这篇没有可查找的文字' : placeholder}
          placeholderTextColor={c.text3}
          style={styles.input}
          editable={!disabled}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          selectionColor={c.accent}
        />
        {trimmed ? (
          <Pressable onPress={() => onChange('')} hitSlop={10} accessibilityLabel="清除查找">
            <Ionicons name="close-circle" size={16} color={c.text3} />
          </Pressable>
        ) : null}
      </View>

      {trimmed ? (
        <View style={styles.hitRow}>
          <Text style={styles.hitText} numberOfLines={1}>
            {countLabel(total, current, note)}
          </Text>
          <View style={styles.hitBtns}>
            <IconButton
              name="chevron-up"
              size={15}
              tone="soft"
              color={c.text2}
              diameter={32}
              disabled={!canPrev}
              onPress={onPrev}
              accessibilityLabel="上一处"
            />
            <IconButton
              name="chevron-down"
              size={15}
              tone="soft"
              color={c.text2}
              diameter={32}
              disabled={!canNext}
              onPress={onNext}
              accessibilityLabel="下一处"
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  wrap: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
    backgroundColor: c.page,
  },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    height: 36,
    backgroundColor: c.hairSoft,
    borderRadius: R.btn + 2,
    paddingHorizontal: 11,
  },
  boxDisabled: { opacity: 0.6 },
  input: {
    flex: 1,
    fontSize: 13.5,
    color: c.text,
    paddingVertical: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as unknown as undefined } : {}),
  },
  hitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 7,
    gap: 10,
  },
  hitText: { flex: 1, fontSize: 12, color: c.text2 },
  hitBtns: { flexDirection: 'row', gap: 6 },
});
