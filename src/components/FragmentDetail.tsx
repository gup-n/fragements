/**
 * 碎片详情页：全屏只读，左右滑动看上一条 / 下一条。
 *
 * 为什么不复用列表里那个编辑面板 —— 那个入口是「改」，长文想从头通读一遍，
 * 却先得到一个光标和键盘。这里只负责读，要改再点右上角的编辑。
 *
 * 横向翻页用 FlatList 而不是手写 PanResponder / ScrollView：
 * `windowSize=3` 自带窗口化，几百条也只挂三页；分页吸附、惯性、回弹全是系统原生。
 * 自己维护 contentOffset 的写法在安卓上尤其容易抖。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Fragment } from '../types';
import { C, R } from '../theme';
import { TagPill } from './TagPill';
import { IconButton } from './IconButton';
import { daySubLabel, formatTime } from '../util/date';

interface Props {
  /** 进入时的上下文序列。时间轴进入就是时间轴顺序，搜索进入就是搜索结果顺序 */
  items: Fragment[];
  initialIndex: number;
  doneIds: Set<number>;
  onClose: () => void;
  onEdit: (f: Fragment) => void;
}

export function FragmentDetail({ items, initialIndex, doneIds, onClose, onEdit }: Props) {
  /**
   * 用实测容器宽度，不用 useWindowDimensions：桌面预览把 App 关在 420px 的壳里，
   * 窗口宽度和这一页的宽度不是一回事，用后者会让每页都宽出一大截、翻页还错位。
   */
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(initialIndex);
  const listRef = useRef<FlatList<Fragment>>(null);

  // 覆盖层不是 Modal，安卓返回键得自己接，否则按返回直接把 App 退了
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const fragment = items[current] ?? items[initialIndex];

  /** 底部的左右箭头：滑动手势之外再给一个确定性的入口，也给「这里能滑」一个提示 */
  const jump = useCallback(
    (delta: number) => {
      const next = current + delta;
      if (next < 0 || next >= items.length) return;
      setCurrent(next);
      listRef.current?.scrollToIndex({ index: next, animated: true });
    },
    [current, items.length],
  );

  if (!fragment) return null;

  const atEnd = current >= items.length - 1;

  return (
    <View
      style={s.root}
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        if (w > 0 && w !== width) setWidth(w);
      }}
    >
      <View style={s.topBar}>
        <IconButton name="close" size={22} color={C.text2} onPress={onClose} accessibilityLabel="关闭" />
        <View style={s.topCenter}>
          <Text style={s.topDate}>{daySubLabel(fragment.createdAt)}</Text>
          <Text style={s.topTime}>
            {formatTime(fragment.createdAt)}
            {items.length > 1 ? ` · ${current + 1} / ${items.length}` : ''}
          </Text>
        </View>
        <Pressable
          onPress={() => onEdit(fragment)}
          hitSlop={8}
          style={({ pressed }) => [s.editBtn, pressed && { opacity: 0.6 }]}
        >
          <Ionicons name="create-outline" size={17} color={C.accentText} />
          <Text style={s.editText}>编辑</Text>
        </Pressable>
      </View>

      {/*
        必须等实测宽度到手再挂 FlatList：initialScrollIndex 和 getItemLayout 都按
        每页宽度算偏移，宽度还是 0 的时候挂上去会停在第一页，跳到第 5 条就失效了。
      */}
      {width > 0 ? (
        <FlatList
          ref={listRef}
          data={items}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={(f) => String(f.id)}
          initialScrollIndex={initialIndex}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          windowSize={3}
          initialNumToRender={1}
          maxToRenderPerBatch={1}
          onMomentumScrollEnd={(e) => {
            const i = Math.round(e.nativeEvent.contentOffset.x / width);
            if (i >= 0 && i < items.length) setCurrent(i);
          }}
          renderItem={({ item }) => (
            <Page fragment={item} width={width} done={doneIds.has(item.id)} />
          )}
        />
      ) : null}

      {items.length > 1 ? (
        <View style={s.footer}>
          <Pressable
            onPress={() => jump(-1)}
            disabled={current === 0}
            hitSlop={12}
            style={({ pressed }) => [s.navBtn, pressed && current > 0 && { opacity: 0.5 }]}
          >
            <Ionicons name="chevron-back" size={19} color={current === 0 ? C.hair : C.text2} />
          </Pressable>
          <Text style={s.hint}>左右滑动查看上一条</Text>
          <Pressable
            onPress={() => jump(1)}
            disabled={atEnd}
            hitSlop={12}
            style={({ pressed }) => [s.navBtn, pressed && !atEnd && { opacity: 0.5 }]}
          >
            <Ionicons name="chevron-forward" size={19} color={atEnd ? C.hair : C.text2} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function Page({ fragment, width, done }: { fragment: Fragment; width: number; done: boolean }) {
  const merged = fragment.mergedInto !== null;
  const hasMeta = fragment.tags.length > 0 || !!fragment.project || fragment.source !== 'app';

  return (
    <ScrollView
      style={{ width }}
      contentContainerStyle={s.content}
      showsVerticalScrollIndicator={false}
    >
      {done || merged ? (
        <View style={s.badges}>
          {done ? (
            <View style={s.doneBadge}>
              <Ionicons name="checkmark" size={11} color={C.tealText} />
              <Text style={s.doneText}>已完成</Text>
            </View>
          ) : null}
          {merged ? <Text style={s.merged}>已合并到另一条</Text> : null}
        </View>
      ) : null}

      {/* selectable：只读页最常见的动作就是把某段复制出去 */}
      <Text style={[s.body, merged && s.bodyMuted]} selectable>
        {fragment.content}
      </Text>

      {hasMeta ? (
        <View style={s.meta}>
          {fragment.tags.map((t) => (
            <TagPill key={t} label={t} />
          ))}
          {fragment.project ? <Text style={s.project}>{fragment.project}</Text> : null}
          {fragment.source !== 'app' ? (
            <View style={s.source}>
              <Ionicons
                name={fragment.source === 'notif' ? 'notifications-outline' : 'share-outline'}
                size={12.5}
                color={C.text3}
              />
              <Text style={s.sourceText}>
                {fragment.source === 'notif' ? '来自通知' : '来自分享'}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <Text style={s.count}>
        {fragment.content.length} 字 ·{' '}
        {new Date(fragment.createdAt).getFullYear()}-{String(new Date(fragment.createdAt).getMonth() + 1).padStart(2, '0')}-
        {String(new Date(fragment.createdAt).getDate()).padStart(2, '0')}
      </Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: C.page,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.hair,
  },
  topCenter: { flex: 1, alignItems: 'center' },
  topDate: { fontSize: 13.5, color: C.text, fontWeight: '600' },
  topTime: { fontSize: 11, color: C.text3, marginTop: 2, fontVariant: ['tabular-nums'] },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: C.accentBg,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: R.pill,
  },
  editText: { fontSize: 12.5, color: C.accentText, fontWeight: '600' },

  content: { paddingHorizontal: 22, paddingTop: 22, paddingBottom: 48 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  doneBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: C.tealBg,
    borderRadius: R.pill,
    paddingLeft: 5,
    paddingRight: 9,
    paddingVertical: 3,
  },
  doneText: { fontSize: 10.5, lineHeight: 15, color: C.tealText },
  merged: { fontSize: 11, color: C.text3 },

  /* 详情页是「阅读」场景，字号和行高都比列表放宽一档 */
  body: { fontSize: 17, lineHeight: 30, color: C.text, letterSpacing: 0.2 },
  bodyMuted: { color: C.text2 },

  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 26,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
  },
  project: { fontSize: 12, color: C.text2 },
  source: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  sourceText: { fontSize: 11.5, color: C.text3 },

  count: { fontSize: 11, color: C.text3, marginTop: 14, fontVariant: ['tabular-nums'] },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
  },
  navBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  hint: { fontSize: 11.5, color: C.text3 },
});
