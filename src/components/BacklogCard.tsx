/**
 * 整理页里的「哪些月还没写总结」卡片。
 *
 * 小结不在这里生成 —— 点一条进月度总结面板，预览完再决定存不存。
 * 这条分工是刻意的：整理一次只看 30 条碎片，可能只是某个月的一部分，
 * 在这里顺手写总结必然写残。
 *
 * v0.15 起只列月份。日/周两种粒度下线后，这张卡片从「按粒度配额挑几个」
 * 变成「按月倒序取前几条」，行首那个「日/周/月」标记也就没有区分作用了。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { R, useThemedStyles, type Palette } from '../theme';
import { periodLabel } from '../util/date';
import type { Backlog } from '../util/digest';

interface Props {
  backlog: Backlog;
  onPick: (period: string) => void;
}

export function BacklogCard({ backlog, onPick }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  if (!backlog.items.length) return null;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Ionicons name="sparkles-outline" size={14} color={c.accentText} />
        <Text style={styles.title}>
          {backlog.total} 个月还没写总结
          {backlog.total > backlog.items.length ? `（列前 ${backlog.items.length} 条）` : ''}
        </Text>
      </View>
      <Text style={styles.hint}>点一条去写那个月，生成完先预览、再决定存不存。</Text>

      {backlog.items.map((b) => (
        <Pressable
          key={b.period}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.hairSoft }]}
          onPress={() => onPick(b.period)}
        >
          <Text style={styles.period}>{periodLabel(b.period)}</Text>
          <Text style={styles.count}>{b.count} 条</Text>
          <Ionicons name="chevron-forward" size={13} color={c.text3} />
        </Pressable>
      ))}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  card: {
    alignSelf: 'stretch',
    marginTop: 18,
    backgroundColor: c.accentBg,
    borderRadius: R.card,
    paddingHorizontal: 14,
    paddingTop: 13,
    paddingBottom: 6,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { flex: 1, fontSize: 13, color: c.accentText, fontWeight: '500' },
  hint: { fontSize: 11, color: c.accentText, opacity: 0.8, lineHeight: 17, marginTop: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.accentHair,
  },
  period: { flex: 1, fontSize: 13, color: c.accentText },
  count: { fontSize: 11, color: c.accentText, opacity: 0.7 },
});
