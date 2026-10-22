/**
 * 统一的圆形图标按钮。
 *
 * 以前各页的图标都是「一个 19px 的 Ionicons + hitSlop」，问题有三：
 * 1. 视觉上只是一枚细线图标，分不清是可点的按钮还是装饰；
 * 2. 触控区只有 23px 左右，手指按偏一点就没反应；
 * 3. 每个页面自己写 padding，同一排图标对不齐。
 *
 * 这里固定 36px 的圆形触控区（图标 21px），按下给透明度反馈。
 * 36 不是 Material 说的 48，但一排要放三四个图标，48 会把标题挤没；
 * 配合 hitSlop 后实际可点区仍大于手指腹。
 */
import React from 'react';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { C } from '../theme';

export type IoniconName = ComponentProps<typeof Ionicons>['name'];

interface Props {
  name: IoniconName;
  onPress: () => void;
  /** 图标直径，默认 21 —— 比正文配图大一档，一眼能认出是什么图标 */
  size?: number;
  color?: string;
  /** 圆形底色。none = 透明（首页工具栏），soft = 浅灰底（返回键），accent = 浅蓝底 */
  tone?: 'none' | 'soft' | 'accent';
  /** 触控区直径，默认 36 */
  diameter?: number;
  /** 右上角数字角标（整理入口的未读条数） */
  badge?: number;
  disabled?: boolean;
  accessibilityLabel?: string;
}

const TONE_BG = { none: 'transparent', soft: C.hairSoft, accent: C.accentBg } as const;

export function IconButton({
  name,
  onPress,
  size = 21,
  color,
  tone = 'none',
  diameter = 36,
  badge,
  disabled,
  accessibilityLabel,
}: Props) {
  const bg = TONE_BG[tone];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        s.base,
        { width: diameter, height: diameter, borderRadius: diameter / 2, backgroundColor: bg },
        pressed && s.pressed,
        disabled && s.disabled,
      ]}
    >
      <Ionicons name={name} size={size} color={color ?? (tone === 'none' ? C.text2 : C.text)} />
      {badge && badge > 0 ? (
        <View style={s.badge}>
          <Text style={s.badgeText}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.45 },
  disabled: { opacity: 0.35 },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 15,
    height: 15,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
    // 和底色之间留一圈缝，压在浅灰底上也能看清边界
    borderWidth: 1.5,
    borderColor: C.page,
  },
  badgeText: { fontSize: 9, lineHeight: 11, color: '#FFFFFF', fontWeight: '600' },
});
