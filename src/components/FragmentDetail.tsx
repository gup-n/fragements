/**
 * 碎片详情页：全屏阅读，左右滑动看上一条 / 下一条，右上角原地改。
 *
 * 编辑**不再另开小窗**：点「编辑」时这一页整屏切成输入态，字号和行高与阅读态一致
 * （17 / 30），光标落下的位置就是刚才读到的地方。之前的弹层是 15px 的小框，
 * 长文在框里只露三行，改一段要来回滚 —— 那跟详情页本身的目的（舒服地读长文）是矛盾的。
 *
 * 横向翻页用 FlatList 而不是手写 PanResponder / ScrollView：
 * `windowSize=3` 自带窗口化，几百条也只挂三页；分页吸附、惯性、回弹全是系统原生。
 * 自己维护 contentOffset 的写法在安卓上尤其容易抖。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Fragment, Note } from '../types';
import { R, useThemedStyles, type Palette } from '../theme';
import { TagPill } from './TagPill';
import { NoteBody } from './NoteBody';
import { IconButton } from './IconButton';
import { dayKey, daySubLabel, formatTime, periodAnchor, periodLabel } from '../util/date';
import { useKeyboardHeight } from '../util/keyboard';

interface Props {
  /** 进入时的上下文序列。时间轴进入就是时间轴顺序，搜索进入就是搜索结果顺序 */
  items: Fragment[];
  initialIndex: number;
  doneIds: Set<number>;
  /** 全部周期总结，详情页自己挑出落在这一天的那些 */
  notes: Note[];
  onClose: () => void;
  /** 保存正文。父组件负责写库并刷新，这里拿 Promise 是为了显示保存中状态 */
  onSave: (id: number, text: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

export function FragmentDetail({
  items,
  initialIndex,
  doneIds,
  notes,
  onClose,
  onSave,
  onDelete,
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  /**
   * 用实测容器宽度，不用 useWindowDimensions：桌面预览把 App 关在 420px 的壳里，
   * 窗口宽度和这一页的宽度不是一回事，用后者会让每页都宽出一大截、翻页还错位。
   */
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(initialIndex);
  const listRef = useRef<FlatList<Fragment>>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);
  const keyboardHeight = useKeyboardHeight();

  const fragment = items[current] ?? items[initialIndex];

  const startEdit = useCallback(() => {
    if (!fragment) return;
    setDraft(fragment.content);
    setArmedDelete(false);
    setEditing(true);
  }, [fragment]);

  const stopEdit = useCallback(() => {
    setEditing(false);
    setArmedDelete(false);
  }, []);

  // 覆盖层不是 Modal，安卓返回键得自己接。编辑态下先退编辑，再按才关页面 ——
  // 否则改了一半按返回会直接把整页关掉，草稿连带着没了
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (editing) {
        stopEdit();
        return true;
      }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [editing, stopEdit, onClose]);

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

  async function save() {
    if (!fragment || saving) return;
    const text = draft.trim();
    // 清空等于删掉内容，不给它这个机会 —— 要删请走显式的删除
    if (!text || text === fragment.content) {
      stopEdit();
      return;
    }
    setSaving(true);
    try {
      await onSave(fragment.id, text);
      stopEdit();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!fragment) return;
    if (!armedDelete) {
      setArmedDelete(true);
      return;
    }
    await onDelete(fragment.id);
    // 删掉的那条已经不在序列里了，留在详情页只会滑到别人的内容上
    onClose();
  }

  if (!fragment) return null;

  if (editing) {
    const canSave = draft.trim().length > 0 && !saving;
    return (
      <View style={[styles.root, { paddingBottom: keyboardHeight }]}>
        <View style={styles.topBar}>
          {/* 和阅读态用同一个关闭钮，切进编辑时顶部不会整排跳位 */}
          <IconButton
            name="close"
            size={22}
            color={c.text2}
            onPress={stopEdit}
            accessibilityLabel="取消编辑"
          />
          <View style={styles.topCenter}>
            <Text style={styles.topDate}>编辑碎片</Text>
            <Text style={styles.topTime}>{draft.length} 字</Text>
          </View>
          <Pressable
            onPress={save}
            disabled={!canSave}
            hitSlop={8}
            style={({ pressed }) => [
              styles.editBtn,
              styles.saveBtn,
              !canSave && styles.saveBtnOff,
              pressed && canSave && { opacity: 0.7 },
            ]}
          >
            {saving ? (
              <ActivityIndicator size="small" color={c.onAccent} />
            ) : (
              <Text style={[styles.saveText, !canSave && styles.saveTextOff]}>保存</Text>
            )}
          </Pressable>
        </View>

        <TextInput
          value={draft}
          onChangeText={setDraft}
          style={styles.editInput}
          multiline
          autoFocus
          maxLength={20000}
          textAlignVertical="top"
          placeholder="写点什么…"
          placeholderTextColor={c.text3}
        />

        <View style={styles.editFoot}>
          <Pressable onPress={remove} hitSlop={8}>
            <Text style={styles.deleteText}>
              {armedDelete ? '再点一次确认删除' : '删除这条碎片'}
            </Text>
          </Pressable>
          <Text style={styles.editHint}>返回键取消</Text>
        </View>
      </View>
    );
  }

  const atEnd = current >= items.length - 1;

  return (
    <View
      style={styles.root}
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        if (w > 0 && w !== width) setWidth(w);
      }}
    >
      <View style={styles.topBar}>
        <IconButton name="close" size={22} color={c.text2} onPress={onClose} accessibilityLabel="关闭" />
        <View style={styles.topCenter}>
          <Text style={styles.topDate}>{daySubLabel(fragment.createdAt)}</Text>
          <Text style={styles.topTime}>
            {formatTime(fragment.createdAt)}
            {items.length > 1 ? ` · ${current + 1} / ${items.length}` : ''}
          </Text>
        </View>
        <Pressable
          onPress={startEdit}
          hitSlop={8}
          style={({ pressed }) => [styles.editBtn, pressed && { opacity: 0.6 }]}
        >
          <Ionicons name="create-outline" size={17} color={c.accentText} />
          <Text style={styles.editText}>编辑</Text>
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
            <Page
              fragment={item}
              width={width}
              done={doneIds.has(item.id)}
              notes={notes}
            />
          )}
        />
      ) : null}

      {items.length > 1 ? (
        <View style={styles.footer}>
          <Pressable
            onPress={() => jump(-1)}
            disabled={current === 0}
            hitSlop={12}
            style={({ pressed }) => [styles.navBtn, pressed && current > 0 && { opacity: 0.5 }]}
          >
            <Ionicons name="chevron-back" size={19} color={current === 0 ? c.hair : c.text2} />
          </Pressable>
          <Text style={styles.hint}>左右滑动查看上一条</Text>
          <Pressable
            onPress={() => jump(1)}
            disabled={atEnd}
            hitSlop={12}
            style={({ pressed }) => [styles.navBtn, pressed && !atEnd && { opacity: 0.5 }]}
          >
            <Ionicons name="chevron-forward" size={19} color={atEnd ? c.hair : c.text2} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/**
 * 挑出属于这一天的总结。
 *
 * 当日小结优先；当天没写小结时，退而取锚点落在这天的周/月总结
 * （periodAnchor 对周/月给的是周日 / 月末，正好对应「这天在周期末尾」的情形）。
 * 反过来不行：只要有一条周总结就把每日小结顶掉，用户会觉得小结写丢了。
 */
function notesOn(day: number, notes: Note[]): Note[] {
  const key = dayKey(day);
  const daily = notes.filter((n) => n.type === 'daily' && n.period === key);
  if (daily.length) return daily;
  return notes.filter((n) => {
    if (n.type === 'daily') return false;
    const anchor = periodAnchor(n.period) ?? n.createdAt;
    return dayKey(anchor) === key;
  });
}

function Page({
  fragment,
  width,
  done,
  notes,
}: {
  fragment: Fragment;
  width: number;
  done: boolean;
  notes: Note[];
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  const merged = fragment.mergedInto !== null;
  const hasMeta = fragment.tags.length > 0 || !!fragment.project || fragment.source !== 'app';
  const dayNotes = notesOn(fragment.createdAt, notes);

  return (
    <ScrollView
      style={{ width }}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {done || merged ? (
        <View style={styles.badges}>
          {done ? (
            <View style={styles.doneBadge}>
              <Ionicons name="checkmark" size={11} color={c.tealText} />
              <Text style={styles.doneText}>已完成</Text>
            </View>
          ) : null}
          {merged ? <Text style={styles.merged}>已合并到另一条</Text> : null}
        </View>
      ) : null}

      {/* 碎片正文也走 Markdown 渲染：会话转出来的碎片有标题 / 列表 / 表格 / 代码 */}
      <NoteBody
        text={fragment.content}
        style={styles.body}
        variant="reading"
        selectable
        muted={merged}
      />

      {hasMeta ? (
        <View style={styles.meta}>
          {fragment.tags.map((t) => (
            <TagPill key={t} label={t} />
          ))}
          {fragment.project ? <Text style={styles.project}>{fragment.project}</Text> : null}
          {fragment.source !== 'app' ? (
            <View style={styles.source}>
              <Ionicons
                name={fragment.source === 'notif' ? 'notifications-outline' : 'share-outline'}
                size={12.5}
                color={c.text3}
              />
              <Text style={styles.sourceText}>
                {fragment.source === 'notif' ? '来自通知' : '来自分享'}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <Text style={styles.count}>
        {fragment.content.length} 字 ·{' '}
        {new Date(fragment.createdAt).getFullYear()}-{String(new Date(fragment.createdAt).getMonth() + 1).padStart(2, '0')}-
        {String(new Date(fragment.createdAt).getDate()).padStart(2, '0')}
      </Text>

      {/*
        小结是「这一天的一句话结论」，看完零碎的碎片后紧接着看到它，
        才不用退回时间轴再去找一遍。它和碎片是两种东西，所以用浅蓝卡片隔开。
      */}
      {dayNotes.map((n) => (
        <View key={n.id} style={styles.noteCard}>
          <View style={styles.noteHead}>
            <Ionicons name="sparkles" size={13} color={c.accent} />
            <Text style={styles.noteKind}>
              {n.type === 'daily' ? '当天小结' : n.type === 'weekly' ? '当周总结' : '当月总结'}
            </Text>
            <Text style={styles.notePeriod}>{periodLabel(n.period)}</Text>
          </View>
          <NoteBody text={n.bodyMd} style={styles.noteBody} />
        </View>
      ))}
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
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  topCenter: { flex: 1, alignItems: 'center' },
  topDate: { fontSize: 13.5, color: c.text, fontWeight: '600' },
  topTime: { fontSize: 11, color: c.text3, marginTop: 2, fontVariant: ['tabular-nums'] },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: c.accentBg,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: R.pill,
  },
  editText: { fontSize: 12.5, color: c.accentText, fontWeight: '600' },

  content: { paddingHorizontal: 22, paddingTop: 22, paddingBottom: 48 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  doneBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: c.tealBg,
    borderRadius: R.pill,
    paddingLeft: 5,
    paddingRight: 9,
    paddingVertical: 3,
  },
  doneText: { fontSize: 10.5, lineHeight: 15, color: c.tealText },
  merged: { fontSize: 11, color: c.text3 },

  /* 详情页是「阅读」场景，字号和行高都比列表放宽一档 */
  body: { fontSize: 17, lineHeight: 30, color: c.text, letterSpacing: 0.2 },

  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 26,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
  },
  project: { fontSize: 12, color: c.text2 },
  source: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  sourceText: { fontSize: 11.5, color: c.text3 },

  count: { fontSize: 11, color: c.text3, marginTop: 14, fontVariant: ['tabular-nums'] },

  // 当天小结
  noteCard: {
    marginTop: 26,
    backgroundColor: c.accentBg,
    borderRadius: R.card,
    paddingHorizontal: 15,
    paddingVertical: 13,
  },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  noteKind: { fontSize: 11.5, color: c.accentText, fontWeight: '600' },
  notePeriod: { flex: 1, fontSize: 11, color: c.text3 },
  noteBody: { fontSize: 14.5, lineHeight: 24, color: c.text },

  // 编辑态：整屏输入，字号与阅读态一致
  saveBtn: { backgroundColor: c.accent, minWidth: 62, justifyContent: 'center' },
  saveBtnOff: { backgroundColor: c.hairSoft },
  saveText: { fontSize: 12.5, color: c.onAccent, fontWeight: '600' },
  saveTextOff: { color: c.text3 },
  editInput: {
    flex: 1,
    fontSize: 17,
    lineHeight: 30,
    letterSpacing: 0.2,
    color: c.text,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 22,
  },
  editFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 10,
    paddingBottom: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
  },
  deleteText: { fontSize: 12.5, color: c.danger },
  editHint: { fontSize: 11, color: c.text3 },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
  },
  navBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  hint: { fontSize: 11.5, color: c.text3 },
});
