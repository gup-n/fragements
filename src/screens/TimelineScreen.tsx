import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Fragment } from '../types';
import { C, R } from '../theme';
import { TagPill } from '../components/TagPill';
import { dayKey, dayLabel, daySubLabel, formatTime } from '../util/date';

type Section = { title: string; sub: string; data: Fragment[] };

/**
 * 冷启动只自动聚焦一次。放在模块作用域而不是 useRef，
 * 是因为从设置页/知识库返回时会卸载再挂载，用 ref 会反复弹键盘。
 */
let autoFocusedOnce = false;

interface Props {
  fragments: Fragment[];
  inboxCount: number;
  onAdd: (text: string) => Promise<void>;
  onEdit: (id: number, text: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onOpenOrganize: () => void;
  onOpenSettings: () => void;
  onOpenKnowledge: () => void;
  onSeed?: () => Promise<void>;
}

export function TimelineScreen({
  fragments,
  inboxCount,
  onAdd,
  onEdit,
  onDelete,
  onOpenOrganize,
  onOpenSettings,
  onOpenKnowledge,
  onSeed,
}: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<Fragment | null>(null);
  const [editText, setEditText] = useState('');
  const [armedDelete, setArmedDelete] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [fullEdit, setFullEdit] = useState(false);
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const listRef = useRef<SectionList<Fragment, Section>>(null);

  // 冷启动即聚焦：记录工具打开就该能打字，不该先点一下输入框
  useEffect(() => {
    if (Platform.OS === 'web' || autoFocusedOnce) return;
    autoFocusedOnce = true;
    const timer = setTimeout(() => inputRef.current?.focus(), 380);
    return () => clearTimeout(timer);
  }, []);

  const sections = useMemo(() => {
    const map = new Map<string, { title: string; sub: string; data: Fragment[] }>();
    for (const f of fragments) {
      const key = dayKey(f.createdAt);
      let bucket = map.get(key);
      if (!bucket) {
        bucket = { title: dayLabel(f.createdAt), sub: daySubLabel(f.createdAt), data: [] };
        map.set(key, bucket);
      }
      bucket.data.push(f);
    }
    return Array.from(map.values());
  }, [fragments]);

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
    setEditing(item);
    setEditText(item.content);
    setArmedDelete(false);
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

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {fragments.length === 0 ? (
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
            keyExtractor={(item) => String(item.id)}
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
              const merged = item.mergedInto !== null;
              return (
                <Pressable
                  onPress={() => openEdit(item)}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                  <Text style={styles.time}>{formatTime(item.createdAt)}</Text>
                  <View style={styles.rail}>
                    {!isLast && <View style={styles.railLine} />}
                    <View style={[styles.dot, merged && styles.dotMuted]} />
                  </View>
                  <View style={styles.rowBody}>
                    {(() => {
                      // 60 字大约才三行，随手记详细一点就被折了，放宽到 100
                      const long = item.content.length > 100 || item.content.includes('\n');
                      const open = expandedIds.has(item.id);
                      return (
                        <>
                          <Text
                            style={[styles.content, merged && styles.contentMuted]}
                            numberOfLines={long && !open ? 3 : undefined}
                          >
                            {item.content}
                          </Text>
                          {long ? (
                            <Pressable
                              onPress={() => toggleExpand(item.id)}
                              hitSlop={8}
                              style={styles.expandBtn}
                            >
                              <Text style={styles.expandText}>
                                {open ? '收起' : `展开全文 · ${item.content.length} 字`}
                              </Text>
                            </Pressable>
                          ) : null}
                        </>
                      );
                    })()}
                    {(item.tags.length > 0 || item.project || item.source !== 'app') && (
                      <View style={styles.metaRow}>
                        {item.tags.map((t) => (
                          <TagPill key={t} label={t} small />
                        ))}
                        {item.project ? (
                          <Text style={styles.project} numberOfLines={1}>
                            {item.project}
                          </Text>
                        ) : null}
                        {item.source !== 'app' ? (
                          <Ionicons
                            name={item.source === 'notif' ? 'notifications-outline' : 'share-outline'}
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

        <View style={styles.composerWrap}>
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
      </KeyboardAvoidingView>

      <Modal
        visible={!!editing}
        transparent
        animationType="fade"
        onRequestClose={() => setEditing(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setEditing(null)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
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
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={fullEdit}
        animationType="slide"
        onRequestClose={() => setFullEdit(false)}
      >
        <View style={styles.fullRoot}>
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
            value={draft}
            onChangeText={setDraft}
            style={styles.fullInput}
            multiline
            autoFocus
            placeholder="想写多少写多少。长一点也没关系，整理时 AI 会单独提炼要点。"
            placeholderTextColor={C.text3}
            maxLength={20000}
          />
          <Text style={styles.fullCount}>{draft.length} 字</Text>
        </View>
      </Modal>
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

  fullRoot: { flex: 1, backgroundColor: C.page, paddingTop: 12 },
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

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(27,27,25,0.32)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
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
