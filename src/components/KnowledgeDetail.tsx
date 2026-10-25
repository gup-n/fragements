/**
 * 知识卡详情页。
 *
 * 卡片列表只放标题和要点（够扫读），点进来才是完整原文 ——
 * 原来行内展开的做法在卡片正文变长之后会把列表撑得很乱。
 *
 * 归档、恢复、删除都在这里，而且删除要点两次 —— 归档可逆，删除不可逆。
 *
 * 二级方向也从这里改：卡片列表会按方向分组，但老卡片的 subtopic 全是空，
 * 没有入口就永远分不了组。点主题那一行就能设。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { KnowledgeCard } from '../types';
import { repo } from '../db/repo';
import { C, R } from '../theme';
import { dayKey } from '../util/date';
import { ScreenHeader } from './ScreenHeader';
import { SubtopicSheet } from './SubtopicSheet';

interface Props {
  card: KnowledgeCard;
  onClose: () => void;
  /** 归档 / 恢复 / 删除 / 改方向之后，让上层刷新列表 */
  onChanged: () => void | Promise<void>;
}

export function KnowledgeDetail({ card, onClose, onChanged }: Props) {
  const [armedDelete, setArmedDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 分方向面板：只针对这一张卡，所以预选就是它自己 */
  const [subOpen, setSubOpen] = useState(false);
  const preselect = useMemo(() => [card.id], [card.id]);

  // 覆盖层自带返回键拦截，否则会一路回主界面。
  // 子面板开着的时候要让位，否则返回键会连页面一起关掉。
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (subOpen) return false;
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose, subOpen]);

  const closeSub = useCallback(() => setSubOpen(false), []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    if (!armedDelete) {
      setArmedDelete(true);
      return;
    }
    run(() => repo.deleteKnowledgeCard(card.id));
  }

  return (
    <View style={s.root}>
      <ScreenHeader title="知识卡" backIcon="close" onBack={onClose} />

      <ScrollView contentContainerStyle={s.content}>
        <Pressable
          style={({ pressed }) => [s.topicRow, pressed && { opacity: 0.6 }]}
          onPress={() => setSubOpen(true)}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`修改二级方向，当前${card.subtopic ?? '未分方向'}`}
        >
          <Ionicons name="pricetag-outline" size={13} color={C.accentText} />
          <Text style={s.topic}>{card.topic}</Text>
          <Ionicons name="chevron-forward" size={11} color={C.text3} />
          <Text style={[s.subtopic, !card.subtopic && s.subtopicEmpty]}>
            {card.subtopic ?? '未分方向'}
          </Text>
          <Ionicons name="create-outline" size={13} color={C.text3} />
        </Pressable>

        <Text style={s.title}>{card.title}</Text>

        {!!card.gist && (
          <View style={s.gistBox}>
            <Text style={s.gist}>{card.gist.replace(/^\s*-\s*/gm, '· ')}</Text>
          </View>
        )}

        <Text style={s.sectionLabel}>原文</Text>
        <View style={s.bodyBox}>
          <Text style={s.body} selectable>
            {card.body}
          </Text>
        </View>

        <Text style={s.meta}>
          沉淀于 {dayKey(card.createdAt)} · 来自 {card.sourceIds.length} 条碎片
        </Text>

        {error ? <Text style={s.error}>{error}</Text> : null}
      </ScrollView>

      <View style={s.footer}>
        {card.archived ? (
          <Pressable
            style={s.ghostBtn}
            disabled={busy}
            onPress={() => run(() => repo.updateKnowledgeCard(card.id, { archived: false }))}
          >
            <Text style={s.ghostText}>恢复到知识库</Text>
          </Pressable>
        ) : (
          <Pressable
            style={s.ghostBtn}
            disabled={busy}
            onPress={() => run(() => repo.updateKnowledgeCard(card.id, { archived: true }))}
          >
            <Text style={s.ghostText}>归档</Text>
          </Pressable>
        )}

        <Pressable style={[s.dangerBtn, armedDelete && s.dangerBtnArmed]} onPress={remove} disabled={busy}>
          {busy ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={[s.dangerText, armedDelete && s.dangerTextArmed]}>
              {armedDelete ? '再点一次彻底删除' : '删除'}
            </Text>
          )}
        </Pressable>
      </View>

      {/* 分方向面板排在最后渲染：同为 absolute 覆盖层，JSX 顺序就是层叠顺序 */}
      {subOpen ? (
        <SubtopicSheet
          topic={card.topic}
          preselect={preselect}
          /* 预填当前方向：否则面板里显示不出「这张卡现在属于哪个方向」，
             想改名还得照着重打一遍 */
          initialName={card.subtopic ?? undefined}
          onClose={closeSub}
          onChanged={onChanged}
        />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: C.page },

  content: { paddingHorizontal: 18, paddingBottom: 28 },
  topicRow: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' },
  topic: { fontSize: 12, color: C.accentText, fontWeight: '600' },
  subtopic: { fontSize: 12, color: C.text2 },
  subtopicEmpty: { color: C.text3 },
  title: {
    fontSize: 20,
    lineHeight: 29,
    color: C.text,
    fontWeight: '600',
    marginTop: 8,
    marginBottom: 14,
  },

  gistBox: {
    backgroundColor: C.accentBg,
    borderRadius: R.card,
    padding: 14,
    marginBottom: 20,
  },
  gist: { fontSize: 14, lineHeight: 24, color: C.accentText },

  sectionLabel: { fontSize: 12, color: C.text3, marginBottom: 8 },
  bodyBox: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    padding: 16,
  },
  body: { fontSize: 15, lineHeight: 26, color: C.text },

  meta: { fontSize: 11, color: C.text3, marginTop: 14 },
  error: { fontSize: 12, color: C.danger, marginTop: 12 },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
    backgroundColor: C.page,
  },
  ghostBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: C.hair,
    backgroundColor: C.card,
  },
  ghostText: { fontSize: 14, color: C.text2 },
  dangerBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: R.btn,
    backgroundColor: C.dangerBg,
  },
  dangerBtnArmed: { backgroundColor: C.danger },
  dangerText: { fontSize: 14, color: C.danger, fontWeight: '500' },
  dangerTextArmed: { color: '#FFFFFF' },
});
