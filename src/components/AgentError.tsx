/**
 * AI 失败时摆在对话里的那张卡。
 *
 * 为什么不只显示一句人话：用户遇到的失败里，有一半是「重试一百次也没用」的那种
 * （模型名不存在、余额不足、额度被思考链吃光、第三方网关返回 HTML）。
 * 只给一句「整理失败，再试一次」，等于把唯一能定位问题的证据扔掉了。
 *
 * 所以这张卡分两层：
 * - 上面一行是**能直接读的原因**；
 * - 展开之后是**原始证据**：哪一步、HTTP 几几几、finish_reason、服务端或模型的原话。
 *
 * 默认收起而不是默认摊开：正文错了的时候用户只想知道「怎么了 + 怎么办」，
 * 一屏 JSON 会把「重试」按钮挤没；但入口必须看得见，不能藏在长按菜单里。
 */
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import type { AiErrorDetail } from '../ai/chat';

interface Props {
  /** 一句话原因（AiError.message） */
  message: string;
  /** 错误码，显示在标题栏，方便对照文档 */
  code?: string;
  detail?: AiErrorDetail;
  /** 标题前缀，比如「整理失败」「回答失败」 */
  title?: string;
  onRetry?: () => void;
}

/** 没有 AiError 时的兜底：至少别把未知错误吞掉 */
export function errorDetailOf(e: unknown): { message: string; code?: string; detail?: AiErrorDetail } {
  if (e instanceof Error) {
    const any = e as any;
    return {
      message: e.message || '未知错误',
      code: typeof any.code === 'string' ? any.code : undefined,
      detail: any.detail,
    };
  }
  return { message: typeof e === 'string' ? e : '未知错误' };
}

export function AgentError({ message, code, detail, title = '出错了', onRetry }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  const rows: [string, string][] = [];
  if (detail?.stage) rows.push(['阶段', detail.stage]);
  if (detail?.status) rows.push(['HTTP', String(detail.status)]);
  if (detail?.finish !== undefined && detail.finish !== null) {
    rows.push(['finish_reason', detail.finish]);
  }
  const hasMore = rows.length > 0 || !!detail?.raw;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Ionicons name="alert-circle-outline" size={20} color={c.danger} accessible={false} />
        <Text style={styles.title} accessibilityRole="header">{title}</Text>
        {code ? <Text style={styles.code}>{code}</Text> : null}
      </View>

      <Text style={styles.message} selectable accessibilityLiveRegion="polite">
        {message}
      </Text>

      <View style={styles.actions}>
        {onRetry ? (
          <Pressable style={[styles.retry, styles.touchTarget]} onPress={onRetry} accessibilityRole="button">
            <Ionicons name="refresh" size={13} color={c.text} />
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        ) : null}
        {hasMore ? (
          <Pressable
            style={[styles.more, styles.touchTarget]}
            onPress={() => setOpen((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }} accessibilityLabel={open ? '收起错误详情' : '展开错误详情'}
          >
            <Text style={styles.moreText}>{open ? '收起详情' : '查看详情'}</Text>
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={12} color={c.text3} />
          </Pressable>
        ) : null}
      </View>

      {open ? (
        <View style={styles.detailBox}>
          {rows.map(([k, v]) => (
            <View key={k} style={styles.kvRow}>
              <Text style={styles.k}>{k}</Text>
              <Text style={styles.v} selectable>
                {v}
              </Text>
            </View>
          ))}
          {detail?.raw ? (
            <ScrollView style={styles.rawBox} nestedScrollEnabled showsVerticalScrollIndicator>
              <Text style={styles.raw} selectable>
                {detail.raw}
              </Text>
            </ScrollView>
          ) : null}
          {/* 「拿着它去搜，比『再试一次』有用」已删：这句是在教育用户，而不是提供信息 */}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  touchTarget: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight },
  /**
   * 错误卡：整块 dangerBg 起底 + 左边一道 2dp 的红。
   *
   * 左边线是刻意的：一眼能在长对话里认出「这里是坏的」。
   * 其余三边不描边 —— 原来套了一整圈 hair，只为了收个边，反而让红条显得像装饰。
   */
  card: {
    backgroundColor: c.dangerBg,
    borderRadius: metrics.cardRadius,
    borderLeftWidth: metrics.strokeWidth * 2, borderLeftColor: c.danger,
    padding: SPACE.md, marginTop: SPACE.md, gap: SPACE.xs,
  },
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs },
  title: { ...TYPE.label, color: c.danger, flexShrink: 1 },
  code: { ...TYPE.meta, color: c.text2, fontVariant: ['tabular-nums'], flexShrink: 1 },
  message: { ...TYPE.compact, color: c.text },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.sm },
  retry: {
    minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs,
    paddingHorizontal: SPACE.md,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.card,
  },
  retryText: { ...TYPE.label, color: c.text },
  more: {
    minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    flexDirection: 'row', alignItems: 'center', gap: SPACE.xs,
    paddingHorizontal: SPACE.xs,
  },
  moreText: { ...TYPE.label, color: c.text2 },
  detailBox: { gap: SPACE.xs, paddingTop: SPACE.sm, borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair },
  kvRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  k: { ...TYPE.meta, minWidth: 96, color: c.text2 },
  v: { ...TYPE.meta, flex: 1, minWidth: 100, color: c.text },
  rawBox: { maxHeight: 248, backgroundColor: c.card, borderRadius: metrics.buttonRadius, padding: SPACE.sm },
  raw: { ...TYPE.meta, color: c.text2, fontFamily: Platform.OS === 'android' ? 'monospace' : undefined },
});
