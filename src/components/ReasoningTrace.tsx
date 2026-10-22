/**
 * 结果页里「模型思考过程」的折叠区。
 *
 * 默认收起 —— 确认结果才是主任务，思考过程是「想追问时再翻」的参考。
 * 整理页和周期总结面板都要用，所以样式在这里自成一套。
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { C, R } from '../theme';

function fmtCount(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

interface Props {
  /** 思维链全文。空串时整个组件不渲染 */
  text: string;
  expanded: boolean;
  onToggle: () => void;
  /** 展开后的高度上限，默认 240 */
  height?: number;
}

export function ReasoningTrace({ text, expanded, onToggle, height = 240 }: Props) {
  if (!text) return null;
  return (
    <View style={s.card}>
      <Pressable style={s.head} onPress={onToggle} hitSlop={4}>
        <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={13} color={C.text3} />
        <Text style={s.title}>模型思考过程</Text>
        <Text style={s.meta}>{fmtCount(text.length)} 字</Text>
      </Pressable>
      {expanded ? (
        <ScrollView
          style={[s.scroll, { maxHeight: height }]}
          contentContainerStyle={s.scrollBody}
          nestedScrollEnabled
        >
          <Text style={s.text}>{text}</Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    marginBottom: 14,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  title: { flex: 1, fontSize: 12, color: C.text2 },
  meta: { fontSize: 11, color: C.text3, fontVariant: ['tabular-nums'] },
  scroll: { backgroundColor: C.hairSoft, marginHorizontal: 12, marginBottom: 12, borderRadius: R.btn },
  scrollBody: { padding: 10 },
  text: { fontSize: 12, lineHeight: 20, color: C.text2 },
});
