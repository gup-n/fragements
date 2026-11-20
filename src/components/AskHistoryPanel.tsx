/**
 * 「历史会话」抽屉（v0.26）。
 *
 * 从 AskScreen 搬出来的：外壳、压暗层、页头、分组标题、空屏、滚动容器。
 * 状态一个不留 —— 打开/关闭、手势、动画值、当前会话、加载中，全部由页面传进来。
 * 这样拆的理由不是「文件太长」，是**这块东西和聊天流没有任何共享状态**：
 * 它只读会话列表、只往外抛四个动作（打开 / 看文档 / 管理 / 新建）。
 *
 * 三件不能改的事（改了就从「抽屉」变成「另一页」）：
 *
 * 1. **由 `mounted` 控制挂载**，不是 `open`。关闭时还要播完退场动画，
 *    提前卸载等于抽屉「啪」地消失。
 * 2. **压暗层 pointerEvents="none"**。它盖在问答页上，能接点击的话，
 *    抽屉推出来的过程中下面那页就点不动了。
 * 3. **`sheetVisible` 时对读屏隐藏**。会话操作簿叠在抽屉之上，
 *    两边都能被读到的话，TalkBack 会把同一件事念两遍。
 */
import { Animated, ScrollView, StyleSheet, Text, View, type GestureResponderHandlers } from 'react-native';
import type { AskSession } from '../types';
import { SPACE, TYPE, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { BusyIndicator as ActivityIndicator } from './BusyIndicator';
import { EmptyState } from './EmptyState';
import { IconButton } from './IconButton';
import { ScreenHeader } from './ScreenHeader';
import { AskHistoryRow } from './AskHistoryRow';

interface Props {
  /** 是否还挂在树上。关掉之后要等退场动画播完才置 false */
  mounted: boolean;
  /** 会话操作簿是否开着：开着时这一层对读屏隐藏 */
  sheetVisible: boolean;
  /** 抽屉的位移（0 = 完全推出，负值 = 往右收） */
  translateX: Animated.AnimatedInterpolation<number>;
  /** 压暗层的透明度，与位移同步 */
  dimOpacity: Animated.AnimatedInterpolation<number>;
  /** 「往右推回去」的手势，由页面创建并持有（它要知道当前开没开） */
  panHandlers: GestureResponderHandlers;
  /** 还开着的会话数（页头副标题） */
  openCount: number;
  loading: boolean;
  /** 按「今天 / 昨天 / 更早」分好的组，顺序即显示顺序 */
  groups: [string, AskSession[]][];
  archived: AskSession[];
  activeId: number | null;
  onClose: () => void;
  onNewSession: () => void;
  onOpen: (session: AskSession) => void;
  onOpenDocs: (session: AskSession) => void;
  onManage: (session: AskSession) => void;
}

export function AskHistoryPanel({
  mounted,
  sheetVisible,
  translateX,
  dimOpacity,
  panHandlers,
  openCount,
  loading,
  groups,
  archived,
  activeId,
  onClose,
  onNewSession,
  onOpen,
  onOpenDocs,
  onManage,
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  if (!mounted) return null;

  const row = (one: AskSession) => (
    <AskHistoryRow
      key={one.id}
      session={one}
      active={activeId === one.id}
      onOpen={onOpen}
      onOpenDocs={onOpenDocs}
      onManage={onManage}
    />
  );

  return (
    <>
      {/* 抽屉推出来时把下面的问答页压暗，眼睛才知道「上面这一层」 */}
      <Animated.View pointerEvents="none" style={[styles.scrim, { opacity: dimOpacity }]} />

      <Animated.View
        style={[styles.page, { transform: [{ translateX }] }]}
        accessibilityViewIsModal
        accessibilityElementsHidden={sheetVisible}
        importantForAccessibility={sheetVisible ? 'no-hide-descendants' : 'auto'}
        {...panHandlers}
      >
        <ScreenHeader
          title="历史会话"
          subtitle={`${openCount} 个会话`}
          onBack={onClose}
          right={
            <IconButton
              name="add"
              size={21}
              tone="soft"
              onPress={onNewSession}
              accessibilityLabel="新建会话"
            />
          }
        />

        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator size="small" color={c.text3} />
            <Text style={styles.loadingText}>正在读历史…</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.content}>
            {groups.length === 0 && archived.length === 0 ? (
              <EmptyState
                icon="time-outline"
                title="还没有历史会话"
                body="问过的问题会自动留在这里。"
              />
            ) : null}

            {groups.map(([label, list]) => (
              <View key={label}>
                <Text style={styles.groupTitle}>{label}</Text>
                {list.map(row)}
              </View>
            ))}

            {archived.length > 0 ? (
              <View>
                <Text style={styles.groupTitle}>已归档 · {archived.length}</Text>
                {archived.map(row)}
              </View>
            ) : null}
          </ScrollView>
        )}
      </Animated.View>
    </>
  );
}

/** 只留这一层用到的样式。`thinkingText` 留在页面里（聊天流也在用） */
const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.scrim },
  page: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.page },
  content: { paddingHorizontal: metrics.pagePadding, paddingBottom: SPACE.xxl },
  loading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.xs,
    paddingTop: SPACE.xxl,
  },
  loadingText: { ...TYPE.label, fontWeight: '400', color: c.text2, flexShrink: 1 },
  groupTitle: { ...TYPE.label, color: c.text2, marginTop: SPACE.xl, marginBottom: SPACE.xs },
});
