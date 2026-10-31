/**
 * 一行可以左右滑的列表项。
 *
 * 为什么不用 react-native-gesture-handler 的 Swipeable：这个项目没有装它，
 * 而 RN 自带的 Animated + PanResponder 足够表达「滑开一段、露出一个按钮」。
 *
 * 三条容易踩的：
 * 1. **只在横向明显时才接管手势**。否则手指斜着划一下，列表就滚不动了。
 * 2. **内容层必须是不透明的页面底色**。操作区在它下面，底色透明就会在关闭状态下
 *    看见「删除」两个红字杵在那儿。
 * 3. **展开状态由父级统一持有**。每行自己记，会出现同时开三行、
 *    或者点到别处那一行还敞着的情况。
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useThemedStyles, type Palette } from '../theme';
import type { IoniconName } from './IconButton';

export interface SwipeAction {
  label: string;
  icon: IoniconName;
  /** 操作区底色，由调用方给（一般是 c.danger / c.accent） */
  bg: string;
  /** 图标与文字的颜色 */
  fg: string;
  onPress: () => void;
}

interface Props {
  children: React.ReactNode;
  /** 当前展开的一侧；null = 关闭。父级统一控制，保证同时只开一行 */
  open: 'left' | 'right' | null;
  onOpen: (side: 'left' | 'right') => void;
  onClose: () => void;
  onPress: () => void;
  onLongPress?: () => void;
  /** 右滑露出的操作（在左边） */
  leftAction?: SwipeAction;
  /** 左滑露出的操作（在右边） */
  rightAction?: SwipeAction;
  /** true：左滑过阈值直接触发 rightAction.onPress，不保持展开（用于「进入问」） */
  rightInstant?: boolean;
  style?: any;
  pressedStyle?: any;
}

/** 操作区宽度：放得下一枚图标 + 两个字，又不至于把正文挤没 */
const ACTION_W = 92;
/** 松手时吸附到操作区的阈值，比操作区宽度的一半多一点，避免误触 */
const THRESHOLD = 56;
/**
 * 回弹统一用这个配置：不带弹性，滑开就该干脆停住。
 *
 * 必须 `useNativeDriver: false`：拖动过程用 `tx.setValue()` 逐帧写值，
 * 同一个 Value 再交给原生驱动会报警告，而且在部分安卓机上直接不动。
 */
const SPRING = { useNativeDriver: false, bounciness: 0, speed: 18 } as const;

/** 横向意图判定：位移够大，且明显不是竖直滚动 */
function isHorizontal(g: { dx: number; dy: number }) {
  return Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5;
}

export function SwipeRow({
  children,
  open,
  onOpen,
  onClose,
  onPress,
  onLongPress,
  leftAction,
  rightAction,
  rightInstant,
  style,
  pressedStyle,
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const tx = useRef(new Animated.Value(0)).current;
  /** 手指按下那一刻内容层停在哪，之后的位移都是从这里加 */
  const base = useRef(0);
  /** JS 侧自己记一份当前值：原生驱动下 Animated.Value 不方便同步读回来 */
  const pos = useRef(0);
  /** 拖动过程中父级如果把 open 改了，别在这里抢着归位 */
  const dragging = useRef(false);

  /**
   * PanResponder 只创建一次，闭包里拿不到最新 props，
   * 所以每次渲染把最新的回调和操作区写进 ref。
   */
  const latest = useRef({ open, onOpen, onClose, leftAction, rightAction, rightInstant });
  latest.current = { open, onOpen, onClose, leftAction, rightAction, rightInstant };

  useEffect(() => {
    if (dragging.current) return;
    const target = open === 'left' ? ACTION_W : open === 'right' ? -ACTION_W : 0;
    // 父级可能在同一帧把 left 换成 right，这里只认最终值，不做过渡
    pos.current = target;
    Animated.spring(tx, { toValue: target, ...SPRING }).start();
  }, [open, tx]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        /**
         * 竖直方向的一律放过：时间轴是要能滚的。
         * capture 和 bubble 两处都挂：安卓上 ScrollView 在触摸开始就把 responder
         * 抢走了，只在冒泡阶段问一句，有时候轮不到这一行。
         */
        onMoveShouldSetPanResponder: (_e, g) => isHorizontal(g),
        onMoveShouldSetPanResponderCapture: (_e, g) => isHorizontal(g),
        // 一旦接管就不还给列表，否则滑到一半被滚动抢走，停在半路
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          dragging.current = true;
          base.current = pos.current;
          tx.stopAnimation();
        },
        onPanResponderMove: (_e, g) => {
          const max = latest.current.leftAction ? ACTION_W : 0;
          const min = latest.current.rightAction ? -ACTION_W : 0;
          const next = Math.max(min, Math.min(max, base.current + g.dx));
          pos.current = next;
          tx.setValue(next);
        },
        onPanResponderRelease: (_e, g) => {
          dragging.current = false;
          const at = base.current + g.dx;
          const { leftAction: l, rightAction: r, rightInstant: instant, onOpen: openRow, onClose: closeRow } =
            latest.current;
          const snap = (target: number) => {
            pos.current = target;
            Animated.spring(tx, { toValue: target, ...SPRING }).start();
          };

          if (at <= -THRESHOLD && r) {
            // 「问」是一次性动作：滑过去就执行，不停在半开的位置
            if (instant) {
              snap(0);
              closeRow();
              r.onPress();
              return;
            }
            snap(-ACTION_W);
            openRow('right');
            return;
          }
          if (at >= THRESHOLD && l) {
            snap(ACTION_W);
            openRow('left');
            return;
          }
          snap(0);
          closeRow();
        },
        onPanResponderTerminate: () => {
          dragging.current = false;
          // 被系统打断（来电、切页）就退回按下时的位置，不要猜用户想去哪一侧
          pos.current = base.current;
          Animated.spring(tx, { toValue: base.current, ...SPRING }).start();
        },
      }),
    [tx],
  );

  /**
   * 已经展开时，点内容等于「先收起」，不打开详情 ——
   * 否则想滑回去却总是跳进下一页。
   */
  function handlePress() {
    if (latest.current.open !== null) {
      latest.current.onClose();
      return;
    }
    onPress();
  }

  function handleLongPress() {
    if (latest.current.open !== null) {
      latest.current.onClose();
      return;
    }
    onLongPress?.();
  }

  return (
    <View style={styles.clip} {...responder.panHandlers}>
      {leftAction ? (
        <Pressable
          style={[styles.action, styles.actionLeft, { backgroundColor: leftAction.bg }]}
          onPress={leftAction.onPress}
          accessibilityRole="button"
          accessibilityLabel={leftAction.label}
        >
          <Ionicons name={leftAction.icon} size={19} color={leftAction.fg} />
          <Text style={[styles.actionText, { color: leftAction.fg }]}>{leftAction.label}</Text>
        </Pressable>
      ) : null}

      {rightAction ? (
        <Pressable
          style={[styles.action, styles.actionRight, { backgroundColor: rightAction.bg }]}
          onPress={rightAction.onPress}
          accessibilityRole="button"
          accessibilityLabel={rightAction.label}
        >
          <Ionicons name={rightAction.icon} size={19} color={rightAction.fg} />
          <Text style={[styles.actionText, { color: rightAction.fg }]}>{rightAction.label}</Text>
        </Pressable>
      ) : null}

      <Animated.View style={{ transform: [{ translateX: tx }] }}>
        <Pressable
          onPress={handlePress}
          onLongPress={onLongPress ? handleLongPress : undefined}
          delayLongPress={400}
          style={({ pressed }) => [style, { backgroundColor: c.page }, pressed && pressedStyle]}
        >
          {children}
        </Pressable>
      </Animated.View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  /*
   * 不能裁剪。
   *
   * 时间轴那条竖线在 `railLine` 里用 `bottom: -8` 伸到下一行，靠的正是允许溢出；
   * 这里一加 `overflow: 'hidden'`，每一行底部都会出现 8px 的断口，整条时间线变成虚线。
   * 横向滑出的内容会画到屏幕外或页面底色上，没有需要裁的东西。
   */
  clip: { backgroundColor: c.page },
  action: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: ACTION_W,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  actionLeft: { left: 0 },
  actionRight: { right: 0 },
  actionText: { fontSize: 11.5, fontWeight: '500' },
});
