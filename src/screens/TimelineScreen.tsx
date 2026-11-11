import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import type { Fragment, Note } from '../types';
import { R, useThemedStyles, type Palette } from '../theme';
import { NoteBody } from '../components/NoteBody';
import { IconButton } from '../components/IconButton';
import { FragmentDetail } from '../components/FragmentDetail';
import { SwipeRow } from '../components/SwipeRow';
import { Toast } from '../components/Toast';
import { dayKey, dayLabel, daySubLabel, formatTime, periodAnchor, periodLabel } from '../util/date';
import { countHits } from '../util/highlight';
import { useKeyboardHeight } from '../util/keyboard';

/**
 * 时间轴上混着两种东西：碎片和周期总结。
 * 用 kind 区分，渲染时分两套样式 —— 但共用同一条竖线，视觉上仍是一条连续的时间流。
 */
type TimelineItem =
  | { kind: 'fragment'; id: number; at: number; fragment: Fragment }
  | { kind: 'note'; id: number; at: number; note: Note };

/**
 * key 是 YYYY-MM-DD（日分区）或 `m:2026-10:note|frag`（月分区），折叠状态按它记；
 * order 决定分区在时间轴上的位置 —— 月分区用「这个月最后一毫秒 + 1ms」。
 */
type Section = {
  key: string;
  title: string;
  sub: string;
  order: number;
  data: TimelineItem[];
  /**
   * `day` = 按天；`month` = 折叠成的整月（小结 / 记录两块）。
   * 展开的月要还原成天 —— 用户 2026-11-11：「10 月记录全放在一起，
   * 展开后应该是要有具体天数的」。
   */
  level: 'day' | 'month';
};

/**
 * 交给 SectionList 的版本：折叠时 data 清空（header 仍然渲染），
 * 所以条数和预览必须提前算好带上，不能等渲染时再读 data。
 */
type DisplaySection = Section & {
  total: number;
  preview: string;
  /** 从展开的月里拆出来的天：头部小一号、不再单独折叠 */
  nested?: boolean;
  /** 展开的月只画一个头，数据全在下面的天分区里 */
  headerOnly?: boolean;
};

/**
 * 冷启动只自动聚焦一次。放在模块作用域而不是 useRef，
 * 是因为从设置页/知识库返回时会卸载再挂载，用 ref 会反复弹键盘。
 */
let autoFocusedOnce = false;

/**
 * 时间轴上总结条目的类型标签。
 *
 * 四种都留着：v0.15 之后只会出现 `monthly`，但旧设备上可能还有没被迁移
 * 清掉的 theme（甚至 daily/weekly）。留着文案 = 照常显示，删掉 = 那条总结
 * 在时间轴上变成空白卡片。**显示兼容和生成入口是两件事。**
 */
const NOTE_KIND: Record<Note['type'], string> = {
  daily: '今日小结',
  weekly: '周总结',
  monthly: '月总结',
  theme: '主题总结',
};

/** 同一天里有多条总结时，粒度大的先显示（月 > 周 > 日） */
const NOTE_RANK: Record<Note['type'], number> = { monthly: 0, weekly: 1, daily: 2, theme: 3 };

interface Props {
  fragments: Fragment[];
  /** 周期总结，按 period 落回时间轴对应日期 */
  notes: Note[];
  /** 已完成待办对应的碎片 id，用来在时间轴上打「已完成」标记 */
  doneIds: Set<number>;
  /**
   * 输入框里的草稿。**由上层持有** —— 这个组件在切到知识库/设置/回顾时会被卸载，
   * 草稿放在组件里就等于「打个半句去翻张卡，回来全没了」。
   */
  draft: string;
  onDraftChange: (text: string) => void;
  onAdd: (text: string) => Promise<void>;
  onEdit: (id: number, text: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onDeleteNote: (id: number) => Promise<void>;
  onOpenSettings: () => void;
  /** 带上碎片 id 时，「问」页会把这它作为上下文 */
  onOpenAsk: (fragmentId?: number) => void;
  onOpenReview: () => void;
  /** 文档库（v0.10.0）。入口在页头「问」的左边 */
  onOpenDocs: () => void;
  onSeed?: () => Promise<void>;
}

export function TimelineScreen({
  fragments,
  notes,
  doneIds,
  draft,
  onDraftChange,
  onAdd,
  onEdit,
  onDelete,
  onDeleteNote,
  onOpenSettings,
  onOpenAsk,
  onOpenReview,
  onOpenDocs,
  onSeed,
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  /** 页头有 4 个图标。窄屏先让副标题让路，不要把品牌名压成省略号 */
  const tightHeader = width < 380;
  const [sending, setSending] = useState(false);
  /**
   * 当前滑开的那一行。存 id 而不是布尔值 —— 父级统一持有才能保证同时只开一行。
   * 展开状态放在父级还有个好处：列表一滚动就能整片收起。
   */
  const [openRow, setOpenRow] = useState<{ id: number; side: 'left' | 'right' } | null>(null);
  /** 等着二次确认的删除目标。null = 没弹层 */
  const [deleteTarget, setDeleteTarget] = useState<Fragment | null>(null);
  /** 底部轻提示，复制成功 / 删除成功都走它 */
  const [toast, setToast] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());
  const [armedNoteDelete, setArmedNoteDelete] = useState<number | null>(null);
  const [fullEdit, setFullEdit] = useState(false);
  const [query, setQuery] = useState('');
  /**
   * 事项筛选。和搜索框是叠乘关系（先筛后搜）。
   *
   * 点一下事项名就只看同类，再点一次取消。
   */
  /**
   * 只按「事项」筛。
   *
   * v0.7 起 AI 就不再打标签了，标签模块（胶囊 / 按标签筛 / 回顾页的标签页）
   * 一直留着旧数据当摆设 —— 用户 2026-11-11 报「标签去掉了但模块还在」。
   * 现在整块拆掉：数据列保留（不销毁历史），只是不再有任何入口。
   */
  const [filter, setFilter] = useState<{ kind: 'project'; value: string } | null>(null);
  /**
   * 折叠过的日期。null 表示「还没手动动过」—— 这时用默认规则（只展开今天）。
   * 不直接把默认集合塞进 state，是因为「今天」会随日期变，写死一次就永远停在旧日期上了。
   */
  const [collapsedDays, setCollapsedDays] = useState<Set<string> | null>(null);
  /**
   * 详情页。只存 id 序列 + 起点，不存碎片快照 ——
   * 存快照的话编辑保存后这里还是旧内容，详情页看起来「没变」，得关掉重开才刷新。
   * 用 id 序列而不是直接读 flat：id 顺序固定，翻到第几条不会因为列表重排而错位。
   */
  const [detail, setDetail] = useState<{ ids: number[]; index: number; query?: string } | null>(null);
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const fullInputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const listRef = useRef<SectionList<TimelineItem, DisplaySection>>(null);
  /** 轻提示的定时器，连着操作两次时要把上一次的清掉，不然第一条会提前消失 */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardHeight = useKeyboardHeight();

  // 冷启动即聚焦：记录工具打开就该能打字，不该先点一下输入框
  useEffect(() => {
    if (Platform.OS === 'web' || autoFocusedOnce) return;
    autoFocusedOnce = true;
    const timer = setTimeout(() => inputRef.current?.focus(), 380);
    return () => clearTimeout(timer);
  }, []);

  // 长文记录是覆盖层而非 Modal，安卓返回键得自己处理，否则直接退出 App。
  // 顺序是「先关最上面那层」：确认弹层压在长文编辑之上。
  useEffect(() => {
    if (!deleteTarget && !fullEdit) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (deleteTarget) setDeleteTarget(null);
      else if (fullEdit) setFullEdit(false);
      return true;
    });
    return () => sub.remove();
  }, [deleteTarget, fullEdit]);

  // 卸载时把还没到点的定时器清掉，否则回调落在已卸载的组件上
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // 覆盖层里的输入框不会因为 autoFocus 稳定抢到焦点（下面那个输入框还聚焦着），
  // 挂载后主动聚焦一次更确定
  useEffect(() => {
    if (!fullEdit) return;
    const timer = setTimeout(() => fullInputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [fullEdit]);

  const searching = query.trim().length > 0;
  /** 有筛选或有搜索 → 结果要全摊开，命中的东西藏在折叠里等于没筛到 */
  const narrowed = searching || filter !== null;
  const todayKey = dayKey(Date.now());

  /**
   * 搜索直接在内存里过滤，不走 SQLite：碎片本来就全量躺在 props 里，
   * 再压一个查询接口下去，反而拿不到 project 这个内存字段的匹配。
   *
   * 只搜「看得见的东西」。以前还搜 tags，但标签已经不在界面上显示了 ——
   * 靠一个看不见的字段命中，用户只会觉得「搜到了什么？哪儿呢」。
   */
  const visibleFragments = useMemo(() => {
    const base = filter ? fragments.filter((f) => f.project === filter.value) : fragments;
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (f) => f.content.toLowerCase().includes(q) || (f.project ?? '').toLowerCase().includes(q),
    );
  }, [fragments, query, filter]);

  /**
   * 分区。
   *
   * 两级结构（用户 2026-11-11 要求）：
   * - **本月**按天分，今天展开、其余日期折叠 —— 找「上周三记了什么」按日期最快；
   * - **更早**按月分，每个月两块：「N月小结」「N月记录」——
   *   往前翻三个月的时候，一屏里塞十几个日期头，其实全是为了找那个月记了什么。
   *
   * 搜索/筛选时一律回到按天分：命中的东西藏在「10月记录」里，等于没搜到。
   */
  const sections = useMemo(() => {
    const map = new Map<string, Section>();
    const monthOf = (at: number) => {
      const d = new Date(at);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };
    const thisMonth = monthOf(Date.now());

    const pushDay = (at: number, item: TimelineItem) => {
      const key = dayKey(at);
      let bucket = map.get(key);
      if (!bucket) {
        const day = new Date(at);
        day.setHours(0, 0, 0, 0);
        bucket = {
          key,
          title: dayLabel(at),
          sub: daySubLabel(at),
          order: day.getTime(),
          data: [],
          level: 'day',
        };
        map.set(key, bucket);
      }
      bucket.data.push(item);
    };

    /**
     * 月分区的 order 用「这个月最后一毫秒」，小结比记录再大 1ms ——
     * 排序是倒序，所以同一月里小结排在上面，整月的顺序也和日期一致。
     */
    const pushMonth = (at: number, item: TimelineItem, kind: 'note' | 'frag') => {
      const d = new Date(at);
      const key = `m:${monthOf(at)}:${kind}`;
      let bucket = map.get(key);
      if (!bucket) {
        const end = new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime() + 86_399_999;
        bucket = {
          key,
          title: `${d.getMonth() + 1}月${kind === 'note' ? '小结' : '记录'}`,
          sub: '整月',
          order: end + (kind === 'note' ? 1 : 0),
          data: [],
          level: 'month',
        };
        map.set(key, bucket);
      }
      bucket.data.push(item);
    };

    const place = (at: number, item: TimelineItem, kind: 'note' | 'frag') => {
      if (narrowed || monthOf(at) === thisMonth) pushDay(at, item);
      else pushMonth(at, item, kind);
    };

    for (const f of visibleFragments) {
      place(f.createdAt, { kind: 'fragment', id: f.id, at: f.createdAt, fragment: f }, 'frag');
    }

    // 搜索 / 筛选时只查碎片原文 —— 把小结也混进来，结果会在日期头下面孤零零挂一条
    if (!narrowed) {
      for (const n of notes) {
        /*
         * 按 period 落回它覆盖的那一天，而不是它被生成的那天 ——
         * 否则「9 月的总结」会飘到 11 月的时间轴上。
         */
        const at = periodAnchor(n.period) ?? n.createdAt;
        place(at, { kind: 'note', id: n.id, at, note: n }, 'note');
      }
    }

    const out = Array.from(map.values());
    for (const bucket of out) {
      bucket.data.sort((a, b) => {
        // 小结排当天最前：它是这一天的一句话结论，先看结论再看零碎
        if (a.kind !== b.kind) return a.kind === 'note' ? -1 : 1;
        if (a.kind === 'note' && b.kind === 'note') {
          const rank = NOTE_RANK[a.note.type] - NOTE_RANK[b.note.type];
          if (rank !== 0) return rank;
        }
        return b.at - a.at;
      });
    }

    return out.sort((a, b) => b.order - a.order);
  }, [visibleFragments, notes, narrowed]);

  /**
   * 当前生效的折叠集合。默认只展开今天，其余全部收起 —— 记录攒了几天以后，
   * 一屏全是前几天的内容会盖住今天刚记的东西。
   * 搜索 / 筛选时强制全展开，否则命中的条目藏在折叠里等于没搜到。
   */
  const collapsedKeys = useMemo(() => {
    if (narrowed) return new Set<string>();
    if (collapsedDays) return collapsedDays;
    return new Set(sections.filter((s) => s.key !== todayKey).map((s) => s.key));
  }, [sections, collapsedDays, narrowed, todayKey]);

  const displaySections = useMemo<DisplaySection[]>(() => {
    const pickPreview = (sec: Section): string => {
      const first = sec.data[0];
      if (first?.kind === 'fragment') return first.fragment.content.replace(/\s+/g, ' ');
      if (first?.kind === 'note') return first.note.bodyMd.replace(/[#*>\-\n]+/g, ' ').trim();
      return '';
    };

    const out: DisplaySection[] = [];
    for (const sec of sections) {
      const collapsed = collapsedKeys.has(sec.key);
      if (sec.level === 'month' && !collapsed) {
        /*
         * 展开的月 = 一个月头 + 若干天。月头只画一次（点它收回去），
         * 数据全部下放到天分区 —— 不再是一大坨没有日期分隔的流水。
         */
        out.push({ ...sec, data: [], total: sec.data.length, preview: '', headerOnly: true });
        const byDay = new Map<string, DisplaySection>();
        for (const item of sec.data) {
          const key = dayKey(item.at);
          let bucket = byDay.get(key);
          if (!bucket) {
            const day = new Date(item.at);
            day.setHours(0, 0, 0, 0);
            bucket = {
              key: `d:${key}`,
              title: dayLabel(item.at),
              sub: daySubLabel(item.at),
              order: day.getTime(),
              data: [],
              level: 'day',
              total: 0,
              preview: '',
              nested: true,
            };
            byDay.set(key, bucket);
            out.push(bucket);
          }
          bucket.data.push(item);
          bucket.total += 1;
        }
        continue;
      }
      out.push({
        ...sec,
        data: collapsed ? [] : sec.data,
        total: sec.data.length,
        preview: collapsed ? pickPreview(sec) : '',
      });
    }
    return out;
  }, [sections, collapsedKeys]);

  /** 详情页的翻页序列：与当前列表顺序一致，搜索时就是搜索结果 */
  const flat = useMemo(() => {
    const out: Fragment[] = [];
    for (const sec of sections) {
      for (const it of sec.data) if (it.kind === 'fragment') out.push(it.fragment);
    }
    return out;
  }, [sections]);

  /**
   * 详情页真正拿到的碎片：按进入时的 id 顺序，从当前 props 里实时取。
   * 编辑保存会触发 reload，这里自动拿到新内容，详情页不用关掉重开。
   */
  const detailItems = useMemo(() => {
    if (!detail) return [];
    const byId = new Map<number, Fragment>();
    for (const f of fragments) byId.set(f.id, f);
    const out: Fragment[] = [];
    for (const id of detail.ids) {
      const f = byId.get(id);
      if (f) out.push(f);
    }
    return out;
  }, [detail, fragments]);

  const todayCount = useMemo(() => {
    const key = dayKey(Date.now());
    return fragments.filter((f) => dayKey(f.createdAt) === key).length;
  }, [fragments]);

  const searchStat = useMemo(() => {
    if (!narrowed) return null;
    return {
      total: visibleFragments.length,
      // 「还没整理」按 organizedAt 算。用 status 的话永远是全部条数（v0.7 之后没人改它）
      pending: visibleFragments.filter((f) => !f.organizedAt).length,
    };
  }, [narrowed, visibleFragments]);

  /**
   * 每条碎片正文里命中几处。只算 `visibleFragments` —— 列表里没有的东西数了也没人看。
   *
   * 依赖写 visibleFragments 而不是 fragments：筛选变化时它会变，而 fragments / query 都没变；
   * 只挂前两个的话，从「全部」切到一个标签下，徽标上的数还是旧的那批。
   */
  const hitCounts = useMemo(() => {
    const map = new Map<number, number>();
    if (!query.trim()) return map;
    for (const f of visibleFragments) map.set(f.id, countHits(f.content, query));
    return map;
  }, [visibleFragments, query]);

  /** 命中总数，给统计行用 */
  const hitTotal = useMemo(() => {
    let n = 0;
    for (const v of hitCounts.values()) n += v;
    return n;
  }, [hitCounts]);

  const canSend = draft.trim().length > 0 && !sending;

  async function submit() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onAdd(text);
      onDraftChange('');
      // 刚记完必须能看见：万一用户把今天也折叠了，这里替他展开。
      // 折叠一个「刚往里写了东西的日期」没有任何意义。
      setCollapsedDays((prev) => {
        if (!prev || !prev.has(todayKey)) return prev;
        const next = new Set(prev);
        next.delete(todayKey);
        return next;
      });
      inputRef.current?.focus();
      scrollToTopSoon();
    } finally {
      setSending(false);
    }
  }

  /**
   * 记完回到顶部。否则当列表滚到下面时，新记的这条在顶部，
   * 用户会觉得"我明明记了却没看见"。
   */
  function scrollToTopSoon() {
    setTimeout(() => {
      try {
        listRef.current?.scrollToLocation({
          sectionIndex: 0,
          itemIndex: 0,
          animated: true,
          viewOffset: 0,
        });
      } catch {
        /* 数据尚未重排完成时忽略，滚动只是锦上添花 */
      }
    }, 140);
  }

  /** 底部轻提示。1.8 秒够读完一行字，又不至于一直杵在那儿 */
  function showToast(text: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(''), 1800);
  }

  /**
   * 长按 = 复制正文。以前长按是打开编辑小窗，但那件事在详情页里做得更好；
   * 而在时间轴上，「把这句话拿到别处去」比「就地改」常见得多。
   */
  async function copyFragment(f: Fragment) {
    await Clipboard.setStringAsync(f.content);
    if (Platform.OS !== 'web') {
      try {
        const Haptics = require('expo-haptics');
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch {
        /* 震动失败不影响复制 */
      }
    }
    setOpenRow(null);
    showToast('已复制这条碎片');
  }

  /** 二次确认之后才真删 —— 滑动露出按钮太容易误触，不能一步到位 */
  async function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    setOpenRow(null);
    await onDelete(id);
    showToast('已删除');
  }

  /** 点一条碎片先读，不直接进编辑 —— 想通读长文时不该先得到一个光标 */
  function openDetail(f: Fragment, q?: string) {
    inputRef.current?.blur();
    setOpenRow(null);
    const i = flat.findIndex((x) => x.id === f.id);
    setDetail({ ids: flat.map((x) => x.id), index: i < 0 ? 0 : i, query: q });
  }

  /** 再点同一个事项就取消 —— 否则筛选开了没法用同一个手势关掉 */
  function toggleFilter(value: string) {
    setFilter((prev) => (prev && prev.value === value ? null : { kind: 'project', value }));
  }

  /** 第一次点击时把「默认只展开今天」固化成显式集合，之后完全按用户的来 */
  function toggleDay(key: string) {
    setCollapsedDays((prev) => {
      const next = new Set(prev ?? collapsedKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleNote(id: number) {
    setArmedNoteDelete(null);
    setExpandedNotes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 删除总结要两次点击，和删碎片一致 —— 内容没了就真没了 */
  async function removeNote(id: number) {
    if (armedNoteDelete !== id) {
      setArmedNoteDelete(id);
      return;
    }
    setArmedNoteDelete(null);
    await onDeleteNote(id);
  }

  function toggleExpand(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.brand} numberOfLines={1}>
            碎片
          </Text>
          {tightHeader ? null : (
            <Text style={styles.brandSub} numberOfLines={1}>
              {todayCount > 0 ? `今天记了 ${todayCount} 条` : '今天还没记东西'}
            </Text>
          )}
        </View>

        <View style={styles.headerActions}>
          {/* 文档、回顾、设置，最后是加大一号的「问」 */}
          <IconButton
            name="documents-outline"
            size={19}
            tone="soft"
            color={c.text2}
            diameter={34}
            onPress={onOpenDocs}
            accessibilityLabel="文档：上传并阅读文档"
          />
          <IconButton
            name="checkmark-circle-outline"
            size={20}
            tone="soft"
            color={c.text2}
            diameter={34}
            onPress={onOpenReview}
            accessibilityLabel="回顾待办与小结"
          />
          <IconButton
            name="settings-outline"
            size={20}
            tone="soft"
            color={c.text2}
            diameter={34}
            onPress={onOpenSettings}
            accessibilityLabel="设置"
          />
          {/*
            问 放在最右边、也比别人大一圈（用户 2026-11-11 要求）：
            它是这一页真正的常用动作 —— 记完就想问，整理也在这里发起。
          */}
          <IconButton
            name="chatbubble-ellipses-outline"
            size={23}
            tone="accent"
            color={c.accentText}
            diameter={42}
            onPress={() => onOpenAsk()}
            accessibilityLabel="问：查自己的记录，或者让它整理"
          />
        </View>
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color={c.text3} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索碎片原文、事项"
            placeholderTextColor={c.text3}
            style={styles.searchInput}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {searching ? (
            <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="清除搜索">
              <Ionicons name="close-circle" size={17} color={c.text3} />
            </Pressable>
          ) : null}
        </View>
        {filter ? (
          <View style={styles.filterRow}>
            <Pressable
              style={({ pressed }) => [styles.filterChip, pressed && { opacity: 0.6 }]}
              onPress={() => setFilter(null)}
              accessibilityRole="button"
              accessibilityLabel="取消筛选"
            >
              <Ionicons name="folder-open" size={11} color={c.accentText} />
              <Text style={styles.filterText} numberOfLines={1}>
                {filter.value}
              </Text>
              <Ionicons name="close" size={12} color={c.accentText} />
            </Pressable>
          </View>
        ) : null}
        {searchStat ? (
          <Text style={styles.searchStat}>
            {searchStat.total === 0
              ? '没有匹配的碎片'
              : !searching
                ? `找到 ${searchStat.total} 条${searchStat.pending > 0 ? ` · ${searchStat.pending} 条还没整理` : ''}`
                : hitTotal > 0
                  ? // 有正文命中就报处数：用户搜「NAS」，想知道的是「一共有几处用得上」
                    `找到 ${searchStat.total} 条 · ${hitTotal} 处`
                  : // 只命中了标签 / 事项。报「0 处」会让人以为搜错了，得说清是正文没有
                    `找到 ${searchStat.total} 条 · 正文无命中`}
          </Text>
        ) : null}
      </View>

      <View style={styles.flex}>
        {sections.length === 0 ? (
          narrowed ? (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Ionicons name="search-outline" size={26} color={c.text3} />
              </View>
              <Text style={styles.emptyTitle}>没有匹配的碎片</Text>
              <Text style={styles.emptyBody}>
                {filter ? '换个事项看看，或者点上面的胶囊清掉筛选' : '换个词试试，记的时候不用斟酌措辞'}
              </Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Ionicons name="create-outline" size={26} color={c.text3} />
              </View>
              <Text style={styles.emptyTitle}>还没有碎片</Text>
              <Text style={styles.emptyBody}>
                想到什么就在下面写一句，{'\n'}不用管分类。攒够了去「问」里说一句整理，它会提炼成知识文档。
              </Text>
              {Platform.OS === 'web' && onSeed ? (
                <Pressable onPress={onSeed} hitSlop={8} style={styles.seedBtn}>
                  <Text style={styles.seedText}>填入示例碎片看看效果</Text>
                </Pressable>
              ) : null}
            </View>
          )
        ) : (
          <SectionList
            ref={listRef}
            sections={displaySections}
            keyExtractor={(item) => `${item.kind}-${item.id}`}
            stickySectionHeadersEnabled
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            // 一滚动就把滑开的操作区收起来：敞着一行往下翻，看着像忘了关
            onScrollBeginDrag={() => setOpenRow(null)}
            renderSectionHeader={({ section }) => {
              const closed = collapsedKeys.has(section.key);
              /*
               * 展开的月里那些天是「已经展开的东西」，再点一下收起来只会让
               * 月头显示「N 条」而下面空着，用户会以为是 bug。所以它们只当分隔线用。
               */
              const locked = searching || !!section.nested;
              return (
                <Pressable
                  style={({ pressed }) => [
                    styles.sectionHeader,
                    section.nested && styles.sectionHeaderNested,
                    pressed && !locked && styles.sectionHeaderPressed,
                  ]}
                  onPress={() => {
                    if (!locked) toggleDay(section.key);
                  }}
                  disabled={locked}
                >
                  <View style={styles.sectionHeaderRow}>
                    <Text style={[styles.sectionTitle, section.nested && styles.sectionTitleNested]}>
                      {section.title}
                    </Text>
                    <Text style={[styles.sectionSub, section.nested && styles.sectionSubNested]}>
                      {section.sub} · {section.total} 条
                    </Text>
                    {locked ? null : (
                      <Ionicons
                        name={closed ? 'chevron-forward' : 'chevron-down'}
                        size={15}
                        color={c.text3}
                      />
                    )}
                  </View>
                  {section.preview ? (
                    <Text style={styles.sectionPreview} numberOfLines={1}>
                      {section.preview}
                    </Text>
                  ) : null}
                </Pressable>
              );
            }}
            renderItem={({ item, index, section }) => {
              const isLast = index === section.data.length - 1;

              if (item.kind === 'note') {
                const note = item.note;
                const open = expandedNotes.has(note.id);
                return (
                  <Pressable
                    onPress={() => toggleNote(note.id)}
                    style={({ pressed }) => [styles.noteRow, pressed && styles.rowPressed]}
                  >
                    <Text style={styles.time}>
                      {note.type === 'daily' ? formatTime(item.at) : ''}
                    </Text>
                    <View style={styles.rail}>
                      {!isLast && <View style={styles.railLine} />}
                      <View style={styles.noteDot} />
                    </View>
                    <View style={styles.noteCard}>
                      <View style={styles.noteHead}>
                        <Ionicons name="sparkles" size={13} color={c.accent} />
                        <Text style={styles.noteKind}>{NOTE_KIND[note.type] ?? '总结'}</Text>
                        <Text style={styles.notePeriod}>{periodLabel(note.period)}</Text>
                      </View>
                      <NoteBody
                        text={note.bodyMd}
                        numberOfLines={open ? undefined : 5}
                        style={styles.noteBody}
                      />
                      <View style={styles.noteFoot}>
                        <Text style={styles.noteToggle}>{open ? '收起' : '展开全文'}</Text>
                        {open && (
                          <Pressable
                            onPress={() => removeNote(note.id)}
                            hitSlop={8}
                            style={styles.noteDeleteHit}
                          >
                            <Text style={styles.noteDelete}>
                              {armedNoteDelete === note.id ? '再点一次确认删除' : '删除这条总结'}
                            </Text>
                          </Pressable>
                        )}
                      </View>
                    </View>
                  </Pressable>
                );
              }

              const fragment = item.fragment;
              const merged = fragment.mergedInto !== null;
              const done = doneIds.has(fragment.id);
              /** 正文里命中几处。进了搜索才有值，普通浏览时是 undefined */
              const hitCount = hitCounts.get(fragment.id) ?? 0;
              /** 搜索时把词带进详情页，正文才描得出高亮、也才有「第 i / N 处」可跳 */
              const hitQuery = searching ? query.trim() : undefined;
              return (
                <SwipeRow
                  open={openRow?.id === fragment.id ? openRow.side : null}
                  onOpen={(side) => setOpenRow({ id: fragment.id, side })}
                  onClose={() => setOpenRow(null)}
                  onPress={() => openDetail(fragment, hitQuery)}
                  onLongPress={() => copyFragment(fragment)}
                  // 方向由用户 2026-10-31 明确：右滑 → 左侧「问」，左滑 → 右侧「删除」
                  leftAction={{
                    label: '问',
                    icon: 'chatbubble-ellipses-outline',
                    bg: c.accent,
                    fg: c.onAccent,
                    onPress: () => onOpenAsk(fragment.id),
                  }}
                  leftInstant
                  rightAction={{
                    label: '删除',
                    icon: 'trash-outline',
                    bg: c.danger,
                    // 红底上的字只能是白的，深色主题下 c.onAccent 是深蓝，压不住
                    fg: '#FFFFFF',
                    // 先收起操作区再弹确认：取消之后不该留一条敞开着的红条
                    onPress: () => {
                      setOpenRow(null);
                      setDeleteTarget(fragment);
                    },
                  }}
                  style={styles.row}
                  pressedStyle={styles.rowPressed}
                >
                  <Text style={styles.time}>{formatTime(fragment.createdAt)}</Text>
                  <View style={styles.rail}>
                    {!isLast && <View style={styles.railLine} />}
                    <View style={[styles.dot, merged && styles.dotMuted]} />
                  </View>
                  <View style={styles.rowBody}>
                    {(() => {
                      // 60 字大约才三行，随手记详细一点就被折了，放宽到 100
                      const long = fragment.content.length > 100 || fragment.content.includes('\n');
                      const open = expandedIds.has(fragment.id);
                      return (
                        <>
                          <NoteBody
                            text={fragment.content}
                            numberOfLines={long && !open ? 3 : undefined}
                            style={styles.content}
                            muted={merged}
                          />
                          {long ? (
                            <Pressable
                              onPress={() => toggleExpand(fragment.id)}
                              hitSlop={8}
                              style={styles.expandBtn}
                            >
                              <Text style={styles.expandText}>
                                {open ? '收起' : `展开全文 · ${fragment.content.length} 字`}
                              </Text>
                            </Pressable>
                          ) : null}
                        </>
                      );
                    })()}
                    {(hitCount > 0 ||
                      fragment.project ||
                      fragment.source !== 'app' ||
                      merged ||
                      done ||
                      !!fragment.organizedAt) && (
                      <View style={styles.metaRow}>
                        {/* 命中处数。点它进详情并从第一处开始跳 —— 正文长的时候，
                            「找到了但不知道在哪」比搜不到更难受 */}
                        {hitCount > 0 ? (
                          <Pressable
                            onPress={() => openDetail(fragment, hitQuery)}
                            hitSlop={4}
                            accessibilityRole="button"
                            accessibilityLabel={`正文命中 ${hitCount} 处，点开查看`}
                            style={({ pressed }) => pressed && { opacity: 0.55 }}
                          >
                            <View style={styles.hitBadge}>
                              <Text style={styles.hitBadgeText}>{hitCount} 处</Text>
                            </View>
                          </Pressable>
                        ) : null}
                        {done ? (
                          <View style={styles.doneBadge}>
                            <Ionicons name="checkmark" size={11} color={c.tealText} />
                            <Text style={styles.doneBadgeText}>已完成</Text>
                          </View>
                        ) : null}
                        {/*
                          「已整理」：这条的产出已经进过文档库。
                          标签拆掉之后这是唯一能看出整理状态的东西，
                          所以给它一点颜色（青），但不能盖过「已完成」。
                        */}
                        {!!fragment.organizedAt ? (
                          <View style={styles.orgBadge}>
                            <Ionicons name="sparkles" size={10} color={c.accentText} />
                            <Text style={styles.orgBadgeText}>已整理</Text>
                          </View>
                        ) : null}
                        {fragment.project ? (
                          <Text
                            style={styles.project}
                            numberOfLines={1}
                            onPress={() => toggleFilter(fragment.project as string)}
                            accessibilityRole="button"
                            accessibilityLabel={`按事项 ${fragment.project} 筛选`}
                          >
                            {fragment.project}
                          </Text>
                        ) : null}
                        {fragment.source !== 'app' ? (
                          <Ionicons
                            name={fragment.source === 'notif' ? 'notifications-outline' : 'share-outline'}
                            size={12.5}
                            color={c.text3}
                          />
                        ) : null}
                        {merged ? <Text style={styles.mergedTag}>已合并</Text> : null}
                      </View>
                    )}
                  </View>
                </SwipeRow>
              );
            }}
            ListFooterComponent={<View style={{ height: 12 }} />}
          />
        )}

        <View style={[styles.composerWrap, { paddingBottom: 10 + keyboardHeight }]}>
          <View style={styles.composer}>
            <TextInput
              ref={inputRef}
              value={draft}
              onChangeText={onDraftChange}
              placeholder="随手记一条…"
              placeholderTextColor={c.text3}
              style={styles.input}
              multiline
              maxLength={2000}
              onSubmitEditing={submit}
              blurOnSubmit={false}
              returnKeyType="default"
            />
            <Pressable onPress={() => setFullEdit(true)} hitSlop={8} style={styles.expandIcon}>
              <Ionicons name="expand-outline" size={17} color={c.text2} />
            </Pressable>
            <Pressable
              onPress={submit}
              disabled={!canSend}
              style={[styles.send, canSend && styles.sendActive]}
              hitSlop={6}
            >
              <Ionicons name="arrow-up" size={18} color={canSend ? c.onAccent : c.text3} />
            </Pressable>
          </View>
        </View>
      </View>

      {/* 轻提示排在覆盖层之前：它只该压在列表上，不该盖住确认弹层 */}
      <Toast text={toast} bottom={80 + keyboardHeight} />

      {/*
        详情页是全屏覆盖层，JSX 顺序就是层叠顺序，必须排在列表之后。
        这里只存 id —— 存快照的话编辑保存后它还是旧内容。
      */}
      {detail && detailItems.length > 0 ? (
        <FragmentDetail
          key={detail.ids[detail.index] ?? 0}
          items={detailItems}
          initialIndex={Math.min(detail.index, detailItems.length - 1)}
          doneIds={doneIds}
          notes={notes}
          highlightQuery={detail.query}
          onClose={() => setDetail(null)}
          onSave={onEdit}
          onDelete={onDelete}
        />
      ) : null}

      {/*
        删除确认。仍然不用 Modal：滑开才露出按钮，误触概率不低，
        所以必须有个明确的第二道门；但 Modal 在安卓上是独立窗口，
        会画到状态栏底下、也收不到键盘事件，覆盖层 + BackHandler 才稳。
      */}
      {deleteTarget ? (
        // paddingBottom 让卡片落在键盘上方 —— 记完一条顺手滑掉它时，键盘往往还开着
        <View style={[styles.overlay, styles.dialogOverlay, { paddingBottom: keyboardHeight }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setDeleteTarget(null)} />
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>删除这条碎片？</Text>
            <Text style={styles.dialogBody} numberOfLines={3}>
              {deleteTarget.content}
            </Text>
            <Text style={styles.dialogHint}>删除后无法恢复。已经整理进文档的内容不会跟着消失。</Text>
            <View style={styles.dialogActions}>
              <Pressable onPress={() => setDeleteTarget(null)} hitSlop={8}>
                <Text style={styles.muted}>取消</Text>
              </Pressable>
              <Pressable onPress={confirmDelete} hitSlop={8}>
                <Text style={styles.dangerText}>删除</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {/*
        长文记录用覆盖层，不用 Modal。
        Modal 在 Android 上是一个独立窗口：拿到的是窗口级 inset，长文页顶部会直接顶到
        状态栏底下和通知栏重合；键盘事件也不会从 Activity 根视图冒上来，躲不开输入法。
        覆盖层留在同一棵 React 树里，安全区已经由外层 SafeAreaView 让出来了。
      */}
      {fullEdit ? (
        <View style={[styles.overlay, styles.fullOverlay, { paddingBottom: keyboardHeight }]}>
          <View style={styles.fullHeader}>
            <Pressable onPress={() => setFullEdit(false)} hitSlop={10}>
              <Text style={styles.muted}>取消</Text>
            </Pressable>
            <Text style={styles.fullTitle}>长文记录</Text>
            <Pressable
              onPress={async () => {
                setFullEdit(false);
                await submit();
              }}
              hitSlop={10}
              disabled={!canSend}
            >
              <Text style={[styles.primary, !canSend && styles.muted]}>保存</Text>
            </Pressable>
          </View>
          <TextInput
            ref={fullInputRef}
            value={draft}
            onChangeText={onDraftChange}
            style={styles.fullInput}
            multiline
            placeholder="想写多少写多少。长一点也没关系，整理时 AI 会单独提炼要点。"
            placeholderTextColor={c.text3}
            maxLength={20000}
          />
          <Text style={styles.fullCount}>{draft.length} 字</Text>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.page },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingLeft: 20,
    paddingRight: 14,
    paddingTop: 6,
    paddingBottom: 10,
  },
  headerLeft: { flexShrink: 1 },
  brand: { fontSize: 22, color: c.text, fontWeight: '600', letterSpacing: 0.8 },
  brandSub: { fontSize: 12, color: c.text3, marginTop: 2 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  // 搜索框放在页头下，用浅灰底和留白跟列表区分，不额外加边框
  searchWrap: {
    paddingHorizontal: 20,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  filterRow: { flexDirection: 'row', marginTop: 8 },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: R.pill,
    backgroundColor: c.accentBg,
  },
  filterText: { fontSize: 12, color: c.accentText, fontWeight: '500', maxWidth: 220 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    height: 38,
    backgroundColor: c.hairSoft,
    borderRadius: R.btn + 2,
    paddingHorizontal: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: c.text,
    paddingVertical: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
  },
  searchStat: { fontSize: 11.5, color: c.text3, marginTop: 7, paddingLeft: 2 },

  listContent: { paddingBottom: 8 },
  // 收起态是两行（日期 + 一条预览），所以 header 从 row 改成 column
  sectionHeader: {
    paddingHorizontal: 20,
    paddingTop: 15,
    paddingBottom: 9,
    backgroundColor: c.page,
  },
  sectionHeaderPressed: { backgroundColor: c.hairSoft },
  /** 展开的月里拆出来的天：往左缩一点、小一号，视觉上挂在月头下面 */
  sectionHeaderNested: { paddingLeft: 32, paddingTop: 11, paddingBottom: 6 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { fontSize: 13.5, color: c.text, fontWeight: '600', letterSpacing: 0.3 },
  sectionTitleNested: { fontSize: 12.5, color: c.text2, fontWeight: '500' },
  sectionSubNested: { color: c.text3 },
  sectionSub: {
    flex: 1,
    fontSize: 11,
    color: c.text3,
    fontVariant: ['tabular-nums'],
  },
  sectionPreview: { fontSize: 12, lineHeight: 17, color: c.text3, marginTop: 5 },

  row: { flexDirection: 'row', paddingHorizontal: 20 },
  rowPressed: { backgroundColor: c.hairSoft },
  time: {
    width: 44,
    fontSize: 11.5,
    color: c.text3,
    paddingTop: 3,
    fontVariant: ['tabular-nums'],
  },
  rail: { width: 16, alignItems: 'center' },
  railLine: { position: 'absolute', top: 17, bottom: -8, width: 1, backgroundColor: c.hair },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: c.text3,
    marginTop: 7,
  },
  dotMuted: { backgroundColor: c.hair },
  rowBody: { flex: 1, paddingBottom: 18, paddingLeft: 2 },
  content: { fontSize: 15, lineHeight: 23, color: c.text },
  expandBtn: { marginTop: 6, alignSelf: 'flex-start' },
  expandText: { fontSize: 12.5, color: c.accent },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  project: { fontSize: 11, color: c.text3, maxWidth: 120 },
  mergedTag: { fontSize: 11, color: c.text3 },

  // 已完成标记：浅青底小胶囊，比标签低调，不和用户自己的 tag 抢注意力
  doneBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: c.tealBg,
    borderRadius: R.pill,
    paddingLeft: 5,
    paddingRight: 8,
    paddingVertical: 2,
  },
  doneBadgeText: { fontSize: 10.5, lineHeight: 15, color: c.tealText },
  /** 「已整理」：和「已完成」并排时不抢戏，用主色淡淡的底 */
  orgBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: c.accentBg,
    borderRadius: R.pill,
    paddingLeft: 5,
    paddingRight: 8,
    paddingVertical: 2,
  },
  orgBadgeText: { fontSize: 10.5, lineHeight: 15, color: c.accentText },
  /**
   * 命中处数徽标。观感贴着小号 TagPill，但颜色固定走 amber 系 ——
   * 标签色是按标签名算的，命中数是系统信息，不该跟着标签的配色跑。
   */
  hitBadge: {
    backgroundColor: c.amberBg,
    borderRadius: R.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  hitBadgeText: { fontSize: 11, lineHeight: 15, color: c.amberText, fontWeight: '500' },

  // 周期总结条目
  noteRow: { flexDirection: 'row', paddingHorizontal: 20 },
  noteDot: {
    width: 9,
    height: 9,
    borderRadius: 2,
    backgroundColor: c.accent,
    marginTop: 5,
    transform: [{ rotate: '45deg' }],
  },
  noteCard: {
    flex: 1,
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
    marginLeft: 2,
  },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  noteKind: { fontSize: 11.5, color: c.accentText, fontWeight: '600' },
  notePeriod: { flex: 1, fontSize: 11, color: c.text3 },
  noteBody: { fontSize: 14.5, lineHeight: 23, color: c.text },
  noteFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  noteToggle: { fontSize: 12.5, color: c.accent },
  noteDeleteHit: { paddingVertical: 2 },
  noteDelete: { fontSize: 11, color: c.danger },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 60 },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: c.hairSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  emptyTitle: { fontSize: 15.5, color: c.text2, fontWeight: '500' },
  emptyBody: {
    fontSize: 13,
    color: c.text3,
    textAlign: 'center',
    lineHeight: 21,
    marginTop: 10,
  },
  seedBtn: { marginTop: 22, paddingVertical: 6, paddingHorizontal: 10 },
  seedText: { fontSize: 12, color: c.accent, textDecorationLine: 'underline' },

  composerWrap: {
    paddingHorizontal: 16,
    paddingTop: 9,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
    backgroundColor: c.page,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    backgroundColor: c.card,
    borderRadius: R.card + 2,
    borderWidth: 0.5,
    borderColor: c.hair,
    paddingLeft: 14,
    paddingRight: 8,
    paddingVertical: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    lineHeight: 21,
    color: c.text,
    maxHeight: 108,
    paddingTop: 4,
    paddingBottom: 4,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
  },
  send: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.hairSoft,
  },
  sendActive: { backgroundColor: c.accent },
  expandIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.hairSoft,
    marginRight: 2,
    marginBottom: 1,
  },

  fullHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  fullTitle: { fontSize: 14, color: c.text, fontWeight: '500' },
  fullInput: {
    flex: 1,
    fontSize: 15,
    lineHeight: 23,
    color: c.text,
    paddingHorizontal: 18,
    paddingVertical: 16,
    textAlignVertical: 'top',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
  },
  fullCount: { fontSize: 11, color: c.text3, textAlign: 'right', paddingHorizontal: 18, paddingBottom: 16 },

  /** 覆盖整个内容区；安全区由外层 SafeAreaView 负责，这里只管层叠 */
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: c.page,
  },
  fullOverlay: { paddingTop: 12 },

  // 删除确认：压在列表正中的一块卡片，底色比 scrim 亮，一眼能分出「这是要你决定」的层
  dialogOverlay: {
    backgroundColor: c.scrim,
    justifyContent: 'center',
    paddingHorizontal: 26,
  },
  dialog: {
    backgroundColor: c.card,
    borderRadius: R.card,
    padding: 20,
    gap: 10,
  },
  dialogTitle: { fontSize: 15, color: c.text, fontWeight: '600' },
  dialogBody: { fontSize: 12.5, color: c.text2, lineHeight: 19 },
  dialogHint: { fontSize: 11.5, color: c.text3, lineHeight: 17 },
  dialogActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 26,
    marginTop: 4,
  },
  dangerText: { fontSize: 13, color: c.danger, fontWeight: '500' },
  muted: { fontSize: 13, color: c.text2 },
  primary: { fontSize: 13, color: c.accent, fontWeight: '500' },
});
