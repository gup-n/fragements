/**
 * 整理页里的「哪些周期还没写小结」卡片。
 *
 * 小结不在这里生成 —— 点一条进周期总结面板，预览完再决定存不存。
 * 这条分工是刻意的：整理一次只看 30 条碎片，可能只是某个周期的一部分，
 * 在这里顺手写小结必然写残。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { DigestKind } from '../types';
import { R, useThemedStyles, type Palette } from '../theme';
import { periodLabel, todayISO } from '../util/date';
import type { Backlog } from '../util/digest';

/** 行首的粒度标记 */
const DIGEST_TAG: Record<DigestKind, string> = { daily: '日', weekly: '周', monthly: '月' };

interface Props {
  backlog: Backlog;
  onPick: (kind: DigestKind, period: string) => void;
}

export function BacklogCard({ backlog, onPick }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  if (!backlog.items.length) return null;
  const today = todayISO();
  const hasRunning = backlog.items.some((b) => b.period === today && b.kind === 'daily');

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Ionicons name="sparkles-outline" size={14} color={c.accentText} />
        <Text style={styles.title}>
          {backlog.total} 个周期还没写小结
          {backlog.total > backlog.items.length ? `（列前 ${backlog.items.length} 条）` : ''}
        </Text>
      </View>
      <Text style={styles.hint}>
        点一条去生成那一条，生成完先预览、再决定存不存。
        {hasRunning ? '今天那条只统计到此刻。' : ''}
      </Text>

      {backlog.items.map((b) => {
        const isToday = b.kind === 'daily' && b.period === today;
        return (
          <Pressable
            key={`${b.kind}|${b.period}`}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.hairSoft }]}
            onPress={() => onPick(b.kind, b.period)}
          >
            <Text style={styles.kind}>{DIGEST_TAG[b.kind]}</Text>
            <Text style={styles.period}>{isToday ? '今天' : periodLabel(b.period)}</Text>
            <Text style={styles.count}>{b.count} 条</Text>
            <Ionicons name="chevron-forward" size={13} color={c.text3} />
          </Pressable>
        );
      })}
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
  kind: { fontSize: 11, color: c.accentText, fontWeight: '600', width: 14 },
  period: { flex: 1, fontSize: 13, color: c.accentText },
  count: { fontSize: 11, color: c.accentText, opacity: 0.7 },
});
