/**
 * 流式生成时的实时面板：转圈 + 已用秒数 + 思维链滚动区 + 字数统计。
 *
 * 和 OrganizeScreen 里那个同名面板是同一套观感，但这里自带样式、
 * 不依赖任何页面的 StyleSheet —— 周期总结和知识库问答都要用它。
 */
import React, { useRef } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ScrollViewInstance } from 'react-native';
import { C, R } from '../theme';

function fmtCount(n: number) {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

interface Props {
  /** 面板标题，如「正在写这一周的小结…」 */
  title: string;
  /** 思维链累积全文 */
  text: string;
  /** 已接收正文的字符数 */
  received: number;
  /** 已用秒数 */
  elapsed: number;
  /** 本轮是否开着思考模式，用来解释「为什么这里空着」 */
  thinking: boolean;
  /** 高度上限，默认 200 */
  height?: number;
}

export function ReasoningStream({ title, text, received, elapsed, thinking, height = 200 }: Props) {
  const scrollRef = useRef<ScrollViewInstance>(null);
  return (
    <View style={s.card}>
      <View style={s.head}>
        <ActivityIndicator size="small" color={C.accent} />
        <Text style={s.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={s.clock}>{elapsed}s</Text>
      </View>

      {text ? (
        <ScrollView
          ref={scrollRef}
          style={[s.scroll, { maxHeight: height }]}
          contentContainerStyle={s.scrollBody}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          <Text style={s.text}>{text}</Text>
        </ScrollView>
      ) : (
        <Text style={s.empty}>
          {thinking ? '模型正在通读这些碎片，还没开始落笔…' : '当前没开思考模式，只能等结果出来'}
        </Text>
      )}

      <View style={s.foot}>
        <Text style={s.meta}>{text ? `思考 ${fmtCount(text.length)} 字` : '等待首字'}</Text>
        <Text style={s.meta}>{received ? `结果 ${fmtCount(received)} 字` : '结果未开始'}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.accentBg,
    padding: 12,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 13, color: C.text, fontWeight: '500' },
  clock: { fontSize: 11, color: C.text3, fontVariant: ['tabular-nums'] },
  scroll: { marginTop: 9, backgroundColor: C.hairSoft, borderRadius: R.btn },
  scrollBody: { padding: 10 },
  text: { fontSize: 12, lineHeight: 19, color: C.text2 },
  empty: { fontSize: 12, color: C.text3, lineHeight: 19, marginTop: 9 },
  foot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 9 },
  meta: { fontSize: 11, color: C.text3, fontVariant: ['tabular-nums'] },
});
