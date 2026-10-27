/**
 * 「深度思考 12 秒 ›」—— 回答出来之后，思维链默认收成一行。
 *
 * 生成时它是要一直盯着看的（那是「模型还在干活」的唯一证据），
 * 但答案一落地，思维链就变成了次要信息：占了半屏、把回答挤到下面，
 * 而九成情况下用户根本不会读第二遍。所以默认折叠，想看再点开。
 *
 * 秒数是**整轮耗时**，不是思考阶段的耗时 —— DeepSeek 的流式响应里
 * 没有「思考结束」这个事件，硬拆只能靠首字时间猜，估出来的数字反而误导。
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { R, useThemedStyles, type Palette } from '../theme';

function fmtCount(n: number) {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

interface Props {
  /** 思维链全文 */
  text: string;
  /** 这一轮总共花了多少秒 */
  seconds: number;
}

/**
 * 展开时最多渲染多少字。
 *
 * v0.6.3 把输出额度提到 64K 之后，思考链动辄几万字。RN 的文本布局是线性的，
 * 一次性丢几万字进去在真机上会明显卡顿 —— 而开头那段「让我看看这些碎片……」
 * 本来就没有信息量，结论都在尾部。所以只留尾段，标题上的字数是全文的。
 */
const TAIL_CHARS = 8_000;

export function ReasoningCollapse({ text, seconds }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const shown = text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text;
  const omitted = text.length - shown.length;

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        hitSlop={6}
        style={({ pressed }) => [styles.head, pressed && { opacity: 0.6 }]}
      >
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={13} color={c.text3} />
        <Text style={styles.title}>深度思考 {seconds} 秒</Text>
        <Text style={styles.meta}>{fmtCount(text.length)} 字</Text>
      </Pressable>

      {open ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.body} nestedScrollEnabled>
          {omitted > 0 ? (
            <Text style={styles.omitted}>… 前面 {fmtCount(omitted)} 字已省略，这里只留最后的推演</Text>
          ) : null}
          <Text style={styles.text}>{shown}</Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  wrap: { marginTop: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4 },
  title: { flex: 1, fontSize: 12, color: c.text3 },
  meta: { fontSize: 11, color: c.text3, fontVariant: ['tabular-nums'] },
  scroll: { maxHeight: 260, marginTop: 4, backgroundColor: c.hairSoft, borderRadius: R.btn },
  body: { padding: 10 },
  omitted: { fontSize: 11, color: c.text3, marginBottom: 6, fontStyle: 'italic' },
  text: { fontSize: 12, lineHeight: 19, color: c.text2 },
});
