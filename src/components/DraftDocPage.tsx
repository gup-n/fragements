/**
 * 草稿里某一篇的整页查看 / 编辑。
 *
 * 为什么从卡片里搬出来（v0.18）：卡片长在聊天流里，展开正文会把下面的内容
 * 全部往下推，`onContentSizeChange` 跟着把 ScrollView 滚到底 —— 用户点「查看」，
 * 视线却被甩到了页面底部，还得自己往回找。编辑更糟：小输入框、软键盘一弹，
 * 被编辑的那一段正好在键盘下面。
 *
 * 所以产出不再在对话里展开，而是「打开一篇」：
 * - 整页只有一个主题，标题、字数、正文各就各位；
 * - 阅读态用 `NoteBody` 真渲染（表格是对齐的），编辑态才是等宽文本框；
 * - 底部常驻「加入文档库」，看完就能收，不用退回对话再找那张卡。
 *
 * 仍然不弹 `Modal`（Android 红线）：这一页由 AskScreen 以绝对定位覆盖层渲染，
 * 返回键走 `attemptClose` 的层级判断。
 */
import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { NoteBody } from './NoteBody';
import { ScreenHeader } from './ScreenHeader';
import { useKeyboardHeight } from '../util/keyboard';
import type { DraftDoc } from '../util/knowledgeDoc';

interface Props {
  doc: DraftDoc;
  /** 第几篇（从 0 起），只用于「2 / 3」这种位置提示 */
  index: number;
  total: number;
  /** 从卡片的「查看」进来是 read，从「编辑」进来是 edit */
  initialMode: 'read' | 'edit';
  saved: boolean;
  canWrite: boolean;
  problem: string | null;
  saving: boolean;
  onChange: (patch: Partial<DraftDoc>) => void;
  onApprove: () => void;
  onClose: () => void;
}

/** 空格和换行不算字数，和文档页「N 字」的口径一致 */
function charsOf(text: string): number {
  return text.replace(/\s/g, '').length;
}

export function DraftDocPage({
  doc,
  index,
  total,
  initialMode,
  saved,
  canWrite,
  problem,
  saving,
  onChange,
  onApprove,
  onClose,
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [mode, setMode] = useState<'read' | 'edit'>(initialMode);
  const keyboardHeight = useKeyboardHeight();

  return (
    <View style={styles.page}>
      <ScreenHeader
        title={doc.title.trim() || '未命名文档'}
        subtitle={`${charsOf(doc.bodyMd)} 字${total > 1 ? ` · ${index + 1} / ${total}` : ''}`}
        onBack={onClose}
        right={
          <Pressable
            onPress={() => setMode(mode === 'read' ? 'edit' : 'read')}
            disabled={saving || saved}
            hitSlop={8}
            style={styles.modeBtn}
            accessibilityRole="button"
            accessibilityLabel={mode === 'read' ? '编辑这篇' : '预览这篇'}
          >
            <Ionicons
              name={mode === 'read' ? 'create-outline' : 'eye-outline'}
              size={15}
              color={c.accentText}
            />
            <Text style={styles.modeText}>{mode === 'read' ? '编辑' : '预览'}</Text>
          </Pressable>
        }
      />

      {mode === 'read' ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.readBody}
          keyboardShouldPersistTaps="handled"
        >
          {doc.summary.trim() ? <Text style={styles.summary}>{doc.summary}</Text> : null}
          <NoteBody text={doc.bodyMd} variant="reading" selectable literalCitations />
        </ScrollView>
      ) : (
        <View style={[styles.editWrap, { paddingBottom: keyboardHeight }]}>
          <Text style={styles.fieldLabel}>标题</Text>
          <TextInput
            value={doc.title}
            onChangeText={(title) => onChange({ title })}
            placeholder="这篇文档叫什么"
            placeholderTextColor={c.text3}
            selectionColor={c.selection}
            style={styles.titleInput}
            maxLength={40}
            editable={!saving && !saved}
          />
          <Text style={styles.fieldLabel}>正文（Markdown）</Text>
          <TextInput
            value={doc.bodyMd}
            onChangeText={(bodyMd) => onChange({ bodyMd })}
            placeholder="Markdown 正文；表格用 | 列 | 列 |"
            placeholderTextColor={c.text3}
            selectionColor={c.selection}
            style={styles.bodyInput}
            multiline
            textAlignVertical="top"
            editable={!saving && !saved}
          />
          <Text style={styles.editHint}>
            表格要写成 Markdown：第一行是表头，第二行是 |---|---|，之后每行一条。
          </Text>
        </View>
      )}

      <View style={styles.footer}>
        {!saved ? (
          <Pressable style={styles.choice} onPress={() => onChange({ keep: !doc.keep })} disabled={saving} accessibilityRole="checkbox" accessibilityState={{ checked: doc.keep, disabled: saving }} accessibilityLabel="将这篇列入待写入内容">
            <Ionicons name={doc.keep ? 'checkbox-outline' : 'square-outline'} size={23} color={c.text} />
            <Text style={styles.ghostText}>{doc.keep ? '已选择这篇' : '未选择这篇 · 点此确认'}</Text>
          </Pressable>
        ) : <Text style={styles.editHint}>此处显示已写入的草稿快照，不会通过改稿覆盖已保存文档。</Text>}
        {problem && !saved ? <Text style={styles.problem}>{problem}</Text> : null}
        <View style={styles.footerRow}>
          <Pressable style={styles.ghost} onPress={onClose} disabled={saving}>
            <Text style={styles.ghostText}>返回对话</Text>
          </Pressable>
          {saved ? (
            <View style={styles.doneBox}>
              <Ionicons name="checkmark-circle" size={15} color={c.tealText} />
              <Text style={styles.doneText}>已加入文档库</Text>
            </View>
          ) : (
            <Pressable
              style={[styles.solid, (!canWrite || !!problem || saving) && styles.off]}
              onPress={onApprove}
              disabled={!canWrite || !!problem || saving}
            >
              <Text style={styles.solidText}>{saving ? '写入中…' : '加入文档库'}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) =>
  StyleSheet.create({
    page: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.page },
    flex: { flex: 1 },
    modeBtn: {
      minHeight: metrics.controlHeight,
      justifyContent: 'center',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: metrics.buttonRadius,
      backgroundColor: c.accentBg,
    },
    modeText: { fontSize: 12, color: c.accentText, fontWeight: '500' },
    readBody: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 40 },
    summary: {
      fontSize: 12.5,
      lineHeight: 19,
      color: c.text3,
      marginBottom: 14,
      paddingLeft: 10,
      borderLeftWidth: 2,
      borderLeftColor: c.accentHair,
    },
    editWrap: { flex: 1, paddingHorizontal: 16, paddingTop: 14, gap: 6 },
    fieldLabel: { fontSize: 11, color: c.text3, marginTop: 4 },
    titleInput: {
      fontSize: 15,
      color: c.text,
      fontWeight: '600',
      paddingVertical: 9,
      paddingHorizontal: 11,
      borderRadius: metrics.buttonRadius,
      backgroundColor: c.card,
      borderWidth: metrics.strokeWidth,
      borderColor: c.hair,
    },
    bodyInput: {
      flex: 1,
      fontSize: 12.5,
      lineHeight: 20,
      color: c.text,
      padding: 11,
      borderRadius: metrics.buttonRadius,
      backgroundColor: c.card,
      borderWidth: metrics.strokeWidth,
      borderColor: c.hair,
      fontFamily: Platform.OS === 'android' ? 'monospace' : undefined,
    },
    editHint: { fontSize: 10.5, lineHeight: 16, color: c.text3, marginTop: 4 },
    footer: {
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 12,
      gap: 8,
      borderTopWidth: metrics.strokeWidth,
      borderTopColor: c.hair,
      backgroundColor: c.page,
    },
    problem: { fontSize: 11, color: c.danger },
    footerRow: { flexDirection: 'row', gap: 10 },
    ghost: {
      minHeight: metrics.controlHeight,
      justifyContent: 'center',
      flex: 1,
      alignItems: 'center',
      paddingVertical: 11,
      borderRadius: metrics.buttonRadius,
      borderWidth: metrics.strokeWidth,
      borderColor: c.hair,
    },
    ghostText: { fontSize: 13, color: c.text },
    solid: {
      minHeight: metrics.controlHeight,
      justifyContent: 'center',
      flex: 1.6,
      alignItems: 'center',
      paddingVertical: 11,
      borderRadius: metrics.buttonRadius,
      backgroundColor: c.accent,
    },
    solidText: { fontSize: 13, color: c.onAccent, fontWeight: '600' },
    doneBox: {
      minHeight: metrics.controlHeight,
      flex: 1.6,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 11,
      borderRadius: metrics.buttonRadius,
      backgroundColor: c.hairSoft,
    },
    doneText: { fontSize: 13, color: c.text2, fontWeight: '600' },
    choice: { minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: 10 },
    off: { opacity: 0.4 },
  });
