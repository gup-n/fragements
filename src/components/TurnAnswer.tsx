/**
 * 一条回答：正文（带可点的引用小标）+ 引用来源 + 网页来源。
 *
 * 从 `AskScreen.tsx` 里搬出来的（v0.24）。它自带两处状态（来源列表展开、链接打不开的原因），
 * 但**不读写页面的任何状态** —— 这是能搬的边界。样式跟着一起走：`makeTurnStyles` 同时被
 * 页面和这里引用（页面里「整理轮」「待发问」也用 `aRow` / `aText`），所以它必须导出，
 * 不能让两边各写一份。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import type { QaCitation, QaTurn } from '../types';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import type { CiteRef } from '../util/mdBlocks';
import { citeKey, coverageLine, orderedCitations } from '../util/askText';
import { NoteBody } from './NoteBody';

/**
 * 底部的版本操作（v0.33）。整理轮不传这个 prop —— 它没有「重新生成」这回事。
 *
 * 为什么这些回调从页面传进来而不是在这里自己调：只有 AskScreen 知道
 * 「前面几轮上下文是什么」「这一轮存到哪」，组件只管画三个按钮。
 */
export interface TurnActions {
  /** 这一轮是第几轮（页面用来重新生成 / 改问题） */
  index: number;
  /** 一共几版 */
  total: number;
  /** 当前显示第几版（0 起） */
  active: number;
  /** 有问答在进行时，这些按钮全部禁用，免得把状态搅乱 */
  disabled: boolean;
  /**
   * 这一轮后面还有别的问答 → 操作行先收起成一枚「⋯」。
   *
   * 十几轮历史每轮底下都摊三个按钮，屏幕会变成一片小字；
   * 但**最新那一轮必须摊开** —— 用户想重新生成的多半正是刚看完的这条。
   */
  collapsible?: boolean;
  onRegenerate: () => void;
  onEdit: () => void;
  onSwitch: (index: number) => void;
}

interface Props {
  turn: QaTurn;
  onCite: (cite: QaCitation) => void;
  actions?: TurnActions;
}

export function TurnAnswer({ turn, onCite, actions }: Props) {
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
  /** 刚点了「复制」：按钮上换成「已复制」，1.6 秒后自己变回来 */
  const [copied, setCopied] = useState(false);
  /** 旧轮次的操作行默认收起，点「⋯」才摊开 */
  const [more, setMore] = useState(false);
  const showActions = !actions?.collapsible || more;

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyAnswer = useCallback(() => {
    void Clipboard.setStringAsync(turn.answer).then(() => setCopied(true)).catch(() => undefined);
  }, [turn.answer]);

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

      {/*
        版本操作（v0.33，抄 chat-demo 的 message actions + branch switcher）。
        放在最底下：先读答案，读完才需要「再来一遍 / 改问题 / 切回上一版」。
        高度 36 + 上下各 6 的 hitSlop = 48 的触控区，看得见的槽比手指小。
      */}
      {actions ? (
        <View style={styles.actRow}>
          {showActions ? (
            <>
              <Pressable
                style={({ pressed }) => [styles.actBtn, pressed && styles.actBtnPressed]}
                hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
                onPress={actions.onRegenerate}
                disabled={actions.disabled}
                accessibilityRole="button"
                accessibilityLabel="重新生成这一轮回答"
                accessibilityState={{ disabled: actions.disabled }}
              >
                <Ionicons name="refresh-outline" size={13} color={c.text3} />
                <Text style={styles.actText}>重新生成</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.actBtn, pressed && styles.actBtnPressed]}
                hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
                onPress={actions.onEdit}
                disabled={actions.disabled}
                accessibilityRole="button"
                accessibilityLabel="修改这一轮的问题"
                accessibilityState={{ disabled: actions.disabled }}
              >
                <Ionicons name="create-outline" size={13} color={c.text3} />
                <Text style={styles.actText}>改问题</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.actBtn, pressed && styles.actBtnPressed]}
                hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
                onPress={copyAnswer}
                accessibilityRole="button"
                accessibilityLabel={copied ? '已复制回答' : '复制这一轮回答'}
              >
                <Ionicons
                  name={copied ? 'checkmark-outline' : 'copy-outline'}
                  size={13}
                  color={copied ? c.accentText : c.text3}
                />
                <Text style={[styles.actText, copied && { color: c.accentText }]}>
                  {copied ? '已复制' : '复制'}
                </Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              style={({ pressed }) => [styles.actBtn, pressed && styles.actBtnPressed]}
              hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
              onPress={() => setMore(true)}
              accessibilityRole="button"
              accessibilityLabel="展开这一轮的操作"
            >
              <Ionicons name="ellipsis-horizontal" size={14} color={c.text3} />
            </Pressable>
          )}

          {actions.total > 1 ? (
            <View style={styles.variantBox}>
              <Pressable
                style={({ pressed }) => [styles.variantArrow, pressed && styles.actBtnPressed]}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                onPress={() => actions.onSwitch(actions.active - 1)}
                disabled={actions.disabled || actions.active <= 0}
                accessibilityRole="button"
                accessibilityLabel="上一版回答"
                accessibilityState={{ disabled: actions.disabled || actions.active <= 0 }}
              >
                <Ionicons
                  name="chevron-back"
                  size={14}
                  color={actions.active <= 0 ? c.hair : c.text2}
                />
              </Pressable>
              <Text style={styles.variantText} accessibilityLabel={`第 ${actions.active + 1} 版，共 ${actions.total} 版`}>
                {actions.active + 1} / {actions.total}
              </Text>
              <Pressable
                style={({ pressed }) => [styles.variantArrow, pressed && styles.actBtnPressed]}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                onPress={() => actions.onSwitch(actions.active + 1)}
                disabled={actions.disabled || actions.active >= actions.total - 1}
                accessibilityRole="button"
                accessibilityLabel="下一版回答"
                accessibilityState={{ disabled: actions.disabled || actions.active >= actions.total - 1 }}
              >
                <Ionicons
                  name="chevron-forward"
                  size={14}
                  color={actions.active >= actions.total - 1 ? c.hair : c.text2}
                />
              </Pressable>
            </View>
          ) : null}
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
    /** 版本操作那一行。36 的槽靠 hitSlop 补到 48，和 IconButton 的 compact 同一口径 */
    actRow: {
      flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs,
      marginTop: SPACE.xs, flexWrap: 'wrap',
    },
    actBtn: {
      minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs,
      paddingHorizontal: SPACE.xs, borderRadius: metrics.buttonRadius,
    },
    /** 按下只换底色（项目规则），不用 opacity 压字 */
    actBtnPressed: { backgroundColor: c.hairSoft },
    actText: { ...TYPE.meta, color: c.text3 },
    /** 版本切换贴右边：它是「同一问的第几版」，和左边三个动作不是一类 */
    variantBox: { flexDirection: 'row', alignItems: 'center', marginLeft: 'auto' },
    variantArrow: { minHeight: 36, minWidth: 24, alignItems: 'center', justifyContent: 'center' },
    variantText: { ...TYPE.meta, color: c.text2, fontVariant: ['tabular-nums'] },
  } as const;
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create(makeTurnStyles(c, metrics));
