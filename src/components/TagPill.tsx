import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { R, tagColor } from '../theme';

interface Props {
  label: string;
  small?: boolean;
  /**
   * 传了才可点。时间轴上点标签直接筛出同类碎片 ——
   * 标签一直是 AI 打好但「只能看不能用」的状态。
   *
   * 注意别把 onPress 传给不可点的场合（比如详情页里的只读标签），
   * 否则用户会以为点了有反应。
   */
  onPress?: () => void;
}

export function TagPill({ label, small, onPress }: Props) {
  const { bg, fg } = tagColor(label);
  const pill = (
    <View style={[styles.pill, { backgroundColor: bg }, small && styles.pillSmall]}>
      <Text style={[styles.text, { color: fg }, small && styles.textSmall]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );

  if (!onPress) return pill;

  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={`按标签 ${label} 筛选`}
      style={({ pressed }) => pressed && styles.pressed}
    >
      {pill}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: R.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
    maxWidth: 120,
  },
  pillSmall: {
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  text: {
    fontSize: 12,
    lineHeight: 16,
  },
  textSmall: {
    fontSize: 11,
    lineHeight: 15,
  },
  pressed: { opacity: 0.55 },
});
