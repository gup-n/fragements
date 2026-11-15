/**
 * 统一图标按钮：视觉图形与触控槽分离，旧 diameter 只控制图形底。
 * 默认触控槽至少 48dp；列表行里的次要动作可以用 `compact`（36 槽 + hitSlop 补到 48），
 * 主导航可带短标签，不依赖颜色或长按才能知道用途。
 */
import React, { useState } from 'react';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View, type AccessibilityState } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';

export type IoniconName = ComponentProps<typeof Ionicons>['name'];

/**
 * 紧凑型的两个数：36 是看得见的槽，6 是四周补出来的 hitSlop。
 * 36 + 6×2 = 48，正好是触控下限 —— 这两个数改一个另一个就得跟着改，
 * 所以单独放常量，别散在样式里。
 */
const COMPACT_SLOT = 36;
const COMPACT_SLOP = 6;

interface Props {
  name: IoniconName;
  onPress: () => void;
  size?: number;
  color?: string;
  /**
   * `none` 透明、`soft` 浅灰底、`accent` 淡蓝底。
   *
   * 曾经还有一个 `primary`（实心主色底）。它没有任何调用方，而且标签色算错了
   * —— 在实心蓝底上用 `accentText`（浅蓝）写字，对比度不够。
   * 需要实心按钮的地方都是整块 `<Pressable>`，不是图标按钮，所以直接去掉。
   */
  tone?: 'none' | 'soft' | 'accent';
  /** 图形底的直径，不会缩小实际触控槽。保留旧调用兼容。 */
  diameter?: number;
  /**
   * 紧凑型：视觉槽 36，靠 hitSlop 把**触控区**补回 48。
   *
   * 加它是为了列表行里的「展开步骤 / 加子项」。那些按钮原来各占一个 48 的槽，
   * 一行待办因此被撑到 96 高 —— 用户 2026-11-15 的原话是「一个待办占用的空间非常大」。
   * 直接把槽改成 36 会让手指点不准，所以缩的是**看得见的**那张脸，
   * 摸得到的范围仍然是 48。页头、底栏这类主入口不要用它。
   */
  compact?: boolean;
  badge?: number;
  disabled?: boolean;
  /** 图形下方的可见短标签，例如「文档」「问」。 */
  label?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: AccessibilityState;
}

function toneBg(c: Palette, tone: 'none' | 'soft' | 'accent') {
  if (tone === 'soft') return c.hairSoft;
  if (tone === 'accent') return c.accentBg;
  return 'transparent';
}

export function IconButton({
  name,
  onPress,
  size = 21,
  color,
  tone = 'none',
  diameter = 36,
  compact = false,
  badge,
  disabled = false,
  label,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
}: Props) {
  const { c, styles, metrics } = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  const foreground = disabled ? c.text3 : color ?? (tone === 'accent' ? c.accentText : c.text2);
  /*
   * 带标签时，标签颜色**跟着图标走**。原来 `tone="primary"` 单独分支到
   * `accentText`，那个分支随着 primary 一起删掉了。
   */
  const labelColor = disabled ? c.text3 : foreground;
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
      {...(compact
        ? { hitSlop: { top: COMPACT_SLOP, bottom: COMPACT_SLOP, left: COMPACT_SLOP, right: COMPACT_SLOP } }
        : null)}
      style={({ pressed }) => [
        styles.base,
        {
          minWidth: Math.max(compact ? COMPACT_SLOT : metrics.controlHeight, diameter),
          minHeight: compact ? COMPACT_SLOT : metrics.controlHeight,
        },
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
  /**
   * 按下**只换底色**，不描边。
   *
   * 原来这里是 `borderColor: c.focus`：墨水风格的 focus 是纯黑，于是每点一下控件
   * 都会闪出一个黑框（用户 2026-11-15 报「点击控件也会有一个黑框」）。
   * 按下反馈用底色已经够，描边只留给键盘/读屏焦点那种「需要持续可见」的状态。
   */
  pressed: { backgroundColor: c.hairSoft },
  focused: { borderColor: c.focus },
  /**
   * 选中：换底色，不套 2px 焦点边。
   *
   * 原来这里是 `borderColor: c.focus; borderWidth: 2` —— 墨水主题下 focus 是纯黑，
   * 选中态就成了一个「一直挂着的黑框」，和按下时的黑框是同一类观感问题。
   * 现在用 accentBg 表态，靠图标实心度 + 文字标签区分，不靠描边。
   */
  selected: { backgroundColor: c.accentBg, borderColor: c.accentHair },
  label: { ...TYPE.label, textAlign: 'center' },
  badge: {
    position: 'absolute', top: -3, right: -4,
    minWidth: 18, minHeight: 18, borderRadius: 9, paddingHorizontal: 3,
    backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center',
    borderWidth: metrics.strokeWidth, borderColor: c.page,
  },
  badgeText: { fontSize: 10, lineHeight: 14, color: c.onAccent, fontWeight: '600' },
});
