/**
 * 整理草稿卡：模型提炼出的文档与待办，落在对话流里，可以直接改。
 *
 * 为什么不做成整页覆盖层：用户改稿时最常做的是「说一句让它改」——
 * 「第二段并进第一段」「标题太长了」。盖住输入框就等于把这个动作拿掉了。
 * 所以它是对话流里的一张卡，随时能上半句说、下半句改。
 *
 * 三个不能省的约束：
 * 1. **写入前必须有权限位**。这张卡会往文档区和待办里写东西，
 *    而它对用户来说只是"整理一下"。所以写入按钮旁边两行开关，
 *    默认开着也要看得见、关得掉。
 * 2. **预览走真正的渲染器**。表格用 `NoteBody` 渲染，和读文档时是同一套 ——
 *    用等宽文本框预览，表格是看不出对齐问题的，而表格恰恰最容易写坏。
 * 3. **没内容就不让写**。空正文 + 空待办写进去是一篇点开全白的文档，
 *    用户还得自己去删。
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { R, useThemedStyles, type Palette } from '../theme';
import { NoteBody } from './NoteBody';
import { draftProblem, keptTodos, type KnowledgeDraft } from '../util/knowledgeDoc';

interface Props {
  draft: KnowledgeDraft;
  onChange: (next: KnowledgeDraft) => void;
  /** 生成 / 修改中：卡片还在，但不给编辑也不给写 */
  busy: boolean;
  /** 已收到的字数与秒数，只用于让用户知道没卡住 */
  received: number;
  elapsed: number;
  reasoning: string;
  error: string;
  /** 材料被截断的说明（少看了内容就有可能漏了关键结论） */
  note: string;
  allowDoc: boolean;
  allowTodos: boolean;
  onAllowDoc: (v: boolean) => void;
  onAllowTodos: (v: boolean) => void;
  saving: boolean;
  /** 已经写进去的文档 id。非 null 时卡片变成「已写入」状态 */
  writtenId: number | null;
  onOpenDoc: (id: number) => void;
  onApprove: () => void;
  onDiscard: () => void;
  onRetry: () => void;
}

export function KnowledgeDraftCard({
  draft,
  onChange,
  busy,
  received,
  elapsed,
  reasoning,
  error,
  note,
  allowDoc,
  allowTodos,
  onAllowDoc,
  onAllowTodos,
  saving,
  writtenId,
  onOpenDoc,
  onApprove,
  onDiscard,
  onRetry,
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [preview, setPreview] = useState(false);

  const todos = keptTodos(draft);
  const problem = draftProblem(draft);
  const isTodosOnly = draft.mode === 'todos';

  const setTodo = (idx: number, patch: Partial<{ text: string; due: string | null; keep: boolean }>) => {
    const next = draft.todos.map((t, i) => (i === idx ? { ...t, ...patch } : t));
    onChange({ ...draft, todos: next });
  };

  if (writtenId !== null) {
    return (
      <View style={styles.card}>
        <View style={styles.headRow}>
          <Ionicons name="checkmark-circle" size={16} color={c.tealText} />
          <Text style={styles.headTitle}>已写入文档区</Text>
        </View>
        <Text style={styles.writtenName} numberOfLines={2}>
          {draft.title || '未命名文档'}
        </Text>
        <View style={styles.actions}>
          <Pressable style={styles.ghost} onPress={() => onOpenDoc(writtenId)}>
            <Text style={styles.ghostText}>打开这篇文档</Text>
          </Pressable>
          <Pressable style={styles.ghost} onPress={onDiscard}>
            <Text style={styles.ghostText}>知道了</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <Ionicons
          name={isTodosOnly ? 'checkbox-outline' : 'sparkles-outline'}
          size={15}
          color={c.accentText}
        />
        <Text style={styles.headTitle}>{isTodosOnly ? '待办草稿' : '整理草稿'}</Text>
        <View style={{ flex: 1 }} />
        {draft.todos.length ? (
          <Text style={styles.count}>{todos.length} 条待办</Text>
        ) : null}
      </View>

      {busy ? (
        <View style={styles.busyBox}>
          <ActivityIndicator size="small" color={c.text3} />
          <Text style={styles.busyText}>
            {received > 0 ? `正在写…（已收到 ${received} 字）` : '正在读这些碎片…'}
          </Text>
          <Text style={styles.elapsed}>{elapsed}s</Text>
        </View>
      ) : null}

      {busy && reasoning ? (
        <Text style={styles.reasoning} numberOfLines={4}>
          {reasoning}
        </Text>
      ) : null}

      {!!note ? <Text style={styles.note}>{note}</Text> : null}

      {!!error ? (
        <View style={styles.errBox}>
          <Text style={styles.errText}>{error}</Text>
          <Pressable style={styles.retry} onPress={onRetry}>
            <Ionicons name="refresh" size={13} color={c.text} />
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        </View>
      ) : null}

      {!isTodosOnly ? (
        <>
          <Text style={styles.label}>标题</Text>
          <TextInput
            value={draft.title}
            onChangeText={(title) => onChange({ ...draft, title })}
            placeholder="这篇文档叫什么"
            placeholderTextColor={c.text3}
            style={styles.titleInput}
            maxLength={40}
            editable={!busy && !saving}
          />

          <View style={styles.modeRow}>
            <Text style={styles.label}>正文</Text>
            <View style={{ flex: 1 }} />
            <Pressable
              style={[styles.tab, !preview && styles.tabOn]}
              onPress={() => setPreview(false)}
            >
              <Text style={[styles.tabText, !preview && styles.tabTextOn]}>编辑</Text>
            </Pressable>
            <Pressable
              style={[styles.tab, preview && styles.tabOn]}
              onPress={() => setPreview(true)}
            >
              <Text style={[styles.tabText, preview && styles.tabTextOn]}>预览</Text>
            </Pressable>
          </View>

          {preview ? (
            <View style={styles.previewBox}>
              {draft.bodyMd.trim() ? (
                <NoteBody text={draft.bodyMd} variant="reading" />
              ) : (
                <Text style={styles.emptyBody}>还没有正文</Text>
              )}
            </View>
          ) : (
            <TextInput
              value={draft.bodyMd}
              onChangeText={(bodyMd) => onChange({ ...draft, bodyMd })}
              placeholder="Markdown 正文，表格用 | 列 | 列 |"
              placeholderTextColor={c.text3}
              style={styles.bodyInput}
              multiline
              textAlignVertical="top"
              editable={!busy && !saving}
            />
          )}
        </>
      ) : null}

      {draft.todos.length ? (
        <>
          <Text style={styles.label}>待办</Text>
          {draft.todos.map((t, i) => (
            <View key={`${i}-${t.text.slice(0, 6)}`} style={styles.todoRow}>
              <Pressable
                onPress={() => setTodo(i, { keep: !t.keep })}
                hitSlop={8}
                accessibilityLabel={t.keep ? '不写入这条' : '写入这条'}
              >
                <View style={[styles.check, t.keep && styles.checkOn]}>
                  {t.keep ? <Ionicons name="checkmark" size={11} color={c.onAccent} /> : null}
                </View>
              </Pressable>
              <TextInput
                value={t.text}
                onChangeText={(text) => setTodo(i, { text })}
                style={[styles.todoInput, !t.keep && styles.todoOff]}
                multiline
                editable={!busy && !saving}
              />
              {t.due ? <Text style={styles.due}>{t.due.slice(5)}</Text> : null}
            </View>
          ))}
        </>
      ) : null}

      {/* 权限位：写入是这张卡唯一会改数据的地方，必须点得到、看得见 */}
      <View style={styles.permBox}>
        <Pressable style={styles.permRow} onPress={() => onAllowDoc(!allowDoc)} hitSlop={4}>
          <Ionicons
            name={allowDoc ? 'checkbox' : 'square-outline'}
            size={16}
            color={allowDoc ? c.accentText : c.text3}
          />
          <Text style={styles.permText}>允许写入文档区{isTodosOnly ? '（不写）' : ''}</Text>
        </Pressable>
        {draft.todos.length ? (
          <Pressable style={styles.permRow} onPress={() => onAllowTodos(!allowTodos)} hitSlop={4}>
            <Ionicons
              name={allowTodos ? 'checkbox' : 'square-outline'}
              size={16}
              color={allowTodos ? c.accentText : c.text3}
            />
            <Text style={styles.permText}>允许新增 {todos.length} 条待办</Text>
          </Pressable>
        ) : null}
        <Text style={styles.permHint}>不改动任何原有碎片；写入后可以在文档区继续改或删。</Text>
      </View>

      {problem && !busy && !error ? <Text style={styles.problem}>{problem}</Text> : null}

      <View style={styles.actions}>
        <Pressable style={styles.ghost} onPress={onDiscard} disabled={saving}>
          <Text style={styles.ghostText}>{draft.bodyMd.trim() ? '放弃' : '关闭'}</Text>
        </Pressable>
        <Pressable
          style={[styles.solid, (busy || saving || !!problem || !!error) && styles.solidOff]}
          onPress={onApprove}
          disabled={busy || saving || !!problem || !!error}
        >
          <Text style={styles.solidText}>
            {saving ? '写入中…' : draft.todos.length && !isTodosOnly ? '通过并写入' : '通过并写入'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.card,
      borderRadius: R.card,
      borderWidth: 0.5,
      borderColor: c.accentHair,
      padding: 14,
      marginTop: 14,
      gap: 8,
    },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    headTitle: { fontSize: 13.5, color: c.text, fontWeight: '600' },
    count: { fontSize: 11, color: c.text3 },
    writtenName: { fontSize: 14, color: c.text, fontWeight: '500' },

    busyBox: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
    busyText: { fontSize: 12, color: c.text2, flexShrink: 1 },
    elapsed: { fontSize: 11, color: c.text3, fontVariant: ['tabular-nums'] },
    reasoning: { fontSize: 11, lineHeight: 17, color: c.text3 },
    note: { fontSize: 11.5, lineHeight: 18, color: c.text3 },

    errBox: { gap: 6 },
    errText: { fontSize: 12.5, lineHeight: 19, color: c.danger },
    retry: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
    retryText: { fontSize: 12, color: c.text },

    label: { fontSize: 11, color: c.text3, marginTop: 2 },
    titleInput: {
      fontSize: 15,
      color: c.text,
      fontWeight: '600',
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: R.btn,
      backgroundColor: c.hairSoft,
    },
    modeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
    tab: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: R.pill,
    },
    tabOn: { backgroundColor: c.accentBg },
    tabText: { fontSize: 11.5, color: c.text3 },
    tabTextOn: { color: c.accentText, fontWeight: '600' },

    bodyInput: {
      minHeight: 150,
      maxHeight: 320,
      fontSize: 13,
      lineHeight: 21,
      color: c.text,
      padding: 10,
      borderRadius: R.btn,
      backgroundColor: c.hairSoft,
      fontFamily: Platform.OS === 'android' ? 'monospace' : undefined,
    },
    previewBox: {
      padding: 10,
      borderRadius: R.btn,
      backgroundColor: c.hairSoft,
    },
    emptyBody: { fontSize: 12.5, color: c.text3 },

    todoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 2 },
    check: {
      width: 17,
      height: 17,
      borderRadius: 5,
      borderWidth: 1,
      borderColor: c.hair,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 8,
    },
    checkOn: { backgroundColor: c.accent, borderColor: c.accent },
    todoInput: { flex: 1, fontSize: 13, lineHeight: 19, color: c.text, paddingVertical: 6 },
    todoOff: { color: c.text3, textDecorationLine: 'line-through' },
    due: { fontSize: 11, color: c.text3, marginTop: 9, fontVariant: ['tabular-nums'] },

    permBox: {
      gap: 6,
      padding: 10,
      borderRadius: R.btn,
      backgroundColor: c.hairSoft,
      marginTop: 4,
    },
    permRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    permText: { fontSize: 12.5, color: c.text },
    permHint: { fontSize: 11, lineHeight: 16, color: c.text3 },

    problem: { fontSize: 12, color: c.accentText },
    actions: { flexDirection: 'row', gap: 10, marginTop: 6 },
    ghost: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 10,
      borderRadius: R.btn,
      borderWidth: 0.5,
      borderColor: c.hair,
    },
    ghostText: { fontSize: 13, color: c.text },
    solid: {
      flex: 1.4,
      alignItems: 'center',
      paddingVertical: 10,
      borderRadius: R.btn,
      backgroundColor: c.accent,
    },
    solidOff: { opacity: 0.4 },
    solidText: { fontSize: 13, color: c.onAccent, fontWeight: '600' },
  });
