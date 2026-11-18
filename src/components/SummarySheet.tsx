import { BusyIndicator as ActivityIndicator } from './BusyIndicator';
/**
 * 月度总结生成面板。
 *
 * 流程刻意分成三步：选月份 → 生成 → 预览后自己决定存不存。
 * 总结虽然不破坏任何数据，但写进时间轴就是一条长期存在的内容，
 * 让它经一次「保存/丢弃」比事后去删更省事。
 *
 * v0.15 起**只剩月这一档**（用户 2026-11-10 要求删掉日/周）：粒度切换器、
 * 按粒度的配额、以及「日 / 周 / 月」三套文案全部去掉。留下的两条老东西仍然有用：
 *
 * 1. **新旧左右对照。** 重新生成同一个月份时并排摆出旧的那篇，
 *    左边旧右边新、各自标字数 —— 「比上一版短了还是长了、丢没丢信息」
 *    只能靠这个看，靠记忆是靠不住的。
 * 2. **勾选缺口排队生成。** 补几个月的总结要点开面板好几次、等好几次、存好几次。
 *    现在把「还没写的月份」列出来勾选，跑完一篇自动进下一篇，
 *    每篇仍然单独预览、单独确认 —— 批量不等于放手。
 *
 * 覆盖层而非 Modal，安卓返回键自己接 —— 项目红线，见 AGENTS.md。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Fragment, Note } from '../types';
import { AiError, type ChatProgress } from '../ai/chat';
import { summarizePeriod, type SummarizeOutcome } from '../ai/summarize';
import { loadAiConfig } from '../ai/config';
import { repo } from '../db/repo';
import { missingDigests, type MissingDigest } from '../util/digest';
import { periodLabel, periodRange, recentMonths } from '../util/date';
import { R, SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { NoteBody } from './NoteBody';
import { ReasoningStream } from './ReasoningStream';
import { ReasoningTrace } from './ReasoningTrace';
import { ScreenHeader } from './ScreenHeader';

/** 可选月份个数。再多就要横向滑很久，而补总结通常只补最近几个月 */
const RECENT_COUNT = 6;

type Phase = 'pick' | 'running' | 'preview';

/** 正文字数不算空白，跟「篇幅上限」的口径一致 */
const charCount = (md: string) => md.replace(/\s/g, '').length;

interface Props {
  onClose: () => void;
  /** 存进库之后通知上层刷新（时间轴才会立刻出现这条总结） */
  onSaved: () => void | Promise<void>;
  /**
   * 打开设置页（App 的 tab 切换）。
   *
   * 这里必须由外面传进来：面板是覆盖层，自己换不了 tab；只写一句「先去设置页填一个」
   * 等于让用户先关面板再找底栏 —— 项目规则里说的「文案指一个点不到的地方」就是这种。
   */
  onOpenSettings?: () => void;
  /** 从「待补总结」点进来时预选月份 */
  initialPeriod?: string;
}

export function SummarySheet({ onClose, onSaved, initialPeriod, onOpenSettings }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [period, setPeriod] = useState(() => initialPeriod ?? recentMonths(1)[0]);
  const [count, setCount] = useState<number | null>(null);
  /** 同月已存在的小结。不只是 id —— 对照要读它的正文 */
  const [existing, setExisting] = useState<Note | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(true);
  const [phase, setPhase] = useState<Phase>('pick');
  const [draft, setDraft] = useState<SummarizeOutcome | null>(null);
  const [error, setError] = useState('');
  /** 错误是「没配 Key」——这时才给「去设置」按钮，别的错误不给（去了也没用） */
  const [needKey, setNeedKey] = useState(false);
  const [saving, setSaving] = useState(false);

  /** 还没写总结的月份。进面板时算一次，用来勾选批量 */
  const [backlog, setBacklog] = useState<MissingDigest[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 正在跑的队列。空数组 = 单篇模式 */
  const [queue, setQueue] = useState<string[]>([]);
  const [queueAt, setQueueAt] = useState(0);

  const [reasoning, setReasoning] = useState('');
  const [received, setReceived] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [thinkingOn, setThinkingOn] = useState(false);
  const [showTrace, setShowTrace] = useState(false);

  const startedAtRef = useRef(0);
  /** 保存防重入锁（state 更新有延迟，光靠 saving 拦不住同一帧的两次点击） */
  const savingRef = useRef(false);
  /** 流式回调很密，最多 120ms 上屏一次；结束再用最终值兜底 */
  const streamRef = useRef({ lastFlush: 0 });

  const inQueue = queue.length > 0;
  const queueTotal = queue.length;

  // 覆盖层的返回键优先级要高于「回主界面」
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phase === 'running') return true; // 正在生成，别让返回把请求丢掉
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [phase, onClose]);

  // 选中月份就先把材料条数查出来，没内容时不让点「生成」
  useEffect(() => {
    let alive = true;
    setCount(null);
    (async () => {
      const range = periodRange(period);
      if (!range) {
        if (alive) setCount(0);
        return;
      }
      const list = await repo.listFragmentsBetween(range.from, range.to);
      if (alive) setCount(list.length);
    })();
    return () => {
      alive = false;
    };
  }, [period]);

  useEffect(() => {
    if (phase !== 'running') return;
    const timer = setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [phase]);

  /*
   * 这个月是不是已经有总结了。必须精确查 —— 拿 listNotes(200) 再筛，
   * 笔记一多就会漏，于是同一个月又插一条出来。
   *
   * 只在选择阶段查：生成时会在 generateOne 里再查一次，那份才是保存时要用的，
   * 因为队列可能连着换好几个月，这里的 state 跟不上。
   */
  useEffect(() => {
    if (phase !== 'pick') return;
    let alive = true;
    (async () => {
      const hit = await repo.findNote('monthly', period);
      if (!alive) return;
      setExisting(hit);
      setReplaceExisting(true);
    })();
    return () => {
      alive = false;
    };
  }, [phase, period]);

  /*
   * 缺口清单：打开面板时算一次。
   *
   * 原来这里读的是 `listFragments(4000)` —— 一个猜的上限。超过 4000 条之后，
   * 更早的月份会静默消失，用户以为「那几个月没记过」。v0.26 改成问仓库要
   * 每月条数：一条 GROUP BY，跟库多大没关系。
   */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [months, notes] = await Promise.all([
          repo.monthCounts(),
          repo.listNotes(500),
        ]);
        if (!alive) return;
        setBacklog(missingDigests(months, notes, RECENT_COUNT).items);
      } catch {
        /* 缺口算不出来不影响单篇生成 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const handleProgress = useCallback((patch: ChatProgress) => {
    const now = Date.now();
    if (now - streamRef.current.lastFlush < 120) return;
    streamRef.current.lastFlush = now;
    if (patch.reasoning !== undefined) setReasoning(patch.reasoning);
    if (patch.content !== undefined) setReceived(patch.content.length);
  }, []);

  /**
   * 生成一篇。**必须走参数**，不能读 state —— 队列里刚 setPeriod 的那一帧
   * state 还是旧的，用它去查碎片会查到上一个月。
   */
  async function generateOne(target: string) {
    setPeriod(target);
    setError('');
    setNeedKey(false);
    setDraft(null);
    setReasoning('');
    setReceived(0);
    setElapsed(0);
    setShowTrace(false);
    streamRef.current.lastFlush = 0;
    startedAtRef.current = Date.now();
    setPhase('running');

    try {
      const config = await loadAiConfig();
      if (!config.apiKey) {
        setPhase('pick');
        setError('还没配置 API Key，填一个就能生成');
        setNeedKey(true);
        return;
      }
      setThinkingOn(config.thinking);

      const range = periodRange(target);
      if (!range) throw new AiError('format', `无法识别的月份：${target}`);

      const [fragments, todos, hit] = await Promise.all([
        repo.listFragmentsBetween(range.from, range.to),
        repo.listTodos(),
        repo.findNote('monthly', target),
      ]);
      setExisting(hit);
      setReplaceExisting(true);
      // running 页显示的是这个数。队列里连着换月份，不重设就会显示上一篇的
      setCount(fragments.length);

      if (!fragments.length) {
        setPhase('pick');
        setError('这个月里没有碎片，先记点什么再来总结');
        return;
      }

      const outcome = await summarizePeriod({
        period: target,
        fragments: fragments as Fragment[],
        todos,
        config,
        onProgress: handleProgress,
      });
      setReasoning(outcome.reasoning);
      setDraft(outcome);
      setPhase('preview');
    } catch (e) {
      setPhase('pick');
      setError(e instanceof AiError ? e.message : e instanceof Error ? e.message : '生成失败，再试一次');
    }
  }

  /** 队列里下一步。没了就收工 */
  async function advance() {
    const next = queueAt + 1;
    if (next < queueTotal) {
      setQueueAt(next);
      await generateOne(queue[next]);
    } else {
      onClose();
    }
  }

  async function save() {
    // 防重入：连点两下按钮会在同一帧里进两次，saving 的 state 还没更新过来
    if (!draft || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      if (existing && !replaceExisting) {
        // 用户明确要另存一条：绕开 upsert 的按月份覆盖，直接插一行
        await repo.insertNote({ type: 'monthly', title: draft.title, bodyMd: draft.bodyMd, period });
      } else {
        await repo.upsertNote({ type: 'monthly', title: draft.title, bodyMd: draft.bodyMd, period });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      savingRef.current = false;
      setSaving(false);
      return;
    }

    // 内容已经落库。刷新失败不该报成「保存失败」，否则用户会以为没存上又存一次
    try {
      await onSaved();
    } catch {
      /* 刷新交给下次进页面 */
    }
    savingRef.current = false;
    setSaving(false);

    // 队列模式：存完自动进下一篇；单篇模式：直接收起面板
    if (inQueue) {
      // 队列里的这一篇已经从清单消失，避免「保存后还能再点一次」
      setBacklog((prev) => prev.filter((b) => b.period !== period));
      await advance();
    } else {
      onClose();
    }
  }

  /** 队列里跳过这一篇（不保存） */
  async function skip() {
    if (!inQueue) {
      setPhase('pick');
      setDraft(null);
      return;
    }
    await advance();
  }

  function toggleJob(p: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  async function startQueue() {
    const jobs = backlog.filter((b) => selected.has(b.period)).map((b) => b.period);
    if (!jobs.length) return;
    setQueue(jobs);
    setQueueAt(0);
    // 这里刻意不清空 selected：第一篇就失败（比如没配 Key）时会退回 pick，
    // 勾选还在的话可以直接重试，不用从头再勾一遍
    await generateOne(jobs[0]);
  }

  /*
   * 从「待补总结」点进来的月份可能比这 6 个月更早，不在 chip 列表里 ——
   * 那就把它补到最前面。否则面板开着，用户看不到自己点的是哪个月。
   */
  const recent = useMemo(() => recentMonths(RECENT_COUNT), []);
  const periods = recent.includes(period) ? recent : [period, ...recent];
  const canGenerate = count !== null && count > 0 && phase === 'pick';
  const selectedCount = selected.size;

  /** 对照用：旧的那篇有多少字 */
  const oldChars = existing ? charCount(existing.bodyMd) : 0;
  const newChars = draft ? charCount(draft.bodyMd) : 0;

  // 队列进度文案。单篇模式不显示
  const queueTag = inQueue ? `第 ${queueAt + 1} / ${queueTotal} 篇` : '';

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="月度总结"
        subtitle={inQueue && phase !== 'pick' ? queueTag : undefined}
        backIcon="close"
        onBack={phase === "running" || saving ? undefined : onClose}
      />

      {phase === 'running' ? (
        <ScrollView contentContainerStyle={styles.content}>
          <ReasoningStream
            title={`正在整理这个月的 ${count ?? 0} 条碎片…`}
            text={reasoning}
            received={received}
            elapsed={elapsed}
            thinking={thinkingOn}
            height={260}
          />
          {inQueue ? (
            <Text style={styles.queueHint}>
              {queueTag} · 跑完这一篇会先进预览，确认了才写库
            </Text>
          ) : null}
          {/* 这段原来还跟着一句「总结只写进时间轴，不会改动任何碎片」—— 和选择页那句完全重复 */}
        </ScrollView>
      ) : phase === 'preview' && draft ? (
        <>
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.previewMetaRow}>
              <Text style={styles.previewMeta}>
                {periodLabel(period)} ·{' '}
                {draft.used === draft.total
                  ? `${draft.total} 条碎片`
                  : `${draft.total} 条碎片（${draft.used} 条进了上下文）`}
              </Text>
              {inQueue ? <Text style={styles.queueBadge}>{queueTag}</Text> : null}
            </View>

            {/*
              有旧的就并排。左旧右新，各自标字数 —— 先看两个数字差多少，
              再看具体删了什么，比来回切两屏快。
            */}
            {existing ? (
              <>
                <View style={styles.compareHead}>
                  <Text style={styles.compareHint}>左边是原来那篇，右边是这次生成的</Text>
                  <Text
                    style={[
                      styles.compareDelta,
                      newChars < oldChars ? styles.deltaDown : styles.deltaUp,
                    ]}
                  >
                    {newChars === oldChars
                      ? '字数相同'
                      : newChars < oldChars
                        ? `少了 ${oldChars - newChars} 字`
                        : `多了 ${newChars - oldChars} 字`}
                  </Text>
                </View>
                <View style={styles.compareRow}>
                  <View style={[styles.compareCol, styles.compareColOld]}>
                    <Text style={styles.compareLabelOld}>旧 · {oldChars} 字</Text>
                    <NoteBody text={existing.bodyMd} style={styles.compareBody} />
                  </View>
                  <View style={[styles.compareCol, styles.compareColNew]}>
                    <Text style={styles.compareLabelNew}>新 · {newChars} 字</Text>
                    <NoteBody text={draft.bodyMd} style={styles.compareBody} />
                  </View>
                </View>
              </>
            ) : (
              <View style={styles.previewCard}>
                <Text style={styles.previewLabel}>新 · {newChars} 字</Text>
                <NoteBody text={draft.bodyMd} style={styles.previewBody} />
              </View>
            )}

            <ReasoningTrace
              text={draft.reasoning}
              expanded={showTrace}
              onToggle={() => setShowTrace((v) => !v)}
              height={220}
            />

            {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
          </ScrollView>

          {existing ? (
            <Pressable style={[styles.replaceRow, styles.touchTarget]} onPress={() => setReplaceExisting((v) => !v)} accessibilityRole="checkbox" accessibilityLabel="替换这个月原有的月总结" accessibilityState={{ checked: replaceExisting, disabled: saving }} disabled={saving}>
              <View style={[styles.checkBox, replaceExisting && styles.checkBoxOn]}>
                {replaceExisting ? <Ionicons name="checkmark" size={11} color={c.onAccent} /> : null}
              </View>
              <Text style={styles.replaceText}>替换这个月原有的月总结</Text>
            </Pressable>
          ) : null}

          <View style={styles.footer}>
            <Pressable style={[styles.ghostBtn, styles.touchTarget]} onPress={skip} disabled={saving} accessibilityState={{ disabled: saving, busy: saving }}>
              <Text style={styles.ghostText}>{inQueue ? '跳过这篇' : '重新选'}</Text>
            </Pressable>
            <Pressable
              style={[[styles.primaryBtn, saving && styles.btnDisabled], styles.touchTarget]}
              onPress={save}
              disabled={saving} accessibilityState={{ disabled: saving, busy: saving }}
            >
              {saving ? (
                <ActivityIndicator size="small" color={c.onAccent} />
              ) : (
                <Text style={styles.primaryText}>
                  {inQueue && queueAt < queueTotal - 1 ? '保存并继续' : '保存到时间轴'}
                </Text>
              )}
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.hint}>
              把一个月的碎片压成一段。总结只写进时间轴，不改动任何碎片。
            </Text>

            {/*
              缺口清单。勾了就按队列跑，不勾就是下面那个单篇。
              排在前面的说明是最近的月份 —— 补总结通常从最近往回补。
            */}
            {backlog.length > 0 ? (
              <>
                <View style={styles.backlogHead}>
                  <Text style={styles.sectionLabel}>还没写的 {backlog.length} 个月</Text>
                  {selectedCount > 0 ? (
                    <Pressable onPress={() => setSelected(new Set())} style={styles.touchTarget}>
                      <Text style={styles.clearText}>清空</Text>
                    </Pressable>
                  ) : null}
                </View>
                <View style={styles.backlogBox}>
                  {backlog.map((b, i) => {
                    const on = selected.has(b.period);
                    return (
                      <Pressable
                        key={b.period}
                        onPress={() => toggleJob(b.period)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={`为${periodLabel(b.period)}生成月总结`}
                        style={({ pressed }) => [[
                          styles.backlogRow,
                          i === backlog.length - 1 && styles.backlogRowLast,
                          pressed && { backgroundColor: c.hairSoft },
                        ], styles.touchTarget]}
                      >
                        <View style={[styles.checkBox, on && styles.checkBoxOn]}>
                          {on ? <Ionicons name="checkmark" size={11} color={c.onAccent} /> : null}
                        </View>
                        <Text style={styles.backlogLabel} numberOfLines={1}>
                          {periodLabel(b.period)}
                        </Text>
                        <Text style={styles.backlogCount}>{b.count} 条</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={styles.backlogNote}>
                  勾选后依次生成，每篇仍然单独确认。
                </Text>
              </>
            ) : (
              <Text style={styles.noneNote}>
                所有有碎片的月份都写过总结了。
              </Text>
            )}

            <Text style={styles.sectionLabel}>或者选一个月份</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
            >
              {periods.map((p) => (
                <Pressable
                  key={p}
                  onPress={() => {
                    setPeriod(p);
                    // 单选月份就等于放弃批量，否则按钮文案和实际行为会对不上
                    setSelected(new Set());
                  }}
                  style={[[styles.chip, period === p && styles.chipOn], styles.touchTarget]} accessibilityRole="radio" accessibilityState={{ checked: period === p, selected: period === p }}
                >
                  <Text style={[styles.chipText, period === p && styles.chipTextOn]}>
                    {period === p ? '✓ ' : ''}{periodLabel(p)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <View style={styles.countCard}>
              {count === null ? (
                <ActivityIndicator size="small" color={c.accent} />
              ) : count === 0 ? (
                <Text style={styles.countEmpty}>这个月里还没有碎片</Text>
              ) : (
                <Text style={styles.countText}>
                  这个月共 <Text style={styles.countNum}>{count}</Text> 条碎片
                </Text>
              )}
              {existing ? (
                <Text style={styles.countWarn}>
                  这个月已经有一份月总结（{oldChars} 字），生成后可以左右对照
                </Text>
              ) : null}
            </View>

            {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
            {needKey && onOpenSettings ? (
              <Pressable
                style={[[styles.errorBtn], styles.touchTarget]}
                onPress={() => {
                  // 先关面板再换 tab：App 是按 route 条件渲染的，不关的话回来时面板还开着
                  onClose();
                  onOpenSettings();
                }}
                accessibilityRole="button"
                accessibilityLabel="去设置填 API Key"
              >
                <Ionicons name="settings-outline" size={14} color={c.accentText} />
                <Text style={styles.errorBtnText}>去设置填 Key</Text>
              </Pressable>
            ) : null}
          </ScrollView>

          <View style={styles.footer}>
            <View style={styles.footerSpacer} />
            <Pressable
              style={[[
                styles.primaryBtn,
                // 勾了批量就一定能点（哪怕当前月份没碎片）；单篇才看 canGenerate
                selectedCount === 0 && !canGenerate && styles.btnDisabled,
              ], styles.touchTarget]}
              onPress={selectedCount > 0 ? startQueue : () => generateOne(period)}
              disabled={selectedCount === 0 && !canGenerate}
            >
              <Text style={styles.primaryText}>
                {selectedCount > 0 ? `生成这 ${selectedCount} 篇` : '生成总结'}
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

/**
 * 样式全部走共享 token。
 *
 * 这份文件曾经是唯一的例外：字号写死 11 / 12 / 12.5 / 13 / 14 / 15，
 * 边框宽度用 `metrics.strokeWidth`（默认主题下是 surfaceStroke 的两倍粗），
 * 内边距写死 16 / 18 / 20。结果是同一屏里 12.5 和 13 混排、卡片描边比别处深一倍。
 * `12.5` 还会在部分安卓机器上被取整成 12 或 13，行高跟着错位。
 */
const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  touchTarget: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight },
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.page },

  content: { paddingHorizontal: metrics.pagePadding, paddingBottom: SPACE.xl },

  hint: { ...TYPE.meta, color: c.text3, marginTop: SPACE.xxs },
  queueHint: { ...TYPE.meta, color: c.accentText, marginTop: SPACE.sm },
  sectionLabel: { ...TYPE.meta, color: c.text3 },
  noneNote: { ...TYPE.meta, color: c.text3, marginTop: SPACE.lg },

  backlogHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SPACE.lg,
    marginBottom: SPACE.xs,
  },
  clearText: { ...TYPE.meta, color: c.accent },
  /** 缺口清单：白卡浮在浅灰页上就够分层，不描边 */
  backlogBox: {
    backgroundColor: c.card,
    borderRadius: metrics.cardRadius,
    overflow: 'hidden',
  },
  backlogRow: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.xs,
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.xs,
    borderBottomWidth: surfaceStroke(metrics),
    borderBottomColor: c.hair,
  },
  backlogRowLast: { borderBottomWidth: 0 },
  backlogLabel: { flex: 1, ...TYPE.label, fontWeight: '400', color: c.text },
  backlogCount: { ...TYPE.meta, color: c.text3, fontVariant: ['tabular-nums'] },
  backlogNote: { ...TYPE.meta, color: c.text3, marginTop: SPACE.xs },

  chipRow: { gap: SPACE.xs, paddingRight: metrics.pagePadding, paddingTop: SPACE.xs },
  /** 月份胶囊：浅灰底、无边框，和设置页的选项同一套 */
  chip: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    paddingHorizontal: SPACE.sm,
    justifyContent: 'center',
    borderRadius: R.pill,
    backgroundColor: c.hairSoft,
  },
  chipOn: { backgroundColor: c.accentBg },
  chipText: { ...TYPE.meta, color: c.text2, fontVariant: ['tabular-nums'] },
  chipTextOn: { color: c.accentText, fontWeight: '600' },

  countCard: {
    marginTop: SPACE.md,
    padding: SPACE.sm,
    borderRadius: metrics.cardRadius,
    backgroundColor: c.card,
    alignItems: 'center',
  },
  countText: { ...TYPE.label, fontWeight: '400', color: c.text2 },
  countNum: { ...TYPE.body, color: c.text, fontWeight: '600' },
  countEmpty: { ...TYPE.label, fontWeight: '400', color: c.text3 },
  countWarn: { ...TYPE.meta, color: c.text3, marginTop: SPACE.xxs, textAlign: 'center' },

  replaceRow: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.xs,
    paddingHorizontal: metrics.pagePadding,
    paddingTop: SPACE.xs,
  },
  /** 复选框：4 的圆角才读成「方框」，原来 16×16 配 8 的圆角是圆形 */
  checkBox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: metrics.strokeWidth,
    borderColor: c.text3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxOn: { backgroundColor: c.accent, borderColor: c.accent },
  replaceText: { ...TYPE.meta, color: c.text2 },

  error: { ...TYPE.meta, color: c.danger, marginTop: SPACE.sm },
  /** 「去设置填 Key」：和错误文案同一块，紧跟在它下面 */
  errorBtn: {
    alignSelf: 'flex-start', marginTop: SPACE.xs,
    minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs,
    backgroundColor: c.accentBg, borderRadius: 999, paddingHorizontal: SPACE.sm,
  },
  errorBtnText: { ...TYPE.label, color: c.accentText },

  previewMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACE.xs,
  },
  previewMeta: { ...TYPE.meta, color: c.text3 },
  queueBadge: {
    ...TYPE.caption,
    color: c.accentText,
    backgroundColor: c.accentBg,
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: R.pill,
    overflow: 'hidden',
  },

  previewCard: {
    backgroundColor: c.card,
    borderRadius: metrics.cardRadius,
    padding: SPACE.md,
    marginTop: SPACE.xxs,
  },
  previewLabel: { ...TYPE.meta, color: c.text3, marginBottom: SPACE.xs },
  previewBody: { ...TYPE.compact },

  compareHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACE.xs,
  },
  compareHint: { ...TYPE.meta, color: c.text3 },
  compareDelta: { ...TYPE.meta, fontWeight: '600', fontVariant: ['tabular-nums'] },
  /** 少了字用中性灰（不是「坏消息」），多了字用琥珀（值得看一眼） */
  deltaDown: { color: c.text2 },
  deltaUp: { color: c.amberText },

  compareRow: { flexDirection: 'row', gap: SPACE.xs, alignItems: 'flex-start' },
  /** 双栏对照靠底色分左右：旧=浅灰、新=白，不画边框 */
  compareCol: {
    flex: 1,
    borderRadius: metrics.cardRadius,
    padding: SPACE.xs,
  },
  compareColOld: { backgroundColor: c.hairSoft },
  compareColNew: { backgroundColor: c.card },
  compareLabelOld: { ...TYPE.caption, fontWeight: '400', color: c.text3, marginBottom: SPACE.xs },
  compareLabelNew: { ...TYPE.caption, color: c.accentText, marginBottom: SPACE.xs },
  /** 双栏并排，只能给 meta。原来 12.5 是半个像素的字号，安卓上会取整 */
  compareBody: { ...TYPE.meta },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: SPACE.xs,
    paddingHorizontal: metrics.pagePadding,
    paddingTop: SPACE.xs,
    paddingBottom: SPACE.md,
    borderTopWidth: surfaceStroke(metrics),
    borderTopColor: c.hair,
    backgroundColor: c.page,
  },
  footerSpacer: { flex: 1 },
  primaryBtn: { minHeight: metrics.controlHeight,
    backgroundColor: c.accent,
    borderRadius: metrics.buttonRadius,
    paddingHorizontal: SPACE.lg,
    paddingVertical: SPACE.xs,
    minWidth: 132,
    alignItems: 'center',
  },
  primaryText: { ...TYPE.label, color: c.onAccent },
  ghostBtn: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    borderRadius: metrics.buttonRadius,
    paddingHorizontal: SPACE.md,
    backgroundColor: c.hairSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostText: { ...TYPE.label, fontWeight: '400', color: c.text2 },
  btnDisabled: { opacity: 0.4 },
});
