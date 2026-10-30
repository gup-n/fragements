/**
 * 周期小结生成面板（日 / 周 / 月）。
 *
 * 流程刻意分成三步：选周期 → 生成 → 预览后自己决定存不存。
 * 总结虽然不破坏任何数据，但写进时间轴就是一条长期存在的内容，
 * 让它经一次「保存/丢弃」比事后去删更省事。
 *
 * v0.8.3 加了两个东西，都来自实际用起来的痛点：
 *
 * 1. **新旧左右对照。** 以前重新生成一个周期，只能看到新的那篇，
 *    旧的那篇是死是活不知道 —— 「比上一版短了还是长了、丢没丢信息」
 *    只能靠记忆。现在有旧的就并排摆出来，左边旧右边新，各自标字数。
 *
 * 2. **勾选缺口排队生成。** 以前一次只能选一个周期。补一周的日小结要
 *    点开面板七次、等七次、存七次。现在把「还没写的周期」列出来勾选，
 *    跑完一篇自动进下一篇，每篇仍然单独预览、单独确认 ——
 *    批量不等于放手，存不存还是逐篇决定的。
 *
 * 覆盖层而非 Modal，安卓返回键自己接 —— 项目红线，见 AGENTS.md。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { DigestKind, Fragment, Note } from '../types';
import { AiError, type ChatProgress } from '../ai/chat';
import { summarizePeriod, type SummarizeOutcome } from '../ai/summarize';
import { loadAiConfig } from '../ai/config';
import { repo } from '../db/repo';
import { missingDigests, type MissingDigest } from '../util/digest';
import { periodLabel, periodRange, recentPeriods } from '../util/date';
import { R, useThemedStyles, type Palette } from '../theme';
import { NoteBody } from './NoteBody';
import { ReasoningStream } from './ReasoningStream';
import { ReasoningTrace } from './ReasoningTrace';
import { ScreenHeader } from './ScreenHeader';

const KINDS: { key: DigestKind; label: string; count: number; hint: string }[] = [
  { key: 'daily', label: '日', count: 14, hint: '把一天里记的东西压成一段' },
  { key: 'weekly', label: '周', count: 8, hint: '看这一周的几条主线' },
  { key: 'monthly', label: '月', count: 6, hint: '一个月里发生了什么、留下了什么' },
];

const KIND_NAME: Record<DigestKind, string> = { daily: '日小结', weekly: '周总结', monthly: '月总结' };
const KIND_SHORT: Record<DigestKind, string> = { daily: '日', weekly: '周', monthly: '月' };

type Phase = 'pick' | 'running' | 'preview';

/** 一篇待生成的小结。队列里放的就是这个 */
interface Job {
  kind: DigestKind;
  period: string;
}

const jobKey = (k: DigestKind, p: string) => `${k}|${p}`;
/** 正文字数不算空白，跟「篇幅上限」的口径一致 */
const charCount = (md: string) => md.replace(/\s/g, '').length;

interface Props {
  onClose: () => void;
  /** 存进库之后通知上层刷新（时间轴才会立刻出现这条总结） */
  onSaved: () => void | Promise<void>;
  /** 从「待补小结」点进来时预选粒度与周期 */
  initialKind?: DigestKind;
  initialPeriod?: string;
}

export function SummarySheet({ onClose, onSaved, initialKind, initialPeriod }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [kind, setKind] = useState<DigestKind>(initialKind ?? 'daily');
  const [period, setPeriod] = useState(
    () => initialPeriod ?? recentPeriods(initialKind ?? 'daily', 1)[0],
  );
  const [count, setCount] = useState<number | null>(null);
  /** 同周期已存在的小结。不只是 id —— 对照要读它的正文 */
  const [existing, setExisting] = useState<Note | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(true);
  const [phase, setPhase] = useState<Phase>('pick');
  const [draft, setDraft] = useState<SummarizeOutcome | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  /** 还没写小结的周期。进面板时算一次，用来勾选批量 */
  const [backlog, setBacklog] = useState<MissingDigest[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 正在跑的队列。空数组 = 单篇模式 */
  const [queue, setQueue] = useState<Job[]>([]);
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

  // 选中周期就先把材料条数查出来，没内容时不让点「生成」
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
   * 这个周期是不是已经有小结了。必须精确查 —— 拿 listNotes(200) 再筛，
   * 笔记一多就会漏，于是同一天又插一条出来（这就是「生成两次小结」的来源）。
   *
   * 只在选择阶段查：生成时会在 generateOne 里再查一次，那份才是保存时要用的，
   * 因为队列可能连着换好几个周期，这里的 state 跟不上。
   */
  useEffect(() => {
    if (phase !== 'pick') return;
    let alive = true;
    (async () => {
      const hit = await repo.findNote(kind, period);
      if (!alive) return;
      setExisting(hit);
      setReplaceExisting(true);
    })();
    return () => {
      alive = false;
    };
  }, [phase, period, kind]);

  // 缺口清单：打开面板时算一次。碎片上限给得宽，是因为它要覆盖所有历史周期，
  // 而这里只做一次全表扫描，几百毫秒就能出结果。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [all, notes] = await Promise.all([
          repo.listFragments(4000),
          repo.listNotes(500),
        ]);
        if (!alive) return;
        setBacklog(missingDigests(all, notes, 12).items);
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

  /** 切粒度：同时把周期重置成该粒度的最近一个 */
  function pickKind(k: DigestKind) {
    setKind(k);
    setPeriod(recentPeriods(k, 1)[0]);
    setError('');
  }

  /**
   * 生成一篇。**必须走参数**，不能读 state —— 队列里刚 setKind 的那一帧
   * state 还是旧的，用它去查碎片会查到上一个周期。
   */
  async function generateOne(job: Job) {
    setKind(job.kind);
    setPeriod(job.period);
    setError('');
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
        setError('还没配置 API Key，先去设置页填一个');
        return;
      }
      setThinkingOn(config.thinking);

      const range = periodRange(job.period);
      if (!range) throw new AiError('format', `无法识别的周期：${job.period}`);

      const [fragments, todos, hit] = await Promise.all([
        repo.listFragmentsBetween(range.from, range.to),
        repo.listTodos(),
        repo.findNote(job.kind, job.period),
      ]);
      setExisting(hit);
      setReplaceExisting(true);
      // running 页显示的是这个数。队列里连着换周期，不重设就会显示上一篇的
      setCount(fragments.length);

      if (!fragments.length) {
        setPhase('pick');
        setError('这个周期里没有碎片，先记点什么再来总结');
        return;
      }

      const outcome = await summarizePeriod({
        kind: job.kind,
        period: job.period,
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
        // 用户明确要另存一条：绕开 upsert 的按周期覆盖，直接插一行
        await repo.insertNote({ type: kind, title: draft.title, bodyMd: draft.bodyMd, period });
      } else {
        await repo.upsertNote({ type: kind, title: draft.title, bodyMd: draft.bodyMd, period });
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
      setBacklog((prev) => prev.filter((b) => jobKey(b.kind, b.period) !== jobKey(kind, period)));
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

  function toggleJob(k: DigestKind, p: string) {
    const key = jobKey(k, p);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function startQueue() {
    const jobs = backlog
      .filter((b) => selected.has(jobKey(b.kind, b.period)))
      .map((b) => ({ kind: b.kind, period: b.period }));
    if (!jobs.length) return;
    setQueue(jobs);
    setQueueAt(0);
    // 这里刻意不清空 selected：第一篇就失败（比如没配 Key）时会退回 pick，
    // 勾选还在的话可以直接重试，不用从头再勾一遍
    await generateOne(jobs[0]);
  }

  const kindMeta = KINDS.find((k) => k.key === kind) ?? KINDS[0];
  // 从待补列表进来时，选中的周期可能不在这批「最近 N 个」里，补到最前面
  const recent = recentPeriods(kind, kindMeta.count);
  const periods = recent.includes(period) ? recent : [period, ...recent];
  const canGenerate = count !== null && count > 0 && phase === 'pick';
  const selectedCount = selected.size;

  /** 对照用：旧的那篇有多少字 */
  const oldChars = existing ? charCount(existing.bodyMd) : 0;
  const newChars = draft ? charCount(draft.bodyMd) : 0;

  // 队列进度文案。单篇模式不显示
  const queueTag = useMemo(() => {
    if (!inQueue) return '';
    return `第 ${queueAt + 1} / ${queueTotal} 篇`;
  }, [inQueue, queueAt, queueTotal]);

  return (
    <View style={styles.root}>
      <ScreenHeader
        title={KIND_NAME[kind]}
        subtitle={inQueue && phase !== 'pick' ? queueTag : undefined}
        backIcon="close"
        onBack={onClose}
      />

      {phase === 'running' ? (
        <ScrollView contentContainerStyle={styles.content}>
          <ReasoningStream
            title={`正在整理${kindMeta.label === '日' ? '这一天' : kindMeta.label === '周' ? '这一周' : '这个月'}的 ${count ?? 0} 条碎片…`}
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
          <Text style={styles.hint}>
            总结只会写进时间轴，不会改动任何碎片。生成完可以先看一遍，再决定存不存。
          </Text>
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

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>

          {existing ? (
            <Pressable style={styles.replaceRow} onPress={() => setReplaceExisting((v) => !v)}>
              <View style={[styles.checkBox, replaceExisting && styles.checkBoxOn]}>
                {replaceExisting ? <Ionicons name="checkmark" size={11} color={c.onAccent} /> : null}
              </View>
              <Text style={styles.replaceText}>替换这个周期原有的{KIND_NAME[kind]}</Text>
            </Pressable>
          ) : null}

          <View style={styles.footer}>
            <Pressable style={styles.ghostBtn} onPress={skip} disabled={saving}>
              <Text style={styles.ghostText}>{inQueue ? '跳过这篇' : '重新选'}</Text>
            </Pressable>
            <Pressable
              style={[styles.primaryBtn, saving && styles.btnDisabled]}
              onPress={save}
              disabled={saving}
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
            <View style={styles.segment}>
              {KINDS.map((k) => (
                <Pressable
                  key={k.key}
                  onPress={() => pickKind(k.key)}
                  style={[styles.segItem, kind === k.key && styles.segItemOn]}
                >
                  <Text style={[styles.segText, kind === k.key && styles.segTextOn]}>{k.label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.hint}>{kindMeta.hint}</Text>

            {/*
              缺口清单。勾了就按队列跑，不勾就是下面那个单篇。
              排在前面的说明是最近的周期 —— 补小结通常从最近往回补。
            */}
            {backlog.length > 0 ? (
              <>
                <View style={styles.backlogHead}>
                  <Text style={styles.sectionLabel}>还没写的 {backlog.length} 个周期</Text>
                  {selectedCount > 0 ? (
                    <Pressable onPress={() => setSelected(new Set())} hitSlop={8}>
                      <Text style={styles.clearText}>清空</Text>
                    </Pressable>
                  ) : null}
                </View>
                <View style={styles.backlogBox}>
                  {backlog.map((b, i) => {
                    const on = selected.has(jobKey(b.kind, b.period));
                    return (
                      <Pressable
                        key={jobKey(b.kind, b.period)}
                        onPress={() => toggleJob(b.kind, b.period)}
                        style={({ pressed }) => [
                          styles.backlogRow,
                          i === backlog.length - 1 && styles.backlogRowLast,
                          pressed && { backgroundColor: c.hairSoft },
                        ]}
                      >
                        <View style={[styles.checkBox, on && styles.checkBoxOn]}>
                          {on ? <Ionicons name="checkmark" size={11} color={c.onAccent} /> : null}
                        </View>
                        <Text style={styles.backlogKind}>{KIND_SHORT[b.kind]}</Text>
                        <Text style={styles.backlogLabel} numberOfLines={1}>
                          {periodLabel(b.period)}
                        </Text>
                        <Text style={styles.backlogCount}>{b.count} 条</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={styles.backlogNote}>
                  勾选后依次生成，每篇仍然单独预览、单独确认。中途关掉不会丢已经存下的。
                </Text>
              </>
            ) : null}

            <Text style={styles.sectionLabel}>或者选一个周期</Text>
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
                    // 单选周期就等于放弃批量，否则按钮文案和实际行为会对不上
                    setSelected(new Set());
                  }}
                  style={[styles.chip, period === p && styles.chipOn]}
                >
                  <Text style={[styles.chipText, period === p && styles.chipTextOn]}>
                    {periodLabel(p)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <View style={styles.countCard}>
              {count === null ? (
                <ActivityIndicator size="small" color={c.accent} />
              ) : count === 0 ? (
                <Text style={styles.countEmpty}>这个周期里还没有碎片</Text>
              ) : (
                <Text style={styles.countText}>
                  这个周期共 <Text style={styles.countNum}>{count}</Text> 条碎片
                  {kind !== 'daily' ? '，会一起读' : ''}
                </Text>
              )}
              {existing ? (
                <Text style={styles.countWarn}>
                  这个周期已经有一份{KIND_NAME[kind]}（{oldChars} 字），生成后可以左右对照
                </Text>
              ) : null}
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>

          <View style={styles.footer}>
            <View style={styles.footerSpacer} />
            <Pressable
              style={[
                styles.primaryBtn,
                // 勾了批量就一定能点（哪怕当前周期没碎片）；单篇才看 canGenerate
                selectedCount === 0 && !canGenerate && styles.btnDisabled,
              ]}
              onPress={selectedCount > 0 ? startQueue : () => generateOne({ kind, period })}
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

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.page },

  content: { paddingHorizontal: 16, paddingBottom: 24 },

  segment: {
    flexDirection: 'row',
    backgroundColor: c.hairSoft,
    borderRadius: R.btn,
    padding: 3,
    marginTop: 4,
  },
  segItem: { flex: 1, paddingVertical: 8, borderRadius: R.btn - 1, alignItems: 'center' },
  segItemOn: { backgroundColor: c.card },
  segText: { fontSize: 13, color: c.text2 },
  segTextOn: { color: c.text, fontWeight: '600' },

  hint: { fontSize: 12, color: c.text3, lineHeight: 19, marginTop: 10 },
  queueHint: { fontSize: 12, color: c.accentText, marginTop: 12 },
  sectionLabel: { fontSize: 12, color: c.text3 },

  backlogHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 20,
    marginBottom: 8,
  },
  clearText: { fontSize: 12, color: c.accent },
  backlogBox: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    overflow: 'hidden',
  },
  backlogRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  backlogRowLast: { borderBottomWidth: 0 },
  backlogKind: { fontSize: 11, color: c.accentText, fontWeight: '600', width: 14 },
  backlogLabel: { flex: 1, fontSize: 13, color: c.text },
  backlogCount: { fontSize: 11, color: c.text3, fontVariant: ['tabular-nums'] },
  backlogNote: { fontSize: 11, color: c.text3, lineHeight: 18, marginTop: 8 },

  chipRow: { gap: 8, paddingRight: 16, paddingTop: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: R.pill,
    borderWidth: 0.5,
    borderColor: c.hair,
    backgroundColor: c.card,
  },
  chipOn: { backgroundColor: c.accentBg, borderColor: c.accentBg },
  chipText: { fontSize: 12, color: c.text2, fontVariant: ['tabular-nums'] },
  chipTextOn: { color: c.accentText, fontWeight: '500' },

  countCard: {
    marginTop: 18,
    padding: 14,
    borderRadius: R.card,
    backgroundColor: c.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    alignItems: 'center',
  },
  countText: { fontSize: 13, color: c.text2 },
  countNum: { fontSize: 15, color: c.text, fontWeight: '600' },
  countEmpty: { fontSize: 13, color: c.text3 },
  countWarn: { fontSize: 11, color: c.text3, marginTop: 8, textAlign: 'center', lineHeight: 17 },

  replaceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  checkBox: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.text3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxOn: { backgroundColor: c.accent, borderColor: c.accent },
  replaceText: { fontSize: 12, color: c.text2 },

  error: { fontSize: 12, color: c.danger, lineHeight: 19, marginTop: 14 },

  previewMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  previewMeta: { fontSize: 11, color: c.text3 },
  queueBadge: {
    fontSize: 10.5,
    color: c.accentText,
    backgroundColor: c.accentBg,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: R.pill,
    overflow: 'hidden',
  },

  previewCard: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    padding: 16,
    marginTop: 4,
  },
  previewLabel: { fontSize: 11, color: c.text3, marginBottom: 10 },
  previewBody: { fontSize: 14, lineHeight: 24 },

  compareHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  compareHint: { fontSize: 11, color: c.text3 },
  compareDelta: { fontSize: 11, fontWeight: '600', fontVariant: ['tabular-nums'] },
  deltaDown: { color: c.tealText },
  deltaUp: { color: c.amberText },

  compareRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  compareCol: {
    flex: 1,
    borderRadius: R.card,
    borderWidth: 0.5,
    padding: 10,
  },
  compareColOld: { backgroundColor: c.hairSoft, borderColor: c.hair },
  compareColNew: { backgroundColor: c.card, borderColor: c.accentBg },
  compareLabelOld: { fontSize: 10.5, color: c.text3, marginBottom: 8 },
  compareLabelNew: { fontSize: 10.5, color: c.accentText, fontWeight: '600', marginBottom: 8 },
  compareBody: { fontSize: 12.5, lineHeight: 20 },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
    backgroundColor: c.page,
  },
  footerSpacer: { flex: 1 },
  primaryBtn: {
    backgroundColor: c.accent,
    borderRadius: R.btn,
    paddingHorizontal: 20,
    paddingVertical: 12,
    minWidth: 132,
    alignItems: 'center',
  },
  primaryText: { fontSize: 14, color: c.onAccent, fontWeight: '500' },
  ghostBtn: {
    borderRadius: R.btn,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 0.5,
    borderColor: c.hair,
    backgroundColor: c.card,
  },
  ghostText: { fontSize: 14, color: c.text2 },
  btnDisabled: { opacity: 0.4 },
});
