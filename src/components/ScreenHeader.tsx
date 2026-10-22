/**
 * 子页面统一的顶部栏：左侧返回圆钮、中间标题（可带副标题）、右侧动作区。
 *
 * 以前四个子页面各自写了一遍「chevron-back + 一个 Text + 一个占位 View」，
 * 于是返回键大小不一样、标题有的左一点有的右一点、页面之间切换会看到跳动。
 * 收成一个组件之后，改一处就等于所有页面一起改。
 *
 * 首页（时间轴）不用它 —— 那里左边是品牌名而不是返回键。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { C } from '../theme';
import { IconButton, type IoniconName } from './IconButton';

interface Props {
  title: string;
  /** 标题下方的小字，用来说明这一页是什么（如「3 个主题 · 12 张卡」） */
  subtitle?: string;
  onBack?: () => void;
  backIcon?: IoniconName;
  /** 右侧动作区，通常是几个 IconButton */
  right?: React.ReactNode;
  /** 底部细分隔线。内容会滚动时建议开，避免标题和列表黏在一起 */
  bordered?: boolean;
}

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  backIcon = 'chevron-back',
  right,
  bordered = true,
}: Props) {
  return (
    <View style={[s.wrap, bordered && s.bordered]}>
      <View style={s.side}>
        {onBack ? (
          <IconButton
            name={backIcon}
            onPress={onBack}
            size={22}
            tone="soft"
            accessibilityLabel="返回"
          />
        ) : null}
      </View>

      <View style={s.center}>
        <Text style={s.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={s.sub} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      <View style={[s.side, s.sideRight]}>{right}</View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 8,
    backgroundColor: C.page,
  },
  bordered: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hair },
  side: { minWidth: 40, justifyContent: 'center' },
  sideRight: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  center: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  title: { fontSize: 16, color: C.text, fontWeight: '600', letterSpacing: 0.3 },
  sub: { fontSize: 11, color: C.text3, marginTop: 1 },
});
