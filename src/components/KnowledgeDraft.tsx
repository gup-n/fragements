/** 聊天中的整理产出：所有篇可审阅，权限/数量/写入共用一个稳定 key 计划。 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { BusyIndicator } from './BusyIndicator';
import { AgentError } from './AgentError';
import { ReasoningFold } from './ReasoningFold';
import type { AiErrorDetail } from '../ai/chat';
import type { DraftCommitReceipt } from '../db/types';
import { docProblem, type KnowledgeDraft } from '../util/knowledgeDoc';
import { selectDraftTargets, type KeyedDraft, type WorkStep } from '../organize/workspace';

export type AgentStep = WorkStep;
interface Props {
  draft: KeyedDraft;
  onChange: (next: KnowledgeDraft) => void;
  busy: boolean;
  received: number;
  elapsed: number;
  reasoning: string;
  error: { message: string; code?: string; detail?: AiErrorDetail } | null;
  onRetry: () => void;
  note: string;
  steps: AgentStep[];
  allowDoc: boolean;
  allowTodos: boolean;
  onAllowDoc: (v: boolean) => void;
  onAllowTodos: (v: boolean) => void;
  saving: boolean;
  receipt: DraftCommitReceipt;
  onOpenDoc: (id: number) => void;
  onOpenDraft: (key: string, mode: 'read' | 'edit') => void;
  leftover: number;
  onContinueAll: () => void;
  onApprove: (key: string | null) => void;
  onDiscard: () => void;
}

export function KnowledgeDraftCard({
  draft, onChange, busy, received, elapsed, reasoning, error, onRetry, note, steps,
  allowDoc, allowTodos, onAllowDoc, onAllowTodos, saving, receipt, onOpenDoc,
  onOpenDraft, leftover, onContinueAll, onApprove, onDiscard,
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [showSteps, setShowSteps] = useState(false);
  const locked = busy || saving;
  const plan = selectDraftTargets(draft, receipt, allowDoc, allowTodos);
  const savedDocs = new Map(receipt.documents.map((d) => [d.key, d]));
  const savedTodos = new Set(receipt.todos.map((t) => t.key));
  const todoTotal = draft.todos.reduce((n, t) => n + 1 + t.children.length, 0);
  const hasTargets = plan.documentCount + plan.todoCount > 0;
  const writeLabel = saving ? '写入中…' : hasTargets
    ? [plan.documentCount ? `${plan.documentCount} 篇文档` : '', plan.todoCount ? `${plan.todoCount} 条待办` : ''].filter(Boolean).join(' + ')
    : receipt.documents.length + receipt.todos.length ? '当前选择已写入' : '没有已批准的内容';
  const patchDoc = (key: string, keep: boolean) => onChange({ ...draft, docs: draft.docs.map((d) => d.key === key ? { ...d, keep } : d) });
  const patchTodo = (key: string, patch: Partial<KeyedDraft['todos'][number]>) => onChange({
    ...draft, todos: draft.todos.map((t) => t.key === key ? { ...t, ...patch } : t),
  });
  const patchChild = (parentKey: string, key: string, keep: boolean) => onChange({
    ...draft, todos: draft.todos.map((t) => t.key === parentKey ? { ...t, children: t.children.map((ch) => ch.key === key ? { ...ch, keep } : ch) } : t),
  });
  const visibleSteps = showSteps ? steps : steps.slice(-3);

  return (
    <View style={styles.card}>
      <View style={styles.heading}>
        {busy ? <BusyIndicator color={c.text2} size="small" /> : null}
        <Text style={styles.title} accessibilityRole="header">{busy ? '正在整理' : draft.mode === 'todos' ? `提炼出 ${todoTotal} 条待办` : `产出 ${draft.docs.length} 篇文档${todoTotal ? ` · ${todoTotal} 条待办` : ''}`}</Text>
        {busy ? <Text style={styles.meta}>{elapsed}s</Text> : null}
      </View>
      {steps.length ? (
        <View style={styles.steps}>
          <Text style={styles.label}>处理过程</Text>
          {visibleSteps.map((step, i) => (
            <View key={`${i}-${step.text}`} style={styles.step}>
              {step.state === 'running'
                ? <BusyIndicator size={16} color={c.text2} />
                : <Ionicons name={step.state === 'fail' ? 'alert-circle-outline' : 'checkmark-circle-outline'} size={16} color={step.state === 'fail' ? c.danger : c.text2} accessible={false} />}
              <Text style={styles.stepText}>{step.text}</Text>
            </View>
          ))}
          {steps.length > 3 ? <Pressable style={styles.textButton} onPress={() => setShowSteps(!showSteps)} accessibilityRole="button" accessibilityState={{ expanded: showSteps }}><Text style={styles.secondary}>{showSteps ? '收起过程' : `展开全部 ${steps.length} 步`}</Text></Pressable> : null}
        </View>
      ) : null}
      {busy ? <Text style={styles.secondary}>{received ? `已收到 ${received} 字；当前材料与进度已在本机保留` : '正在读取这次选定的材料…'}</Text> : null}
      {reasoning.trim() ? <ReasoningFold text={reasoning} defaultOpen={busy} /> : null}
      {!!note ? <Text style={styles.note}>{note}</Text> : null}
      {error ? <AgentError title="整理暂停" message={error.message} code={error.code} detail={error.detail} onRetry={locked ? undefined : onRetry} /> : null}
      {leftover > 0 && !busy ? (
        <Pressable style={styles.outline} onPress={onContinueAll} disabled={saving} accessibilityRole="button" accessibilityLabel={`继续处理快照中剩下的 ${leftover} 条材料`}>
          <Text style={styles.secondary}>还有 {leftover} 条材料未处理 · 继续</Text>
        </Pressable>
      ) : null}

      {draft.mode === 'knowledge' ? draft.docs.map((doc) => {
        const saved = savedDocs.get(doc.key);
        const problem = docProblem(doc);
        return (
          <View key={doc.key} style={[styles.document, (saved || doc.keep) && styles.documentSelected]}>
            <View style={styles.docHeading}>
              <Pressable
                style={[styles.checkHit, (saved || doc.keep) && styles.checkSelected]} disabled={locked || !!saved} onPress={() => patchDoc(doc.key, !doc.keep)}
                accessibilityRole="checkbox" accessibilityState={{ checked: !!saved || doc.keep, disabled: locked || !!saved }}
                accessibilityLabel={`${saved ? '已写入' : doc.keep ? '取消写入' : '选择写入'}文档 ${doc.title || '未命名文档'}`}
              >
                <Ionicons name={saved ? 'checkmark-circle' : doc.keep ? 'checkbox-outline' : 'square-outline'} size={23} color={saved || doc.keep ? c.accent : c.text2} accessible={false} />
              </Pressable>
              <Pressable style={styles.docTitleHit} onPress={() => onOpenDraft(doc.key, 'read')} accessibilityRole="button" accessibilityLabel={`查看 ${doc.title || '未命名文档'}`}>
                <Text style={styles.docTitle}>{doc.title || '未命名文档'}</Text>
                <Text style={styles.meta}>{doc.bodyMd.replace(/\s/g, '').length} 字 · {saved ? '已写入' : doc.keep ? '待确认写入' : '未选择'}</Text>
              </Pressable>
            </View>
            <Text style={styles.secondary}>{doc.summary || '没有摘要，点查看阅读全文'}</Text>
            <View style={styles.row}>
              <Pressable style={styles.smallButton} onPress={() => onOpenDraft(doc.key, 'read')} accessibilityRole="button"><Text style={styles.buttonText}>查看全文</Text></Pressable>
              {saved ? (
                <Pressable style={[styles.smallButton, styles.writeButton]} onPress={() => onOpenDoc(saved.id)} accessibilityRole="button"><Text style={styles.writeButtonText}>打开已存文档</Text></Pressable>
              ) : (
                <>
                  <Pressable style={[styles.smallButton, locked && styles.off]} disabled={locked} onPress={() => onOpenDraft(doc.key, 'edit')} accessibilityRole="button" accessibilityState={{ disabled: locked }}><Text style={styles.buttonText}>编辑</Text></Pressable>
                  <Pressable style={[styles.smallButton, styles.writeButton, (!allowDoc || !doc.keep || !!problem || locked) && styles.off]} disabled={!allowDoc || !doc.keep || !!problem || locked} onPress={() => onApprove(doc.key)} accessibilityRole="button" accessibilityState={{ disabled: !allowDoc || !doc.keep || !!problem || locked }}><Text style={styles.writeButtonText}>写入这一篇</Text></Pressable>
                </>
              )}
            </View>
            {problem && !saved ? <Text style={styles.problem}>{problem}</Text> : null}
          </View>
        );
      }) : null}

      {draft.todos.length ? <Text style={styles.label}>待办与步骤 · 每条都可以单独取消</Text> : null}
      {draft.todos.map((todo) => {
        const saved = savedTodos.has(todo.key);
        return (
          <View key={todo.key} style={styles.todoGroup}>
            <View style={styles.todoRow}>
              <Pressable style={[styles.checkHit, (saved || todo.keep) && styles.checkSelected]} onPress={() => patchTodo(todo.key, { keep: !todo.keep })} disabled={locked || saved} accessibilityRole="checkbox" accessibilityState={{ checked: saved || todo.keep, disabled: locked || saved }} accessibilityLabel={`${saved ? '已写入' : todo.keep ? '取消写入' : '选择写入'}待办 ${todo.text}`}>
                <Ionicons name={saved ? 'checkmark-circle' : todo.keep ? 'checkbox-outline' : 'square-outline'} size={23} color={saved || todo.keep ? c.accent : c.text2} accessible={false} />
              </Pressable>
              <TextInput value={todo.text} onChangeText={(text) => patchTodo(todo.key, { text })} style={[styles.todoInput, !todo.keep && styles.unselected]} multiline editable={!locked && !saved} accessibilityLabel="待办内容" selectionColor={c.selection} />
            </View>
            <Text style={styles.todoState}>{saved ? '已写入' : todo.keep ? '已选择' : '未选择'}{todo.due ? ` · 截止 ${todo.due}` : ''}</Text>
            {todo.children.map((child) => {
              const childSaved = savedTodos.has(child.key);
              return (
                <View key={child.key} style={styles.childRow}>
                  <Pressable style={styles.checkHit} onPress={() => patchChild(todo.key, child.key, !child.keep)} disabled={locked || childSaved || !todo.keep} accessibilityRole="checkbox" accessibilityState={{ checked: childSaved || child.keep, disabled: locked || childSaved || !todo.keep }} accessibilityLabel={`${childSaved ? '已写入' : child.keep ? '取消写入' : '选择写入'}步骤 ${child.text}`}>
                    <Ionicons name={childSaved ? 'checkmark-circle' : child.keep ? 'checkbox-outline' : 'square-outline'} size={20} color={childSaved || (child.keep && todo.keep) ? c.accent : c.text2} accessible={false} />
                  </Pressable>
                  <Text style={[styles.childText, (!child.keep || !todo.keep) && styles.unselected]}>{child.text}{childSaved ? ' · 已写入' : !child.keep ? ' · 未选择' : ''}</Text>
                </View>
              );
            })}
          </View>
        );
      })}

      <View style={styles.permissions}>
        <View style={styles.permissionHeading}>
          <Ionicons name="shield-checkmark-outline" size={18} color={c.text2} accessible={false} />
          <Text style={styles.label}>确认写入权限</Text>
        </View>
        <Pressable style={[styles.permission, locked && styles.off]} onPress={() => onAllowDoc(!allowDoc)} disabled={locked} accessibilityRole="switch" accessibilityState={{ checked: allowDoc, disabled: locked }} accessibilityLabel="允许写入文档">
          <Ionicons name={allowDoc ? 'checkbox-outline' : 'square-outline'} size={22} color={allowDoc ? c.accent : c.text2} accessible={false} />
          <Text style={styles.permissionText}>文档写入 · {allowDoc ? '开启' : '关闭'}{draft.mode === 'todos' ? '（本轮不写文档）' : ''}</Text>
        </Pressable>
        <Pressable style={[styles.permission, locked && styles.off]} onPress={() => onAllowTodos(!allowTodos)} disabled={locked} accessibilityRole="switch" accessibilityState={{ checked: allowTodos, disabled: locked }} accessibilityLabel="允许新增待办">
          <Ionicons name={allowTodos ? 'checkbox-outline' : 'square-outline'} size={22} color={allowTodos ? c.accent : c.text2} accessible={false} />
          <Text style={styles.permissionText}>待办写入 · {allowTodos ? '开启' : '关闭'}</Text>
        </Pressable>
        <Text style={styles.note}>只写你选择的条目；原始碎片不删除。离开页面会保留这份草稿，不会自动继续请求。</Text>
      </View>
      <View style={styles.row}>
        <Pressable style={styles.outline} onPress={onDiscard} disabled={locked} accessibilityRole="button"><Text style={styles.buttonText}>放弃草稿</Text></Pressable>
        <Pressable style={[styles.primary, (!hasTargets || locked) && styles.off]} onPress={() => onApprove(null)} disabled={!hasTargets || locked} accessibilityRole="button" accessibilityState={{ disabled: !hasTargets || locked, busy: saving }} accessibilityLabel={hasTargets ? `确认写入 ${writeLabel}` : writeLabel}>
          <Text style={styles.primaryText}>{hasTargets && !saving ? `确认写入 ${writeLabel}` : writeLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  card: { paddingTop: SPACE.xs, paddingBottom: SPACE.md, gap: SPACE.md },
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs },
  title: { ...TYPE.title, flex: 1, minWidth: 140, color: c.text },
  meta: { ...TYPE.meta, color: c.text2 },
  secondary: { ...TYPE.body, color: c.text2 },
  note: { ...TYPE.label, fontWeight: '400', color: c.text2 },
  steps: { gap: SPACE.xs, borderLeftWidth: surfaceStroke(metrics), borderLeftColor: c.hair, paddingLeft: SPACE.sm },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.xs },
  stepText: { ...TYPE.label, fontWeight: '400', flex: 1, color: c.text2 },
  textButton: { minHeight: metrics.controlHeight, justifyContent: 'center', alignSelf: 'flex-start' },
  document: {
    backgroundColor: c.card,
    borderWidth: surfaceStroke(metrics), borderColor: c.hair,
    borderRadius: metrics.cardRadius, padding: SPACE.md, gap: SPACE.sm,
  },
  documentSelected: { borderColor: c.accentHair },
  docHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.xs },
  docTitleHit: { flex: 1, minHeight: metrics.controlHeight, justifyContent: 'center', gap: SPACE.xxs },
  docTitle: { ...TYPE.title, color: c.text },
  checkHit: { width: metrics.controlHeight, minHeight: metrics.controlHeight, alignItems: 'center', justifyContent: 'center', borderRadius: metrics.buttonRadius },
  checkSelected: { backgroundColor: c.accentBg },
  row: { flexDirection: 'row', gap: SPACE.xs, flexWrap: 'wrap' },
  smallButton: {
    minHeight: metrics.controlHeight, minWidth: 72, flexGrow: 1,
    paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs,
    justifyContent: 'center', alignItems: 'center', borderRadius: metrics.buttonRadius,
    borderWidth: surfaceStroke(metrics), borderColor: c.hair, backgroundColor: c.hairSoft,
  },
  writeButton: { backgroundColor: c.accentBg, borderColor: c.accentHair },
  buttonText: { ...TYPE.label, color: c.text, textAlign: 'center' },
  writeButtonText: { ...TYPE.label, color: c.accentText, textAlign: 'center' },
  outline: {
    minHeight: metrics.controlHeight, paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md,
    justifyContent: 'center', alignItems: 'center', borderWidth: surfaceStroke(metrics), borderColor: c.hair,
    borderRadius: metrics.buttonRadius,
  },
  primary: {
    flex: 1, minWidth: 160, minHeight: metrics.controlHeight,
    padding: SPACE.sm, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.accent, borderRadius: metrics.buttonRadius,
  },
  primaryText: { ...TYPE.label, color: c.onAccent, textAlign: 'center' },
  permissions: {
    gap: SPACE.xs, backgroundColor: c.hairSoft,
    borderWidth: surfaceStroke(metrics), borderColor: c.hair,
    borderRadius: metrics.cardRadius, padding: SPACE.md,
  },
  permissionHeading: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  permission: { minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  permissionText: { ...TYPE.body, flex: 1, color: c.text },
  label: { ...TYPE.label, color: c.text },
  todoGroup: { borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair, paddingBottom: SPACE.sm, gap: SPACE.xxs },
  todoRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  todoInput: { ...TYPE.body, flex: 1, minHeight: metrics.controlHeight, color: c.text, paddingVertical: SPACE.xs },
  todoState: { ...TYPE.meta, marginLeft: metrics.controlHeight + SPACE.xs, color: c.text2 },
  childRow: { flexDirection: 'row', alignItems: 'center', marginLeft: SPACE.xl, gap: SPACE.xxs },
  childText: { ...TYPE.body, flex: 1, color: c.text2 },
  unselected: { color: c.text3 },
  problem: { ...TYPE.label, fontWeight: '400', color: c.danger },
  off: { opacity: 0.55 },
});
