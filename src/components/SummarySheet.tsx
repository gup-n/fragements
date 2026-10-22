/**
 * 周期总结生成面板（日 / 周 / 月）。
 *
 * 流程刻意分成三步：选周期 → 生成 → 预览后自己决定存不存。
 * 总结虽然不破坏任何数据，但写进时间轴就是一条长期存在的内容，
 * 让它经一次「保存/丢弃」比事后去删更省事。
 *
 * 覆盖层而非 Modal，安卓返回键自己接 —— 项目红线，见 AGENTS.md。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import type { DigestKind, Fragment } from '../types';
import { AiError, type ChatProgress } from '../ai/chat';
import { summarizePeriod, type SummarizeOutcome } from '../ai/summarize';
import { loadAiConfig } from '../ai/config';
import { repo } from '../db/repo';
import { periodLabel, periodRange, recentPeriods } from '../util/date';
import { C, R } from '../theme';
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

type Phase = 'pick' | 'running' | 'preview';

interface Props {
  onClose: () => void;
  /** 存进库之后通知上层刷新（时间轴才会立刻出现这条总结） */
  onSaved: () => void | Promise<void>;
  /** 从「待补小结」点进来时预选粒度与周期 */
  initialKind?: DigestKind;
  initialPeriod?: string;
}

export function SummarySheet({ onClose, onSaved, initialKind, initialPeriod }: Props) {
  const [kind, setKind] = useState<DigestKind>(initialKind ?? 'daily');
  const [period, setPeriod] = useState(
    () => initialPeriod ?? recentPeriods(initialKind ?? 'daily', 1)[0],
  );
  /** 从待补列表进来时周期是外部指定的，切粒度不该把它重置掉 */
  const [pinned, setPinned] = useState(!!initialPeriod);
  const [count, setCount] = useState<number | null>(null);
  /** 同周期已存在的小结 id —— 重复生成时默认替换，避免时间轴上堆两条同日的 */
  const [existingId, setExistingId] = useState<number | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(true);
  const [phase, setPhase] = useState<Phase>('pick');
  const [draft, setDraft] = useState<SummarizeOutcome | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

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

  // 覆盖层的返回键优先级要高于「回主界面」
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phase === 'running') return true; // 正在生成，别让返回把请求丢掉
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [phase, onClose]);

  // 换粒度时把周期重置成该粒度的当前周期；预选进来的那一次不重置
  useEffect(() => {
    if (pinned) {
      setPinned(false);
      return;
    }
    setPeriod(recentPeriods(kind, 1)[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

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

  // 查这个周期是不是已经有小结了。必须精确查 —— 拿 listNotes(200) 再筛，
  // 笔记一多就会漏，于是同一天又插一条出来（这就是"生成两次小结"的来源）
  useEffect(() => {
    let alive = true;
    (async () => {
      const hit = await repo.findNote(kind, period);
      if (!alive) return;
      setExistingId(hit ? hit.id : null);
      setReplaceExisting(true);
    })();
    return () => {
      alive = false;
    };
  }, [period, kind]);

  const handleProgress = useCallback((patch: ChatProgress) => {
    const now = Date.now();
    if (now - streamRef.current.lastFlush < 120) return;
    streamRef.current.lastFlush = now;
    if (patch.reasoning !== undefined) setReasoning(patch.reasoning);
    if (patch.content !== undefined) setReceived(patch.content.length);
  }, []);

  async function generate() {
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

      const range = periodRange(period);
      if (!range) throw new AiError('format', `无法识别的周期：${period}`);

      const [fragments, todos, cards] = await Promise.all([
        repo.listFragmentsBetween(range.from, range.to),
        repo.listTodos(),
        repo.listKnowledgeCards(),
      ]);
      if (!fragments.length) {
        setPhase('pick');
        setError('这个周期里没有碎片，先记点什么再来总结');
        return;
      }

      const outcome = await summarizePeriod({
        kind,
        period,
        fragments: fragments as Fragment[],
        todos,
        cards,
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

  async function save() {
    // 防重入：连点两下按钮会在同一帧里进两次，saving 的 state 还没更新过来
    if (!draft || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      if (existingId && !replaceExisting) {
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
    onClose();
  }

  const kindMeta = KINDS.find((k) => k.key === kind) ?? KINDS[0];
  // 从待补列表进来时，选中的周期可能不在这批「最近 N 个」里，补到最前面
  const recent = recentPeriods(kind, kindMeta.count);
  const periods = recent.includes(period) ? recent : [period, ...recent];
  const canGenerate = count !== null && count > 0 && phase === 'pick';

  return (
    <View style={s.root}>
      <ScreenHeader title={KIND_NAME[kind]} backIcon="close" onBack={onClose} />

      {phase === 'running' ? (
        <ScrollView contentContainerStyle={s.content}>
          <ReasoningStream
            title={`正在整理${kindMeta.label === '日' ? '这一天' : kindMeta.label === '周' ? '这一周' : '这个月'}的 ${count ?? 0} 条碎片…`}
            text={reasoning}
            received={received}
            elapsed={elapsed}
            thinking={thinkingOn}
            height={260}
          />
          <Text style={s.hint}>
            总结只会写进时间轴，不会改动任何碎片。生成完可以先看一遍，再决定存不存。
          </Text>
        </ScrollView>
      ) : phase === 'preview' && draft ? (
        <>
          <ScrollView contentContainerStyle={s.content}>
            <View style={s.previewCard}>
              <Text style={s.previewMeta}>
                {periodLabel(period)} ·{' '}
                {draft.used === draft.total
                  ? `${draft.total} 条碎片`
                  : `${draft.total} 条碎片（${draft.used} 条进了上下文）`}
              </Text>
              <NoteBody text={draft.bodyMd} style={s.previewBody} />
            </View>

            <ReasoningTrace
              text={draft.reasoning}
              expanded={showTrace}
              onToggle={() => setShowTrace((v) => !v)}
              height={220}
            />

            {error ? <Text style={s.error}>{error}</Text> : null}
          </ScrollView>

          {existingId ? (
            <Pressable style={s.replaceRow} onPress={() => setReplaceExisting((v) => !v)}>
              <View style={[s.checkBox, replaceExisting && s.checkBoxOn]}>
                {replaceExisting ? <Ionicons name="checkmark" size={11} color="#FFFFFF" /> : null}
              </View>
              <Text style={s.replaceText}>替换这个周期原有的{KIND_NAME[kind]}</Text>
            </Pressable>
          ) : null}

          <View style={s.footer}>
            <Pressable style={s.ghostBtn} onPress={() => setPhase('pick')} disabled={saving}>
              <Text style={s.ghostText}>重新选</Text>
            </Pressable>
            <Pressable
              style={[s.primaryBtn, saving && s.btnDisabled]}
              onPress={save}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={s.primaryText}>保存到时间轴</Text>
              )}
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <ScrollView contentContainerStyle={s.content}>
            <View style={s.segment}>
              {KINDS.map((k) => (
                <Pressable
                  key={k.key}
                  onPress={() => setKind(k.key)}
                  style={[s.segItem, kind === k.key && s.segItemOn]}
                >
                  <Text style={[s.segText, kind === k.key && s.segTextOn]}>{k.label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={s.hint}>{kindMeta.hint}</Text>

            <Text style={s.sectionLabel}>选一个周期</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.chipRow}
            >
              {periods.map((p) => (
                <Pressable
                  key={p}
                  onPress={() => setPeriod(p)}
                  style={[s.chip, period === p && s.chipOn]}
                >
                  <Text style={[s.chipText, period === p && s.chipTextOn]}>
                    {periodLabel(p)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <View style={s.countCard}>
              {count === null ? (
                <ActivityIndicator size="small" color={C.accent} />
              ) : count === 0 ? (
                <Text style={s.countEmpty}>这个周期里还没有碎片</Text>
              ) : (
                <Text style={s.countText}>
                  这个周期共 <Text style={s.countNum}>{count}</Text> 条碎片
                  {kind !== 'daily' ? '，会一起读' : ''}
                </Text>
              )}
              {existingId ? (
                <Text style={s.countWarn}>
                  这个周期已经有一份{KIND_NAME[kind]}，保存时可以替换掉
                </Text>
              ) : null}
            </View>

            {error ? <Text style={s.error}>{error}</Text> : null}
          </ScrollView>

          <View style={s.footer}>
            <View style={s.footerSpacer} />
            <Pressable
              style={[s.primaryBtn, !canGenerate && s.btnDisabled]}
              onPress={generate}
              disabled={!canGenerate}
            >
              <Text style={s.primaryText}>生成总结</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: C.page },

  content: { paddingHorizontal: 16, paddingBottom: 24 },

  segment: {
    flexDirection: 'row',
    backgroundColor: C.hairSoft,
    borderRadius: R.btn,
    padding: 3,
    marginTop: 4,
  },
  segItem: { flex: 1, paddingVertical: 8, borderRadius: R.btn - 1, alignItems: 'center' },
  segItemOn: { backgroundColor: C.card },
  segText: { fontSize: 13, color: C.text2 },
  segTextOn: { color: C.text, fontWeight: '600' },

  hint: { fontSize: 12, color: C.text3, lineHeight: 19, marginTop: 10 },
  sectionLabel: { fontSize: 12, color: C.text3, marginTop: 20, marginBottom: 8 },

  chipRow: { gap: 8, paddingRight: 16 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: R.pill,
    borderWidth: 0.5,
    borderColor: C.hair,
    backgroundColor: C.card,
  },
  chipOn: { backgroundColor: C.accentBg, borderColor: C.accentBg },
  chipText: { fontSize: 12, color: C.text2, fontVariant: ['tabular-nums'] },
  chipTextOn: { color: C.accentText, fontWeight: '500' },

  countCard: {
    marginTop: 18,
    padding: 14,
    borderRadius: R.card,
    backgroundColor: C.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    alignItems: 'center',
  },
  countText: { fontSize: 13, color: C.text2 },
  countNum: { fontSize: 15, color: C.text, fontWeight: '600' },
  countEmpty: { fontSize: 13, color: C.text3 },
  countWarn: { fontSize: 11, color: C.text3, marginTop: 8 },

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
    borderColor: C.text3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxOn: { backgroundColor: C.accent, borderColor: C.accent },
  replaceText: { fontSize: 12, color: C.text2 },

  error: { fontSize: 12, color: C.danger, lineHeight: 19, marginTop: 14 },

  previewCard: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: C.hair,
    padding: 16,
    marginTop: 4,
  },
  previewMeta: { fontSize: 11, color: C.text3, marginBottom: 10 },
  previewBody: { fontSize: 14, lineHeight: 24 },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.hair,
    backgroundColor: C.page,
  },
  footerSpacer: { flex: 1 },
  primaryBtn: {
    backgroundColor: C.accent,
    borderRadius: R.btn,
    paddingHorizontal: 20,
    paddingVertical: 12,
    minWidth: 132,
    alignItems: 'center',
  },
  primaryText: { fontSize: 14, color: '#FFFFFF', fontWeight: '500' },
  ghostBtn: {
    borderRadius: R.btn,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 0.5,
    borderColor: C.hair,
    backgroundColor: C.card,
  },
  ghostText: { fontSize: 14, color: C.text2 },
  btnDisabled: { opacity: 0.4 },
});
