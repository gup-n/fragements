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
import { useThemedStyles, type Palette } from '../theme';

interface Props {
  /** 为空就不画。清空由调用方的定时器负责 */
  text: string | null;
  /** 距内容区底部的距离。有底部工具栏的页面要往上抬一点 */
  bottom?: number;
}

export function Toast({ text, bottom = 24 }: Props) {
  const { styles } = useThemedStyles(makeStyles);
  if (!text) return null;

  return (
    <View style={[styles.wrap, { bottom }]} pointerEvents="none">
      <View style={styles.pill}>
        <Text style={styles.text} numberOfLines={2}>
          {text}
        </Text>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  /**
   * 反色药丸：底色用 `text`、字用 `page`。
   *
   * 不用写死的黑底白字 —— 深色模式下页面本来就近黑，黑药丸会糊进背景里，
   * 用户完全看不出提示出现过。跟着调色板反着来，两套主题都清晰。
   */
  pill: {
    maxWidth: '78%',
    backgroundColor: c.text,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  text: { fontSize: 12.5, lineHeight: 17, color: c.page, textAlign: 'center' },
});
