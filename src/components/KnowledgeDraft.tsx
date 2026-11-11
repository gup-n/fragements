/**
 * 整理的过程与产出，落在对话流里，可以直接改。
 *
 * v0.17 按用户的反馈重做，三处与上一版的差别：
 *
 * 1. **过程看得见**。上一版只显示「已收到 1200 字」，然后一整篇正文直接落屏。
 *    现在有步骤日志（读了什么、拆出几个主题、正在写哪一篇）和可展开的思考过程 ——
 *    和 agent 干活时一样，用户能判断它是不是跑偏了、要不要打断。
 * 2. **产出是「几篇文档」而不是「一大坨正文」**。一次整理可能拆出 1~4 篇，
 *    每篇一张卡：标题、字数、一句话摘要，点开才展开正文。
 *    用户要的是「产出 2 篇，先看这篇」，不是往下滚三千字。
 * 3. **每篇能单独加入文档库**。原来只有「通过并写入」一刀切，
 *    某一篇写得不好就只能整批放弃 —— 而那意味着另外两篇也得重跑。
 *
 * 三个不能省的约束：
 * - **写入前必须有权限位**：这张卡会往文档区和待办里写东西，而它对用户来说只是
 *   "整理一下"。所以写入按钮旁边两行开关，默认开着也要看得见、关得掉。
 * - **预览走真正的渲染器**：用 `NoteBody` 渲染，和读文档时同一套 ——
 *   用等宽文本框预览，表格是对不齐的，而表格恰恰最容易写坏。
 * - **报错不省略**：错误卡带「查看详情」，里面是服务端/模型的原话。
 */
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { R, useThemedStyles, type Palette } from '../theme';
import type { AiErrorDetail } from '../ai/chat';
import { NoteBody } from './NoteBody';
import { AgentError } from './AgentError';
import { ReasoningFold } from './ReasoningFold';
import {
  countTodos,
  docProblem,
  keptDocs,
  keptTodos,
  todoShape,
  type DraftDoc,
  type KnowledgeDraft,
} from '../util/knowledgeDoc';

/** 过程日志的一行。「正在写…」用 running，跑完了改成 done */
export interface AgentStep {
  text: string;
  state: 'done' | 'running' | 'fail';
}

export interface SavedDoc {
  /** 草稿里那篇的下标。写入后要把它标成「已加入」，不是整批 */
  index: number;
  id: number;
  name: string;
}

interface Props {
  draft: KnowledgeDraft;
  onChange: (next: KnowledgeDraft) => void;
  busy: boolean;
  received: number;
  elapsed: number;
  reasoning: string;
  error: { message: string; code?: string; detail?: AiErrorDetail } | null;
  onRetry: () => void;
  /** 材料说明：读了多少条、有没有截断 */
  note: string;
  steps: AgentStep[];
  allowDoc: boolean;
  allowTodos: boolean;
  onAllowDoc: (v: boolean) => void;
  onAllowTodos: (v: boolean) => void;
  saving: boolean;
  saved: SavedDoc[];
  onOpenDoc: (id: number) => void;
  /** 打开整页查看/编辑某一篇。卡片本身不再就地展开 —— 那会把对话滚到底 */
  onOpenDraft: (index: number, mode: 'read' | 'edit') => void;
  /** 还有多少条碎片没进这一轮（「全部整理」被单轮上限截断时） */
  leftover: number;
  onContinueAll: () => void;
  /** index 为 null 表示写入全部；否则只写那一篇 */
  onApprove: (index: number | null) => void;
  onDiscard: () => void;
}

/** 正文字数。空格和换行不算，和文档页「N 字」的口径一致 */
function charsOf(text: string): number {
  return text.replace(/\s/g, '').length;
}

export function KnowledgeDraftCard({
  draft,
  onChange,
  busy,
  received,
  elapsed,
  reasoning,
  error,
  onRetry,
  note,
  steps,
  allowDoc,
  allowTodos,
  onAllowDoc,
  onAllowTodos,
  saving,
  saved,
  onOpenDoc,
  onOpenDraft,
  leftover,
  onContinueAll,
  onApprove,
  onDiscard,
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);

  const todos = keptTodos(draft);
  const docs = draft.docs;
  /** 卡片上最多列 8 篇：再多就该分几次整理了，一屏几十张卡反而找不到 */
  const shownDocs = docs.slice(0, 8);
  const docCardsHidden = docs.length - shownDocs.length;
  const shape = todoShape(draft);
  const isTodosOnly = draft.mode === 'todos';
  const savedMap = new Map(saved.map((s) => [s.index, s]));

  const patchDoc = (index: number, patch: Partial<DraftDoc>) => {
    onChange({ ...draft, docs: draft.docs.map((d, i) => (i === index ? { ...d, ...patch } : d)) });
  };
  const patchTodo = (index: number, patch: Partial<(typeof draft.todos)[number]>) => {
    onChange({ ...draft, todos: draft.todos.map((t, i) => (i === index ? { ...t, ...patch } : t)) });
  };
  const patchChild = (ti: number, ci: number, keep: boolean) => {
    onChange({
      ...draft,
      todos: draft.todos.map((t, i) =>
        i === ti
          ? { ...t, children: t.children.map((ch, j) => (j === ci ? { ...ch, keep } : ch)) }
          : t,
      ),
    });
  };

  /**
   * 卡片标题。三种状态各说一句话：
   * 跑着、跑完有产出、跑完没产出。没有第四种。
   */
  const headTitle = busy
    ? draft.mode === 'todos'
      ? '正在整理待办'
      : '正在整理'
    : isTodosOnly
      ? `抽出 ${countTodos(draft)} 条待办`
      : docs.length
        ? `产出 ${docs.length} 篇文档${countTodos(draft) ? ` · ${countTodos(draft)} 条待办` : ''}`
        : '这次没有可沉淀的内容';

  const doneCount = saved.length;
  const writable = isTodosOnly
    ? !!todos.length && allowTodos
    : (allowDoc && !!keptDocs(draft).length) || (allowTodos && !!todos.length);

  return (
    <View style={styles.card}>
      {/* ---- 头 ---- */}
      <View style={styles.headRow}>
        <Ionicons
          name={busy ? 'sync-outline' : isTodosOnly ? 'checkbox-outline' : 'sparkles-outline'}
          size={15}
          color={c.accentText}
        />
        <Text style={styles.headTitle}>{headTitle}</Text>
        <View style={styles.flex} />
        {busy ? <Text style={styles.elapsed}>{elapsed}s</Text> : null}
      </View>

      {/* ---- 过程：步骤日志 ---- */}
      {steps.length ? (
        <View style={styles.steps}>
          {steps.map((s, i) => (
            <View key={`${i}-${s.text}`} style={styles.stepRow}>
              {s.state === 'running' ? (
                <ActivityIndicator size="small" color={c.text3} style={styles.stepIcon} />
              ) : (
                <Ionicons
                  name={s.state === 'fail' ? 'close-circle' : 'checkmark-circle'}
                  size={12}
                  color={s.state === 'fail' ? c.danger : c.tealText}
                  style={styles.stepIcon}
                />
              )}
              <Text style={[styles.stepText, s.state === 'running' && styles.stepTextRun]}>
                {s.text}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* 生成中：只报进度，不占屏 */}
      {busy ? (
        <Text style={styles.busyText}>
          {received > 0 ? `已收到 ${received} 字，正在成形…` : '正在读材料…'}
        </Text>
      ) : null}

      {/* ---- 思考过程：默认收起，标题上标字数 ---- */}
      {reasoning.trim() ? (
        <View style={styles.reasonWrap}>
          {/* 生成中就摊开：用户要求「思考过程可以查看」，藏着等于没做 */}
          <ReasoningFold text={reasoning} defaultOpen={busy} />
        </View>
      ) : null}

      {!!note && !busy ? <Text style={styles.note}>{note}</Text> : null}

      {/* 这一轮被单轮上限截断时，必须有看得见的「接着来」—— 藏起来等于没做 */}
      {leftover > 0 && !busy ? (
        <Pressable style={styles.moreBtn} onPress={onContinueAll} disabled={saving} hitSlop={4}>
          <Ionicons name="layers-outline" size={13} color={c.accentText} />
          <Text style={styles.moreText}>还有 {leftover} 条碎片没整理，继续</Text>
        </Pressable>
      ) : null}

      {/* ---- 错误：带详情 ---- */}
      {error ? (
        <View style={styles.errWrap}>
          <AgentError
            title={isTodosOnly ? '整理待办失败' : '整理失败'}
            message={error.message}
            code={error.code}
            detail={error.detail}
            onRetry={onRetry}
          />
        </View>
      ) : null}

      {/* ---- 产出：每篇一张小卡 ---- */}
      {!isTodosOnly && docs.length ? (
        <View style={styles.docsBlock}>
          <Text style={styles.label}>产出</Text>
          {shownDocs.map((doc, i) => {
            const done = savedMap.get(i);
            const problem = docProblem(doc);
            return (
              <View key={`doc-${i}`} style={styles.docCard}>
                {/*
                  点整行就是「看这一篇」。以前点一下是在卡片里展开正文，
                  结果把下面的按钮全推走、ScrollView 跟着滚到底 —— 用户点「查看」，
                  视线被甩到页面底部。现在一律开整页。
                */}
                <Pressable
                  style={styles.docHead}
                  onPress={() => onOpenDraft(i, 'read')}
                  accessibilityRole="button"
                  accessibilityLabel={`打开《${doc.title || '未命名文档'}》`}
                >
                  <View style={styles.docHeadBody}>
                    <Text style={styles.docTitle} numberOfLines={2}>
                      {doc.title || '未命名文档'}
                    </Text>
                    <Text style={styles.docSummary} numberOfLines={2}>
                      {doc.summary || '（没有摘要）'}
                    </Text>
                  </View>
                  <View style={styles.docCharsBox}>
                    <Text style={styles.docChars}>{charsOf(doc.bodyMd)} 字</Text>
                    {done ? (
                      <Ionicons name="checkmark-circle" size={13} color={c.tealText} />
                    ) : (
                      <Ionicons name="chevron-forward" size={13} color={c.text3} />
                    )}
                  </View>
                </Pressable>

                <View style={styles.docActions}>
                  <Pressable style={styles.miniBtn} onPress={() => onOpenDraft(i, 'read')} hitSlop={4}>
                    <Text style={styles.miniText}>查看</Text>
                  </Pressable>
                  {done ? (
                    <Pressable style={styles.miniBtn} onPress={() => onOpenDoc(done.id)} hitSlop={4}>
                      <Text style={styles.miniText}>打开文档</Text>
                    </Pressable>
                  ) : (
                    <>
                      <Pressable
                        style={styles.miniBtn}
                        onPress={() => onOpenDraft(i, 'edit')}
                        hitSlop={4}
                        disabled={busy || saving}
                      >
                        <Text style={styles.miniText}>编辑</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.miniPrimary, (!allowDoc || !!problem || busy || saving) && styles.off]}
                        onPress={() => onApprove(i)}
                        disabled={!allowDoc || !!problem || busy || saving}
                        hitSlop={4}
                      >
                        <Text style={styles.miniPrimaryText}>加入文档库</Text>
                      </Pressable>
                    </>
                  )}
                </View>
                {problem && !busy ? <Text style={styles.docProblem}>{problem}</Text> : null}
              </View>
            );
          })}
          {docCardsHidden > 0 ? (
            <Text style={styles.note}>还有 {docCardsHidden} 篇没列出来，先处理上面这几篇再继续。</Text>
          ) : null}
        </View>
      ) : null}

      {/* ---- 待办：两层 ---- */}
      {todos.length ? (
        <View style={styles.todosBlock}>
          <Text style={styles.label}>
            待办 {todos.length} 件{shape.sub ? ` · ${shape.sub} 个步骤` : ''}
          </Text>
          {draft.todos.map((t, i) => {
            if (!t.text.trim()) return null;
            return (
              <View key={`todo-${i}`} style={styles.todoGroup}>
                <View style={styles.todoRow}>
                  <Pressable
                    onPress={() => patchTodo(i, { keep: !t.keep })}
                    hitSlop={8}
                    accessibilityLabel={t.keep ? '不写入这条' : '写入这条'}
                  >
                    <View style={[styles.check, t.keep && styles.checkOn]}>
                      {t.keep ? <Ionicons name="checkmark" size={11} color={c.onAccent} /> : null}
                    </View>
                  </Pressable>
                  <TextInput
                    value={t.text}
                    onChangeText={(text) => patchTodo(i, { text })}
                    style={[styles.todoInput, !t.keep && styles.todoOff]}
                    multiline
                    editable={!busy && !saving}
                  />
                  {t.due ? <Text style={styles.due}>{t.due.slice(5)}</Text> : null}
                </View>
                {t.children.map((ch, ci) => (
                  <View key={`sub-${i}-${ci}`} style={styles.subRow}>
                    <View style={styles.subRail} />
                    <Pressable
                      onPress={() => patchChild(i, ci, !ch.keep)}
                      hitSlop={8}
                      accessibilityLabel={ch.keep ? '不写入这个步骤' : '写入这个步骤'}
                    >
                      <View style={[styles.subCheck, ch.keep && styles.checkOn]}>
                        {ch.keep ? (
                          <Ionicons name="checkmark" size={9} color={c.onAccent} />
                        ) : null}
                      </View>
                    </Pressable>
                    <Text style={[styles.subText, !ch.keep && styles.todoOff]}>{ch.text}</Text>
                  </View>
                ))}
              </View>
            );
          })}
        </View>
      ) : null}

      {/* ---- 权限位：写入是这张卡唯一会改数据的地方 ---- */}
      <View style={styles.permBox}>
        <Pressable style={styles.permRow} onPress={() => onAllowDoc(!allowDoc)} hitSlop={4}>
          <Ionicons
            name={allowDoc ? 'checkbox' : 'square-outline'}
            size={16}
            color={allowDoc ? c.accentText : c.text3}
          />
          <Text style={styles.permText}>
            允许写入文档区{isTodosOnly ? '（本轮不写）' : `（${docs.length} 篇）`}
          </Text>
        </Pressable>
        {draft.todos.length ? (
          <Pressable style={styles.permRow} onPress={() => onAllowTodos(!allowTodos)} hitSlop={4}>
            <Ionicons
              name={allowTodos ? 'checkbox' : 'square-outline'}
              size={16}
              color={allowTodos ? c.accentText : c.text3}
            />
            <Text style={styles.permText}>允许新增 {countTodos(draft)} 条待办</Text>
          </Pressable>
        ) : null}
        <Text style={styles.permHint}>不改动任何原有碎片；写入后可以在文档区继续改或删。</Text>
      </View>

      <View style={styles.actions}>
        <Pressable style={styles.ghost} onPress={onDiscard} disabled={saving}>
          <Text style={styles.ghostText}>{doneCount ? '关闭' : '放弃'}</Text>
        </Pressable>
        <Pressable
          style={[styles.solid, (!writable || busy || saving) && styles.off]}
          onPress={() => onApprove(null)}
          disabled={!writable || busy || saving}
        >
          <Text style={styles.solidText}>
            {saving
              ? '写入中…'
              : doneCount
                ? '全部已完成'
                : isTodosOnly
                  ? '写入这些待办'
                  : `全部加入文档库${docs.length > 1 ? `（${docs.length} 篇）` : ''}`}
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
    flex: { flex: 1 },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    headTitle: { fontSize: 13.5, color: c.text, fontWeight: '600', flexShrink: 1 },
    elapsed: { fontSize: 11, color: c.text3, fontVariant: ['tabular-nums'] },

    /* 过程日志 */
    steps: { gap: 5, marginTop: 2 },
    stepRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    stepIcon: { width: 13, alignItems: 'center' },
    stepText: { flex: 1, fontSize: 11.5, lineHeight: 16, color: c.text3 },
    stepTextRun: { color: c.text2 },
    busyText: { fontSize: 11.5, color: c.text3 },
    reasonWrap: { marginTop: 2 },

    note: { fontSize: 11.5, lineHeight: 18, color: c.text3 },
    moreBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 9,
      borderRadius: R.btn,
      backgroundColor: c.accentBg,
    },
    moreText: { fontSize: 12, color: c.accentText, fontWeight: '500' },
    errWrap: { marginTop: -6 },

    /* 产出 */
    docsBlock: { gap: 8, marginTop: 2 },
    label: { fontSize: 11, color: c.text3, marginTop: 2 },
    docCard: {
      backgroundColor: c.hairSoft,
      borderRadius: R.btn,
      paddingHorizontal: 11,
      paddingVertical: 9,
      gap: 7,
    },
    docHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
    docHeadBody: { flex: 1, gap: 2 },
    docTitle: { fontSize: 13.5, color: c.text, fontWeight: '600', lineHeight: 19 },
    docSummary: { fontSize: 11.5, lineHeight: 17, color: c.text3 },
    docChars: { fontSize: 10.5, color: c.text3, fontVariant: ['tabular-nums'] },
    docCharsBox: { alignItems: 'flex-end', gap: 4, marginTop: 1 },
    docActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    miniBtn: {
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: R.pill,
      borderWidth: 0.5,
      borderColor: c.hair,
      backgroundColor: c.card,
    },
    miniText: { fontSize: 11.5, color: c.text2 },
    miniPrimary: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: R.pill,
      backgroundColor: c.accent,
    },
    miniPrimaryText: { fontSize: 11.5, color: c.onAccent, fontWeight: '600' },
    off: { opacity: 0.4 },
    docProblem: { fontSize: 10.5, color: c.danger },

    /* 待办 */
    todosBlock: { gap: 5, marginTop: 2 },
    todoGroup: { gap: 2 },
    todoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    check: {
      width: 17,
      height: 17,
      borderRadius: 5,
      borderWidth: 1,
      borderColor: c.hair,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 6,
      backgroundColor: c.card,
    },
    checkOn: { backgroundColor: c.accent, borderColor: c.accent },
    todoInput: { flex: 1, fontSize: 13, lineHeight: 19, color: c.text, paddingVertical: 5 },
    todoOff: { color: c.text3, textDecorationLine: 'line-through' },
    due: { fontSize: 11, color: c.text3, marginTop: 8, fontVariant: ['tabular-nums'] },
    subRow: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 10 },
    subRail: { width: 1, height: 14, backgroundColor: c.hair, marginLeft: 8 },
    subCheck: {
      width: 14,
      height: 14,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: c.hair,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.card,
    },
    subText: { flex: 1, fontSize: 12.5, lineHeight: 18, color: c.text2 },

    /* 权限位 */
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

    actions: { flexDirection: 'row', gap: 10, marginTop: 2 },
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
      flex: 1.6,
      alignItems: 'center',
      paddingVertical: 10,
      borderRadius: R.btn,
      backgroundColor: c.accent,
    },
    solidText: { fontSize: 13, color: c.onAccent, fontWeight: '600' },
  });
