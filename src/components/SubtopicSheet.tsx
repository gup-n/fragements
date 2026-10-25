/**
 * 给卡片分二级方向。
 *
 * 补的是一个口子：`subtopic` 只有 AI 整理**新卡**时才会填，老卡片全是空，
 * 于是「主题内按方向分组」在已有数据上根本看不到效果 —— 那功能只对新卡有意义。
 *
 * 从卡片详情页进来会预选那一张；从主题页进来是空的，可以一次勾好几张。
 * 从方向小节头进来会预选整组，改完就是给整组改名。
 * 已经用过的方向列成胶囊，点一下填进输入框 —— 顺手复用，避免「换盘」和
 * 「硬盘更换」各建一个方向，分组反而更碎。
 *
 * 「移除方向」是一个独立按钮，不是「输入框留空再点确定」——
 * 那个约定在真机上没人发现（用户反馈「不可移除方向」），
 * 隐藏起来的语义等于没有这个功能。
 */
import React, { useEffect, useMemo, useState } from 'react';
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
  topic: string;
  /** 预选中的卡片 id（从卡片详情页、或点某个方向小节头时传） */
  preselect?: number[];
  /** 预填的方向名。点已有方向的表头进来时用它，改完就是给整组改名 */
  initialName?: string;
  onClose: () => void;
  /** 改完之后让上层刷新卡片列表 */
  onChanged: () => void | Promise<void>;
}

export function SubtopicSheet({ topic, preselect, initialName, onClose, onChanged }: Props) {
  const [cards, setCards] = useState<KnowledgeCard[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(() => new Set(preselect ?? []));
  const [name, setName] = useState(initialName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const keyboardHeight = useKeyboardHeight();

  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await repo.listKnowledgeCards(topic);
      if (alive) setCards(list);
    })();
    return () => {
      alive = false;
    };
  }, [topic]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  /** 这主题下已经用过的方向，按卡片数排 —— 多数情况用户只是想并进其中一个 */
  const dirs = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of cards ?? []) {
      if (!c.subtopic) continue;
      map.set(c.subtopic, (map.get(c.subtopic) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [cards]);

  /** 未分方向的排最后，其余按方向聚在一起，扫一眼就知道哪些还没归置 */
  const sorted = useMemo(() => {
    return [...(cards ?? [])].sort((a, b) => {
      const sa = a.subtopic;
      const sb = b.subtopic;
      if (sa === sb) return a.title.localeCompare(b.title);
      if (sa === null) return 1;
      if (sb === null) return -1;
      return sa.localeCompare(sb);
    });
  }, [cards]);

  const target = name.trim();
  /** 至少勾了一张、且没在写库 */
  const pickable = picked.size > 0 && !busy;
  const canApply = pickable && !!target;
  /** 移除方向：只要勾了卡就能点，不必先清输入框 */
  const canClear = pickable;

  function toggle(id: number) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
    setError('');
  }

  /** @param value 方向名；null 表示清掉方向 */
  async function commit(value: string | null) {
    if (!pickable) return;
    Keyboard.dismiss();
    setBusy(true);
    setError('');
    try {
      // 别看返回的 changed 判断成败：不同驱动对「值没变」算不算一次改动
      // 说法不一致，某些版本会返回 0，照它判断就会「删掉了却提示失败、面板关不掉」。
      await repo.setCardSubtopic(Array.from(picked), value);
      await onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '设置失败');
      setBusy(false);
    }
  }

  return (
    <View style={[s.root, keyboardHeight > 0 && { paddingBottom: keyboardHeight }]}>
      <ScreenHeader
        title="分方向"
        subtitle={
          picked.size
            ? `已选 ${picked.size} 张卡`
            : `${cards?.length ?? 0} 张卡 · 勾选后统一设一个方向`
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
            方向只是「{topic}」里的次级分类，改它不影响卡片内容，随时可以再改。
          </Text>

          {cards.length === 0 ? (
            <Text style={s.hint}>
              {picked.size
                ? '这张卡已归档，所以不在下面的列表里；设置仍然会生效。'
                : '这个主题下还没有卡片。'}
            </Text>
          ) : (
            <View style={s.list}>
              {sorted.map((card, i) => {
                const on = picked.has(card.id);
                return (
                  <Pressable
                    key={card.id}
                    onPress={() => toggle(card.id)}
                    style={({ pressed }) => [
                      s.row,
                      i === sorted.length - 1 && { borderBottomWidth: 0 },
                      pressed && { backgroundColor: C.hairSoft },
                    ]}
                  >
                    <View style={[s.check, on && s.checkOn]}>
                      {on ? <Ionicons name="checkmark" size={13} color="#FFFFFF" /> : null}
                    </View>
                    <View style={s.rowBody}>
                      <Text style={[s.cardTitle, on && s.cardTitleOn]} numberOfLines={2}>
                        {card.title}
                      </Text>
                      <Text style={[s.current, !card.subtopic && s.currentEmpty]} numberOfLines={1}>
                        {card.subtopic ?? '未分方向'}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </ScrollView>
      )}

      <View style={s.footer}>
        {dirs.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.chipRow}
            keyboardShouldPersistTaps="handled"
          >
            {dirs.map(([dir, n]) => {
              const on = dir === target;
              return (
                <Pressable
                  key={dir}
                  onPress={() => {
                    setName(on ? '' : dir);
                    setError('');
                  }}
                  style={({ pressed }) => [s.chip, on && s.chipOn, pressed && { opacity: 0.7 }]}
                >
                  <Text style={[s.chipText, on && s.chipTextOn]}>{dir}</Text>
                  <Text style={[s.chipCount, on && s.chipTextOn]}>{n}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        <View style={s.inputRow}>
          <Ionicons name="pricetag-outline" size={15} color={C.text3} />
          <TextInput
            style={s.input}
            value={name}
            onChangeText={(v) => {
              setName(v);
              setError('');
            }}
            placeholder={dirs.length ? '新方向，或点上面的胶囊复用' : '比如「换盘」「备份」'}
            placeholderTextColor={C.text3}
            maxLength={12}
            returnKeyType="done"
            onSubmitEditing={() => commit(target)}
          />
          {name ? (
            <Pressable onPress={() => setName('')} hitSlop={8} accessibilityLabel="清空">
              <Ionicons name="close-circle" size={16} color={C.text3} />
            </Pressable>
          ) : null}
        </View>

        <View style={s.footRow}>
          <Text style={s.footHint} numberOfLines={1}>
            {picked.size ? (target ? `设为「${target}」` : '输入方向名后点设定') : '先勾选卡片'}
          </Text>
          <Pressable
            onPress={() => commit(null)}
            disabled={!canClear}
            style={({ pressed }) => [
              s.clearBtn,
              !canClear && s.btnOff,
              pressed && canClear && { opacity: 0.6 },
            ]}
            accessibilityLabel="移除这些卡的方向"
          >
            <Ionicons name="close" size={13} color={canClear ? C.text2 : C.text3} />
            <Text style={[s.clearText, !canClear && s.textOff]}>移除方向</Text>
          </Pressable>
          <Pressable
            onPress={() => commit(target)}
            disabled={!canApply}
            style={[s.applyBtn, !canApply && s.applyBtnOff]}
          >
            {busy ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Text style={[s.applyText, !canApply && s.applyTextOff]}>设定</Text>
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
    paddingVertical: 12,
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
  rowBody: { flex: 1, gap: 4 },
  cardTitle: { fontSize: 14.5, lineHeight: 21, color: C.text },
  cardTitleOn: { color: C.accentText, fontWeight: '500' },
  current: { fontSize: 11.5, color: C.text2 },
  currentEmpty: { color: C.text3 },

  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    backgroundColor: C.page,
    gap: 8,
  },
  chipRow: { gap: 7, paddingRight: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: R.pill,
    backgroundColor: C.hairSoft,
  },
  chipOn: { backgroundColor: C.accentBg },
  chipText: { fontSize: 12, color: C.text2 },
  chipCount: { fontSize: 10.5, color: C.text3, fontVariant: ['tabular-nums'] },
  chipTextOn: { color: C.accentText, fontWeight: '600' },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    paddingHorizontal: 12,
    backgroundColor: C.card,
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: C.hair,
  },
  input: { flex: 1, fontSize: 14.5, color: C.text, paddingVertical: 0 },

  footRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  footHint: { flex: 1, fontSize: 11.5, color: C.text3 },
  /** 次级动作：移除方向。做成描边按钮，不和主按钮抢注意力 */
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: R.btn,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.hair,
    backgroundColor: C.card,
  },
  clearText: { fontSize: 12.5, color: C.text2 },
  btnOff: { backgroundColor: C.hairSoft },
  textOff: { color: C.text3 },
  applyBtn: {
    minWidth: 64,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: R.btn,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.accent,
  },
  applyBtnOff: { backgroundColor: C.hairSoft },
  applyText: { fontSize: 13.5, color: '#FFFFFF', fontWeight: '600' },
  applyTextOff: { color: C.text3 },
  error: { fontSize: 12, color: C.danger },
});
