/**
 * 一条回答：正文（带可点的引用小标）+ 引用来源 + 网页来源。
 *
 * 从 `AskScreen.tsx` 里搬出来的（v0.24）。它自带两处状态（来源列表展开、链接打不开的原因），
 * 但**不读写页面的任何状态** —— 这是能搬的边界。样式跟着一起走：`makeTurnStyles` 同时被
 * 页面和这里引用（页面里「整理轮」「待发问」也用 `aRow` / `aText`），所以它必须导出，
 * 不能让两边各写一份。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { QaCitation, QaTurn } from '../types';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import type { CiteRef } from '../util/mdBlocks';
import { citeKey, coverageLine, orderedCitations } from '../util/askText';
import { NoteBody } from './NoteBody';

interface Props {
  turn: QaTurn;
  onCite: (cite: QaCitation) => void;
}

export function TurnAnswer({ turn, onCite }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const cites = useMemo(() => orderedCitations(turn), [turn]);
  const labels = useMemo(
    () => new Map(cites.map((cite, i) => [citeKey(cite.kind, cite.id), String(i + 1)])),
    [cites],
  );
  const byKey = useMemo(
    () => new Map(cites.map((cite) => [citeKey(cite.kind, cite.id), cite])),
    [cites],
  );
  const [sourcesOpen, setSourcesOpen] = useState(false);
  /** 打不开链接的原因。就近写在那一块下面，不弹框 */
  const [linkErr, setLinkErr] = useState('');

  const citeLabel = useCallback(
    (ref: CiteRef) => labels.get(citeKey(ref.kind, ref.id)) ?? null,
    [labels],
  );
  const openCite = useCallback(
    (ref: CiteRef) => {
      const cite = byKey.get(citeKey(ref.kind, ref.id));
      if (cite) onCite(cite);
    },
    [byKey, onCite],
  );

  return (
    <View style={styles.aRow}>
      <NoteBody text={turn.answer} style={styles.aText} citeLabel={citeLabel} onCite={openCite} />

      {turn.documentCoverage?.length ? (
        <Text style={styles.covText}>{coverageLine(turn.documentCoverage)}</Text>
      ) : null}

      {cites.length > 0 ? (
        <View style={styles.srcBlock}>
          <Pressable
            style={styles.srcToggle}
            onPress={() => setSourcesOpen((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: sourcesOpen }}
            accessibilityLabel={sourcesOpen ? '收起引用来源' : '展开引用来源'}
          >
            <Ionicons name="link-outline" size={13} color={c.text3} />
            <Text style={styles.srcLabel}>参考 {cites.length} 条</Text>
            <Ionicons
              name={sourcesOpen ? 'chevron-up' : 'chevron-down'}
              size={12}
              color={c.text3}
            />
          </Pressable>

          {sourcesOpen
            ? cites.map((cite, i) => (
                <Pressable
                  key={citeKey(cite.kind, cite.id)}
                  style={styles.srcRow}
                  onPress={() => onCite(cite)}
                >
                  <Text style={styles.srcIndex}>{i + 1}</Text>
                  <Text style={styles.srcTitle} numberOfLines={1}>
                    {cite.label}
                  </Text>
                  <Ionicons name="chevron-forward" size={12} color={c.text3} />
                </Pressable>
              ))
            : null}
        </View>
      ) : null}

      {/*
        网页来源：**不依赖模型有没有写 [W 编号]**。
        它只在自己真的搜过网时出现，点一下直接开浏览器 ——
        用户说的「网页链接没法点」就是这里缺了一块：内容进了回答，链接却没落地。
      */}
      {turn.webSources?.length ? (
        <View style={styles.webBlock}>
          <Text style={styles.webTitle}>网页来源</Text>
          {turn.webSources.map((w) => (
            <Pressable
              key={w.url}
              style={({ pressed }) => [styles.webRow, pressed && { opacity: 0.6 }]}
              onPress={() => {
                setLinkErr('');
                Linking.openURL(w.url).catch(() =>
                  setLinkErr(`打不开这个链接：${w.url}`),
                );
              }}
              accessibilityRole="link"
              accessibilityLabel={`打开网页 ${w.title}`}
            >
              <Ionicons name="globe-outline" size={12} color={c.text3} />
              <Text style={styles.webRowText} numberOfLines={1}>
                {w.title}
              </Text>
              <Ionicons name="open-outline" size={12} color={c.text3} />
            </Pressable>
          ))}
          {linkErr ? <Text style={styles.webErr}>{linkErr}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * 回答区用到的样式。`aRow` / `aText` 被页面里另外两处复用（整理轮、待发问），
 * 所以在这里导出、由页面 spread 进自己的 `StyleSheet.create`，不各写一份。
 */
export function makeTurnStyles(c: Palette, metrics: ThemeMetrics) {
  return {
    aRow: { marginBottom: SPACE.sm, gap: SPACE.xs },
    aText: { ...TYPE.body, color: c.text },
    covText: {
      ...TYPE.meta, color: c.text2, marginTop: SPACE.xs,
      paddingLeft: SPACE.sm, borderLeftWidth: surfaceStroke(metrics), borderLeftColor: c.hair,
    },
    srcBlock: { marginTop: SPACE.xs, gap: SPACE.xxs },
    srcToggle: { minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, alignSelf: 'flex-start' },
    srcLabel: { ...TYPE.label, color: c.text2 },
    srcRow: {
      minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
      borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair,
      paddingHorizontal: SPACE.xs, paddingVertical: SPACE.sm,
    },
    srcIndex: {
      ...TYPE.meta, minWidth: SPACE.xl, color: c.accentText, fontWeight: '600', textAlign: 'center',
      backgroundColor: c.accentBg, borderRadius: metrics.buttonRadius,
      paddingVertical: SPACE.xxs, overflow: 'hidden',
    },
    srcTitle: { ...TYPE.body, flex: 1, color: c.text2 },
    webBlock: { marginTop: SPACE.sm, paddingTop: SPACE.xs, gap: SPACE.xxs, borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair },
    webTitle: { ...TYPE.label, color: c.text2 },
    webRow: { minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, paddingVertical: SPACE.xs },
    webRowText: { ...TYPE.body, flex: 1, color: c.accentText },
    webErr: { ...TYPE.meta, color: c.danger },
  } as const;
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create(makeTurnStyles(c, metrics));
