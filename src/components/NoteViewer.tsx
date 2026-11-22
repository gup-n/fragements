/** 小结全屏阅读器：滑动顺序来自调用方列表，等实测宽度后才挂分页FlatList。 */
import { useEffect, useRef, useState } from 'react';
import { BackHandler, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Note } from '../types';
import { dayKey, periodLabel } from '../util/date';
import { SPACE, TYPE, surfaceStroke, useTheme, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { NoteBody } from './NoteBody';
import { ScreenHeader } from './ScreenHeader';
import { IconButton } from './IconButton';

const KIND_LABEL: Record<Note['type'], string> = {
  daily: '日小结', weekly: '周总结', monthly: '月总结', theme: '主题总结',
};

interface Props {
  notes: Note[];
  initialIndex: number;
  onClose: () => void;
  /** 删除当前这篇小结。删除进回收站；调用方负责重读列表（列表一变阅读器会自己关） */
  onDeleteNote: (id: number) => void;
}

export function NoteViewer({ notes, initialIndex, onClose, onDeleteNote }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const { reduceMotion } = useTheme();
  const [width, setWidth] = useState(0);
  /** 删除要二次确认：第一次把按钮换成「确认删除」，第二次才真删 */
  const [armed, setArmed] = useState(false);
  const first = Math.min(Math.max(initialIndex, 0), Math.max(notes.length - 1, 0));
  const [current, setCurrent] = useState(first);
  const listRef = useRef<FlatList<Note>>(null);
  /**
   * 正看的那一篇，按 id 记。
   *
   * 列表会变（保存了新小结、删了旧的）：只按下标续着，位置不变、内容却换了
   * 一篇 —— 界面上看不出任何错，这才是最难发现的一种错位。
   */
  const currentIdRef = useRef<number | null>(notes[first]?.id ?? null);

  useEffect(() => {
    currentIdRef.current = notes[current]?.id ?? null;
    setArmed(false);
  }, [current, notes]);

  useEffect(() => {
    const id = currentIdRef.current;
    if (id === null || !notes.length) return;
    const at = notes.findIndex((n) => n.id === id);
    if (at < 0 || at === current) return;
    setCurrent(at);
    if (width > 0) listRef.current?.scrollToIndex({ index: at, animated: false });
  }, [notes, current, width]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [onClose]);

  const jump = (delta: number) => {
    const next = current + delta;
    if (next < 0 || next >= notes.length) return;
    listRef.current?.scrollToIndex({ index: next, animated: !reduceMotion });
    setCurrent(next);
  };
  const cur = notes[current];
  if (!cur) return null;

  const onPressDelete = () => {
    if (!armed) { setArmed(true); return; }
    onDeleteNote(cur.id);
  };

  return (
    <View
      style={styles.root} accessibilityViewIsModal
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        if (w > 0 && w !== width) setWidth(w);
      }}
    >
      <ScreenHeader
        title={periodLabel(cur.period) || dayKey(cur.createdAt)}
        subtitle={`${KIND_LABEL[cur.type]}${notes.length > 1 ? ` · ${current + 1} / ${notes.length}` : ''}`}
        backIcon="close" backLabel="关闭小结" onBack={onClose}
        right={
          <Pressable
            onPress={onPressDelete}
            style={({ pressed }) => [styles.delBtn, armed && styles.delArmed, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
            accessibilityLabel={armed ? '确认删除这篇小结' : '删除这篇小结'}
          >
            <Ionicons name={armed ? 'warning-outline' : 'trash-outline'} size={16} color={armed ? c.danger : c.text2} />
            <Text style={[styles.delText, armed && styles.delTextArmed]}>{armed ? '确认删除' : '删除'}</Text>
          </Pressable>
        }
      />
      {width > 0 ? (
        <FlatList
          ref={listRef} data={notes} horizontal pagingEnabled showsHorizontalScrollIndicator={false}
          keyExtractor={(n) => String(n.id)} initialScrollIndex={current}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          windowSize={3} initialNumToRender={1} maxToRenderPerBatch={1}
          onMomentumScrollEnd={(e) => {
            const i = Math.round(e.nativeEvent.contentOffset.x / width);
            if (i >= 0 && i < notes.length) setCurrent(i);
          }}
          renderItem={({ item }) => <Page note={item} width={width} />}
        />
      ) : null}
      {notes.length > 1 ? (
        <View style={styles.footer}>
          <IconButton name="chevron-back" disabled={current === 0} onPress={() => jump(-1)} accessibilityLabel="上一篇小结" />
          <View style={styles.footerInfo}>
            <Text style={styles.pageCount}>{current + 1} / {notes.length}</Text>
            <Text style={styles.hint}>左右滑动，或点箭头翻篇</Text>
          </View>
          <IconButton name="chevron-forward" disabled={current === notes.length - 1} onPress={() => jump(1)} accessibilityLabel="下一篇小结" />
        </View>
      ) : null}
    </View>
  );
}

function Page({ note, width }: { note: Note; width: number }) {
  const { styles } = useThemedStyles(makeStyles);
  const chars = note.bodyMd.replace(/\s/g, '').length;
  return (
    <ScrollView style={{ width }} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.metaRow}>
        <Text style={styles.kind}>{KIND_LABEL[note.type]}</Text>
        <Text style={styles.meta}>{periodLabel(note.period) || dayKey(note.createdAt)} · {chars} 字</Text>
      </View>
      <NoteBody text={note.bodyMd} variant="reading" selectable />
    </ScrollView>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.page },
  content: { paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.xl, paddingBottom: SPACE.xxl },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACE.xs, marginBottom: SPACE.xl, paddingBottom: SPACE.md, borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair },
  kind: { ...TYPE.label, color: c.text },
  meta: { ...TYPE.meta, color: c.text2, fontVariant: ['tabular-nums'] },
  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.xs,
    paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.xs, borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair,
  },
  footerInfo: { flex: 1, minWidth: 0, alignItems: 'center', gap: SPACE.xxs },
  pageCount: { ...TYPE.label, color: c.text, fontVariant: ['tabular-nums'] },
  delBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs, paddingHorizontal: SPACE.sm, minHeight: metrics.controlHeight },
  delArmed: { backgroundColor: c.dangerBg, borderRadius: metrics.buttonRadius },
  delText: { ...TYPE.label, color: c.text2 },
  delTextArmed: { color: c.danger },
  hint: { ...TYPE.meta, color: c.text2, textAlign: 'center' },
});
