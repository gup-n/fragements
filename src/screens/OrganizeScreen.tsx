/**
 * 整理页：点一次「开始」，程序自己一批一批跑到结束，最后统一确认。
 *
 * v0.7 换掉了「一次只跑 30 条、跑完再点继续」的老流程。老流程的问题是
 * 用户得自己判断「还剩多少、要不要再来一轮」，而模型每轮只看得到一批，
 * 跨批的重复待办、同义标签全靠用户事后发现。现在的分工是：
 *
 * - **程序**：装箱、游标、失败拆分、断点续跑（`ai/organizeRun.ts`）
 * - **模型**：只看一批，输出六类结果 + 一句摘要（`ai/prompt.ts`）
 * - **用户**：只在最后看一眼、勾几项（本页面）
 *
 * 写库只发生在最后一步，走 `db/commit.ts`。中途退出、被杀、断电，
 * 碎片和待办一个字都不会变。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type {
  AiConfig,
  DigestKind,
  Fragment,
  Note,
  OrganizeReview,
  OrganizeScope,
  OrganizeSession,
  TagStat,
  Todo,
} from '../types';
import { R, useThemedStyles, type Palette } from '../theme';
import { repo } from '../db/repo';
import { commitPlan, type CommitOutcome } from '../db/commit';
import { loadAiConfig } from '../ai/config';
import {
  BatchFailure,
  abandonSession,
  finishSession,
  findUnfinished,
  runOrganize,
  skipBatch,
  startSession,
  type RunProgress,
} from '../ai/organizeRun';
import { defaultDeselected, safeKeys, reviewCounts, allKeys } from '../util/resultItems';
import { finalizePlan } from '../util/organizePlan';
import { missingDigests } from '../util/digest';
import { SummarySheet } from '../components/SummarySheet';
import { ResultSections } from '../components/ResultSections';
import { BacklogCard } from '../components/BacklogCard';
import { ReasoningStream } from '../components/ReasoningStream';
import { ScreenHeader } from '../components/ScreenHeader';

interface Props {
  fragments: Fragment[];
  /** 用于算出「哪些周期还没有小结」 */
  notes: Note[];
  onClose: () => void;
  onApplied: () => void | Promise<void>;
  onOpenSettings: () => void;
}

type Phase = 'idle' | 'running' | 'review' | 'applying' | 'done';

/** 整理页「待补小结」最多列几条 */
const BACKLOG_LIMIT = 10;

interface Failure {
  message: string;
  code: string;
  session: OrganizeSession;
  batchIds: number[];
  round: number;
  totalRounds: number;
}

export function OrganizeScreen({ fragments, notes, onClose, onApplied, onOpenSettings }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [phase, setPhase] = useState<Phase>('idle');
  const [scope, setScope] = useState<OrganizeScope>('inbox');
  const [session, setSession] = useState<OrganizeSession | null>(null);
  const [review, setReview] = useState<OrganizeReview | null>(null);
  /** 被取消勾选的项。结果默认按 `defaultDeselected` 来，所以只记「取消」更稳 */
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<Failure | null>(null);
  const [outcome, setOutcome] = useState<CommitOutcome | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [stopping, setStopping] = useState(false);
  const [digestTarget, setDigestTarget] = useState<{ kind: DigestKind; period: string } | null>(null);

  /** 上次没跑完的会话。进页面时读一次，用来显示「继续上次」 */
  const [resume, setResume] = useState<{ session: OrganizeSession; remaining: number } | null>(null);

  /** 本次运行用到的三份快照。确认页和写库都用它们，不能中途重读 —— 否则勾选会错位 */
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [tags, setTags] = useState<TagStat[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);

  /** 进度。`round` 是当前批次序号，`totalRounds` 是按装箱估算的批数 */
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const startedAtRef = useRef(0);
  const stopRef = useRef(false);
  /**
   * 流式回调很密集（一个思考过程几百个 chunk），每块都 setState 会把 JS 线程占满。
   * 用 ref 攒着，最多 120ms 上屏一次；结束时再用最终值兜一次底。
   */
  const streamRef = useRef({ lastFlush: 0 });

  const inboxCount = useMemo(() => fragments.filter((f) => f.status === 'inbox').length, [fragments]);
  const allCount = useMemo(() => fragments.filter((f) => f.mergedInto === null).length, [fragments]);
  const available = scope === 'inbox' ? inboxCount : allCount;

  const backlog = useMemo(
    () => missingDigests(fragments, notes, BACKLOG_LIMIT),
    [fragments, notes],
  );

  // 进页面先看有没有没跑完的会话
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await findUnfinished();
        if (!alive || !s) return;
        const done = new Set([...s.plan.processedIds, ...s.plan.skippedIds]);
        const remaining = s.pendingIds.filter((id) => !done.has(id)).length;
        setResume({ session: s, remaining });
        setScope(s.scope);
      } catch {
        /* 读不到就当没有，不影响新开一次 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 运行中每 0.5 秒刷新计时，让人知道没卡住
  useEffect(() => {
    if (phase !== 'running') return;
    const timer = setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [phase]);

  const acceptedKeys = useMemo(() => (review ? allKeys(review) : []), [review]);
  const isOn = (key: string) => !deselected.has(key);
  const acceptedCount = acceptedKeys.filter(isOn).length;
  const safe = useMemo(() => (review ? safeKeys(review).length : 0), [review]);
  const counts = useMemo(() => (review ? reviewCounts(review) : null), [review]);

  function toggle(key: string) {
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectSafe() {
    if (!review) return;
    const on = new Set(safeKeys(review));
    setDeselected(new Set(allKeys(review).filter((k) => !on.has(k))));
  }

  function selectNone() {
    if (!review) return;
    setDeselected(new Set(allKeys(review)));
  }

  /** 流式回调，节流上屏 */
  function handleProgress(update: RunProgress) {
    const now = Date.now();
    if (now - streamRef.current.lastFlush < 120) return;
    streamRef.current.lastFlush = now;
    setProgress(update);
  }

  /** 准备一次运行需要的三份快照。确认页与写库必须用同一份 */
  async function loadContext() {
    const cfg = await loadAiConfig();
    if (!cfg.apiKey) throw new Error('还没配置 API Key，先去设置页填一个');
    const [tagList, todoList] = await Promise.all([repo.listTags(), repo.listTodos()]);
    setConfig(cfg);
    setTags(tagList);
    setTodos(todoList);
    return { cfg, tagList, todoList };
  }

  /** 把会话收成确认页。跑了 0 条时不算成功，回到 idle 并说明原因 */
  function showReview(next: OrganizeSession, tagList: TagStat[]) {
    const processed = next.plan.processedIds.length;
    if (!processed) {
      setPhase('idle');
      setErrorMsg('这次一条都没跑成，没有任何改动。可以再试一次。');
      return;
    }
    const rev = finalizePlan(next.plan, tagList);
    setSession(next);
    setReview(rev);
    setDeselected(defaultDeselected(rev));
    setFailure(null);
    setPhase('review');
  }

  /** 跑（或续跑）一次。失败不抛到界面，收成 `failure` 让用户选下一步 */
  async function loop(
    start: OrganizeSession,
    cfg: AiConfig,
    tagList: TagStat[],
    todoList: Todo[],
  ) {
    stopRef.current = false;
    setStopping(false);
    startedAtRef.current = Date.now();
    streamRef.current.lastFlush = 0;
    setElapsed(0);
    setProgress(null);
    setErrorMsg('');
    setPhase('running');

    try {
      const next = await runOrganize({
        session: start,
        config: cfg,
        existingTags: tagList,
        todos: todoList,
        onProgress: handleProgress,
        shouldStop: () => stopRef.current,
      });
      setSession(next);
      showReview(next, tagList);
    } catch (e) {
      if (e instanceof BatchFailure) {
        setSession(e.session);
        setFailure({
          message: e.message || '这一批失败了',
          code: e.code,
          session: e.session,
          batchIds: e.batchIds,
          round: e.round,
          totalRounds: e.totalRounds,
        });
        setPhase('running');
        return;
      }
      setErrorMsg((e as Error)?.message || '整理失败，稍后再试');
      setPhase('idle');
    }
  }

  /** 新开一次 */
  async function start() {
    if (!available) return;
    try {
      const { cfg, tagList, todoList } = await loadContext();
      const fresh = await startSession(scope);
      setResume(null);
      await loop(fresh, cfg, tagList, todoList);
    } catch (e) {
      setErrorMsg((e as Error)?.message || '启动失败');
      setPhase('idle');
    }
  }

  /** 继续上次：没跑完就接着跑，跑完了直接进确认页 */
  async function resumeRun() {
    if (!resume) return;
    try {
      const { cfg, tagList, todoList } = await loadContext();
      if (resume.remaining > 0) {
        await loop(resume.session, cfg, tagList, todoList);
      } else {
        showReview(resume.session, tagList);
      }
    } catch (e) {
      setErrorMsg((e as Error)?.message || '继续失败');
      setPhase('idle');
    }
  }

  async function dropResume() {
    if (!resume) return;
    try {
      await abandonSession(resume.session.id);
    } catch {
      /* 删不掉也不影响新开一次 */
    }
    setResume(null);
  }

  /** 失败后：重试这一批 */
  async function retryBatch() {
    if (!failure) return;
    const sess = failure.session;
    setFailure(null);
    try {
      const { cfg, tagList, todoList } = await loadContext();
      await loop(sess, cfg, tagList, todoList);
    } catch (e) {
      setErrorMsg((e as Error)?.message || '重试失败');
      setPhase('idle');
    }
  }

  /** 失败后：跳过这一批（不标记碎片状态，下次整理还在） */
  async function skipThisBatch() {
    if (!failure) return;
    const { session: sess, batchIds } = failure;
    setFailure(null);
    try {
      const { cfg, tagList, todoList } = await loadContext();
      const next = await skipBatch(sess, batchIds);
      await loop(next, cfg, tagList, todoList);
    } catch (e) {
      setErrorMsg((e as Error)?.message || '跳过失败');
      setPhase('idle');
    }
  }

  /** 失败后：放弃本次，已跑完的批次也一并丢掉（还没写库，所以没有残留） */
  async function abortRun() {
    if (!failure) return;
    const sess = failure.session;
    setFailure(null);
    setSession(null);
    setProgress(null);
    setPhase('idle');
    try {
      await abandonSession(sess.id);
    } catch {
      /* 删不掉只会留个「继续上次」的提示，不影响数据 */
    }
  }

  /** 用户主动停止：当前批跑完就收，已跑完的照常进确认页 */
  function stopRun() {
    stopRef.current = true;
    setStopping(true);
  }

  async function apply() {
    if (!session) return;
    setPhase('applying');
    try {
      const report = await commitPlan({
        plan: session.plan,
        existingTags: tags,
        accepted: isOn,
        // 跳过的批次不在这里，它们要保持 inbox，下次还能被整理到
        processedIds: session.plan.processedIds,
      });
      await finishSession(session.id);
      setOutcome(report);
      setResume(null);
      // 先刷新再进 done：done 页要显示「还剩几条」，用旧数据算会把刚整理的又算一遍
      try {
        await onApplied();
      } catch {
        /* 刷新失败不该翻成「写入失败」—— 内容已经进库了 */
      }
      setPhase('done');
    } catch (e) {
      setErrorMsg((e as Error)?.message || '写入失败');
      setPhase('review');
    }
  }

  /** 全部放弃：还没写库，删掉会话即可 */
  async function discard() {
    if (session) {
      try {
        await abandonSession(session.id);
      } catch {
        /* 同上 */
      }
    }
    setSession(null);
    setReview(null);
    setResume(null);
    setPhase('idle');
  }

  const refactor = (session?.scope ?? scope) === 'all';

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="整理"
        subtitle={
          phase === 'review'
            ? review
              ? `跑完 ${review.rounds} 批，处理 ${review.processedCount} 条`
              : '确认后才会写库'
            : '自动跑完所有批次，最后统一确认'
        }
        onBack={onClose}
      />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {phase === 'idle' && (
          <View>
            <View style={styles.segment}>
              <Pressable
                style={[styles.segmentItem, scope === 'inbox' && styles.segmentItemOn]}
                onPress={() => setScope('inbox')}
              >
                <Ionicons
                  name="sparkles-outline"
                  size={14}
                  color={scope === 'inbox' ? c.accentText : c.text3}
                />
                <Text style={[styles.segmentText, scope === 'inbox' && styles.segmentTextOn]}>
                  整理未读
                </Text>
              </Pressable>
              <Pressable
                style={[styles.segmentItem, scope === 'all' && styles.segmentItemOn]}
                onPress={() => setScope('all')}
              >
                <Ionicons
                  name="sync-outline"
                  size={14}
                  color={scope === 'all' ? c.accentText : c.text3}
                />
                <Text style={[styles.segmentText, scope === 'all' && styles.segmentTextOn]}>
                  全部重过
                </Text>
              </Pressable>
            </View>

            {resume && (
              <View style={styles.resumeCard}>
                <View style={styles.resumeHead}>
                  <Ionicons name="time-outline" size={15} color={c.amberText} />
                  <Text style={styles.resumeTitle}>
                    {resume.remaining > 0
                      ? `上次整理到 ${resume.session.pendingIds.length - resume.remaining} / ${resume.session.pendingIds.length}`
                      : '上次已经跑完了，还没确认写入'}
                  </Text>
                </View>
                <Text style={styles.resumeSub}>
                  {resume.remaining > 0
                    ? `还剩 ${resume.remaining} 条没跑。继续会接着上次的进度，不会从头再来。`
                    : `有 ${(resume.session.plan.processedIds ?? []).length} 条的整理结果等着你确认。`}
                </Text>
                <View style={styles.resumeRow}>
                  <Pressable style={styles.resumePrimary} onPress={resumeRun}>
                    <Text style={styles.resumePrimaryText}>
                      {resume.remaining > 0 ? '继续上次' : '去确认'}
                    </Text>
                  </Pressable>
                  <Pressable style={styles.resumeGhost} onPress={dropResume}>
                    <Text style={styles.resumeGhostText}>丢掉</Text>
                  </Pressable>
                </View>
              </View>
            )}

            <View style={styles.heroCard}>
              <Text style={styles.heroNum}>{available}</Text>
              <Text style={styles.heroLabel}>
                {scope === 'all' ? '条碎片全部重过一遍' : '条未整理的碎片'}
              </Text>
              <Pressable
                style={[styles.primaryBtn, !available && styles.primaryBtnDisabled]}
                onPress={start}
                disabled={!available}
              >
                <Text style={styles.primaryBtnText}>
                  {available ? `开始整理 ${available} 条` : '没有可整理的碎片'}
                </Text>
              </Pressable>
              {!!errorMsg && <Text style={styles.errText}>{errorMsg}</Text>}
              {errorMsg.includes('API Key') && (
                <Pressable style={styles.linkRow} onPress={onOpenSettings}>
                  <Text style={styles.linkText}>去设置里填 API Key</Text>
                  <Ionicons name="chevron-forward" size={13} color={c.accent} />
                </Pressable>
              )}
            </View>

            <View style={styles.explainCard}>
              <Text style={styles.explainTitle}>它会怎么做</Text>
              <Text style={styles.explainText}>
                每批 40 条、16000 字，跑完一批自动接下一批，直到全部跑完 —— 你不用一次次点「继续」。
                每批的结论会总结成一句话带给下一批，所以不会重复抽同样的待办、也不会给同一件事起两种标签。
              </Text>
              <Text style={styles.explainText}>
                跑完会给你一张确认页：标签按名字分组、新标签单独标出来。会删内容的操作（删待办、合并待办、
                合并碎片）默认都不勾，得你自己点。
              </Text>
              <Text style={styles.explainText}>
                中途返回、手机关掉都没关系：进度存在本地，下次进来有「继续上次」。而且只有最后点「应用」
                才会写库，中途出任何问题，你的碎片一个字都不会变。
              </Text>
              {scope === 'all' ? (
                <Text style={styles.explainWarn}>
                  全部重过会把已有标签重新判一遍。勾上的标签会覆盖旧的，没勾的保留原样，不会被清空。
                </Text>
              ) : null}
            </View>

            <BacklogCard backlog={backlog} onPick={(kind, period) => setDigestTarget({ kind, period })} />
          </View>
        )}

        {phase === 'running' && !failure && (
          <View>
            <View style={styles.progressCard}>
              <View style={styles.progressTop}>
                <Text style={styles.progressTitle}>
                  {/* 撞额度被拆开重试时批次会超出估算值，别显示「第 9 / 8 批」 */}
                  第 {progress?.round ?? 1} /{' '}
                  {Math.max(progress?.totalRounds ?? 1, progress?.round ?? 1)} 批
                </Text>
                <Text style={styles.progressMeta}>
                  {progress?.done ?? 0} / {progress?.total ?? session?.pendingIds.length ?? available} 条
                </Text>
              </View>
              <View style={styles.bar}>
                <View
                  style={[
                    styles.barFill,
                    {
                      width: `${Math.min(
                        100,
                        Math.round(
                          ((progress?.done ?? 0) / Math.max(1, progress?.total ?? available)) * 100,
                        ),
                      )}%`,
                    },
                  ]}
                />
              </View>
              <Text style={styles.progressSub}>
                本批 {progress?.batchCount ?? '—'} 条 · 已用 {elapsed} 秒
                {stopping ? ' · 正在跑完这一批…' : ''}
              </Text>
              <Pressable
                style={[styles.stopBtn, stopping && styles.stopBtnOff]}
                onPress={stopRun}
                disabled={stopping}
              >
                <Text style={styles.stopBtnText}>{stopping ? '收尾中…' : '停止，先看已跑完的'}</Text>
              </Pressable>
            </View>

            <ReasoningStream
              title="正在思考…"
              text={progress?.reasoning ?? ''}
              received={progress?.content.length ?? 0}
              elapsed={elapsed}
              thinking={config?.thinking ?? false}
              height={280}
            />
          </View>
        )}

        {phase === 'running' && failure && (
          <View style={styles.heroCard}>
            <Ionicons name="alert-circle-outline" size={30} color={c.danger} />
            <Text style={styles.failTitle}>
              第 {failure.round} / {failure.totalRounds} 批失败了
            </Text>
            <Text style={styles.failMsg}>{failure.message}</Text>
            <Text style={styles.failHint}>
              前面已经跑完的 {failure.session.plan.rounds} 批结果都还在，选「跳过这一批」或「重试」
              不会让它们白跑。这一批的 {failure.batchIds.length} 条碎片不会被标记，下次整理还会遇到。
            </Text>
            <Pressable style={styles.primaryBtn} onPress={retryBatch}>
              <Text style={styles.primaryBtnText}>重试这一批</Text>
            </Pressable>
            <Pressable style={styles.secondaryBtn} onPress={skipThisBatch}>
              <Text style={styles.secondaryBtnText}>跳过这一批，继续跑后面的</Text>
            </Pressable>
            <Pressable style={styles.secondaryBtn} onPress={abortRun}>
              <Text style={styles.secondaryBtnText}>放弃本次（什么都不写）</Text>
            </Pressable>
            {failure.code === 'auth' && (
              <Pressable style={styles.linkRow} onPress={onOpenSettings}>
                <Text style={styles.linkText}>检查 API Key 和 Base URL</Text>
                <Ionicons name="chevron-forward" size={13} color={c.accent} />
              </Pressable>
            )}
          </View>
        )}

        {phase === 'applying' && (
          <View style={styles.centerBox}>
            <ActivityIndicator color={c.accent} />
            <Text style={styles.centerText}>正在写入…</Text>
          </View>
        )}

        {phase === 'review' && review && (
          <View>
            {!!errorMsg && <Text style={styles.reviewErr}>{errorMsg}</Text>}
            <Text style={styles.resultHint}>
              跑完 {review.rounds} 批、处理 {review.processedCount} 条
              {review.skippedCount > 0 ? `，跳过 ${review.skippedCount} 条` : ''}。
              {review.rejected > 0
                ? `另有 ${review.rejected} 条结果不合法已丢弃（id 不存在、日期不对之类）。`
                : ''}
            </Text>
            <View style={styles.summaryRow}>
              <Stat
                label="标签组"
                value={review.tags.length}
              />
              <Stat label="新待办" value={`${counts?.todos ?? 0}`} />
              <Stat label="已完成" value={`${counts?.done ?? 0}`} />
              <Stat label="合并碎片" value={`${counts?.mergedFragments ?? 0}`} />
            </View>

            <View style={styles.quickRow}>
              <Pressable style={styles.quickBtn} onPress={selectSafe}>
                <Ionicons name="shield-checkmark-outline" size={13} color={c.accentText} />
                <Text style={styles.quickBtnText}>全选安全项 {safe}</Text>
              </Pressable>
              <Pressable style={styles.quickBtnGhost} onPress={selectNone}>
                <Text style={styles.quickBtnGhostText}>全不选</Text>
              </Pressable>
            </View>

            <ResultSections
              review={review}
              fragments={fragments}
              todos={todos}
              isOn={isOn}
              onToggle={toggle}
              refactor={refactor}
            />
          </View>
        )}

        {phase === 'done' && outcome && (
          <View style={styles.centerBox}>
            <Ionicons name="checkmark-circle-outline" size={34} color={c.accent} />
            <Text style={styles.centerText}>已写入 {outcome.applied} 项</Text>
            <Text style={styles.doneMeta}>
              {[
                outcome.tags ? `标签 ${outcome.tags} 条` : '',
                outcome.todos ? `新待办 ${outcome.todos} 条` : '',
                outcome.done ? `标完成 ${outcome.done} 条` : '',
                outcome.dropped ? `删待办 ${outcome.dropped} 条` : '',
                outcome.mergedTodos ? `并待办 ${outcome.mergedTodos} 组` : '',
                outcome.mergedFragments ? `并碎片 ${outcome.mergedFragments} 组` : '',
              ]
                .filter(Boolean)
                .join(' · ') || '没有需要写入的改动'}
            </Text>
            <Text style={styles.doneSub}>
              {outcome.marked} 条碎片已记为「整理过」，原文一个字都没动。
              {outcome.applied === 0 ? '这次只更新了状态，下次整理不会再拿它们来跑。' : ''}
            </Text>
            <Pressable style={styles.primaryBtn} onPress={onClose}>
              <Text style={styles.primaryBtnText}>回到时间轴</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      {phase === 'review' && (
        <View style={styles.footer}>
          <Pressable style={styles.secondaryBtnFlex} onPress={discard}>
            <Text style={styles.secondaryBtnText}>全部放弃</Text>
          </Pressable>
          <Pressable
            style={[styles.primaryBtnFlex, !acceptedCount && styles.primaryBtnDisabled]}
            onPress={apply}
          >
            <Text style={styles.primaryBtnText}>
              {acceptedCount ? `应用 ${acceptedCount} 项` : '只标记为已整理'}
            </Text>
          </Pressable>
        </View>
      )}

      {digestTarget && (
        <SummarySheet
          initialKind={digestTarget.kind}
          initialPeriod={digestTarget.period}
          onClose={() => setDigestTarget(null)}
          onSaved={onApplied}
        />
      )}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  const { c, styles } = useThemedStyles(makeStyles);
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.page },
  content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24 },

  segment: {
    flexDirection: 'row',
    backgroundColor: c.hairSoft,
    borderRadius: R.btn,
    padding: 3,
    marginBottom: 14,
  },
  segmentItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 8,
    borderRadius: R.btn - 2,
  },
  segmentItemOn: { backgroundColor: c.card },
  segmentText: { fontSize: 13, color: c.text2 },
  segmentTextOn: { color: c.text, fontWeight: '500' },

  resumeCard: {
    backgroundColor: c.amberBg,
    borderRadius: R.card,
    padding: 14,
    marginBottom: 14,
    gap: 6,
  },
  resumeHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  resumeTitle: { fontSize: 13, color: c.amberText, fontWeight: '500' },
  resumeSub: { fontSize: 11.5, color: c.amberText, lineHeight: 17, opacity: 0.9 },
  resumeRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  resumePrimary: {
    backgroundColor: c.amberText,
    borderRadius: R.btn,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  resumePrimaryText: { fontSize: 13, color: c.onAccent, fontWeight: '500' },
  resumeGhost: {
    borderRadius: R.btn,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 0.5,
    borderColor: c.amberText,
  },
  resumeGhostText: { fontSize: 13, color: c.amberText },

  heroCard: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    padding: 22,
    alignItems: 'center',
  },
  heroNum: { fontSize: 40, color: c.text, fontWeight: '500', lineHeight: 46 },
  heroLabel: { fontSize: 13, color: c.text2, marginTop: 2 },

  explainCard: {
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: R.card,
    backgroundColor: c.hairSoft,
    gap: 8,
  },
  explainTitle: { fontSize: 12, color: c.text, fontWeight: '500' },
  explainText: { fontSize: 11, color: c.text2, lineHeight: 18 },
  explainWarn: { fontSize: 11, color: c.amberText, lineHeight: 18 },

  progressCard: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    padding: 18,
    gap: 10,
  },
  progressTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  progressTitle: { fontSize: 14, color: c.text, fontWeight: '500' },
  progressMeta: { fontSize: 12, color: c.text2 },
  bar: { height: 6, borderRadius: 3, backgroundColor: c.hairSoft, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3, backgroundColor: c.accent },
  progressSub: { fontSize: 11, color: c.text3 },
  stopBtn: {
    alignSelf: 'flex-start',
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: c.hair,
    paddingVertical: 7,
    paddingHorizontal: 14,
  },
  stopBtnOff: { opacity: 0.5 },
  stopBtnText: { fontSize: 12, color: c.text2 },

  failTitle: { fontSize: 14, color: c.text, fontWeight: '500', marginTop: 10 },
  failMsg: { fontSize: 12, color: c.danger, lineHeight: 19, textAlign: 'center', marginTop: 6 },
  failHint: { fontSize: 11, color: c.text3, lineHeight: 17, textAlign: 'center', marginTop: 8 },

  primaryBtn: {
    backgroundColor: c.accent,
    borderRadius: R.btn,
    paddingVertical: 11,
    paddingHorizontal: 22,
    marginTop: 18,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  primaryBtnDisabled: { backgroundColor: c.hair },
  primaryBtnText: { fontSize: 14, color: c.onAccent, fontWeight: '500' },
  secondaryBtn: {
    borderRadius: R.btn,
    paddingVertical: 10,
    paddingHorizontal: 22,
    marginTop: 8,
    alignSelf: 'stretch',
    alignItems: 'center',
    borderWidth: 0.5,
    borderColor: c.hair,
  },
  secondaryBtnText: { fontSize: 13, color: c.text2 },
  secondaryBtnFlex: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: c.hair,
  },
  primaryBtnFlex: {
    flex: 1.6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: R.btn,
    backgroundColor: c.accent,
  },

  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    marginTop: 14,
    paddingVertical: 8,
  },
  linkText: { fontSize: 13, color: c.accent },

  centerBox: { alignItems: 'center', justifyContent: 'center', paddingVertical: 70, gap: 10 },
  centerText: { fontSize: 14, color: c.text2 },
  doneMeta: { fontSize: 11.5, color: c.text3, textAlign: 'center', lineHeight: 18, paddingHorizontal: 20 },
  doneSub: {
    fontSize: 12,
    color: c.text3,
    lineHeight: 19,
    textAlign: 'center',
    maxWidth: 320,
    marginBottom: 4,
  },

  errText: { fontSize: 12, color: c.danger, lineHeight: 19, textAlign: 'center', marginTop: 12 },
  reviewErr: {
    fontSize: 12,
    color: c.danger,
    lineHeight: 18,
    backgroundColor: c.dangerBg,
    borderRadius: R.btn,
    padding: 10,
    marginBottom: 12,
  },

  resultHint: { fontSize: 12, color: c.text3, marginBottom: 12, marginTop: 4, lineHeight: 18 },

  summaryRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  stat: {
    flex: 1,
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    paddingVertical: 10,
    alignItems: 'center',
    gap: 2,
  },
  statValue: { fontSize: 15, color: c.text, fontWeight: '500' },
  statLabel: { fontSize: 10.5, color: c.text3 },

  quickRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  quickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: c.accentBg,
    borderRadius: R.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  quickBtnText: { fontSize: 12, color: c.accentText },
  quickBtnGhost: {
    borderRadius: R.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 0.5,
    borderColor: c.hair,
  },
  quickBtnGhostText: { fontSize: 12, color: c.text2 },

  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
    backgroundColor: c.page,
  },
});
