/**
 * 主题整理面板。
 *
 * 解决的问题：主题只是卡片上的一个字符串，模型新建一个的成本是零，
 * 于是「工具」「资讯」各占一个，其实都是 AI。整理时 AI 会提归并建议，
 * 但它不可能每次都判断对 —— 所以得有一个用户自己动手的地方。
 *
 * 合并和改名是同一个动作（把一批主题下的卡片改挂到另一个名字下），
 * 所以这里只有一个输入框：勾一个就是改名，勾多个就是合并。
 *
 * 用覆盖层而不是 Modal —— 见 SPEC 第 8.1 节，Modal 会压到状态栏下且收不到键盘。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { KnowledgeCard } from '../types';
import { repo } from '../db/repo';
import { C, R } from '../theme';
import { useKeyboardHeight } from '../util/keyboard';
import { ScreenHeader } from './ScreenHeader';

interface Props {
  topics: { topic: string; count: number }[];
  onClose: () => void;
  /** 改完之后让上层刷新主题列表和卡片列表 */
  onChanged: () => void | Promise<void>;
}

export function TopicSheet({ topics, onClose, onChanged }: Props) {
  const [cards, setCards] = useState<KnowledgeCard[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirtyRef = useRef(false);
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const keyboardHeight = useKeyboardHeight();

  useEffect(() => {
    (async () => setCards(await repo.listKnowledgeCards()))();
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  /** 每个主题下挂几张卡、分别是哪几张 —— 只给前两个标题，够判断该不该并了 */
  const preview = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of cards ?? []) {
      const list = map.get(c.topic);
      if (list) list.push(c.title);
      else map.set(c.topic, [c.title]);
    }
    return map;
  }, [cards]);

  const picked = Array.from(selected);
  const to = target.trim();
  const canApply = picked.length > 0 && !!to && !busy;

  function toggle(topic: string) {
    const next = new Set(selected);
    if (next.has(topic)) next.delete(topic);
    else next.add(topic);
    setSelected(next);
    setError('');
    // 用户没手改过名字时，用第一个选中的主题名做预填 ——
    // 多数情况就是「并到这个主题里」，省一次输入
    if (!dirtyRef.current) setTarget(Array.from(next)[0] ?? '');
  }

  async function apply() {
    if (!canApply) return;
    const from = picked;
    // 只勾一个、名字也没改，等于什么都没做
    if (from.length === 1 && from[0] === to) {
      onClose();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await repo.retopicCards(from, to);
      await onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '合并失败');
      setBusy(false);
    }
  }

  return (
    <View style={[s.root, keyboardHeight > 0 && { paddingBottom: keyboardHeight }]}>
      <ScreenHeader
        title="整理主题"
        subtitle={
          picked.length
            ? picked.length === 1
              ? '改名后这个主题下的卡片都会跟着走'
              : `把 ${picked.length} 个主题并成一个`
            : `${topics.length} 个主题 · 方向相近的可以并起来`
        }
        backIcon="close"
        onBack={onClose}
      />

      {cards === null ? (
        <View style={s.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          <Text style={s.hint}>
            勾选要合并的主题，在下面给它们起一个名字。只改主题名，卡片一张都不会少。
          </Text>

          <View style={s.list}>
            {topics.map((t, i) => {
              const on = selected.has(t.topic);
              const titles = preview.get(t.topic) ?? [];
              const shown = titles.slice(0, 2).join(' / ');
              return (
                <Pressable
                  key={t.topic}
                  onPress={() => toggle(t.topic)}
                  style={({ pressed }) => [
                    s.row,
                    i === topics.length - 1 && { borderBottomWidth: 0 },
                    pressed && { backgroundColor: C.hairSoft },
                  ]}
                >
                  <View style={[s.check, on && s.checkOn]}>
                    {on ? <Ionicons name="checkmark" size={13} color="#FFFFFF" /> : null}
                  </View>
                  <View style={s.rowBody}>
                    <View style={s.rowTop}>
                      <Text style={[s.name, on && s.nameOn]}>{t.topic}</Text>
                      <Text style={s.count}>{t.count} 张</Text>
                    </View>
                    {!!shown && (
                      <Text style={s.preview} numberOfLines={1}>
                        {shown}
                        {titles.length > 2 ? ' …' : ''}
                      </Text>
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      )}

      <View style={s.footer}>
        <View style={s.inputRow}>
          <Ionicons name="pricetag-outline" size={15} color={C.text3} />
          <TextInput
            ref={inputRef}
            style={s.input}
            value={target}
            onChangeText={(v) => {
              dirtyRef.current = true;
              setTarget(v);
              setError('');
            }}
            placeholder={picked.length ? '合并后的主题名' : '先在上面勾选主题'}
            placeholderTextColor={C.text3}
            editable={picked.length > 0}
            maxLength={20}
            returnKeyType="done"
            onSubmitEditing={() => {
              Keyboard.dismiss();
              apply();
            }}
          />
          <Pressable
            onPress={apply}
            disabled={!canApply}
            hitSlop={8}
            style={[s.applyBtn, !canApply && s.applyBtnOff]}
          >
            {busy ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Ionicons name="checkmark" size={18} color={canApply ? '#FFFFFF' : C.text3} />
            )}
          </Pressable>
        </View>
        {error ? <Text style={s.error}>{error}</Text> : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: C.page },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 28 },
  hint: { fontSize: 12, color: C.text3, lineHeight: 19, marginBottom: 12 },

  list: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.hair,
  },
  check: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: C.hair,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: C.accent, borderColor: C.accent },
  rowBody: { flex: 1, gap: 3 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  name: { flex: 1, fontSize: 15, color: C.text, fontWeight: '500' },
  nameOn: { color: C.accentText },
  count: { fontSize: 11.5, color: C.text3, fontVariant: ['tabular-nums'] },
  preview: { fontSize: 11.5, color: C.text3, lineHeight: 17 },

  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    backgroundColor: C.page,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    paddingLeft: 12,
    paddingRight: 6,
    backgroundColor: C.card,
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: C.hair,
  },
  input: { flex: 1, fontSize: 14.5, color: C.text, paddingVertical: 0 },
  applyBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.accent,
  },
  applyBtnOff: { backgroundColor: C.hairSoft },
  error: { fontSize: 12, color: C.danger, marginTop: 8 },
});
