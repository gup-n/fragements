/**
 * 批量工作流（v0.28）。
 *
 * 用户 2026-11-18 的原话是「批量处理」，但设计稿里定的是**一篇篇过**：
 * 一次勾十篇、AI 一口气生成十篇直接入库 —— 那不叫批量，那叫把十次决定
 * 打包成一次不可撤销的操作。所以这里的形状是：一次只推进一篇，
 * 每一篇都要用户点「存为新文档」或「放弃」。
 *
 * 推进逻辑只有一个入口：`plan` 一变、又没有待审的提案，就再拿下一篇。
 * 这样「生成失败」「用户跳过」「用户存了」三种情况走的是同一条路，
 * 不会出现某一种之后卡住不动。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { DocProposal, Document, ProposalKind } from '../types';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { BusyIndicator as ActivityIndicator } from '../components/BusyIndicator';
import { ScreenHeader } from '../components/ScreenHeader';
import { ProposalSheet, type ProposalDecision } from './ProposalSheet';
import { repo } from '../db/repo';
import { proposeRewrite, proposeTags } from '../documents/proposals';
import {
  batchProgress, batchSummary, nextBatchItem, patchBatchItem, planBatch,
  type BatchState, type BatchPlan,
} from '../util/docBatch';

interface Props {
  docs: { id: number; name: string }[];
  onClose: () => void;
  /** 每存下一篇都要让外面的列表重读一次 */
  onChanged: () => void;
}

const STATE_LABEL: Record<BatchState, string> = {
  pending: '排队中',
  running: '正在生成…',
  review: '等你决定',
  done: '已存为新文档',
  skipped: '跳过',
  failed: '失败',
};

export function BatchSheet({ docs, onClose, onChanged }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  /*
   * 先选做什么，再开始跑。
   *
   * 两个动作对模型的要求完全不同（一个重写正文、一个只挑标签），
   * 合成一个按钮之后再让用户在里面选，等于多一次点击；而直接猜一个更糟 ——
   * 猜错就要把已经花掉的十次调用扔掉。
   */
  const [kind, setKind] = useState<ProposalKind | null>(null);
  const [plan, setPlan] = useState<BatchPlan | null>(null);
  const [proposal, setProposal] = useState<DocProposal | null>(null);
  const [original, setOriginal] = useState<Document | null>(null);
  const [error, setError] = useState('');
  /** 正在生成的那一篇。用 ref：它是「别重复发请求」的锁，不该触发渲染 */
  const running = useRef<number | null>(null);
  const alive = useRef(true);
  /** 最新一版进度。`advance` 里不能读 state —— 它拿到的是渲染那一刻的旧值 */
  const planRef = useRef<BatchPlan | null>(plan);
  planRef.current = plan;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const advance = useCallback(async (currentKind: ProposalKind) => {
    const current = planRef.current;
    if (!current) return;
    const item = nextBatchItem(current);
    if (!item || running.current !== null) return;
    running.current = item.documentId;
    setError('');
    setPlan((prev) => (prev ? patchBatchItem(prev, item.documentId, { state: 'running' }) : prev));

    try {
      const doc = await repo.findDocument(item.documentId);
      if (!alive.current) return;
      if (!doc) throw new Error('这篇已经不在了');
      // 改一版必须有正文；没有就安静跳过 —— 这不是失败，没什么可修的
      if (currentKind !== 'tag' && !doc.bodyMd.trim()) {
        setPlan((prev) => (prev ? patchBatchItem(prev, item.documentId, { state: 'skipped', note: '还没有正文' }) : prev));
        return;
      }
      const next = currentKind === 'tag'
        ? await proposeTags(item.documentId)
        : await proposeRewrite(item.documentId, 'polish');
      if (!alive.current) return;
      setOriginal(doc);
      setProposal(next);
      setPlan((prev) => (prev ? patchBatchItem(prev, item.documentId, { state: 'review', proposalId: next.id }) : prev));
    } catch (e) {
      if (!alive.current) return;
      const text = e instanceof Error ? e.message : '生成失败';
      setError(text);
      setPlan((prev) => (prev ? patchBatchItem(prev, item.documentId, { state: 'failed', note: text }) : prev));
    } finally {
      running.current = null;
    }
  }, []);

  /*
   * 唯一的推进点。
   *
   * 条件三条：没有待审提案、还有排队中的、没有正在跑的那一篇。
   * `plan` 在依赖里是必须的 —— 每次有人被跳过/失败/存下，都要重新算一次下一篇。
   */
  useEffect(() => {
    if (!kind || !plan) return;
    if (proposal) return;
    if (running.current !== null) return;
    if (!plan.items.some((item) => item.state === 'pending')) return;
    void advance(kind);
  }, [advance, kind, plan, proposal]);

  const decide = useCallback((decision: ProposalDecision) => {
    const item = planRef.current?.items.find((x) => x.state === 'review');
    if (item) {
      const note =
        decision.kind === 'saved'
          ? decision.docId ? `新文档 #${decision.docId}` : '只挂了标签'
          : decision.kind === 'rejected' ? '已放弃' : '先放着';
      setPlan((prev) => (prev ? patchBatchItem(prev, item.documentId, { state: 'skipped', note }) : prev));
      if (decision.kind === 'saved') onChanged();
    }
    setProposal(null);
    setOriginal(null);
  }, [onChanged]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [onClose]);

  if (proposal) return <ProposalSheet proposal={proposal} original={original} onDone={decide} />;

  if (!kind || !plan) {
    return (
      <View style={styles.root} accessibilityViewIsModal>
        <ScreenHeader title="批量处理" subtitle={`${docs.length} 篇`} backIcon="close" backLabel="关闭" onBack={onClose} />
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.summary}>选一件事，然后一篇篇过。每篇都要你点一下才会存。</Text>
          <Pressable
            style={({ pressed }) => [styles.choice, pressed && { opacity: 0.8 }]}
            onPress={() => { setPlan(planBatch('optimize', docs)); setKind('optimize'); }}
            accessibilityRole="button"
            accessibilityLabel="批量整理：每篇重写一版正文"
          >
            <Ionicons name="sparkles-outline" size={20} color={c.accentText} />
            <View style={styles.choiceBody}>
              <Text style={styles.choiceTitle}>整理正文</Text>
              <Text style={styles.choiceHint}>每篇出一版更好的正文，存成新文档；原稿不动。没有正文的会跳过。</Text>
            </View>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.choice, pressed && { opacity: 0.8 }]}
            onPress={() => { setPlan(planBatch('tag', docs)); setKind('tag'); }}
            accessibilityRole="button"
            accessibilityLabel="批量打标签：每篇建议一组标签"
          >
            <Ionicons name="pricetags-outline" size={20} color={c.accentText} />
            <View style={styles.choiceBody}>
              <Text style={styles.choiceTitle}>打标签</Text>
              <Text style={styles.choiceHint}>每篇建议一组标签，只动标签，不改正文。</Text>
            </View>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  const progress = batchProgress(plan);
  const done = !progress.open;

  return (
    <View style={styles.root} accessibilityViewIsModal>
      <ScreenHeader
        title={kind === 'tag' ? '批量打标签' : '批量整理'}
        subtitle={`${progress.done} / ${progress.total}`}
        backIcon="close"
        backLabel="关闭批量处理"
        onBack={onClose}
      />

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` },
            ]}
          />
        </View>
        <Text style={styles.summary} accessibilityLiveRegion="polite">
          {done
            ? `这一批走完了：${batchSummary(plan)}`
            : `还剩 ${progress.total - progress.done} 篇。一次决定一篇，放弃不会改任何东西。`}
        </Text>
        {error ? <Text style={styles.error}>{error}（这一篇跳过了，可以稍后单独重试）</Text> : null}

        <View style={styles.card}>
          {plan.items.map((item, index) => (
            <View key={item.documentId} style={[styles.row, index > 0 && styles.rowLine]}>
              <StateIcon
                state={item.state}
                color={
                  item.state === 'done' ? c.tealText
                    : item.state === 'failed' ? c.danger
                      : item.state === 'running' ? c.accent
                        : c.text3
                }
              />
              <View style={styles.rowBody}>
                <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
                <Text style={styles.rowState}>
                  {STATE_LABEL[item.state]}
                  {item.note ? ` · ${item.note}` : ''}
                </Text>
              </View>
            </View>
          ))}
        </View>

        {!done ? (
          <Text style={styles.hint}>
            关掉这一页不会撤销已经存下的文档 —— 它们已经各自是一篇新文档了。
          </Text>
        ) : null}
      </ScrollView>

      {done ? (
        <View style={styles.footer}>
          <Pressable
            style={({ pressed }) => [styles.primary, pressed && { opacity: 0.85 }]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="完成，回到文档列表"
          >
            <Text style={styles.primaryText}>完成</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function StateIcon({ state, color }: { state: BatchState; color: string }) {
  if (state === 'running') return <ActivityIndicator size="small" color={color} />;
  const name =
    state === 'done' ? 'checkmark-circle'
      : state === 'failed' ? 'alert-circle'
        : state === 'skipped' ? 'remove-circle-outline'
          : state === 'review' ? 'hourglass-outline'
            : 'ellipse-outline';
  return <Ionicons name={name} size={18} color={color} />;
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.page },
  content: { paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.md, gap: SPACE.sm },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: c.hairSoft, overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: c.accent },
  summary: { ...TYPE.compact, color: c.text2 },
  error: { ...TYPE.compact, color: c.danger },
  card: { backgroundColor: c.card, borderRadius: metrics.cardRadius, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, minHeight: 52 },
  rowLine: { borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: { ...TYPE.compact, color: c.text },
  rowState: { marginTop: 2, ...TYPE.meta, color: c.text2 },
  hint: { ...TYPE.meta, color: c.text2 },
  choice: {
    flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm, padding: SPACE.md,
    borderRadius: metrics.cardRadius, backgroundColor: c.card, minHeight: 72,
  },
  choiceBody: { flex: 1, minWidth: 0 },
  choiceTitle: { ...TYPE.title, color: c.text },
  choiceHint: { marginTop: SPACE.xxs, ...TYPE.compact, color: c.text2 },
  footer: { paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.sm },
  primary: {
    minHeight: metrics.controlHeight, borderRadius: metrics.buttonRadius, backgroundColor: c.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  primaryText: { ...TYPE.body, color: c.onAccent, fontWeight: '600' },
});
