/**
 * 引用详情面板：点正文里的小标，从底部展开「这条引用到底出自哪儿」。
 *
 * 为什么是底部面板而不是跳到碎片详情：读回答的人是顺着句子往下读的，
 * 点一下只想**确认这句有依据**，不想丢掉当前这段回答。面板盖住大半屏，
 * 关掉还在原位。
 *
 * 覆盖层而不是 `Modal` —— 项目红线，见 AGENTS.md 第 4 条：
 * Modal 带 FLAG_LAYOUT_NO_LIMITS，会画到状态栏下。返回键自己接。
 *
 * 正文用快照（`QaCitation.body`）而不是回库查：历史会话重开时当时检索到的
 * 碎片可能已经被合并、改标签甚至删掉了，回查会得到空面板，而回答里明明写着
 * 「按 [F3] 的做法」。快照过期，但至少是当时真实看到的东西。
 */
import React, { useCallback, useEffect } from 'react';
import { BackHandler, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { QaCitation } from '../types';
import { R, useThemedStyles, type Palette } from '../theme';
import { IconButton, type IoniconName } from './IconButton';

/** 四种来源的图标。用线框图标，和页面别处的写法一致 */
const ICON: Record<QaCitation['kind'], IoniconName> = {
  F: 'document-text-outline',
  N: 'sparkles-outline',
  T: 'checkbox-outline',
  W: 'globe-outline',
};

const KIND_NAME: Record<QaCitation['kind'], string> = {
  F: '碎片',
  N: '小结',
  T: '待办',
  W: '网页',
};

interface Props {
  cite: QaCitation;
  onClose: () => void;
}

export function CitationSheet({ cite, onClose }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);

  // 返回键只注册一次：onClose 每次渲染都是新函数，放进依赖会每帧重挂监听
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const url = cite.url;

  /** 打不开就算了：链接失效不该弹一个错误盖住正文，用户本来只是想看看 */
  const openUrl = useCallback(() => {
    if (!url) return;
    Linking.openURL(url).catch(() => {});
  }, [url]);

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="关闭引用" />

      <View style={styles.panel}>
        <View style={styles.head}>
          <View style={styles.iconWrap}>
            <Ionicons name={ICON[cite.kind]} size={16} color={c.accentText} />
          </View>
          <View style={styles.headText}>
            <Text style={styles.kind}>{KIND_NAME[cite.kind]}</Text>
            <Text style={styles.label} numberOfLines={2}>
              {cite.label}
            </Text>
          </View>
          <IconButton
            name="close"
            onPress={onClose}
            size={18}
            diameter={32}
            tone="soft"
            accessibilityLabel="关闭引用"
          />
        </View>

        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.bodyText} selectable>
            {cite.body.trim() || '（这条没有正文）'}
          </Text>
        </ScrollView>

        {url ? (
          <View style={styles.linkRow}>
            <Text style={styles.url} numberOfLines={1}>
              {url}
            </Text>
            <Pressable
              onPress={openUrl}
              accessibilityRole="button"
              accessibilityLabel="打开网页"
              style={({ pressed }) => [styles.openBtn, pressed && styles.pressed]}
            >
              <Text style={styles.openText}>打开网页</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  /** 压在面板下面，点空白处关掉 */
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: c.scrim,
  },
  /**
   * `maxHeight` 而不是固定高度：待办引用只有一行字，固定高度会留一大片空。
   * 上限 72% 是给长碎片留的余量，超过就滚。
   */
  panel: {
    backgroundColor: c.card,
    borderTopLeftRadius: R.card,
    borderTopRightRadius: R.card,
    maxHeight: '72%',
    paddingBottom: 16,
  },

  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  iconWrap: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: c.accentBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  headText: { flex: 1, minWidth: 0 },
  kind: { fontSize: 11, color: c.text3, letterSpacing: 0.5 },
  label: { fontSize: 13, lineHeight: 19, color: c.text, fontWeight: '600', marginTop: 2 },

  body: { flexGrow: 0, flexShrink: 1 },
  bodyContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  bodyText: { fontSize: 14.5, lineHeight: 23, color: c.text2 },

  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    marginTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
  },
  url: { flex: 1, fontSize: 11.5, color: c.text3 },
  openBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: R.btn,
    backgroundColor: c.accentBg,
  },
  openText: { fontSize: 12.5, color: c.accentText, fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
