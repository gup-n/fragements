/**
 * 结果页里「模型思考过程」的折叠区。
 *
 * 默认收起 —— 确认结果才是主任务，思考过程是「想追问时再翻」的参考。
 * 整理页和周期总结面板都要用，所以样式在这里自成一套。
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SPACE, TYPE, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';

interface Props {
  /** 思维链全文。空串时整个组件不渲染 */
  text: string;
  expanded: boolean;
  onToggle: () => void;
  /** 展开后的高度上限，默认 240 */
  height?: number;
}

export function ReasoningTrace({ text, expanded, onToggle, height = 240 }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  if (!text) return null;
  return (
    <View style={styles.card}>
      <Pressable style={[styles.head, styles.touchTarget]} onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={expanded ? '收起模型思考过程' : '展开模型思考过程'}>
        <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={16} color={c.text2} accessible={false} />
        <Text style={styles.title}>模型思考过程</Text>
        {/* 「N 字」已删：这是事后的折叠块，字数不提供任何决策信息 */}
        <View style={styles.flex} />
      </Pressable>
      {expanded ? (
        <ScrollView
          style={[styles.scroll, { maxHeight: height }]}
          contentContainerStyle={styles.scrollBody}
          nestedScrollEnabled
        >
          <Text style={styles.text}>{text}</Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  touchTarget: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight },
  card: { marginBottom: SPACE.md },
  head: {
    minHeight: metrics.controlHeight,
    flexDirection: 'row', alignItems: 'center', gap: SPACE.xs,
    paddingVertical: SPACE.xs,
  },
  title: { ...TYPE.label, flex: 1, color: c.text2 },
  flex: { flex: 1 },
  scroll: {
    backgroundColor: c.hairSoft, borderRadius: metrics.buttonRadius,
  },
  scrollBody: { padding: SPACE.sm },
  text: { ...TYPE.body, color: c.text2 },
});
