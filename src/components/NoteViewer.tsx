/**
 * 小结的全屏阅读器：左右滑动在**当前筛选出来的那批**小结之间切换。
 *
 * 为什么要有这个东西：回顾页里的小结卡只展开到 5 行，长的小结得点「展开」
 * 才能看全，而且一次只能看一篇 —— 想看「上周周总结怎么写的、这周是不是
 * 更短」得来回退。时间轴的碎片详情页早就是左右滑动的，小结没有理由更差。
 *
 * 两个实现细节：
 * - 每页是独立的 ScrollView（小结可能上千字，必须能纵向滚），外层 FlatList
 *   负责横向分页。手势不冲突：横向归 FlatList，纵向归内层。
 * - 必须等实测宽度到手再挂 FlatList。initialScrollIndex 和 getItemLayout
 *   都按每页宽度算偏移，宽度还是 0 的时候挂上去会停在第一页 —— 从第 5 篇
 *   点进来却显示第 1 篇。FragmentDetail（v0.4.2）在这栽过。
 */
import React, { useEffect, useRef, useState } from 'react';
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
import type { Note } from '../types';
import { dayKey, periodLabel } from '../util/date';
import { R, useThemedStyles, type Palette } from '../theme';
import { NoteBody } from './NoteBody';
import { ScreenHeader } from './ScreenHeader';

const KIND_LABEL: Record<Note['type'], string> = {
  daily: '日小结',
  weekly: '周总结',
  monthly: '月总结',
  theme: '主题总结',
};

interface Props {
  /** 当前筛选出来的全部小结，顺序就是滑动顺序 */
  notes: Note[];
  /** 从第几篇点进来的 */
  initialIndex: number;
  onClose: () => void;
}

export function NoteViewer({ notes, initialIndex, onClose }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(
    Math.min(Math.max(initialIndex, 0), Math.max(notes.length - 1, 0)),
  );
  const listRef = useRef<FlatList<Note>>(null);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const jump = (delta: number) => {
    const next = current + delta;
    if (next < 0 || next >= notes.length) return;
    listRef.current?.scrollToIndex({ index: next, animated: true });
    setCurrent(next);
  };

  const cur = notes[current];
  if (!cur) return null;

  return (
    <View
      style={styles.root}
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        if (w > 0 && w !== width) setWidth(w);
      }}
    >
      <ScreenHeader
        title={periodLabel(cur.period) || dayKey(cur.createdAt)}
        subtitle={`${KIND_LABEL[cur.type]}${notes.length > 1 ? ` · ${current + 1} / ${notes.length}` : ''}`}
        backIcon="close"
        onBack={onClose}
      />

      {width > 0 ? (
        <FlatList
          ref={listRef}
          data={notes}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={(n) => String(n.id)}
          initialScrollIndex={current}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          windowSize={3}
          initialNumToRender={1}
          maxToRenderPerBatch={1}
          onMomentumScrollEnd={(e) => {
            const i = Math.round(e.nativeEvent.contentOffset.x / width);
            if (i >= 0 && i < notes.length) setCurrent(i);
          }}
          renderItem={({ item }) => <Page note={item} width={width} />}
        />
      ) : null}

      {notes.length > 1 ? (
        <View style={styles.footer}>
          <Pressable
            onPress={() => jump(-1)}
            disabled={current === 0}
            hitSlop={12}
            style={({ pressed }) => [styles.navBtn, pressed && current > 0 && { opacity: 0.5 }]}
          >
            <Ionicons name="chevron-back" size={19} color={current === 0 ? c.hair : c.text2} />
          </Pressable>
          <Text style={styles.hint}>左右滑动查看其他小结</Text>
          <Pressable
            onPress={() => jump(1)}
            disabled={current === notes.length - 1}
            hitSlop={12}
            style={({ pressed }) => [
              styles.navBtn,
              pressed && current < notes.length - 1 && { opacity: 0.5 },
            ]}
          >
            <Ionicons
              name="chevron-forward"
              size={19}
              color={current === notes.length - 1 ? c.hair : c.text2}
            />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function Page({ note, width }: { note: Note; width: number }) {
  const { c, styles } = useThemedStyles(makeStyles);
  const chars = note.bodyMd.replace(/\s/g, '').length;

  return (
    <ScrollView
      style={{ width }}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.metaRow}>
        <View style={styles.badge}>
          <Ionicons name="sparkles" size={11} color={c.accentText} />
          <Text style={styles.badgeText}>{KIND_LABEL[note.type]}</Text>
        </View>
        <Text style={styles.meta}>
          {periodLabel(note.period) || dayKey(note.createdAt)} · {chars} 字
        </Text>
      </View>

      {/* selectable：小结最常被拿去做的事就是复制一段出去 */}
      <View style={styles.body}>
        <NoteBody text={note.bodyMd} style={styles.bodyText} />
      </View>
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: c.page,
  },

  content: { paddingHorizontal: 18, paddingTop: 6, paddingBottom: 28 },

  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: R.pill,
    backgroundColor: c.accentBg,
  },
  badgeText: { fontSize: 11, color: c.accentText, fontWeight: '500' },
  meta: { fontSize: 11.5, color: c.text3, fontVariant: ['tabular-nums'] },

  body: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    padding: 16,
  },
  bodyText: { fontSize: 14.5, lineHeight: 25 },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
  },
  navBtn: { padding: 6 },
  hint: { fontSize: 11.5, color: c.text3 },
});
