/**
 * 问答里的「改动建议」清单。
 *
 * 原则和整理页一模一样：**模型只出建议，勾了才写库**，且默认一条都不勾。
 * 用户问「帮我合并一下主题」时确实要多点两下，但反过来 ——
 * 默认勾上、用户顺手点了执行 —— 代价是知识库被悄悄改了结构，还回不去。
 * 两害相权，多点两下。
 */
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { AskAction } from '../types';
import { applyAskAction } from '../db/askCommit';
import { actionKey, describeAction } from '../util/askActions';
import { C, R } from '../theme';

interface Props {
  actions: AskAction[];
  /** 卡片 id → 标题，用于把「归档 #12」显示成看得懂的东西 */
  titleOf: (id: number) => string | null;
  /** 执行完通知上层刷新知识库 */
  onApplied: () => void | Promise<void>;
}

export function AskActions({ actions, titleOf, onApplied }: Props) {
  /** 勾选状态按内容做 key。按数组下标的话，提案一重排就勾到了别的条目上 */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<string[]>([]);

  const open = actions.filter((a) => !applied.has(actionKey(a)));
  const pickedCount = open.filter((a) => picked.has(actionKey(a))).length;

  function toggle(key: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function run() {
    if (running || !pickedCount) return;
    setRunning(true);
    const lines: string[] = [];
    const doneKeys: string[] = [];
    // 逐条执行：一条失败不该把成功的也回滚，用户勾了半天却什么都没生效最难排查
    for (const action of open) {
      const key = actionKey(action);
      if (!picked.has(key)) continue;
      try {
        lines.push(await applyAskAction(action));
        doneKeys.push(key);
      } catch (e) {
        lines.push(`${describeAction(action, titleOf).label}失败：${e instanceof Error ? e.message : '未知错误'}`);
      }
    }
    setApplied((prev) => new Set([...prev, ...doneKeys]));
    setPicked(new Set());
    setResults(lines);
    setRunning(false);
    await onApplied();
  }

  if (!actions.length) return null;

  return (
    <View style={s.wrap}>
      <View style={s.head}>
        <Ionicons name="construct-outline" size={13} color={C.amberText} />
        <Text style={s.headText}>
          改动建议 {actions.length} 条{applied.size ? ` · 已执行 ${applied.size}` : ''}
        </Text>
        {open.length > 1 ? (
          <Pressable
            hitSlop={8}
            onPress={() =>
              setPicked(
                pickedCount === open.length ? new Set() : new Set(open.map((a) => actionKey(a))),
              )
            }
          >
            <Text style={s.allBtn}>{pickedCount === open.length ? '取消全选' : '全选'}</Text>
          </Pressable>
        ) : null}
      </View>

      {actions.map((action) => {
        const key = actionKey(action);
        const text = describeAction(action, titleOf);
        const done = applied.has(key);
        const on = picked.has(key);
        return (
          <Pressable
            key={key}
            disabled={done || running}
            onPress={() => toggle(key)}
            style={({ pressed }) => [s.item, done && s.itemDone, pressed && !done && s.itemPressed]}
          >
            <View style={[s.box, on && s.boxOn, done && s.boxDone]}>
              {done ? (
                <Ionicons name="checkmark" size={12} color="#FFFFFF" />
              ) : on ? (
                <Ionicons name="checkmark" size={12} color="#FFFFFF" />
              ) : null}
            </View>
            <View style={s.itemBody}>
              <View style={s.itemHead}>
                <Text style={[s.label, done && s.labelDone]}>{text.label}</Text>
                {text.risky ? <Text style={s.riskyTag}>归档可恢复</Text> : null}
              </View>
              <Text style={[s.detail, done && s.labelDone]}>{text.detail}</Text>
              {action.reason ? <Text style={s.reason}>{action.reason}</Text> : null}
            </View>
          </Pressable>
        );
      })}

      {open.length ? (
        <Pressable
          onPress={run}
          disabled={!pickedCount || running}
          style={({ pressed }) => [
            s.runBtn,
            (!pickedCount || running) && s.runBtnOff,
            pressed && pickedCount > 0 && { opacity: 0.75 },
          ]}
        >
          {running ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={[s.runText, !pickedCount && s.runTextOff]}>
              {pickedCount ? `执行选中的 ${pickedCount} 项` : '先勾选要执行的项'}
            </Text>
          )}
        </Pressable>
      ) : null}

      {results.length ? (
        <View style={s.results}>
          {results.map((line, i) => (
            <View key={i} style={s.resultRow}>
              <Ionicons name="checkmark-circle" size={12} color={C.tealText} />
              <Text style={s.resultText}>{line}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    marginTop: 18,
    backgroundColor: C.amberBg,
    borderRadius: R.card,
    padding: 12,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 9 },
  headText: { flex: 1, fontSize: 12, color: C.amberText, fontWeight: '600' },
  allBtn: { fontSize: 12, color: C.amberText },

  item: {
    flexDirection: 'row',
    gap: 9,
    backgroundColor: C.card,
    borderRadius: R.btn,
    padding: 10,
    marginBottom: 7,
  },
  itemPressed: { opacity: 0.75 },
  itemDone: { opacity: 0.55 },
  box: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: C.text3,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  boxOn: { backgroundColor: C.accent, borderColor: C.accent },
  boxDone: { backgroundColor: C.tealText, borderColor: C.tealText },

  itemBody: { flex: 1 },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { fontSize: 13, color: C.text, fontWeight: '500' },
  labelDone: { color: C.text3, textDecorationLine: 'line-through' },
  riskyTag: {
    fontSize: 9.5,
    color: C.amberText,
    backgroundColor: C.amberBg,
    borderRadius: R.pill,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  detail: { fontSize: 12, lineHeight: 18, color: C.text2, marginTop: 3 },
  reason: { fontSize: 11.5, lineHeight: 17, color: C.text3, marginTop: 4 },

  runBtn: {
    marginTop: 3,
    height: 38,
    borderRadius: R.btn,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  runBtnOff: { backgroundColor: C.hairSoft },
  runText: { fontSize: 13, color: '#FFFFFF', fontWeight: '600' },
  runTextOff: { color: C.text3, fontWeight: '400' },

  results: { marginTop: 10, gap: 5 },
  resultRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 5 },
  resultText: { flex: 1, fontSize: 11.5, lineHeight: 17, color: C.tealText },
});
