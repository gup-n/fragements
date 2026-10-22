import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Fragment, Note } from '../types';
import { C, R } from '../theme';
import { TagPill } from '../components/TagPill';
import { NoteBody } from '../components/NoteBody';
import { dayKey, dayLabel, daySubLabel, formatTime, periodAnchor, periodLabel } from '../util/date';
import { useKeyboardHeight } from '../util/keyboard';

/**
 * 时间轴上混着两种东西：碎片和周期总结。
 * 用 kind 区分，渲染时分两套样式 —— 但共用同一条竖线，视觉上仍是一条连续的时间流。
 */
type TimelineItem =
  | { kind: 'fragment'; id: number; at: number; fragment: Fragment }
  | { kind: 'note'; id: number; at: number; note: Note };

type Section = { title: string; sub: string; data: TimelineItem[] };

/**
 * 冷启动只自动聚焦一次。放在模块作用域而不是 useRef，
 * 是因为从设置页/知识库返回时会卸载再挂载，用 ref 会反复弹键盘。
 */
let autoFocusedOnce = false;

/** 时间轴上总结条目的类型标签 */
const NOTE_KIND: Record<Note['type'], string> = {
  daily: '今日小结',
  weekly: '周总结',
  monthly: '月总结',
  theme: '主题总结',
};

interface Props {
  fragments: Fragment[];
  /** 周期总结，按 period 落回时间轴对应日期 */
  notes: Note[];
  inboxCount: number;
  /** 已完成待办对应的碎片 id，用来在时间轴上打「已完成」标记 */
  doneIds: Set<number>;
  onAdd: (text: string) => Promise<void>;
  onEdit: (id: number, text: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onDeleteNote: (id: number) => Promise<void>;
  onOpenOrganize: () => void;
  onOpenSettings: () => void;
  onOpenKnowledge: () => void;
  onOpenReview: () => void;
  onSeed?: () => Promise<void>;
}

export function TimelineScreen({
  fragments,
  notes,
  inboxCount,
  doneIds,
  onAdd,
  onEdit,
  onDelete,
  onDeleteNote,
  onOpenOrganize,
  onOpenSettings,
  onOpenKnowledge,
  onOpenReview,
  onSeed,
}: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<Fragment | null>(null);
  const [editText, setEditText] = useState('');
  const [armedDelete, setArmedDelete] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());
  const [armedNoteDelete, setArmedNoteDelete] = useState<number | null>(null);
  const [fullEdit, setFullEdit] = useState(false);
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const fullInputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const listRef = useRef<SectionList<TimelineItem, Section>>(null);
  const keyboardHeight = useKeyboardHeight();

  // 冷启动即聚焦：记录工具打开就该能打字，不该先点一下输入框
  useEffect(() => {
    if (Platform.OS === 'web' || autoFocusedOnce) return;
    autoFocusedOnce = true;
    const timer = setTimeout(() => inputRef.current?.focus(), 380);
    return () => clearTimeout(timer);
  }, []);

  // 长文编辑是覆盖层而非 Modal，安卓返回键得自己处理，否则直接退出 App
  useEffect(() => {
    if (!editing && !fullEdit) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (editing) setEditing(null);
      if (fullEdit) setFullEdit(false);
      return true;
    });
    return () => sub.remove();
  }, [editing, fullEdit]);

  // 覆盖层里的输入框不会因为 autoFocus 稳定抢到焦点（下面那个输入框还聚焦着），
  // 挂载后主动聚焦一次更确定
  useEffect(() => {
    if (!fullEdit) return;
    const timer = setTimeout(() => fullInputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [fullEdit]);

  const sections = useMemo(() => {
    const map = new Map<string, Section>();

    const push = (at: number, item: TimelineItem) => {
      const key = dayKey(at);
      let bucket = map.get(key);
      if (!bucket) {
        bucket = { title: dayLabel(at), sub: daySubLabel(at), data: [] };
        map.set(key, bucket);
      }
      bucket.data.push(item);
    };

    for (const f of fragments) {
      push(f.createdAt, { kind: 'fragment', id: f.id, at: f.createdAt, fragment: f });
    }

    // 周期总结按 period 落回它覆盖的那一天/周/月末，
    // 而不是它被生成的那天 —— 否则上周的周报会跑到今天来
    for (const n of notes) {
      const at = periodAnchor(n.period) ?? n.createdAt;
      push(at, { kind: 'note', id: n.id, at, note: n });
    }

    for (const bucket of map.values()) {
      bucket.data.sort((a, b) => {
        // 小结排当天最前：它是这一天的一句话结论，先看结论再看零碎
        if (a.kind !== b.kind) return a.kind === 'note' ? -1 : 1;
        return b.at - a.at;
      });
    }

    // 日期键是 YYYY-MM-DD，字典序即时间序；时间轴是新在上
    return Array.from(map.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([, bucket]) => bucket);
  }, [fragments, notes]);

  const todayCount = useMemo(() => {
    const key = dayKey(Date.now());
    return fragments.filter((f) => dayKey(f.createdAt) === key).length;
  }, [fragments]);

  const canSend = draft.trim().length > 0 && !sending;

  async function submit() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onAdd(text);
      setDraft('');
      inputRef.current?.focus();
      scrollToTopSoon();
    } finally {
      setSending(false);
    }
  }

  /**
   * 记完回到顶部。否则当列表滚到下面时，新记的这条在顶部，
   * 用户会觉得"我明明记了却没看见"。
   */
  function scrollToTopSoon() {
    setTimeout(() => {
      try {
        listRef.current?.scrollToLocation({
          sectionIndex: 0,
          itemIndex: 0,
          animated: true,
          viewOffset: 0,
        });
      } catch {
        /* 数据尚未重排完成时忽略，滚动只是锦上添花 */
      }
    }, 140);
  }

  function openEdit(item: Fragment) {
    inputRef.current?.blur();
    setEditing(item);
    setEditText(item.content);
    setArmedDelete(false);
  }

  function toggleNote(id: number) {
    setArmedNoteDelete(null);
    setExpandedNotes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 删除总结要两次点击，和删碎片一致 —— 内容没了就真没了 */
  async function removeNote(id: number) {
    if (armedNoteDelete !== id) {
      setArmedNoteDelete(id);
      return;
    }
    setArmedNoteDelete(null);
    await onDeleteNote(id);
  }

  function toggleExpand(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveEdit() {
    if (!editing) return;
    const text = editText.trim();
    if (!text) return;
    await onEdit(editing.id, text);
    setEditing(null);
  }

  async function removeEditing() {
    if (!editing) return;
    if (!armedDelete) {
      setArmedDelete(true);
      return;
    }
    await onDelete(editing.id);
    setEditing(null);
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>碎片</Text>
          <Text style={styles.brandSub}>
            {todayCount > 0 ? `今天记了 ${todayCount} 条` : '今天还没记东西'}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable style={styles.iconBtn} onPress={onOpenKnowledge} hitSlop={10}>
            <Ionicons name="albums-outline" size={19} color={C.text2} />
          </Pressable>
          <Pressable style={styles.iconBtn} onPress={onOpenReview} hitSlop={10}>
            <Ionicons name="list-outline" size={19} color={C.text2} />
          </Pressable>
          <Pressable style={styles.iconBtn} onPress={onOpenSettings} hitSlop={10}>
            <Ionicons name="settings-outline" size={19} color={C.text2} />
          </Pressable>
          <Pressable style={styles.organizeBtn} onPress={onOpenOrganize}>
            <Ionicons name="sparkles-outline" size={12} color={C.accentText} />
            <Text style={styles.organizeText}>
              整理{inboxCount > 0 ? ` ${inboxCount > 99 ? '99+' : inboxCount}` : ''}
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.flex}>
        {sections.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>还没有碎片</Text>
            <Text style={styles.emptyBody}>
              想到什么就在下面写一句，{'\n'}不用管分类，AI 会在你点「整理」时帮你归置。
            </Text>
            {Platform.OS === 'web' && onSeed ? (
              <Pressable onPress={onSeed} hitSlop={8} style={styles.seedBtn}>
                <Text style={styles.seedText}>填入示例碎片看看效果</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <SectionList
            ref={listRef}
            sections={sections}
            keyExtractor={(item) => `${item.kind}-${item.id}`}
            stickySectionHeadersEnabled
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            renderSectionHeader={({ section }) => (
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                <Text style={styles.sectionSub}>
                  {section.sub} · {section.data.length} 条
                </Text>
              </View>
            )}
            renderItem={({ item, index, section }) => {
              const isLast = index === section.data.length - 1;

              if (item.kind === 'note') {
                const note = item.note;
                const open = expandedNotes.has(note.id);
                return (
                  <Pressable
                    onPress={() => toggleNote(note.id)}
                    style={({ pressed }) => [styles.noteRow, pressed && styles.rowPressed]}
                  >
                    <Text style={styles.time}>{formatTime(item.at)}</Text>
                    <View style={styles.rail}>
                      {!isLast && <View style={styles.railLine} />}
                      <View style={styles.noteDot} />
                    </View>
                    <View style={styles.noteCard}>
                      <View style={styles.noteHead}>
                        <Ionicons name="sparkles" size={11} color={C.accent} />
                        <Text style={styles.noteKind}>{NOTE_KIND[note.type] ?? '总结'}</Text>
                        <Text style={styles.notePeriod}>{periodLabel(note.period)}</Text>
                      </View>
                      <NoteBody
                        text={note.bodyMd}
                        numberOfLines={open ? undefined : 5}
                        style={styles.noteBody}
                      />
                      <View style={styles.noteFoot}>
                        <Text style={styles.noteToggle}>{open ? '收起' : '展开全文'}</Text>
                        {open && (
                          <Pressable
                            onPress={() => removeNote(note.id)}
                            hitSlop={8}
                            style={styles.noteDeleteHit}
                          >
                            <Text style={styles.noteDelete}>
                              {armedNoteDelete === note.id ? '再点一次确认删除' : '删除这条总结'}
                            </Text>
                          </Pressable>
                        )}
                      </View>
                    </View>
                  </Pressable>
                );
              }

              const fragment = item.fragment;
              const merged = fragment.mergedInto !== null;
              const done = doneIds.has(fragment.id);
              return (
                <Pressable
                  onPress={() => openEdit(fragment)}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                  <Text style={styles.time}>{formatTime(fragment.createdAt)}</Text>
                  <View style={styles.rail}>
                    {!isLast && <View style={styles.railLine} />}
                    <View style={[styles.dot, merged && styles.dotMuted]} />
                  </View>
                  <View style={styles.rowBody}>
                    {(() => {
                      // 60 字大约才三行，随手记详细一点就被折了，放宽到 100
                      const long = fragment.content.length > 100 || fragment.content.includes('\n');
                      const open = expandedIds.has(fragment.id);
                      return (
                        <>
                          <Text
                            style={[styles.content, merged && styles.contentMuted]}
                            numberOfLines={long && !open ? 3 : undefined}
                          >
                            {fragment.content}
                          </Text>
                          {long ? (
                            <Pressable
                              onPress={() => toggleExpand(fragment.id)}
                              hitSlop={8}
                              style={styles.expandBtn}
                            >
                              <Text style={styles.expandText}>
                                {open ? '收起' : `展开全文 · ${fragment.content.length} 字`}
                              </Text>
                            </Pressable>
                          ) : null}
                        </>
                      );
                    })()}
                    {(fragment.tags.length > 0 ||
                      fragment.project ||
                      fragment.source !== 'app' ||
                      merged ||
                      done) && (
                      <View style={styles.metaRow}>
                        {done ? (
                          <View style={styles.doneBadge}>
                            <Ionicons name="checkmark" size={9} color={C.tealText} />
                            <Text style={styles.doneBadgeText}>已完成</Text>
                          </View>
                        ) : null}
                        {fragment.tags.map((t) => (
                          <TagPill key={t} label={t} small />
                        ))}
                        {fragment.project ? (
                          <Text style={styles.project} numberOfLines={1}>
                            {fragment.project}
                          </Text>
                        ) : null}
                        {fragment.source !== 'app' ? (
                          <Ionicons
                            name={fragment.source === 'notif' ? 'notifications-outline' : 'share-outline'}
                            size={11}
                            color={C.text3}
                          />
                        ) : null}
                        {merged ? <Text style={styles.mergedTag}>已合并</Text> : null}
                      </View>
                    )}
                  </View>
                </Pressable>
              );
            }}
            ListFooterComponent={<View style={{ height: 12 }} />}
          />
        )}

        <View style={[styles.composerWrap, { paddingBottom: 10 + keyboardHeight }]}>
          <View style={styles.composer}>
            <TextInput
              ref={inputRef}
              value={draft}
              onChangeText={setDraft}
              placeholder="随手记一条…"
              placeholderTextColor={C.text3}
              style={styles.input}
              multiline
              maxLength={2000}
              onSubmitEditing={submit}
              blurOnSubmit={false}
              returnKeyType="default"
            />
            <Pressable onPress={() => setFullEdit(true)} hitSlop={8} style={styles.expandIcon}>
              <Ionicons name="expand-outline" size={16} color={C.text3} />
            </Pressable>
            <Pressable
              onPress={submit}
              disabled={!canSend}
              style={[styles.send, canSend && styles.sendActive]}
              hitSlop={6}
            >
              <Ionicons name="arrow-up" size={17} color={canSend ? '#FFFFFF' : C.text3} />
            </Pressable>
          </View>
        </View>
      </View>

      {/*
        编辑面板与长文输入都用覆盖层，不再用 Modal。
        Modal 在 Android 上是一个独立窗口：拿到的是窗口级 inset，长文页顶部会直接顶到
        状态栏底下和通知栏重合；键盘事件也不会从 Activity 根视图冒上来，躲不开输入法。
        覆盖层留在同一棵 React 树里，安全区已经由外层 SafeAreaView 让出来了。
      */}
      {editing ? (
        <View style={[styles.overlay, styles.sheetOverlay, { paddingBottom: keyboardHeight }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setEditing(null)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>编辑碎片</Text>
            <TextInput
              value={editText}
              onChangeText={setEditText}
              style={styles.sheetInput}
              multiline
              autoFocus
              maxLength={2000}
            />
            <View style={styles.sheetActions}>
              <Pressable onPress={removeEditing} hitSlop={8}>
                <Text style={styles.danger}>{armedDelete ? '再点一次确认删除' : '删除'}</Text>
              </Pressable>
              <View style={styles.flex} />
              <Pressable onPress={() => setEditing(null)} hitSlop={8}>
                <Text style={styles.muted}>取消</Text>
              </Pressable>
              <Pressable onPress={saveEdit} hitSlop={8}>
                <Text style={styles.primary}>保存</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {fullEdit ? (
        <View style={[styles.overlay, styles.fullOverlay, { paddingBottom: keyboardHeight }]}>
          <View style={styles.fullHeader}>
            <Pressable onPress={() => setFullEdit(false)} hitSlop={10}>
              <Text style={styles.muted}>取消</Text>
            </Pressable>
            <Text style={styles.fullTitle}>长文记录</Text>
            <Pressable
              onPress={async () => {
                setFullEdit(false);
                await submit();
              }}
              hitSlop={10}
              disabled={!canSend}
            >
              <Text style={[styles.primary, !canSend && styles.muted]}>保存</Text>
            </Pressable>
          </View>
          <TextInput
            ref={fullInputRef}
            value={draft}
            onChangeText={setDraft}
            style={styles.fullInput}
            multiline
            placeholder="想写多少写多少。长一点也没关系，整理时 AI 会单独提炼要点。"
            placeholderTextColor={C.text3}
            maxLength={20000}
          />
          <Text style={styles.fullCount}>{draft.length} 字</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.page },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 14,
  },
  brand: { fontSize: 22, color: C.text, fontWeight: '500', letterSpacing: 0.5 },
  brandSub: { fontSize: 12, color: C.text3, marginTop: 3 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBtn: { padding: 2 },
  organizeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: C.accentBg,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: R.pill,
  },
  organizeText: { fontSize: 13, color: C.accentText, fontWeight: '500' },

  listContent: { paddingBottom: 8 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 8,
    backgroundColor: C.page,
  },
  sectionTitle: { fontSize: 13, color: C.text, fontWeight: '500' },
  sectionSub: { fontSize: 11, color: C.text3 },

  row: { flexDirection: 'row', paddingHorizontal: 20 },
  rowPressed: { backgroundColor: C.hairSoft },
  time: { width: 42, fontSize: 12, color: C.text3, paddingTop: 3, fontVariant: ['tabular-nums'] },
  rail: { width: 16, alignItems: 'center' },
  railLine: { position: 'absolute', top: 16, bottom: -6, width: 1, backgroundColor: C.hair },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.text3,
    marginTop: 6,
  },
  dotMuted: { backgroundColor: C.hair },
  rowBody: { flex: 1, paddingBottom: 16, paddingLeft: 2 },
  content: { fontSize: 15, lineHeight: 22, color: C.text },
  contentMuted: { color: C.text3 },
  expandBtn: { marginTop: 5, alignSelf: 'flex-start' },
  expandText: { fontSize: 12, color: C.accent },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  project: { fontSize: 11, color: C.text3, maxWidth: 120 },
  mergedTag: { fontSize: 11, color: C.text3 },

  // 已完成标记：浅青底小胶囊，比标签低调，不和用户自己的 tag 抢注意力
  doneBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: C.tealBg,
    borderRadius: R.pill,
    paddingLeft: 4,
    paddingRight: 7,
    paddingVertical: 2,
  },
  doneBadgeText: { fontSize: 10, lineHeight: 14, color: C.tealText },

  // 周期总结条目
  noteRow: { flexDirection: 'row', paddingHorizontal: 20 },
  noteDot: {
    width: 8,
    height: 8,
    borderRadius: 2,
    backgroundColor: C.accent,
    marginTop: 5,
    transform: [{ rotate: '45deg' }],
  },
  noteCard: {
    flex: 1,
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    paddingHorizontal: 13,
    paddingVertical: 11,
    marginBottom: 16,
    marginLeft: 2,
  },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 7 },
  noteKind: { fontSize: 11, color: C.accentText, fontWeight: '500' },
  notePeriod: { flex: 1, fontSize: 11, color: C.text3 },
  noteBody: { fontSize: 14, lineHeight: 22, color: C.text },
  noteFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  noteToggle: { fontSize: 12, color: C.accent },
  noteDeleteHit: { paddingVertical: 2 },
  noteDelete: { fontSize: 11, color: C.danger },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 60 },
  emptyTitle: { fontSize: 15, color: C.text2, fontWeight: '500' },
  emptyBody: {
    fontSize: 13,
    color: C.text3,
    textAlign: 'center',
    lineHeight: 21,
    marginTop: 10,
  },
  seedBtn: { marginTop: 22, paddingVertical: 6, paddingHorizontal: 10 },
  seedText: { fontSize: 12, color: C.accent, textDecorationLine: 'underline' },

  composerWrap: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
    backgroundColor: C.page,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    lineHeight: 21,
    color: C.text,
    maxHeight: 108,
    paddingTop: 4,
    paddingBottom: 4,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
  },
  send: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.hairSoft,
  },
  sendActive: { backgroundColor: C.accent },
  expandIcon: { paddingBottom: 7, paddingHorizontal: 1 },

  fullHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.hair,
  },
  fullTitle: { fontSize: 14, color: C.text, fontWeight: '500' },
  fullInput: {
    flex: 1,
    fontSize: 15,
    lineHeight: 23,
    color: C.text,
    paddingHorizontal: 18,
    paddingVertical: 16,
    textAlignVertical: 'top',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
  },
  fullCount: { fontSize: 11, color: C.text3, textAlign: 'right', paddingHorizontal: 18, paddingBottom: 16 },

  /** 覆盖整个内容区；安全区由外层 SafeAreaView 负责，这里只管层叠 */
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: C.page,
  },
  sheetOverlay: {
    backgroundColor: 'rgba(27,27,25,0.32)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  fullOverlay: { paddingTop: 12 },
  sheet: {
    backgroundColor: C.card,
    borderRadius: R.card,
    padding: 18,
    borderWidth: 0.5,
    borderColor: C.hair,
  },
  sheetTitle: { fontSize: 14, color: C.text, fontWeight: '500', marginBottom: 12 },
  sheetInput: {
    fontSize: 15,
    lineHeight: 22,
    color: C.text,
    minHeight: 88,
    maxHeight: 220,
    borderWidth: 0.5,
    borderColor: C.hair,
    borderRadius: R.btn,
    padding: 12,
    textAlignVertical: 'top',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
  },
  sheetActions: { flexDirection: 'row', alignItems: 'center', gap: 18, marginTop: 16 },
  danger: { fontSize: 13, color: C.danger },
  muted: { fontSize: 13, color: C.text2 },
  primary: { fontSize: 13, color: C.accent, fontWeight: '500' },
});
