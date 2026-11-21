/**
 * 整屏兜底：库打不开，或者库打开了但首屏读不出来（v0.35 / v0.36）。
 *
 * 之前 `repo.init()` 失败只 `console.warn`，然后 `setBooted(true)` 照常进门：
 * 列表是空的、统计是 0 条，首页还写着「还没有碎片，记一条试试」——
 * 用户看到的是「我的记录没了」，而记录其实好端端躺在库里。
 *
 * 这块屏幕只做一件事：把「数据还在、别卸载」说清楚，并给一个真的能按的重试。
 * 不做「从备份恢复」入口：那条路依赖已经打开的库，正是现在没有的东西。
 *
 * 默认文案是「库打不开」；首屏读库失败复用同一个组件，只换标题/正文/重试文案
 * （`App.tsx` 的 `loadError`）。**不要再写第二块错误屏** —— 两份文案迟早不一致。
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SPACE, TYPE, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';

export function BootError({
  detail,
  busy,
  onRetry,
  title = '数据打不开',
  body = '你的记录还在手机上，这次只是没能打开数据库。',
  warn = '先不要卸载应用 —— 卸载会连同这些记录一起删掉。',
  hint = '反复失败的话，先看看手机存储是不是满了。',
  retryLabel = '重试',
  retryAccessibilityLabel = '重新打开数据库',
}: {
  detail: string;
  /** 正在重试。没有这个反馈，用户会以为按钮没反应，连着点 */
  busy: boolean;
  onRetry: () => void;
  /** 标题。首屏读库失败时用「数据没读出来」，不要说成数据库打不开 */
  title?: string;
  body?: string;
  /** 整块屏幕上最要紧的那句：卸载 = 删数据 */
  warn?: string;
  hint?: string;
  retryLabel?: string;
  retryAccessibilityLabel?: string;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.root}>
        <View style={styles.icon}>
          <Ionicons name="alert-circle-outline" size={26} color={c.danger} accessible={false} />
        </View>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        <Text style={styles.body}>{body}</Text>
        <Text style={styles.warn}>{warn}</Text>
        {detail ? (
          <View style={styles.detailBox}>
            <Text style={styles.detail} numberOfLines={6}>
              {detail}
            </Text>
          </View>
        ) : null}
        <Pressable
          onPress={onRetry}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={retryAccessibilityLabel}
          accessibilityState={{ disabled: busy, busy }}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed, busy && styles.btnBusy]}
        >
          <Text style={styles.btnText}>{busy ? '正在重试…' : retryLabel}</Text>
        </Pressable>
        <Text style={styles.hint}>{hint}</Text>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.page },
    root: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: SPACE.xl,
      gap: SPACE.sm,
    },
    icon: {
      width: metrics.controlHeight,
      height: metrics.controlHeight,
      borderRadius: metrics.controlHeight / 2,
      backgroundColor: c.dangerBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: { ...TYPE.heading, color: c.text, textAlign: 'center', maxWidth: 360 },
    body: { ...TYPE.body, color: c.text2, textAlign: 'center', maxWidth: 360 },
    /** 这一句是整块屏幕上最要紧的：卸载 = 删数据，不能和普通说明同一个分量 */
    warn: { ...TYPE.compact, color: c.text, fontWeight: '600', textAlign: 'center', maxWidth: 360 },
    detailBox: {
      marginTop: SPACE.xs,
      paddingVertical: SPACE.xs,
      paddingHorizontal: SPACE.sm,
      borderRadius: metrics.buttonRadius,
      backgroundColor: c.hairSoft,
      maxWidth: 360,
    },
    detail: { ...TYPE.meta, color: c.text3, textAlign: 'center' },
    btn: {
      marginTop: SPACE.sm,
      minHeight: metrics.controlHeight,
      paddingHorizontal: SPACE.xxl,
      justifyContent: 'center',
      borderRadius: metrics.buttonRadius,
      backgroundColor: c.accent,
    },
    btnPressed: { backgroundColor: c.accentText },
    btnBusy: { opacity: 0.6 },
    btnText: { ...TYPE.label, color: c.onAccent, fontWeight: '600' },
    hint: { ...TYPE.meta, color: c.text3, textAlign: 'center', maxWidth: 360 },
  });
