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
import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { R, useThemedStyles, type Palette } from '../theme';
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
        <Ionicons name="alert-circle" size={15} color={c.danger} />
        <Text style={styles.title}>{title}</Text>
        {code ? <Text style={styles.code}>{code}</Text> : null}
      </View>

      <Text style={styles.message} selectable>
        {message}
      </Text>

      <View style={styles.actions}>
        {onRetry ? (
          <Pressable style={styles.retry} onPress={onRetry} hitSlop={6}>
            <Ionicons name="refresh" size={13} color={c.text} />
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        ) : null}
        {hasMore ? (
          <Pressable
            style={styles.more}
            onPress={() => setOpen((v) => !v)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={open ? '收起错误详情' : '展开错误详情'}
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
            <ScrollView style={styles.rawBox} nestedScrollEnabled showsVerticalScrollIndicator={false}>
              <Text style={styles.raw} selectable>
                {detail.raw}
              </Text>
            </ScrollView>
          ) : null}
          <Text style={styles.hint}>
            上面是服务端或模型的原话。拿着它去搜，比「再试一次」有用。
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  card: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    paddingHorizontal: 13,
    paddingVertical: 11,
    marginTop: 12,
    gap: 7,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontSize: 12.5, color: c.danger, fontWeight: '600' },
  code: { fontSize: 10, color: c.text3, fontVariant: ['tabular-nums'] },
  message: { fontSize: 13, lineHeight: 20, color: c.text },

  actions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  retry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: R.pill,
    borderWidth: 0.5,
    borderColor: c.hair,
  },
  retryText: { fontSize: 12, color: c.text },
  more: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  moreText: { fontSize: 11.5, color: c.text3 },

  detailBox: {
    gap: 6,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
  },
  kvRow: { flexDirection: 'row', gap: 8 },
  k: { width: 96, fontSize: 11, color: c.text3 },
  v: { flex: 1, fontSize: 11, color: c.text2 },
  rawBox: {
    maxHeight: 220,
    backgroundColor: c.hairSoft,
    borderRadius: R.btn,
    padding: 9,
  },
  raw: {
    fontSize: 11,
    lineHeight: 17,
    color: c.text2,
    fontFamily: Platform.OS === 'android' ? 'monospace' : undefined,
  },
  hint: { fontSize: 10.5, lineHeight: 15, color: c.text3 },
});
