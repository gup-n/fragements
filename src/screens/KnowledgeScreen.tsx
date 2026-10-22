/**
 * 知识库。
 *
 * 三层：主题列表 → 某主题下的卡片 → 单卡详情（覆盖层）。
 * 卡片列表只放标题和要点，便于扫读；原文点进详情页看，
 * 字号按「阅读」而不是「标注」来定 —— 这里的内容是要读的，不是要扫的。
 *
 * 顶部两件查询工具：关键字搜索（跨主题，命中后仍可按主题过滤）、问模型（默认当前主题）。
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { KnowledgeCard } from '../types';
import { C, R } from '../theme';
import { repo } from '../db/repo';
import { dayKey } from '../util/date';
import { AskSheet } from '../components/AskSheet';
import { KnowledgeDetail } from '../components/KnowledgeDetail';

interface Props {
  onClose: () => void;
}

export function KnowledgeScreen({ onClose }: Props) {
  const [topics, setTopics] = useState<{ topic: string; count: number }[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [loading, setLoading] = useState(true);
  /** 归档区：重构时归档掉的旧卡都在这里，必须能看见、能恢复 */
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<KnowledgeCard[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);

  const [keyword, setKeyword] = useState('');
  /** null = 没在搜索；数组 = 搜索结果 */
  const [results, setResults] = useState<KnowledgeCard[] | null>(null);

  const [detail, setDetail] = useState<KnowledgeCard | null>(null);
  const [askOpen, setAskOpen] = useState(false);

  const reloadTopics = useCallback(async () => {
    setTopics(await repo.listKnowledgeTopics());
    setArchivedCount((await repo.listArchivedKnowledgeCards()).length);
    setLoading(false);
  }, []);

  useEffect(() => {
    reloadTopics();
  }, [reloadTopics]);

  useEffect(() => {
    if (!active) {
      setCards([]);
      return;
    }
    (async () => setCards(await repo.listKnowledgeCards(active)))();
  }, [active]);

  useEffect(() => {
    if (!showArchived) return;
    (async () => setArchived(await repo.listArchivedKnowledgeCards()))();
  }, [showArchived]);

  // 搜索防抖：每敲一个字就查一次 SQLite 没必要
  useEffect(() => {
    const kw = keyword.trim();
    if (!kw) {
      setResults(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      const found = await repo.searchKnowledgeCards(kw);
      // 在主题页里搜，只留这个主题的
      if (alive) setResults(active ? found.filter((c) => c.topic === active) : found);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [keyword, active]);

  /** 卡片被归档/恢复/删除后，把三层视图的缓存都刷一遍 */
  const refreshAll = useCallback(async () => {
    await reloadTopics();
    if (active) setCards(await repo.listKnowledgeCards(active));
    if (showArchived) setArchived(await repo.listArchivedKnowledgeCards());
    const kw = keyword.trim();
    if (kw) {
      const found = await repo.searchKnowledgeCards(kw);
      setResults(active ? found.filter((c) => c.topic === active) : found);
    }
  }, [active, showArchived, keyword, reloadTopics]);

  function goBack() {
    if (keyword.trim()) {
      setKeyword('');
      return;
    }
    if (showArchived) {
      setShowArchived(false);
      return;
    }
    if (active) {
      setActive(null);
      return;
    }
    onClose();
  }

  // 安卓返回键：先按页内层级退，退到底才回主界面。
  // 覆盖层自己会注册更晚的监听器，所以这里遇到覆盖层直接放行。
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (detail || askOpen) return false;
      goBack();
      return true;
    });
    return () => sub.remove();
  });

  const total = topics.reduce((n, t) => n + t.count, 0);
  const title = showArchived ? '已归档' : (active ?? '知识库');
  const searching = keyword.trim().length > 0;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={goBack} hitSlop={12} style={styles.back}>
          <Ionicons name="chevron-back" size={20} color={C.text} />
        </Pressable>
        <Text style={styles.title}>{title}</Text>
        <View style={{ width: 24 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : (
        <>
          {!showArchived && (
            <View style={styles.toolRow}>
              <View style={styles.searchBox}>
                <Ionicons name="search" size={15} color={C.text3} />
                <TextInput
                  style={styles.searchInput}
                  value={keyword}
                  onChangeText={setKeyword}
                  placeholder={active ? `在「${active}」里搜` : '搜标题、要点、原文'}
                  placeholderTextColor={C.text3}
                  returnKeyType="search"
                  autoCorrect={false}
                />
                {searching ? (
                  <Pressable onPress={() => setKeyword('')} hitSlop={10}>
                    <Ionicons name="close-circle" size={16} color={C.text3} />
                  </Pressable>
                ) : null}
              </View>
              <Pressable
                style={({ pressed }) => [styles.askBtn, pressed && { backgroundColor: C.accentBg }]}
                onPress={() => setAskOpen(true)}
              >
                <Ionicons name="sparkles-outline" size={14} color={C.accentText} />
                <Text style={styles.askText}>问</Text>
              </Pressable>
            </View>
          )}

          {showArchived ? (
            <ScrollView contentContainerStyle={styles.content}>
              <Text style={styles.hint}>
                归档的卡片不参与整理，但原文一条都没删。随时可以恢复。
              </Text>
              {archived.map((card) => (
                <Pressable
                  key={card.id}
                  style={({ pressed }) => [
                    styles.card,
                    styles.cardArchived,
                    pressed && { backgroundColor: C.hairSoft },
                  ]}
                  onPress={() => setDetail(card)}
                >
                  <Text style={styles.cardTopic}>{card.topic}</Text>
                  <Text style={styles.cardTitle}>{card.title}</Text>
                  {!!card.gist && (
                    <Text style={styles.gist} numberOfLines={3}>
                      {card.gist}
                    </Text>
                  )}
                  <Text style={styles.date}>沉淀于 {dayKey(card.createdAt)}</Text>
                </Pressable>
              ))}
              {archived.length === 0 && <Text style={styles.hint}>没有归档的卡片。</Text>}
            </ScrollView>
          ) : searching ? (
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              {results === null ? (
                <View style={styles.center}>
                  <ActivityIndicator color={C.accent} />
                </View>
              ) : results.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>没有匹配的卡片</Text>
                  <Text style={styles.emptyBody}>
                    换个词试试，或者直接用「问」让 AI 把相关的翻出来。
                  </Text>
                </View>
              ) : (
                <>
                  <Text style={styles.hint}>
                    找到 {results.length} 张{active ? `（限「${active}」）` : ''}
                  </Text>
                  {results.map((card) => (
                    <Pressable
                      key={card.id}
                      style={({ pressed }) => [
                        styles.card,
                        pressed && { backgroundColor: C.hairSoft },
                      ]}
                      onPress={() => setDetail(card)}
                    >
                      <Text style={styles.cardTopic}>{card.topic}</Text>
                      <Text style={styles.cardTitle}>{card.title}</Text>
                      {!!card.gist && (
                        <Text style={styles.gist} numberOfLines={3}>
                          {card.gist}
                        </Text>
                      )}
                    </Pressable>
                  ))}
                </>
              )}
            </ScrollView>
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
                  <Text style={styles.hint}>
                    共 {total} 条，分布在 {topics.length} 个主题
                  </Text>
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
                          <Ionicons name="chevron-forward" size={14} color={C.text3} />
                        </View>
                      </Pressable>
                    ))}
                  </View>
                </>
              )}

              {archivedCount > 0 && (
                <Pressable
                  style={({ pressed }) => [
                    styles.archiveRow,
                    pressed && { backgroundColor: C.hairSoft },
                  ]}
                  onPress={() => setShowArchived(true)}
                >
                  <View style={styles.archiveLeft}>
                    <Ionicons name="archive-outline" size={14} color={C.text3} />
                    <Text style={styles.archiveLabel}>已归档</Text>
                  </View>
                  <View style={styles.topicRight}>
                    <Text style={styles.topicCount}>{archivedCount}</Text>
                    <Ionicons name="chevron-forward" size={14} color={C.text3} />
                  </View>
                </Pressable>
              )}
            </ScrollView>
          ) : (
            <ScrollView contentContainerStyle={styles.content}>
              {cards.map((card) => (
                <Pressable
                  key={card.id}
                  style={({ pressed }) => [styles.card, pressed && { backgroundColor: C.hairSoft }]}
                  onPress={() => setDetail(card)}
                >
                  <Text style={styles.cardTitle}>{card.title}</Text>
                  {!!card.gist && <Text style={styles.gist}>{card.gist}</Text>}
                  <View style={styles.cardMeta}>
                    <Text style={styles.date}>{dayKey(card.createdAt)}</Text>
                    <Text style={styles.openHint}>查看原文</Text>
                  </View>
                </Pressable>
              ))}
              {cards.length === 0 && <Text style={styles.hint}>这个主题下还没有卡片。</Text>}
            </ScrollView>
          )}
        </>
      )}

      {askOpen ? (
        <AskSheet topic={active} onClose={() => setAskOpen(false)} onOpenCard={(c) => setDetail(c)} />
      ) : null}
      {detail ? (
        <KnowledgeDetail card={detail} onClose={() => setDetail(null)} onChanged={refreshAll} />
      ) : null}
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 40 },

  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 11,
    height: 38,
    backgroundColor: C.card,
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: C.hair,
  },
  searchInput: { flex: 1, fontSize: 13, color: C.text, paddingVertical: 0 },
  askBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 13,
    height: 38,
    borderRadius: R.btn,
    backgroundColor: C.accentBg,
  },
  askText: { fontSize: 13, color: C.accentText, fontWeight: '500' },

  content: { paddingHorizontal: 16, paddingBottom: 28 },
  hint: { fontSize: 12, color: C.text3, marginBottom: 10, marginTop: 2, lineHeight: 19 },

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
    paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.hair,
  },
  topicName: { fontSize: 15, color: C.text },
  topicRight: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  topicCount: { fontSize: 12, color: C.text3 },

  card: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    padding: 16,
    marginBottom: 10,
  },
  cardTopic: { fontSize: 11, color: C.accentText, fontWeight: '500', marginBottom: 5 },
  cardTitle: { fontSize: 16, lineHeight: 24, color: C.text, fontWeight: '500' },
  gist: { fontSize: 14, lineHeight: 23, color: C.text2, marginTop: 8 },
  cardMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 11 },
  date: { fontSize: 11, color: C.text3, marginTop: 10 },
  openHint: { fontSize: 12, color: C.accent, marginTop: 10 },

  cardArchived: { opacity: 0.75 },
  archiveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 18,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
  },
  archiveLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  archiveLabel: { fontSize: 13, color: C.text2 },
});
