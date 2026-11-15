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
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
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
    <View style={styles.page} accessibilityViewIsModal>
      <ScreenHeader
        title="文档草稿"
        subtitle={`${charsOf(doc.bodyMd)} 字${total > 1 ? ` · 第 ${index + 1} / ${total} 篇` : ''}${saved ? ' · 已写入快照' : ' · 待审阅'}`}
        onBack={onClose}
        right={
          <Pressable
            onPress={() => setMode(mode === 'read' ? 'edit' : 'read')}
            disabled={saving || saved}
            style={[styles.modeBtn, (saving || saved) && styles.off]}
            accessibilityRole="button"
            accessibilityState={{ disabled: saving || saved }}
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
          <Text style={styles.documentTitle} accessibilityRole="header">{doc.title.trim() || '未命名文档'}</Text>
          {doc.summary.trim() ? (
            <View style={styles.summaryWrap}>
              <Text style={styles.summaryLabel}>摘要</Text>
              <Text style={styles.summary}>{doc.summary}</Text>
            </View>
          ) : null}
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
            accessibilityLabel="文档草稿正文（Markdown）"
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
          <Pressable style={[styles.choice, doc.keep && styles.choiceOn]} onPress={() => onChange({ keep: !doc.keep })} disabled={saving} accessibilityRole="checkbox" accessibilityState={{ checked: doc.keep, disabled: saving }} accessibilityLabel="将这篇列入待写入内容">
            <Ionicons name={doc.keep ? 'checkbox-outline' : 'square-outline'} size={23} color={doc.keep ? c.accent : c.text2} accessible={false} />
            <Text style={styles.ghostText}>{doc.keep ? '已选择这篇' : '未选择这篇 · 点此确认'}</Text>
          </Pressable>
        ) : <Text style={styles.editHint}>此处显示已写入的草稿快照，不会通过改稿覆盖已保存文档。</Text>}
        {problem && !saved ? <Text style={styles.problem}>{problem}</Text> : null}
        <View style={styles.footerRow}>
          <Pressable style={[styles.ghost, saving && styles.off]} onPress={onClose} disabled={saving} accessibilityRole="button" accessibilityState={{ disabled: saving }}>
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
              accessibilityRole="button"
              accessibilityState={{ disabled: !canWrite || !!problem || saving, busy: saving }}
              accessibilityLabel="加入文档库"
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
      minHeight: metrics.controlHeight, minWidth: metrics.controlHeight,
      justifyContent: 'center', flexDirection: 'row', alignItems: 'center', gap: SPACE.xs,
      paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs,
      borderRadius: metrics.buttonRadius, backgroundColor: c.accentBg,
      borderWidth: surfaceStroke(metrics), borderColor: c.accentHair,
    },
    modeText: { ...TYPE.label, color: c.accentText },
    readBody: { paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.xl, paddingBottom: SPACE.xxl },
    documentTitle: { ...TYPE.heading, color: c.text, marginBottom: SPACE.md },
    summaryWrap: { paddingBottom: SPACE.lg, marginBottom: SPACE.lg, gap: SPACE.xs, borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair },
    summaryLabel: { ...TYPE.label, color: c.text2 },
    summary: { ...TYPE.body, color: c.text2 },
    editWrap: { flex: 1, paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.md, gap: SPACE.xs },
    fieldLabel: { ...TYPE.label, color: c.text2, marginTop: SPACE.xxs },
    titleInput: {
      ...TYPE.title, minHeight: metrics.controlHeight, color: c.text,
      paddingVertical: SPACE.sm, paddingHorizontal: SPACE.sm,
      borderRadius: metrics.buttonRadius, backgroundColor: c.card,
      borderWidth: metrics.strokeWidth, borderColor: c.hair,
    },
    bodyInput: {
      ...TYPE.body, flex: 1, minHeight: metrics.controlHeight, color: c.text,
      padding: SPACE.sm, borderRadius: metrics.buttonRadius, backgroundColor: c.card,
      borderWidth: metrics.strokeWidth, borderColor: c.hair,
      fontFamily: Platform.OS === 'android' ? 'monospace' : undefined,
    },
    editHint: { ...TYPE.meta, color: c.text2, marginTop: SPACE.xxs },
    footer: {
      paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.sm, paddingBottom: SPACE.md,
      gap: SPACE.xs, borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair, backgroundColor: c.page,
    },
    problem: { ...TYPE.label, fontWeight: '400', color: c.danger },
    footerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
    ghost: {
      minHeight: metrics.controlHeight, minWidth: 96, justifyContent: 'center', flex: 1, alignItems: 'center',
      paddingVertical: SPACE.sm, paddingHorizontal: SPACE.sm,
      borderRadius: metrics.buttonRadius, borderWidth: surfaceStroke(metrics), borderColor: c.hair,
    },
    ghostText: { ...TYPE.label, color: c.text, flexShrink: 1, textAlign: 'center' },
    solid: {
      minHeight: metrics.controlHeight, minWidth: 144, justifyContent: 'center', flex: 1.6, alignItems: 'center',
      paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md,
      borderRadius: metrics.buttonRadius, backgroundColor: c.accent,
    },
    solidText: { ...TYPE.label, color: c.onAccent, textAlign: 'center' },
    doneBox: {
      minHeight: metrics.controlHeight, minWidth: 144, flex: 1.6,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs,
      paddingVertical: SPACE.sm, paddingHorizontal: SPACE.sm,
      borderRadius: metrics.buttonRadius, backgroundColor: c.hairSoft,
      borderWidth: surfaceStroke(metrics), borderColor: c.hair,
    },
    doneText: { ...TYPE.label, color: c.text2, flexShrink: 1 },
    choice: {
      minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
      padding: SPACE.sm, borderRadius: metrics.buttonRadius,
      borderWidth: surfaceStroke(metrics), borderColor: c.hair,
    },
    choiceOn: { backgroundColor: c.accentBg, borderColor: c.accentHair },
    off: { opacity: 0.55 },
  });
