/**
 * 空屏只有一种长相。
 *
 * 五个页面原来各写一遍同样的四行（圆形图标底 / 标题 / 说明 / 可选入口），
 * 份份都差一点：`maxWidth` 一处有一处没有（说明句在窄屏换行、在平板上拉成一整行），
 * 图标底有的用主色有的用灰、标题有的带 header 角色有的不带。
 * 「同一个概念只有一份实现」在样式上同样成立 —— 否则下一处新增页面又会是第六份。
 *
 * 三种形态：
 * - 中性（默认）：灰底 + 灰图标，用于「这里现在没东西」；
 * - `tone="accent"`：主色淡底 + 主色图标，只给「希望你做点什么」的整屏空屏用（时间轴）；
 * - `fill`：撑满剩余高度并垂直居中，用于列表为空时占住整块区域。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SPACE, TYPE, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { type IoniconName } from './IconButton';

interface Props {
  icon: IoniconName;
  title: string;
  /** 一句说明。不写就只显示标题 —— 空屏上的第二段解释通常没人读 */
  body?: string;
  /** 图标底与图标的色调。`plain` = 灰底灰图，`accent` = 淡蓝底蓝图 */
  tone?: 'plain' | 'accent';
  /** 图标颜色单独指定（比如灰底 + 主色图标）；不传就跟着 tone 走 */
  iconColor?: string;
  iconSize?: number;
  /** 撑满剩余高度、垂直居中 */
  fill?: boolean;
  /** 空屏下面的入口（按钮、入口列表） */
  children?: React.ReactNode;
}

export function EmptyState({
  icon,
  title,
  body,
  tone = 'plain',
  iconColor,
  iconSize = 22,
  fill = false,
  children,
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  return (
    <View style={[styles.root, fill && styles.fill]}>
      <View style={[styles.icon, tone === 'accent' && styles.iconAccent]}>
        <Ionicons
          name={icon}
          size={iconSize}
          color={iconColor ?? (tone === 'accent' ? c.accent : c.text3)}
          accessible={false}
        />
      </View>
      <Text style={styles.title} accessibilityRole="header">{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {children}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  root: { alignItems: 'center', gap: SPACE.sm, paddingTop: SPACE.xl },
  /**
   * 撑满时整块居中，底距留一个控件高度 —— 因为下面通常压着输入框，
   * 不留的话空屏会贴着输入框顶边，看着像被挡住。
   */
  fill: { flex: 1, justifyContent: 'center', paddingTop: 0, paddingBottom: metrics.controlHeight },
  /** 48 的圆（= 触控槽高度）：整屏空屏上它是唯一「有体积」的东西，再小就只剩一行字 */
  icon: {
    width: metrics.controlHeight, height: metrics.controlHeight, borderRadius: metrics.controlHeight / 2,
    backgroundColor: c.hairSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  iconAccent: { backgroundColor: c.accentBg },
  title: { ...TYPE.title, color: c.text, textAlign: 'center', maxWidth: 360 },
  body: { ...TYPE.compact, color: c.text2, textAlign: 'center', maxWidth: 360 },
});
