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
import { IconButton } from '../components/IconButton';
import { FragmentDetail } from '../components/FragmentDetail';
import { dayKey, dayLabel, daySubLabel, formatTime, periodAnchor, periodLabel } from '../util/date';
import { useKeyboardHeight } from '../util/keyboard';

/**
 * 时间轴上混着两种东西：碎片和周期总结。
 * 用 kind 区分，渲染时分两套样式 —— 但共用同一条竖线，视觉上仍是一条连续的时间流。
 */
type TimelineItem =
  | { kind: 'fragment'; id: number; at: number; fragment: Fragment }
  | { kind: 'note'; id: number; at: number; note: Note };

/** key 是 YYYY-MM-DD，折叠状态按它记；标题只用于显示，不能拿来当键 */
type Section = { key: string; title: string; sub: string; data: TimelineItem[] };

/**
 * 交给 SectionList 的版本：折叠时 data 清空（header 仍然渲染），
 * 所以条数和预览必须提前算好带上，不能等渲染时再读 data。
 */
type DisplaySection = Section & { total: number; preview: string };

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
  const [query, setQuery] = useState('');
  /**
   * 折叠过的日期。null 表示「还没手动动过」—— 这时用默认规则（只展开今天）。
   * 不直接把默认集合塞进 state，是因为「今天」会随日期变，写死一次就永远停在旧日期上了。
   */
  const [collapsedDays, setCollapsedDays] = useState<Set<string> | null>(null);
  /** 详情页。存序列快照而不是只存 id —— 用户滑到第 5 条时列表可能重排了 */
  const [detail, setDetail] = useState<{ items: Fragment[]; index: number } | null>(null);
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const fullInputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const listRef = useRef<SectionList<TimelineItem, DisplaySection>>(null);
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

  const searching = query.trim().length > 0;
  const todayKey = dayKey(Date.now());

  /**
   * 搜索直接在内存里过滤，不走 SQLite：碎片本来就全量躺在 props 里，
   * 再压一个查询接口下去，反而拿不到 tags / project 这几个内存字段的匹配。
   */
  const visibleFragments = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fragments;
    return fragments.filter(
      (f) =>
        f.content.toLowerCase().includes(q) ||
        (f.project ?? '').toLowerCase().includes(q) ||
        f.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [fragments, query]);

  const sections = useMemo(() => {
    const map = new Map<string, Section>();

    const push = (at: number, item: TimelineItem) => {
      const key = dayKey(at);
      let bucket = map.get(key);
      if (!bucket) {
        bucket = { key, title: dayLabel(at), sub: daySubLabel(at), data: [] };
        map.set(key, bucket);
      }
      bucket.data.push(item);
    };

    for (const f of visibleFragments) {
      push(f.createdAt, { kind: 'fragment', id: f.id, at: f.createdAt, fragment: f });
    }

    // 搜索时只查碎片原文 —— 把小结也混进来，结果会在日期头下面孤零零挂一条，
    // 反而看不清到底哪条碎片命中了。要翻小结请直接看时间轴。
    if (!searching) {
      // 周期总结按 period 落回它覆盖的那一天/周/月末，
      // 而不是它被生成的那天 —— 否则上周的周报会跑到今天来
      for (const n of notes) {
        const at = periodAnchor(n.period) ?? n.createdAt;
        push(at, { kind: 'note', id: n.id, at, note: n });
      }
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
  }, [visibleFragments, notes, searching]);

  /**
   * 当前生效的折叠集合。默认只展开今天，其余全部收起 —— 记录攒了几天以后，
   * 一屏全是前几天的内容会盖住今天刚记的东西。
   * 搜索时强制全展开，否则命中的条目藏在折叠里等于没搜到。
   */
  const collapsedKeys = useMemo(() => {
    if (searching) return new Set<string>();
    if (collapsedDays) return collapsedDays;
    return new Set(sections.filter((s) => s.key !== todayKey).map((s) => s.key));
  }, [sections, collapsedDays, searching, todayKey]);

  const displaySections = useMemo<DisplaySection[]>(
    () =>
      sections.map((sec) => {
        const first = sec.data[0];
        const preview =
          first?.kind === 'fragment'
            ? first.fragment.content.replace(/\s+/g, ' ')
            : first?.kind === 'note'
              ? first.note.bodyMd.replace(/[#*>\-\n]+/g, ' ').trim()
              : '';
        const collapsed = collapsedKeys.has(sec.key);
        return {
          ...sec,
          data: collapsed ? [] : sec.data,
          total: sec.data.length,
          preview: collapsed ? preview : '',
        };
      }),
    [sections, collapsedKeys],
  );

  /** 详情页的翻页序列：与当前列表顺序一致，搜索时就是搜索结果 */
  const flat = useMemo(() => {
    const out: Fragment[] = [];
    for (const sec of sections) {
      for (const it of sec.data) if (it.kind === 'fragment') out.push(it.fragment);
    }
    return out;
  }, [sections]);

  const todayCount = useMemo(() => {
    const key = dayKey(Date.now());
    return fragments.filter((f) => dayKey(f.createdAt) === key).length;
  }, [fragments]);

  const searchStat = useMemo(() => {
    if (!searching) return null;
    return {
      total: visibleFragments.length,
      inbox: visibleFragments.filter((f) => f.status === 'inbox').length,
    };
  }, [searching, visibleFragments]);

  const canSend = draft.trim().length > 0 && !sending;

  async function submit() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onAdd(text);
      setDraft('');
      // 刚记完必须能看见：万一用户把今天也折叠了，这里替他展开。
      // 折叠一个「刚往里写了东西的日期」没有任何意义。
      setCollapsedDays((prev) => {
        if (!prev || !prev.has(todayKey)) return prev;
        const next = new Set(prev);
        next.delete(todayKey);
        return next;
      });
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

  /** 点一条碎片先读，不直接进编辑 —— 想通读长文时不该先得到一个光标 */
  function openDetail(f: Fragment) {
    inputRef.current?.blur();
    const i = flat.findIndex((x) => x.id === f.id);
    setDetail({ items: flat, index: i < 0 ? 0 : i });
  }

  /** 第一次点击时把「默认只展开今天」固化成显式集合，之后完全按用户的来 */
  function toggleDay(key: string) {
    setCollapsedDays((prev) => {
      const next = new Set(prev ?? collapsedKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
        <View style={styles.headerLeft}>
          <Text style={styles.brand} numberOfLines={1}>
            碎片
          </Text>
          <Text style={styles.brandSub} numberOfLines={1}>
            {todayCount > 0 ? `今天记了 ${todayCount} 条` : '今天还没记东西'}
          </Text>
        </View>

        <View style={styles.headerActions}>
          <IconButton
            name="library-outline"
            size={20}
            tone="soft"
            color={C.text2}
            diameter={34}
            onPress={onOpenKnowledge}
            accessibilityLabel="知识库"
          />
          <IconButton
            name="checkmark-circle-outline"
            size={20}
            tone="soft"
            color={C.text2}
            diameter={34}
            onPress={onOpenReview}
            accessibilityLabel="回顾待办与小结"
          />
          <IconButton
            name="settings-outline"
            size={20}
            tone="soft"
            color={C.text2}
            diameter={34}
            onPress={onOpenSettings}
            accessibilityLabel="设置"
          />
          {/* 主入口：有未读时实心蓝底，没有的时候退成描边，一眼看出「现在该不该整理」 */}
          <Pressable
            style={({ pressed }) => [
              styles.organizeBtn,
              inboxCount > 0 && styles.organizeBtnOn,
              pressed && { opacity: 0.7 },
            ]}
            onPress={onOpenOrganize}
          >
            <Ionicons
              name="sparkles"
              size={14}
              color={inboxCount > 0 ? '#FFFFFF' : C.accentText}
            />
            <Text style={[styles.organizeText, inboxCount > 0 && styles.organizeTextOn]}>
              整理{inboxCount > 0 ? ` ${inboxCount > 99 ? '99+' : inboxCount}` : ''}
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color={C.text3} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索碎片原文、标签、事项"
            placeholderTextColor={C.text3}
            style={styles.searchInput}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {searching ? (
            <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="清除搜索">
              <Ionicons name="close-circle" size={17} color={C.text3} />
            </Pressable>
          ) : null}
        </View>
        {searchStat ? (
          <Text style={styles.searchStat}>
            {searchStat.total === 0
              ? '没有匹配的碎片'
              : `找到 ${searchStat.total} 条${searchStat.inbox > 0 ? ` · ${searchStat.inbox} 条还没整理` : ''}`}
          </Text>
        ) : null}
      </View>

      <View style={styles.flex}>
        {sections.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Ionicons name="create-outline" size={26} color={C.text3} />
            </View>
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
            sections={displaySections}
            keyExtractor={(item) => `${item.kind}-${item.id}`}
            stickySectionHeadersEnabled
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            renderSectionHeader={({ section }) => {
              const closed = collapsedKeys.has(section.key);
              return (
                <Pressable
                  style={({ pressed }) => [
                    styles.sectionHeader,
                    pressed && !searching && styles.sectionHeaderPressed,
                  ]}
                  onPress={() => {
                    if (!searching) toggleDay(section.key);
                  }}
                  disabled={searching}
                >
                  <View style={styles.sectionHeaderRow}>
                    <Text style={styles.sectionTitle}>{section.title}</Text>
                    <Text style={styles.sectionSub}>
                      {section.sub} · {section.total} 条
                    </Text>
                    {searching ? null : (
                      <Ionicons
                        name={closed ? 'chevron-forward' : 'chevron-down'}
                        size={15}
                        color={C.text3}
                      />
                    )}
                  </View>
                  {section.preview ? (
                    <Text style={styles.sectionPreview} numberOfLines={1}>
                      {section.preview}
                    </Text>
                  ) : null}
                </Pressable>
              );
            }}
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
                        <Ionicons name="sparkles" size={13} color={C.accent} />
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
                  onPress={() => openDetail(fragment)}
                  // 长按直接进编辑：看是主路径，改是熟练用户的捷径，不用每次先进详情页
                  onLongPress={() => openEdit(fragment)}
                  delayLongPress={400}
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
                            <Ionicons name="checkmark" size={11} color={C.tealText} />
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
                            size={12.5}
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
              <Ionicons name="expand-outline" size={17} color={C.text2} />
            </Pressable>
            <Pressable
              onPress={submit}
              disabled={!canSend}
              style={[styles.send, canSend && styles.sendActive]}
              hitSlop={6}
            >
              <Ionicons name="arrow-up" size={18} color={canSend ? '#FFFFFF' : C.text3} />
            </Pressable>
          </View>
        </View>
      </View>

      {/*
        详情页必须排在编辑面板之前渲染 —— 两者都是 absolute 全屏覆盖层，
        JSX 顺序就是层叠顺序。存活的详情页留在下面，编辑完关掉能回到原来那一条。
      */}
      {detail ? (
        <FragmentDetail
          key={detail.items[detail.index]?.id ?? 0}
          items={detail.items}
          initialIndex={detail.index}
          doneIds={doneIds}
          onClose={() => setDetail(null)}
          onEdit={openEdit}
        />
      ) : null}

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
    gap: 8,
    paddingLeft: 20,
    paddingRight: 14,
    paddingTop: 6,
    paddingBottom: 10,
  },
  headerLeft: { flexShrink: 1 },
  brand: { fontSize: 22, color: C.text, fontWeight: '600', letterSpacing: 0.8 },
  brandSub: { fontSize: 12, color: C.text3, marginTop: 2 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  organizeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 6,
    backgroundColor: C.accentBg,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: R.pill,
  },
  organizeBtnOn: { backgroundColor: C.accent },
  organizeText: { fontSize: 13, color: C.accentText, fontWeight: '600' },
  organizeTextOn: { color: '#FFFFFF' },

  // 搜索框放在页头下，用浅灰底和留白跟列表区分，不额外加边框
  searchWrap: {
    paddingHorizontal: 20,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.hair,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    height: 38,
    backgroundColor: C.hairSoft,
    borderRadius: R.btn + 2,
    paddingHorizontal: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: C.text,
    paddingVertical: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
  },
  searchStat: { fontSize: 11.5, color: C.text3, marginTop: 7, paddingLeft: 2 },

  listContent: { paddingBottom: 8 },
  // 收起态是两行（日期 + 一条预览），所以 header 从 row 改成 column
  sectionHeader: {
    paddingHorizontal: 20,
    paddingTop: 15,
    paddingBottom: 9,
    backgroundColor: C.page,
  },
  sectionHeaderPressed: { backgroundColor: C.hairSoft },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { fontSize: 13.5, color: C.text, fontWeight: '600', letterSpacing: 0.3 },
  sectionSub: {
    flex: 1,
    fontSize: 11,
    color: C.text3,
    fontVariant: ['tabular-nums'],
  },
  sectionPreview: { fontSize: 12, lineHeight: 17, color: C.text3, marginTop: 5 },

  row: { flexDirection: 'row', paddingHorizontal: 20 },
  rowPressed: { backgroundColor: C.hairSoft },
  time: {
    width: 44,
    fontSize: 11.5,
    color: C.text3,
    paddingTop: 3,
    fontVariant: ['tabular-nums'],
  },
  rail: { width: 16, alignItems: 'center' },
  railLine: { position: 'absolute', top: 17, bottom: -8, width: 1, backgroundColor: C.hair },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: C.text3,
    marginTop: 7,
  },
  dotMuted: { backgroundColor: C.hair },
  rowBody: { flex: 1, paddingBottom: 18, paddingLeft: 2 },
  content: { fontSize: 15, lineHeight: 23, color: C.text },
  contentMuted: { color: C.text3 },
  expandBtn: { marginTop: 6, alignSelf: 'flex-start' },
  expandText: { fontSize: 12.5, color: C.accent },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  project: { fontSize: 11, color: C.text3, maxWidth: 120 },
  mergedTag: { fontSize: 11, color: C.text3 },

  // 已完成标记：浅青底小胶囊，比标签低调，不和用户自己的 tag 抢注意力
  doneBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: C.tealBg,
    borderRadius: R.pill,
    paddingLeft: 5,
    paddingRight: 8,
    paddingVertical: 2,
  },
  doneBadgeText: { fontSize: 10.5, lineHeight: 15, color: C.tealText },

  // 周期总结条目
  noteRow: { flexDirection: 'row', paddingHorizontal: 20 },
  noteDot: {
    width: 9,
    height: 9,
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
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
    marginLeft: 2,
  },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  noteKind: { fontSize: 11.5, color: C.accentText, fontWeight: '600' },
  notePeriod: { flex: 1, fontSize: 11, color: C.text3 },
  noteBody: { fontSize: 14.5, lineHeight: 23, color: C.text },
  noteFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  noteToggle: { fontSize: 12.5, color: C.accent },
  noteDeleteHit: { paddingVertical: 2 },
  noteDelete: { fontSize: 11, color: C.danger },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 60 },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: C.hairSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  emptyTitle: { fontSize: 15.5, color: C.text2, fontWeight: '500' },
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
    paddingTop: 9,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
    backgroundColor: C.page,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    backgroundColor: C.card,
    borderRadius: R.card + 2,
    borderWidth: 0.5,
    borderColor: C.hair,
    paddingLeft: 14,
    paddingRight: 8,
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
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.hairSoft,
  },
  sendActive: { backgroundColor: C.accent },
  expandIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.hairSoft,
    marginRight: 2,
    marginBottom: 1,
  },

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
