/**
 * 审批 AI 的提案（v0.28）。
 *
 * 形状借用了月总结面板：整屏覆盖、可滚动正文、底部三个决定。理由也一样 ——
 * 用户要对着一大段正文做判断，半屏弹窗一屏只放得下五行，滚起来还要和背后的列表抢手势。
 *
 * 三个出口对应三条真实路径（设计稿第四节）：
 * - **存为新文档**：新写一篇 `origin='knowledge'`，原稿一个字不动；
 * - **只存标签**：只动 `doc_tag_links`；
 * - **放弃**：什么都不写，提案留一条 rejected 审计。
 */
import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { DocProposal, Document } from '../types';
import { R, SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { BusyIndicator as ActivityIndicator } from '../components/BusyIndicator';
import { ScreenHeader } from '../components/ScreenHeader';
import { approveProposal, rejectProposal } from '../documents/proposals';
import { PROPOSAL_LABEL, diffSummary, proposalTitle } from '../util/proposal';

export type ProposalDecision =
  | { kind: 'saved'; docId: number | null; tags: string[] }
  | { kind: 'rejected' }
  | { kind: 'dismissed' };

interface Props {
  proposal: DocProposal;
  /** 原稿。取不到时只能看建议，界面上要如实说 */
  original: Document | null;
  onDone: (decision: ProposalDecision) => void;
}

export function ProposalSheet({ proposal, original, onDone }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [tab, setTab] = useState<'suggest' | 'origin'>('suggest');
  const [busy, setBusy] = useState<'newDoc' | 'tagsOnly' | 'reject' | null>(null);
  const [error, setError] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const payload = proposal.payload;
  const hasBody = !!payload.bodyMd;
  const tags = payload.tags ?? [];
  const shownText = tab === 'suggest' ? payload.bodyMd ?? '' : original?.bodyMd ?? '';

  function dismiss() {
    if (busy) return;
    onDone({ kind: 'dismissed' });
  }

  const liveDismiss = useRef(dismiss);
  liveDismiss.current = dismiss;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { liveDismiss.current(); return true; });
    return () => sub.remove();
  }, []);

  async function decide(choice: 'newDoc' | 'tagsOnly') {
    if (busy) return;
    setBusy(choice);
    setError('');
    try {
      const result = await approveProposal(proposal, choice);
      if (!alive.current) return;
      onDone({ kind: 'saved', docId: result.docId, tags: result.tags });
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : '没有存进去，原稿没有受影响');
        setBusy(null);
      }
    }
  }

  async function drop() {
    if (busy) return;
    setBusy('reject');
    try {
      await rejectProposal(proposal.id);
      if (alive.current) onDone({ kind: 'rejected' });
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : '没能标记为放弃，再试一次');
        setBusy(null);
      }
    }
  }

  return (
    <View style={styles.root} accessibilityViewIsModal>
      <ScreenHeader
        title={proposalTitle(proposal.kind)}
        subtitle={`${PROPOSAL_LABEL[proposal.kind]} · ${original?.name ?? '原稿已不在'}`}
        backIcon="close"
        backLabel="先放着"
        onBack={dismiss}
      />

      <View style={styles.meta}>
        {payload.note ? <Text style={styles.note}>{payload.note}</Text> : null}
        {hasBody ? (
          <Text style={styles.diff}>{diffSummary(original?.bodyMd ?? '', payload.bodyMd ?? '')}</Text>
        ) : null}
        {tags.length ? (
          <View style={styles.tagWrap}>
            {tags.map((name) => (
              <View key={name} style={styles.tag}>
                <Text style={styles.tagText}>{name}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {/* 建议 / 原文 两个页签：手机上左右并排根本放不下两段正文 */}
      {hasBody ? (
        <View style={styles.tabs}>
          {(['suggest', 'origin'] as const).map((key) => (
            <Pressable
              key={key}
              style={[styles.tab, tab === key && styles.tabOn]}
              onPress={() => setTab(key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === key }}
              accessibilityLabel={key === 'suggest' ? '看建议的正文' : '看原稿'}
            >
              <Text style={[styles.tabText, tab === key && styles.tabTextOn]}>
                {key === 'suggest' ? '建议' : '原稿'}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        <Text style={styles.bodyText} selectable>
          {shownText || '（这一段是空的）'}
        </Text>
      </ScrollView>

      <View style={styles.footer}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.hint}>
          {hasBody
            ? '存为新文档之后，原稿还在原处，一个字都不会变。'
            : '这条提案只有标签，可以直接挂上。'}
        </Text>
        <View style={styles.actions}>
          <Pressable
            style={({ pressed }) => [styles.ghost, pressed && { opacity: 0.7 }]}
            onPress={() => void drop()}
            disabled={!!busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: !!busy }}
            accessibilityLabel="放弃这条建议"
          >
            <Text style={styles.ghostText}>{busy === 'reject' ? '正在放弃…' : '放弃'}</Text>
          </Pressable>
          {hasBody ? (
            <Pressable
              style={({ pressed }) => [styles.ghost, pressed && { opacity: 0.7 }]}
              onPress={() => void decide('tagsOnly')}
              disabled={!!busy || !tags.length}
              accessibilityRole="button"
              accessibilityState={{ disabled: !!busy || !tags.length }}
              accessibilityLabel="只存标签，不改正文"
            >
              <Text style={[styles.ghostText, !tags.length && styles.off]}>只存标签</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={({ pressed }) => [styles.primary, pressed && { opacity: 0.85 }, busy && styles.off]}
            onPress={() => void decide(hasBody ? 'newDoc' : 'tagsOnly')}
            disabled={!!busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: !!busy, busy: !!busy }}
            accessibilityLabel={hasBody ? '存为新文档' : '挂上这些标签'}
          >
            {busy && busy !== 'reject' ? (
              <ActivityIndicator size="small" color={c.onAccent} />
            ) : (
              <>
                <Ionicons name={hasBody ? 'add-circle-outline' : 'pricetag-outline'} size={16} color={c.onAccent} />
                <Text style={styles.primaryText}>{hasBody ? '存为新文档' : '挂上标签'}</Text>
              </>
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.page },
  meta: {
    paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.sm, gap: SPACE.xs,
    borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair,
  },
  note: { ...TYPE.compact, color: c.text2 },
  diff: { ...TYPE.label, color: c.accentText, fontVariant: ['tabular-nums'] },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  tag: { minHeight: 28, paddingHorizontal: SPACE.sm, borderRadius: R.pill, backgroundColor: c.accentBg, justifyContent: 'center' },
  tagText: { ...TYPE.label, color: c.accentText },
  tabs: { flexDirection: 'row', gap: SPACE.xs, paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.sm },
  tab: {
    flex: 1, minHeight: 36, borderRadius: metrics.buttonRadius, backgroundColor: c.hairSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  tabOn: { backgroundColor: c.accentBg },
  tabText: { ...TYPE.label, color: c.text2 },
  tabTextOn: { color: c.accentText, fontWeight: '600' },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.md },
  bodyText: { ...TYPE.body, color: c.text, lineHeight: 24 },
  footer: {
    paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.sm, gap: SPACE.xs,
    borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair, backgroundColor: c.page,
  },
  hint: { ...TYPE.meta, color: c.text2 },
  error: { ...TYPE.compact, color: c.danger },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  ghost: {
    flexGrow: 1, flexBasis: 88, minHeight: metrics.controlHeight, paddingHorizontal: SPACE.sm,
    borderRadius: metrics.buttonRadius, backgroundColor: c.hairSoft, alignItems: 'center', justifyContent: 'center',
  },
  ghostText: { ...TYPE.label, color: c.text, textAlign: 'center' },
  off: { opacity: 0.45 },
  primary: {
    flexGrow: 1.4, flexBasis: 120, minHeight: metrics.controlHeight, flexDirection: 'row', gap: SPACE.xs,
    borderRadius: metrics.buttonRadius, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center',
  },
  primaryText: { ...TYPE.body, color: c.onAccent, fontWeight: '600' },
});
