/**
 * 一句话提示条（「已复制」「已归档」这类）。
 *
 * 时间轴和「问」页都要用，所以单独一个组件而不是各页自己拼一个 Text ——
 * 两处高度 / 圆角 / 字色一旦不同，切页的时候能看出来闪一下。
 *
 * **不自己做定时器。** 谁触发谁负责清空（`setTimeout(() => setToast(null), 1600)`）：
 * 组件里藏一个定时器，连续点两次时后一次会被前一次的定时器提前清掉，
 * 表现是「第二次提示一闪就没了」，而且从组件代码上一眼看不出原因。
 *
 * `pointerEvents="none"` 是必须的：它浮在内容上方，拦截触摸会把下面的按钮变哑。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SPACE, TYPE, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';

/**
 * 底栏占的高度。**有底栏的页面必须用它算提示位置。**
 *
 * `bottom` 的默认值 24 只适合「页面底部就是屏幕底部」的场景。底栏一出现，
 * 那 52dp 就把提示条整个盖住了 —— 用户点了个按钮，什么都没看到，
 * 看起来像没生效。v0.20.9 的时间轴和文档页都踩了这个（当时给的是 24）。
 */
export const TAB_BAR_HEIGHT = 56;

interface Props {
  /** 为空就不画。清空由调用方的定时器负责 */
  text: string | null;
  /** 距内容区底部的距离。有底部工具栏或底栏的页面要往上抬 */
  bottom?: number;
}

export function Toast({ text, bottom = 24 }: Props) {
  const { styles } = useThemedStyles(makeStyles);
  if (!text) return null;

  return (
    <View style={[styles.wrap, { bottom }]} pointerEvents="none">
      <View style={styles.pill}>
        <Text style={styles.text} numberOfLines={3} accessibilityLiveRegion="polite">
          {text}
        </Text>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  /**
   * 反色药丸：底色用 `text`、字用 `card`（也就是反过来的那一层）。
   *
   * 不用写死的黑底白字 —— 深色模式下页面本来就近黑，黑药丸会糊进背景里，
   * 用户完全看不出提示出现过。跟着调色板反着来，两套主题都清晰。
   *
   * 不描边：反色本身已经是最高对比，外面再套一圈 0.5 的纸色只会显脏。
   */
  pill: {
    maxWidth: '90%',
    backgroundColor: c.text,
    borderRadius: metrics.buttonRadius,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
  },
  text: { ...TYPE.label, fontWeight: '500', color: c.card, textAlign: 'center' },
});
