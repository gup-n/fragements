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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { dayKey, daySubLabel, formatTime, monthKey, periodLabel } from '../util/date';
import { countHits } from '../util/highlight';
import { parseBlocks } from '../util/mdBlocks';
import { useKeyboardHeight } from '../util/keyboard';

/**
 * ScrollView 的实例类型。RN 0.88 里 `typeof ScrollView` 是组件本身，
 * 不能当实例用（`scrollTo` 不在上面）—— 取 ref 的类型才拿到实例。
 */
type ScrollViewInstance = React.ComponentRef<typeof ScrollView>;

interface Props {
  /** 进入时的上下文序列。时间轴进入就是时间轴顺序，搜索进入就是搜索结果顺序 */
  items: Fragment[];
  initialIndex: number;
  doneIds: Set<number>;
  /** 全部周期总结，详情页自己挑出落在这一天的那些 */
  notes: Note[];
  /**
   * 从搜索进来时带上的查询词。
   *
   * 给了就做两件事：正文里描出命中，顶部多一组「第 i / N 处」上下跳。
   * 不给时整页与以前完全一致（不多挂 onLayout，也不多一行工具栏）。
   */
  highlightQuery?: string;
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
  highlightQuery,
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

  /* ---------------- 搜索命中：高亮 + 逐处跳转 ---------------- */

  /** 当前停在第几处。换页归零，否则上一页的 3/5 会带到下一屏 */
  const [hitIndex, setHitIndex] = useState(0);
  /**
   * 每页各自的「文字块下标 → 实测 y」，按碎片 id 分开存。
   *
   * 不共用一份：横向 FlatList 会同时挂着相邻几页，共用的话后挂载的那页
   * 会把当前页的 y 覆盖掉，跳转就跳到别人的高度上。
   */
  const blockY = useRef(new Map<number, Map<number, number>>());
  /** 每页的 ScrollView，跳转时按碎片 id 取当前这一页的 */
  const pageRefs = useRef(new Map<number, ScrollViewInstance>());

  /**
   * 第 i 处落在哪个块。数组长度就是命中总数。
   *
   * 口径必须和 NoteBody 对得上：同一个 parseBlocks、同一批 seg、同一个 countHits。
   * 不按字符比例估位置 —— 中文一行约 18 字、英文能塞 40 个，估出来的 y 常常差半屏。
   */
  const hitBlocks = useMemo(() => {
    const q = highlightQuery?.trim() ?? '';
    const at: number[] = [];
    if (!q) return at;
    parseBlocks(fragment?.content ?? '').forEach((b, bi) => {
      // 分隔线没有文字；表格和代码块有，而且 NoteBody 现在也给它们量位置，
      // 漏掉的话「共 5 处」只能跳到 3 处，编号和正文对不上
      let n = 0;
      if (b.kind === 'table') {
        for (const seg of b.head.flat()) n += countHits(seg.text, q);
        for (const row of b.rows) for (const seg of row.flat()) n += countHits(seg.text, q);
      } else if (b.kind === 'code') {
        n = countHits(b.text, q);
      } else if (b.kind !== 'hr') {
        for (const seg of b.segs) n += countHits(seg.text, q);
      }
      for (let k = 0; k < n; k++) at.push(bi);
    });
    return at;
  }, [fragment?.content, highlightQuery]);

  const hitTotal = hitBlocks.length;
  /** 换页那一帧 hitIndex 可能还落在旧的范围内，读的时候夹一下，不会显示「第 4 / 2 处」 */
  const shownHit = hitTotal > 0 ? Math.min(hitIndex, hitTotal - 1) : 0;

  useEffect(() => {
    setHitIndex(0);
  }, [current, highlightQuery]);

  const registerScroll = useCallback((id: number, view: ScrollViewInstance | null) => {
    if (view) pageRefs.current.set(id, view);
    else pageRefs.current.delete(id);
  }, []);

  const registerBlock = useCallback((id: number, blockIndex: number, y: number) => {
    let m = blockY.current.get(id);
    if (!m) {
      m = new Map();
      blockY.current.set(id, m);
    }
    m.set(blockIndex, y);
  }, []);

  const goHit = useCallback(
    (delta: number) => {
      const last = hitTotal - 1;
      if (last < 0 || !fragment) return;
      const next = Math.min(Math.max(shownHit + delta, 0), last);
      if (next === shownHit) return;
      setHitIndex(next);
      const y = blockY.current.get(fragment.id)?.get(hitBlocks[next]);
      // 还没量到这一块（刚换页的那一帧）就不滚：高亮本身已经在屏幕上，
      // 按 undefined 硬滚一下反而会跳回顶部
      if (y !== undefined) {
        pageRefs.current.get(fragment.id)?.scrollTo({ y: Math.max(0, y - 16), animated: true });
      }
    },
    [fragment, hitBlocks, hitTotal, shownHit],
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
        「第 i / N 处」只在有命中时出现。单独占一行而不是塞进标题栏：
        一行里已经有关闭、日期、编辑三样，再挤两个箭头，日期会被压成「10月2…」。
        禁用态降透明度而不是隐藏 —— 按钮位置来回变比灰一点更难受。
      */}
      {hitTotal > 0 ? (
        <View style={styles.hitBar}>
          <Text style={styles.hitBarText}>
            第 {shownHit + 1} / {hitTotal} 处
          </Text>
          <View style={styles.hitBarBtns}>
            <IconButton
              name="chevron-up"
              size={16}
              tone="soft"
              color={c.text2}
              diameter={34}
              disabled={shownHit <= 0}
              onPress={() => goHit(-1)}
              accessibilityLabel="上一处命中"
            />
            <IconButton
              name="chevron-down"
              size={16}
              tone="soft"
              color={c.text2}
              diameter={34}
              disabled={shownHit >= hitTotal - 1}
              onPress={() => goHit(1)}
              accessibilityLabel="下一处命中"
            />
          </View>
        </View>
      ) : null}

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
              highlight={highlightQuery}
              registerScroll={registerScroll}
              registerBlock={registerBlock}
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
 * 这条碎片所属月份的月总结。
 *
 * v0.15 之前是三级降级：当天的日小结 → 当周周总结 → 当月月总结。
 * 日/周两种粒度下线之后只剩「当月」一种，三级降级就退化成一条 —
 * 留着分支只会让人以为那两种还在（而且它们的数据已经被迁移删掉了）。
 */
function notesOn(day: number, notes: Note[]): Note[] {
  const key = monthKey(day);
  return notes.filter((n) => n.type === 'monthly' && n.period === key);
}

function Page({
  fragment,
  width,
  done,
  notes,
  highlight,
  registerScroll,
  registerBlock,
}: {
  fragment: Fragment;
  width: number;
  done: boolean;
  notes: Note[];
  highlight?: string;
  registerScroll: (id: number, view: ScrollViewInstance | null) => void;
  registerBlock: (id: number, blockIndex: number, y: number) => void;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  const merged = fragment.mergedInto !== null;
  const hasMeta = fragment.tags.length > 0 || !!fragment.project || fragment.source !== 'app';
  const dayNotes = notesOn(fragment.createdAt, notes);
  // 身份要稳：内联箭头每次渲染都会换新，React 会把 ref 先置 null 再挂回去
  const setScrollRef = useCallback(
    (view: ScrollViewInstance | null) => registerScroll(fragment.id, view),
    [fragment.id, registerScroll],
  );

  return (
    <ScrollView
      ref={setScrollRef}
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
        highlight={highlight}
        // 只有搜索进来才逐块渲染：平时合并成一个大 Text，行距更连贯
        onBlockLayout={highlight ? (bi, y) => registerBlock(fragment.id, bi, y) : undefined}
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
        月总结是这个月的结论。看完当天的零碎记录后紧接着看到它，
        不用退回时间轴再翻一遍。它和碎片是两种东西，所以用浅蓝卡片隔开。
      */}
      {dayNotes.map((n) => (
        <View key={n.id} style={styles.noteCard}>
          <View style={styles.noteHead}>
            <Ionicons name="sparkles" size={13} color={c.accent} />
            <Text style={styles.noteKind}>当月总结</Text>
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

  /**
   * 命中跳转条。底色用 amberBg —— 和正文里的高亮块是同一个颜色，
   * 「这条在这里」和「正文里描的那几段」一眼就是同一件事。
   */
  hitBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 20,
    paddingRight: 12,
    paddingVertical: 3,
    backgroundColor: c.amberBg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  hitBarText: { fontSize: 11.5, color: c.amberText, fontWeight: '600', fontVariant: ['tabular-nums'] },
  hitBarBtns: { flexDirection: 'row', alignItems: 'center', gap: 4 },

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
