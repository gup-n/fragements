/** 聊天中的整理产出：所有篇可审阅，权限/数量/写入共用一个稳定 key 计划。 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
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
        <Text style={styles.title}>{busy ? '正在整理' : draft.mode === 'todos' ? `提炼出 ${todoTotal} 条待办` : `产出 ${draft.docs.length} 篇文档${todoTotal ? ` · ${todoTotal} 条待办` : ''}`}</Text>
        {busy ? <Text style={styles.meta}>{elapsed}s</Text> : null}
      </View>
      {steps.length ? (
        <View style={styles.steps}>
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
          <View key={doc.key} style={styles.document}>
            <View style={styles.docHeading}>
              <Pressable
                style={styles.checkHit} disabled={locked || !!saved} onPress={() => patchDoc(doc.key, !doc.keep)}
                accessibilityRole="checkbox" accessibilityState={{ checked: !!saved || doc.keep, disabled: locked || !!saved }}
                accessibilityLabel={`${saved ? '已写入' : doc.keep ? '取消写入' : '选择写入'}文档 ${doc.title || '未命名文档'}`}
              >
                <Ionicons name={saved ? 'checkmark-circle' : doc.keep ? 'checkbox-outline' : 'square-outline'} size={23} color={c.text} />
              </Pressable>
              <Pressable style={styles.docTitleHit} onPress={() => onOpenDraft(doc.key, 'read')} accessibilityRole="button" accessibilityLabel={`查看 ${doc.title || '未命名文档'}`}>
                <Text style={styles.docTitle}>{doc.title || '未命名文档'}</Text>
                <Text style={styles.meta}>{doc.bodyMd.replace(/\s/g, '').length} 字 · {saved ? '已写入' : doc.keep ? '待确认写入' : '未选择'}</Text>
              </Pressable>
            </View>
            <Text style={styles.secondary}>{doc.summary || '没有摘要，点查看阅读全文'}</Text>
            <View style={styles.row}>
              <Pressable style={styles.smallButton} onPress={() => onOpenDraft(doc.key, 'read')} accessibilityRole="button"><Text style={styles.buttonText}>查看</Text></Pressable>
              {saved ? (
                <Pressable style={styles.smallButton} onPress={() => onOpenDoc(saved.id)} accessibilityRole="button"><Text style={styles.buttonText}>打开已存文档</Text></Pressable>
              ) : (
                <>
                  <Pressable style={styles.smallButton} disabled={locked} onPress={() => onOpenDraft(doc.key, 'edit')} accessibilityRole="button"><Text style={styles.buttonText}>编辑</Text></Pressable>
                  <Pressable style={[styles.smallButton, (!allowDoc || !doc.keep || !!problem || locked) && styles.off]} disabled={!allowDoc || !doc.keep || !!problem || locked} onPress={() => onApprove(doc.key)} accessibilityRole="button"><Text style={styles.buttonText}>写入这一篇</Text></Pressable>
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
              <Pressable style={styles.checkHit} onPress={() => patchTodo(todo.key, { keep: !todo.keep })} disabled={locked || saved} accessibilityRole="checkbox" accessibilityState={{ checked: saved || todo.keep, disabled: locked || saved }} accessibilityLabel={`${saved ? '已写入' : todo.keep ? '取消写入' : '选择写入'}待办 ${todo.text}`}>
                <Ionicons name={saved ? 'checkmark-circle' : todo.keep ? 'checkbox-outline' : 'square-outline'} size={23} color={c.text} />
              </Pressable>
              <TextInput value={todo.text} onChangeText={(text) => patchTodo(todo.key, { text })} style={[styles.todoInput, !todo.keep && styles.unselected]} multiline editable={!locked && !saved} accessibilityLabel="待办内容" selectionColor={c.selection} />
            </View>
            <Text style={styles.todoState}>{saved ? '已写入' : todo.keep ? '已选择' : '未选择'}{todo.due ? ` · 截止 ${todo.due}` : ''}</Text>
            {todo.children.map((child) => {
              const childSaved = savedTodos.has(child.key);
              return (
                <View key={child.key} style={styles.childRow}>
                  <Pressable style={styles.checkHit} onPress={() => patchChild(todo.key, child.key, !child.keep)} disabled={locked || childSaved || !todo.keep} accessibilityRole="checkbox" accessibilityState={{ checked: childSaved || child.keep, disabled: locked || childSaved || !todo.keep }} accessibilityLabel={`${childSaved ? '已写入' : child.keep ? '取消写入' : '选择写入'}步骤 ${child.text}`}>
                    <Ionicons name={childSaved ? 'checkmark-circle' : child.keep ? 'checkbox-outline' : 'square-outline'} size={20} color={c.text2} />
                  </Pressable>
                  <Text style={[styles.childText, (!child.keep || !todo.keep) && styles.unselected]}>{child.text}{childSaved ? ' · 已写入' : !child.keep ? ' · 未选择' : ''}</Text>
                </View>
              );
            })}
          </View>
        );
      })}

      <View style={styles.permissions}>
        <Pressable style={styles.permission} onPress={() => onAllowDoc(!allowDoc)} disabled={locked} accessibilityRole="switch" accessibilityState={{ checked: allowDoc, disabled: locked }} accessibilityLabel="允许写入文档">
          <Ionicons name={allowDoc ? 'checkbox-outline' : 'square-outline'} size={22} color={c.text} />
          <Text style={styles.permissionText}>文档写入 · {allowDoc ? '开' : '关'}{draft.mode === 'todos' ? '（本轮不写文档）' : ''}</Text>
        </Pressable>
        <Pressable style={styles.permission} onPress={() => onAllowTodos(!allowTodos)} disabled={locked} accessibilityRole="switch" accessibilityState={{ checked: allowTodos, disabled: locked }} accessibilityLabel="允许新增待办">
          <Ionicons name={allowTodos ? 'checkbox-outline' : 'square-outline'} size={22} color={c.text} />
          <Text style={styles.permissionText}>待办写入 · {allowTodos ? '开' : '关'}</Text>
        </Pressable>
        <Text style={styles.note}>只写你选择的条目；原始碎片不删除。离开页面会保留这份草稿，不会自动继续请求。</Text>
      </View>
      <View style={styles.row}>
        <Pressable style={styles.outline} onPress={onDiscard} disabled={locked} accessibilityRole="button"><Text style={styles.buttonText}>放弃草稿</Text></Pressable>
        <Pressable style={[styles.primary, (!hasTargets || locked) && styles.off]} onPress={() => onApprove(null)} disabled={!hasTargets || locked} accessibilityRole="button" accessibilityLabel={hasTargets ? `确认写入 ${writeLabel}` : writeLabel}>
          <Text style={styles.primaryText}>{hasTargets && !saving ? `确认写入 ${writeLabel}` : writeLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  card: { paddingTop: 8, gap: 12 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, color: c.text, fontSize: 16, lineHeight: 24, fontWeight: '600' },
  meta: { color: c.text3, fontSize: 12, lineHeight: 19 },
  secondary: { color: c.text2, fontSize: 14, lineHeight: 22 },
  note: { color: c.text2, fontSize: 12.5, lineHeight: 20 },
  steps: { gap: 6, borderLeftWidth: metrics.strokeWidth, borderLeftColor: c.hair, paddingLeft: 12 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  stepText: { flex: 1, color: c.text2, fontSize: 13, lineHeight: 20 },
  textButton: { minHeight: metrics.controlHeight, justifyContent: 'center' },
  document: { backgroundColor: c.card, borderWidth: metrics.strokeWidth, borderColor: c.hair, borderRadius: metrics.cardRadius, padding: 12, gap: 8 },
  docHeading: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  docTitleHit: { flex: 1, minHeight: metrics.controlHeight, justifyContent: 'center', gap: 4 },
  docTitle: { color: c.text, fontSize: 16, lineHeight: 24, fontWeight: '600' },
  checkHit: { width: metrics.controlHeight, minHeight: metrics.controlHeight, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  smallButton: { minHeight: metrics.controlHeight, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center', borderRadius: metrics.buttonRadius, backgroundColor: c.hairSoft },
  buttonText: { color: c.text, fontSize: 14, lineHeight: 21 },
  outline: { minHeight: metrics.controlHeight, paddingVertical: 10, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center', borderWidth: metrics.strokeWidth, borderColor: c.hair, borderRadius: metrics.buttonRadius },
  primary: { flex: 1, minWidth: 160, minHeight: metrics.controlHeight, padding: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: c.accent, borderRadius: metrics.buttonRadius },
  primaryText: { color: c.onAccent, fontSize: 14, lineHeight: 21, fontWeight: '600' },
  permissions: { gap: 4, borderTopWidth: metrics.strokeWidth, borderTopColor: c.hair, paddingTop: 8 },
  permission: { minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: 10 },
  permissionText: { flex: 1, color: c.text, fontSize: 14, lineHeight: 22 },
  label: { color: c.text2, fontSize: 14, lineHeight: 22, fontWeight: '600' },
  todoGroup: { borderBottomWidth: metrics.strokeWidth, borderBottomColor: c.hair, paddingBottom: 10 },
  todoRow: { flexDirection: 'row', alignItems: 'center' },
  todoInput: { flex: 1, minHeight: metrics.controlHeight, color: c.text, fontSize: 15, lineHeight: 24, paddingVertical: 10 },
  todoState: { marginLeft: metrics.controlHeight, color: c.text2, fontSize: 12, lineHeight: 19 },
  childRow: { flexDirection: 'row', alignItems: 'center', marginLeft: 24 },
  childText: { flex: 1, color: c.text2, fontSize: 14, lineHeight: 22 },
  unselected: { color: c.text3 },
  problem: { color: c.danger, fontSize: 13, lineHeight: 20 },
  off: { opacity: 0.55 },
});
