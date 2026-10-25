/**
 * 知识库。
 *
 * 三层：主题列表 → 某主题下的卡片 → 单卡详情（覆盖层）。
 * 卡片列表只放标题和要点，便于扫读；原文点进详情页看，
 * 字号按「阅读」而不是「标注」来定 —— 这里的内容是要读的，不是要扫的。
 *
 * 顶部两件查询工具：关键字搜索（跨主题，命中后仍可按主题过滤）、问模型（默认当前主题）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { ScreenHeader } from '../components/ScreenHeader';
import { IconButton } from '../components/IconButton';
import { TopicSheet } from '../components/TopicSheet';
import { SubtopicSheet } from '../components/SubtopicSheet';

interface Props {
  onClose: () => void;
}

export function KnowledgeScreen({ onClose }: Props) {
  const [topics, setTopics] = useState<{ topic: string; count: number; dirs: number }[]>([]);
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
  /** 主题整理面板：合并 / 改名。AI 的归并建议不可能每次都准，得有个人工入口 */
  const [topicOpen, setTopicOpen] = useState(false);
  /**
   * 分方向面板。`preset` 有值时是「给某一组改名」：点方向小节头进来，
   * 那一组的卡片已经勾好、方向名也填好了；没有值时是主题级的批量勾选。
   */
  const [sub, setSub] = useState<{ preset: { ids: number[]; name: string } | null } | null>(null);

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
  // 注意订阅变量不能叫 sub —— 会和下面的 sub state 重名，
  // 闭包里永远拿到订阅对象（恒为真），返回键就彻底失效了。
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (detail || askOpen || topicOpen || sub) return false;
      goBack();
      return true;
    });
    return () => subscription.remove();
  });

  /** 主题内的卡片行。分组显示和单层平铺都用它，避免两份几乎一样的 JSX */
  function renderCard(card: KnowledgeCard) {
    return (
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
    );
  }

  const total = topics.reduce((n, t) => n + t.count, 0);
  const title = showArchived ? '已归档' : (active ?? '知识库');
  const searching = keyword.trim().length > 0;

  /**
   * 主题内按二级方向分组。
   * 只有一个组时不显示分组头 —— 大多数主题下就那么两三张卡，
   * 硬加一层「未分方向」的标题纯属噪音。
   */
  const groups = useMemo(() => {
    const map = new Map<string | null, KnowledgeCard[]>();
    for (const c of cards) {
      const k = c.subtopic ?? null;
      const list = map.get(k);
      if (list) list.push(c);
      else map.set(k, [c]);
    }
    return Array.from(map.entries()).sort((a, b) => {
      const [sa, la] = a;
      const [sb, lb] = b;
      if (sa === null) return 1;
      if (sb === null) return -1;
      return lb.length - la.length || sa.localeCompare(sb);
    });
  }, [cards]);

  /** 已分出去的方向个数（不含「未分方向」那一组），用来写副标题 */
  const dirCount = groups.filter(([k]) => k !== null).length;

  /**
   * 详情页展示的卡片必须实时派生，不能用点进来时那个对象 ——
   * 在详情页里改完方向后上层会刷新列表，但对象还是旧的，页面看起来「没变」，
   * 得关掉重进才生效（v0.4.2 在碎片详情页上踩过同一个坑）。
   * 找不到时退回快照：从问答里点开的卡可能不在当前列表范围内。
   */
  const detailLive = useMemo(() => {
    if (!detail) return null;
    const pool = [...cards, ...(results ?? []), ...archived];
    return pool.find((c) => c.id === detail.id) ?? detail;
  }, [detail, cards, results, archived]);

  return (
    <View style={styles.root}>
      <ScreenHeader
        title={title}
        subtitle={
          showArchived
            ? `共 ${archivedCount} 张已归档`
            : active
              ? `${cards.length} 张卡${dirCount > 0 ? ` · ${dirCount} 个方向` : ''}`
              : topics.length
                ? `${topics.length} 个主题 · ${total} 张卡`
                : undefined
        }
        onBack={goBack}
        right={
          showArchived ? undefined : active ? (
            cards.length > 0 ? (
              <IconButton
                name="layers-outline"
                size={20}
                tone="soft"
                onPress={() => setSub({ preset: null })}
                accessibilityLabel="分方向"
              />
            ) : undefined
          ) : topics.length > 1 ? (
            <IconButton
              name="git-merge-outline"
              size={20}
              tone="soft"
              onPress={() => setTopicOpen(true)}
              accessibilityLabel="整理主题"
            />
          ) : undefined
        }
      />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : (
        <>
          {!showArchived && (
            <View style={styles.toolRow}>
              <View style={styles.searchBox}>
                <Ionicons name="search" size={16} color={C.text3} />
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
                    <Ionicons name="close-circle" size={17} color={C.text3} />
                  </Pressable>
                ) : null}
              </View>
              <Pressable
                style={({ pressed }) => [styles.askBtn, pressed && { backgroundColor: C.accentBg }]}
                onPress={() => setAskOpen(true)}
              >
                <Ionicons name="sparkles-outline" size={15} color={C.accentText} />
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
                        <View style={styles.topicLeft}>
                          <Text style={styles.topicName}>{t.topic}</Text>
                          {t.dirs > 0 ? (
                            <Text style={styles.topicDirs}>{t.dirs} 个方向</Text>
                          ) : null}
                        </View>
                        <View style={styles.topicRight}>
                          <Text style={styles.topicCount}>{t.count}</Text>
                          <Ionicons name="chevron-forward" size={16} color={C.text3} />
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
                    <Ionicons name="archive-outline" size={16} color={C.text3} />
                    <Text style={styles.archiveLabel}>已归档</Text>
                  </View>
                  <View style={styles.topicRight}>
                    <Text style={styles.topicCount}>{archivedCount}</Text>
                    <Ionicons name="chevron-forward" size={16} color={C.text3} />
                  </View>
                </Pressable>
              )}
            </ScrollView>
          ) : (
            <ScrollView contentContainerStyle={styles.content}>
              {groups.length > 1
                ? groups.map(([dir, list]) => (
                    <View key={dir ?? '__none'}>
                      {/* 点这个表头就是给整组改名 / 并到别的方向去 */}
                      <Pressable
                        style={({ pressed }) => [styles.subHead, pressed && dir && { opacity: 0.55 }]}
                        disabled={!dir}
                        onPress={() =>
                          dir
                            ? setSub({
                                preset: { ids: list.map((c) => c.id), name: dir },
                              })
                            : undefined
                        }
                        accessibilityRole={dir ? 'button' : undefined}
                        accessibilityLabel={dir ? `修改方向「${dir}」` : undefined}
                      >
                        <Text style={styles.subName}>{dir ?? '未分方向'}</Text>
                        <Text style={styles.subCount}>{list.length}</Text>
                        {dir ? <Ionicons name="create-outline" size={12} color={C.text3} /> : null}
                      </Pressable>
                      {list.map(renderCard)}
                    </View>
                  ))
                : cards.map(renderCard)}
              {cards.length === 0 && <Text style={styles.hint}>这个主题下还没有卡片。</Text>}
            </ScrollView>
          )}
        </>
      )}

      {sub && active ? (
        <SubtopicSheet
          key={sub.preset ? sub.preset.name : 'all'}
          topic={active}
          preselect={sub.preset?.ids}
          initialName={sub.preset?.name}
          onClose={() => setSub(null)}
          onChanged={refreshAll}
        />
      ) : null}
      {topicOpen ? (
        <TopicSheet
          topics={topics}
          onClose={() => setTopicOpen(false)}
          onChanged={refreshAll}
        />
      ) : null}
      {askOpen ? (
        <AskSheet
          topic={active}
          onClose={() => setAskOpen(false)}
          onOpenCard={(c) => setDetail(c)}
          onChanged={refreshAll}
        />
      ) : null}
      {detailLive ? (
        <KnowledgeDetail
          card={detailLive}
          onClose={() => setDetail(null)}
          onChanged={refreshAll}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.page },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 40 },

  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 11,
    height: 40,
    backgroundColor: C.card,
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: C.hair,
  },
  searchInput: { flex: 1, fontSize: 13.5, color: C.text, paddingVertical: 0 },
  askBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 13,
    height: 40,
    borderRadius: R.btn,
    backgroundColor: C.accentBg,
  },
  askText: { fontSize: 13.5, color: C.accentText, fontWeight: '600' },

  content: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 28 },
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
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.hair,
  },
  topicLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7 },
  topicName: { fontSize: 15.5, color: C.text, fontWeight: '500' },
  topicDirs: { fontSize: 11, color: C.text3 },
  topicRight: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  topicCount: {
    fontSize: 11.5,
    color: C.text2,
    backgroundColor: C.hairSoft,
    borderRadius: R.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 26,
    textAlign: 'center',
    overflow: 'hidden',
    fontVariant: ['tabular-nums'],
  },

  // 主题内的二级方向小节头
  subHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 10,
    paddingBottom: 8,
    paddingHorizontal: 2,
  },
  subName: { fontSize: 12.5, color: C.text2, fontWeight: '600', letterSpacing: 0.2 },
  subCount: {
    fontSize: 10.5,
    color: C.text3,
    backgroundColor: C.hairSoft,
    borderRadius: R.pill,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
    fontVariant: ['tabular-nums'],
  },

  card: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    padding: 16,
    marginBottom: 10,
  },
  cardTopic: { fontSize: 11, color: C.accentText, fontWeight: '600', marginBottom: 6, letterSpacing: 0.3 },
  cardTitle: { fontSize: 16, lineHeight: 24, color: C.text, fontWeight: '600' },
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
