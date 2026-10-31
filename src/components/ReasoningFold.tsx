/**
 * 一条回答的「深度思考」折叠块。
 *
 * 为什么需要它：v0.8.8 里思维链只在 `busy` 期间渲染，答案一落屏组件就被卸载，
 * 用户看到的是「闪一下没了」，而且没有任何展开入口。
 *
 * 两个刻意的选择：
 * - **刚答完的那一轮默认展开**（`defaultOpen`），否则内容还是会在眼前消失一次；
 *   历史轮次默认收起，避免一屏全是思考链。
 * - **思维链跟着 QaTurn 持久化**，历史会话重开也能看，不是只活在这一次运行里。
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { R, useThemedStyles, type Palette } from '../theme';

interface Props {
  text: string;
  /** 刚答完的那一轮传 true：先把内容摊开，用户自己收 */
  defaultOpen?: boolean;
}

export function ReasoningFold({ text, defaultOpen = false }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(defaultOpen);

  if (!text.trim()) return null;

  return (
    <View style={styles.wrap}>
      <Pressable
        style={styles.head}
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={open ? '收起深度思考' : '展开深度思考'}
      >
        <Ionicons name="bulb-outline" size={14} color={c.text3} />
        <Text style={styles.title}>深度思考</Text>
        <Text style={styles.meta}>{text.length} 字</Text>
        <View style={styles.flex} />
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={c.text3} />
      </Pressable>

      {open ? (
        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.text} selectable>
            {text}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  wrap: {
    marginTop: 2,
    marginBottom: 10,
    backgroundColor: c.hairSoft,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  title: { fontSize: 12, color: c.text2, fontWeight: '500' },
  meta: { fontSize: 10.5, color: c.text3, fontVariant: ['tabular-nums'] },
  flex: { flex: 1 },
  body: { maxHeight: 280 },
  bodyContent: { paddingHorizontal: 11, paddingBottom: 11 },
  text: { fontSize: 12, lineHeight: 19, color: c.text2 },
});
