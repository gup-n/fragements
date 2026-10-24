/**
 * 问答记录：所有主题的提问摊成一个扁平列表，Q / A 成对。
 *
 * 为什么不做成「每个主题一个会话气泡流」：
 * 这些记录的第一用途是**回看**（上次那个问题最后怎么解决的），
 * 第二用途才是带进新一轮。气泡流适合连续的对话，翻旧账时要一直往上滑，
 * 而扁平列表每条自带时间和主题，扫一眼就能定位。
 *
 * 记录**默认不参与检索**：卡片是沉淀下来的结论，问答是一次性对话，
 * 混在一起会让「全库 N 张卡」虚高，也会让检索捞出一堆当时问错的废话。
 * 想用哪条，手动点「带入本轮」。
 */
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { AskLog } from '../types';
import { C, R } from '../theme';
import { daySubLabel, formatTime } from '../util/date';

interface Props {
  logs: AskLog[];
  loading: boolean;
  /** 已勾选要带进这一轮的记录 id */
  pinned: Set<number>;
  onTogglePin: (log: AskLog) => void;
  /** 一键带入最近 N 轮 —— 「这主题刚才聊到哪」这个动作最常用 */
  onPinRecent: () => void;
  onEdit: (id: number, question: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /** scope 是 'all' 或主题名，显示成「全库」/ 主题名 */
  scopeLabel: (scope: string) => string;
}

/** 列表只显示精简：把 Markdown 标记和换行压成一行，否则三行预览全被符号占满 */
function preview(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function AskHistory({
  logs,
  loading,
  pinned,
  onTogglePin,
  onPinRecent,
  onEdit,
  onDelete,
  scopeLabel,
}: Props) {
  const [openIds, setOpenIds] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [armed, setArmed] = useState<number | null>(null);

  function toggleOpen(id: number) {
    setArmed(null);
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startEdit(log: AskLog) {
    setEditingId(log.id);
    setEditText(log.question);
    setArmed(null);
  }

  async function saveEdit() {
    if (editingId === null) return;
    const text = editText.trim();
    if (!text) return;
    await onEdit(editingId, text);
    setEditingId(null);
  }

  async function remove(id: number) {
    if (armed !== id) {
      setArmed(id);
      return;
    }
    setArmed(null);
    await onDelete(id);
  }

  if (loading) {
    return (
      <View style={s.loading}>
        <ActivityIndicator size="small" color={C.text3} />
      </View>
    );
  }

  if (!logs.length) {
    return (
      <View style={s.empty}>
        <View style={s.emptyIcon}>
          <Ionicons name="chatbubbles-outline" size={22} color={C.text3} />
        </View>
        <Text style={s.emptyTitle}>还没有问答记录</Text>
        <Text style={s.emptyBody}>
          问过的问题都会记在这里，换主题也能翻到。{'\n'}
          记录不参与卡片检索，想用就点「带入本轮」。
        </Text>
      </View>
    );
  }

  return (
    <View>
      <View style={s.bar}>
        <Text style={s.barText}>{logs.length} 条记录</Text>
        <Pressable onPress={onPinRecent} hitSlop={8}>
          <Text style={s.barBtn}>带入最近 3 轮</Text>
        </Pressable>
      </View>

      {logs.map((log) => {
        const open = openIds.has(log.id);
        const editing = editingId === log.id;
        const on = pinned.has(log.id);
        return (
          <View key={log.id} style={[s.card, on && s.cardOn]}>
            <View style={s.head}>
              <Text style={s.when}>
                {daySubLabel(log.createdAt)} {formatTime(log.createdAt)}
              </Text>
              <Text style={s.scope}>{scopeLabel(log.scope)}</Text>
              {log.web.length ? (
                <View style={s.webTag}>
                  <Ionicons name="globe-outline" size={10} color={C.accentText} />
                  <Text style={s.webTagText}>联网</Text>
                </View>
              ) : null}
              <View style={s.grow} />
              {on ? (
                <View style={s.pinTag}>
                  <Text style={s.pinTagText}>已带入</Text>
                </View>
              ) : null}
            </View>

            {editing ? (
              <>
                <TextInput
                  value={editText}
                  onChangeText={setEditText}
                  style={s.editInput}
                  multiline
                  autoFocus
                  maxLength={500}
                />
                <View style={s.editActions}>
                  <Pressable onPress={() => setEditingId(null)} hitSlop={8}>
                    <Text style={s.muted}>取消</Text>
                  </Pressable>
                  <Pressable onPress={saveEdit} hitSlop={8}>
                    <Text style={s.primary}>保存</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <Pressable onPress={() => toggleOpen(log.id)}>
                <Text style={s.question} numberOfLines={open ? undefined : 2}>
                  {log.question}
                </Text>
                <Text style={s.answer} numberOfLines={open ? undefined : 2}>
                  {open ? log.answer : preview(log.answer)}
                </Text>
                <Text style={s.toggle}>{open ? '收起' : '展开全文'}</Text>
              </Pressable>
            )}

            {!editing ? (
              <View style={s.actions}>
                <Pressable onPress={() => onTogglePin(log)} hitSlop={6}>
                  <Text style={[s.link, on && s.linkOn]}>{on ? '取消带入' : '带入本轮'}</Text>
                </Pressable>
                <Pressable onPress={() => startEdit(log)} hitSlop={6}>
                  <Text style={s.link}>改问题</Text>
                </Pressable>
                <View style={s.grow} />
                <Pressable onPress={() => remove(log.id)} hitSlop={6}>
                  <Text style={s.danger}>
                    {armed === log.id ? '再点一次确认删除' : '删除'}
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  loading: { paddingTop: 40, alignItems: 'center' },
  empty: { alignItems: 'center', paddingTop: 50, paddingHorizontal: 24 },
  emptyIcon: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: C.hairSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  emptyTitle: { fontSize: 14, color: C.text2, fontWeight: '500' },
  emptyBody: { fontSize: 12, lineHeight: 19, color: C.text3, textAlign: 'center', marginTop: 8 },

  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 10,
  },
  barText: { fontSize: 11.5, color: C.text3 },
  barBtn: { fontSize: 12, color: C.accent },

  card: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 9,
  },
  cardOn: { borderColor: C.accent, backgroundColor: C.accentBg },

  head: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 6 },
  when: { fontSize: 10.5, color: C.text3, fontVariant: ['tabular-nums'] },
  scope: { fontSize: 10.5, color: C.accentText },
  grow: { flex: 1 },
  webTag: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  webTagText: { fontSize: 9.5, color: C.accentText },
  pinTag: {
    backgroundColor: C.accent,
    borderRadius: R.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  pinTagText: { fontSize: 9.5, color: '#FFFFFF' },

  question: { fontSize: 13.5, lineHeight: 20, color: C.text, fontWeight: '500' },
  answer: { fontSize: 12.5, lineHeight: 19, color: C.text2, marginTop: 4 },
  toggle: { fontSize: 11.5, color: C.accent, marginTop: 6 },

  editInput: {
    fontSize: 13.5,
    lineHeight: 20,
    color: C.text,
    minHeight: 56,
    borderWidth: 0.5,
    borderColor: C.hair,
    borderRadius: R.btn,
    padding: 10,
    textAlignVertical: 'top',
  },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 18, marginTop: 10 },

  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginTop: 10,
    paddingTop: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
  },
  link: { fontSize: 12, color: C.text2 },
  linkOn: { color: C.accentText, fontWeight: '600' },
  danger: { fontSize: 12, color: C.danger },
  muted: { fontSize: 13, color: C.text2 },
  primary: { fontSize: 13, color: C.accent, fontWeight: '500' },
});
