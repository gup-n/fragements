/**
 * 底部标签栏：五个平级主入口。
 *
 * 为什么从「首页一排带字图标」改成底栏（用户 2026-11-15 要求「参考其余软件」）：
 *
 * 1. **位置**。拇指够不到屏幕上部，而首页那排图标在标题下面 —— 想切页得先把手抬起来。
 *    底栏是单手拇指的自然落点，也是 Android/iOS 上的通用约定。
 * 2. **首屏高度**。那一排加上下留白占了近 90dp，等于把「看的」让给「切页的」。
 *    首屏该放记录，不放导航。
 * 3. **返回语义**。原来每个页面都是「全屏页 + 左上返回」，从文档跳问再跳回顾会攒出一栈。
 *    底栏是平级的：四个页面对等，互不嵌套。
 *
 * 选中态不靠颜色单独表达：实心图标 + 加粗字 + 短线头，三个信号同时给。
 *
 * **设置也在底栏里**（v0.20.9，用户要求放到最右）。它一开始留在首页右上角，
 * 理由是「低频配置项不该和四个高频入口争宽度」；用户试过之后的意见是
 * 一致地把所有入口放平更省事 —— 那就放平。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import type { IoniconName } from './IconButton';
import { GlassBackdrop, glassable } from './GlassBackdrop';

export type MainTab = 'timeline' | 'docs' | 'ask' | 'review' | 'settings';

interface Item {
  key: MainTab;
  label: string;
  /** 未选中用线框图标，选中用实心：颜色不是唯一线索 */
  icon: IoniconName;
  iconOn: IoniconName;
  accessibilityLabel: string;
}

/**
 * 五项，按用户 2026-11-15 的要求排：「问」居中（最高频的 AI 入口放在拇指正中），
 * 「设置」在最右（和系统里其它 App 的「我的/设置」同位）。
 *
 * 320dp 的窄屏上每项还有 64dp，超过 48dp 的触控下限；再塞第六项就要掉到 53dp 了。
 */
const ITEMS: Item[] = [
  { key: 'timeline', label: '碎片', icon: 'layers-outline', iconOn: 'layers', accessibilityLabel: '碎片：时间轴' },
  // 文档与回顾换位（v0.27，用户 2026-11-18 要求）：回顾是每天都会翻的，文档不是
  { key: 'review', label: '回顾', icon: 'checkmark-circle-outline', iconOn: 'checkmark-circle', accessibilityLabel: '回顾：待办与小结' },
  { key: 'ask', label: '问', icon: 'chatbubble-ellipses-outline', iconOn: 'chatbubble-ellipses', accessibilityLabel: '问：查记录或让它整理' },
  { key: 'docs', label: '文档', icon: 'documents-outline', iconOn: 'documents', accessibilityLabel: '文档：上传并阅读' },
  { key: 'settings', label: '设置', icon: 'settings-outline', iconOn: 'settings', accessibilityLabel: '设置：模型、外观与数据' },
];

interface Props {
  current: MainTab;
  onChange: (tab: MainTab) => void;
  /**
   * 有东西正开着（长文输入、阅读器、整理草稿）时锁住。
   * 切页会卸载当前屏幕，草稿和滚动位置一起没 —— 这和原来四个图标上的 disabled 是同一条规矩。
   */
  disabled?: boolean;
}

export function TabBar({ current, onChange, disabled = false }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  return (
    <View style={styles.bar} accessibilityRole="tablist">
      {/* 墨水风格下底栏是透的：滚到一半的碎片从底下透出来，但被压得看不清 */}
      <GlassBackdrop radius={0} tone="bar" />
      {ITEMS.map((item) => {
        const on = item.key === current;
        const tint = disabled ? c.text3 : on ? c.accent : c.text2;
        return (
          <Pressable
            key={item.key}
            onPress={() => { if (!on && !disabled) onChange(item.key); }}
            disabled={disabled}
            accessibilityRole="tab"
            accessibilityState={{ selected: on, disabled }}
            accessibilityLabel={item.accessibilityLabel}
            style={({ pressed }) => [styles.slot, pressed && !disabled && styles.slotPressed]}
          >
            <Ionicons name={on ? item.iconOn : item.icon} size={20} color={tint} accessible={false} />
            <Text style={[styles.label, { color: tint }, on && styles.labelOn]} numberOfLines={1}>
              {item.label}
            </Text>
            <View style={[styles.marker, on && !disabled && { backgroundColor: c.accent }]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: glassable(metrics, c.card),
    borderTopWidth: surfaceStroke(metrics),
    borderTopColor: c.hair,
    paddingTop: 3,
    overflow: 'hidden',
  },
  /** 每个槽至少 48×48：320dp 宽的机器上五等分也有 64dp，够 */
  slot: {
    flex: 1,
    minWidth: metrics.controlHeight,
    minHeight: metrics.controlHeight,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    paddingTop: SPACE.xxs,
    paddingBottom: 2,
  },
  slotPressed: { backgroundColor: c.hairSoft },
  label: { ...TYPE.caption },
  labelOn: { fontWeight: '700' },
  /** 固定高度的短线头，未选中时透明 —— 占位不变，切换时不跳动 */
  marker: { width: 14, height: 2, borderRadius: 1, marginTop: 1, backgroundColor: 'transparent' },
});
