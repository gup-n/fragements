/**
 * 一条回答的「深度思考」折叠块。
 *
 * 为什么需要它：v0.8.8 里思维链只在 `busy` 期间渲染，答案一落屏组件就被卸载，
 * 用户看到的是「闪一下没了」，而且没有任何展开入口。
 *
 * 两个刻意的选择：
 * - **刚答完的那一轮默认展开**（`defaultOpen`），否则内容还是会在眼前消失一次；
 *   历史轮次默认收起，避免一屏全是思考链。
 * - **思维链跟着 QaTurn 持久化**，历史会话重开也能看，不是只活在这一次运行里。
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';

interface Props {
  text: string;
  /** 刚答完的那一轮传 true：先把内容摊开，用户自己收 */
  defaultOpen?: boolean;
}

export function ReasoningFold({ text, defaultOpen = false }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(defaultOpen);

  if (!text.trim()) return null;

  return (
    <View style={styles.wrap}>
      <Pressable
        style={[styles.head, styles.touchTarget]}
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button" accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? '收起深度思考' : '展开深度思考'}
      >
        <Ionicons name="bulb-outline" size={18} color={c.text2} accessible={false} />
        <Text style={styles.title}>深度思考</Text>
        <Text style={styles.meta}>{text.length} 字</Text>
        <View style={styles.flex} />
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={c.text2} accessible={false} />
      </Pressable>

      {open ? (
        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <Text style={styles.text} selectable>
            {text}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  touchTarget: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight },
  wrap: { marginTop: SPACE.xxs, marginBottom: SPACE.md },
  head: {
    minHeight: metrics.controlHeight,
    flexDirection: 'row', alignItems: 'center', gap: SPACE.xs,
    paddingVertical: SPACE.xs,
  },
  title: { ...TYPE.label, color: c.text2, flexShrink: 1 },
  meta: { ...TYPE.meta, color: c.text3, fontVariant: ['tabular-nums'] },
  flex: { flex: 1 },
  body: {
    maxHeight: 280, backgroundColor: c.hairSoft,
    borderRadius: metrics.buttonRadius,
    borderLeftWidth: surfaceStroke(metrics), borderLeftColor: c.hair,
  },
  bodyContent: { padding: SPACE.sm },
  text: { ...TYPE.body, color: c.text2 },
});
