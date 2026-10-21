import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { KnowledgeCard } from '../types';
import { C, R } from '../theme';
import { repo } from '../db/repo';
import { dayKey } from '../util/date';

interface Props {
  onClose: () => void;
}

export function KnowledgeScreen({ onClose }: Props) {
  const [topics, setTopics] = useState<{ topic: string; count: number }[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [armedDelete, setArmedDelete] = useState<number | null>(null);

  const reloadTopics = useCallback(async () => {
    setTopics(await repo.listKnowledgeTopics());
    setLoading(false);
  }, []);

  useEffect(() => {
    reloadTopics();
  }, [reloadTopics]);

  useEffect(() => {
    if (!active) return;
    (async () => setCards(await repo.listKnowledgeCards(active)))();
  }, [active]);

  async function remove(id: number) {
    if (armedDelete !== id) {
      setArmedDelete(id);
      return;
    }
    await repo.deleteKnowledgeCard(id);
    setArmedDelete(null);
    setExpanded(null);
    if (active) setCards(await repo.listKnowledgeCards(active));
    await reloadTopics();
  }

  const total = topics.reduce((n, t) => n + t.count, 0);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={() => (active ? setActive(null) : onClose())}
          hitSlop={12}
          style={styles.back}
        >
          <Ionicons name="chevron-back" size={20} color={C.text} />
        </Pressable>
        <Text style={styles.title}>{active ?? '知识库'}</Text>
        <View style={{ width: 24 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : !active ? (
        <ScrollView contentContainerStyle={styles.content}>
          {topics.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>还没有沉淀知识</Text>
              <Text style={styles.emptyBody}>
                记下学到的东西、踩过的坑，{'\n'}点「整理」时 AI 会把它们挑出来归到主题下。
              </Text>
            </View>
          ) : (
            <>
              <Text style={styles.hint}>共 {total} 条，分布在 {topics.length} 个主题</Text>
              <View style={styles.topicList}>
                {topics.map((t, i) => (
                  <Pressable
                    key={t.topic}
                    onPress={() => setActive(t.topic)}
                    style={({ pressed }) => [
                      styles.topicRow,
                      i === topics.length - 1 && { borderBottomWidth: 0 },
                      pressed && { backgroundColor: C.hairSoft },
                    ]}
                  >
                    <Text style={styles.topicName}>{t.topic}</Text>
                    <View style={styles.topicRight}>
                      <Text style={styles.topicCount}>{t.count}</Text>
                      <Ionicons name="chevron-forward" size={13} color={C.text3} />
                    </View>
                  </Pressable>
                ))}
              </View>
            </>
          )}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {cards.map((card) => {
            const open = expanded === card.id;
            return (
              <View key={card.id} style={styles.card}>
                <Pressable onPress={() => setExpanded(open ? null : card.id)}>
                  <Text style={styles.cardTitle}>{card.title}</Text>
                  {!!card.gist && <Text style={styles.gist}>{card.gist}</Text>}
                  <View style={styles.cardMeta}>
                    <Text style={styles.date}>{dayKey(card.createdAt)}</Text>
                    <Text style={styles.toggle}>{open ? '收起原文' : '展开原文'}</Text>
                  </View>
                </Pressable>

                {open && (
                  <View style={styles.bodyBox}>
                    <Text style={styles.bodyText}>{card.body}</Text>
                    <Pressable onPress={() => remove(card.id)} hitSlop={8}>
                      <Text style={styles.del}>
                        {armedDelete === card.id ? '再点一次确认移出' : '移出知识库'}
                      </Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          })}
          {cards.length === 0 && <Text style={styles.hint}>这个主题下还没有卡片。</Text>}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.page },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  back: { width: 24 },
  title: { fontSize: 16, color: C.text, fontWeight: '500' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  content: { paddingHorizontal: 16, paddingBottom: 28 },
  hint: { fontSize: 12, color: C.text3, marginBottom: 10, marginTop: 2 },

  empty: { alignItems: 'center', paddingTop: 90 },
  emptyTitle: { fontSize: 15, color: C.text2, fontWeight: '500' },
  emptyBody: { fontSize: 13, color: C.text3, textAlign: 'center', lineHeight: 21, marginTop: 10 },

  topicList: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    overflow: 'hidden',
  },
  topicRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.hair,
  },
  topicName: { fontSize: 14, color: C.text },
  topicRight: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  topicCount: { fontSize: 12, color: C.text3 },

  card: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    padding: 14,
    marginBottom: 10,
  },
  cardTitle: { fontSize: 14, lineHeight: 21, color: C.text, fontWeight: '500' },
  gist: { fontSize: 12, lineHeight: 19, color: C.text2, marginTop: 6 },
  cardMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 9,
  },
  date: { fontSize: 11, color: C.text3 },
  toggle: { fontSize: 12, color: C.accent },
  bodyBox: {
    marginTop: 11,
    paddingTop: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
    gap: 10,
  },
  bodyText: { fontSize: 13, lineHeight: 21, color: C.text },
  del: { fontSize: 12, color: C.danger },
});
