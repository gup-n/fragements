import { BusyIndicator as ActivityIndicator } from '../components/BusyIndicator';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Image,
  Platform,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import type { Fragment, Note, PendingFragmentImage } from '../types';
import { R, SPACE, TYPE, surfaceStroke, useTheme, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { WEB_INPUT_RESET } from '../util/platformStyle';
import { NoteBody } from '../components/NoteBody';
import { IconButton } from '../components/IconButton';
import { EmptyState } from '../components/EmptyState';
import { GlassBackdrop, glassable } from '../components/GlassBackdrop';
import { FragmentDetail } from '../components/FragmentDetail';
import { SwipeRow } from '../components/SwipeRow';
import { Toast } from '../components/Toast';
import { dayKey, dayLabel, daySubLabel, formatTime, periodAnchor, periodLabel } from '../util/date';
import { countHits } from '../util/highlight';
import { shortPreview } from '../util/text';
import { useKeyboardHeight } from '../util/keyboard';
import { fragmentSearchText, imageStateOf, imageTextsOf } from '../util/fragmentText';
import { imageToken, removeToken, stripImageTokens } from '../util/inlineImages';
import { mergeWindowHits, olderCount } from '../util/paging';
import { fragmentImageUri } from '../db/fragmentImages';
import { repo } from '../db/repo';

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
 * 折叠状态下分区头那一行预览。
 *
 * 收起的日期 / 月份必须能让人判断「里面大概是什么」——
 * 否则用户只能一天天点开看，折叠就只是把内容藏起来。
 */
function previewOfItem(item: TimelineItem): string {
  if (item.kind === 'fragment') {
    // 正文里的 `![](img:12)` 是给渲染层看的定位标记，预览里要换成一句人话
    const text = stripImageTokens(item.fragment.content).replace(/\s+/g, ' ').trim();
    if (text) return text;
    // 纯图碎片没有正文：折叠起来的时候至少要看得见「这里有一张图」，
    // 否则那一行是空白，用户会以为碎片丢了
    const pic = imageTextsOf(item.fragment).join(' · ').replace(/\s+/g, ' ');
    const n = item.fragment.images.length;
    return pic ? `[${n} 张图] ${pic}` : `[${n} 张图]`;
  }
  return item.note.bodyMd.replace(/[#*>\-\n]+/g, ' ').trim();
}

/**
 * 冷启动只自动聚焦一次。放在模块作用域而不是 useRef，
 * 是因为从设置页/知识库返回时会卸载再挂载，用 ref 会反复弹键盘。
 */
let autoFocusedOnce = false;

/**
 * 「展开全文」四周补出来的触控区。
 *
 * 这一行看得见只有 26（一行 13 号字），上下各补一点才是好按的高度。
 * 补得**不对称**：上面只给 2，因为再往上就是正文最后一行 ——
 * 给多了会把「点正文打开详情」的那一块抢走；下面给 12，那里本来就是行间空白。
 */
const EXPAND_SLOP = { top: 2, bottom: 12, left: 8, right: 8 };

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
  pendingImages: PendingFragmentImage[];
  onPendingImagesChange: React.Dispatch<React.SetStateAction<PendingFragmentImage[]>>;
  nextImageKey: () => string;
  /** 返回字符串表示已提交，但刷新等后续步骤需要提示；不能当成保存失败。 */
  onAdd: (text: string, images?: PendingFragmentImage[]) => Promise<void | string>;
  onEdit: (id: number, text: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onDeleteNote: (id: number) => Promise<void>;
  onOpenAsk: (fragmentId?: number) => void;
  /**
   * 通知栏「记一条」点进来的计数器。
   *
   * 页面已经在时间轴时不会重新挂载，冷启动那次自动聚焦就不会再跑一遍 ——
   * 用户点了通知却停在原地，等于入口是坏的。所以用一个自增值当信号。
   */
  focusSignal?: number;
  /**
   * 库里一共多少条碎片（v0.26）。
   *
   * `fragments` 从这一版起只是**已加载的一窗**，不是全部；「还有多少更早的」
   * 只能拿总数减，不能拿「这一页满没满」反推。
   */
  total?: number;
  /** 正在读更早那一页。按钮据此变成「读取中…」并禁用 */
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** 正在读字的**配图 id**（不是碎片 id：一条可能有好几张图，各读各的） */
  imageBusy: Set<number>;
  /** 读图失败的原因（配图 id → 一句话）。必须能就地重试 */
  imageFail: Record<string, string>;
  onReparseImage: (fragment: Fragment, imageId: number) => void;
  /** 详情页里给已有碎片补图。返回落库后的配图（id 用来在正文里插定位标记） */
  onAddImages: (
    fragmentId: number,
    uris: string[],
  ) => Promise<{ id: number; path: string }[]>;
  /** 详情页里删掉一张图 */
  onRemoveImage: (imageId: number) => Promise<void>;
}

export function TimelineScreen({
  fragments,
  notes,
  doneIds,
  draft,
  onDraftChange,
  pendingImages: pending,
  onPendingImagesChange: setPending,
  nextImageKey,
  onAdd,
  onEdit,
  onDelete,
  onDeleteNote,
  onOpenAsk,
  focusSignal,
  total = 0,
  loadingOlder = false,
  onLoadOlder,
  imageBusy,
  imageFail,
  onReparseImage,
  onAddImages,
  onRemoveImage,
}: Props) {
  const { c, styles, metrics } = useThemedStyles(makeStyles);
  const { reduceMotion } = useTheme();
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState(false);
  const sendingRef = useRef(false);
  const pickingRef = useRef(false);
  const alive = useRef(true);
  const draftRef = useRef(draft);
  const pendingRef = useRef(pending);
  draftRef.current = draft;
  pendingRef.current = pending;
  const composerBusy = sending || picking;
  const [composerNotice, setComposerNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  function changeDraft(next: string) {
    if (sendingRef.current || pickingRef.current) return;
    draftRef.current = next;
    onDraftChange(next);
    setComposerNotice(null);
  }

  function navigate(run: () => void) {
    if (!sendingRef.current && !pickingRef.current) run();
  }

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  /**
   * 当前滑开的那一行。存 id 而不是布尔值 —— 父级统一持有才能保证同时只开一行。
   * 展开状态放在父级还有个好处：列表一滚动就能整片收起。
   */
  const [openRow, setOpenRow] = useState<{ id: number; side: 'left' | 'right' } | null>(null);
  /** 等着二次确认的删除目标。null = 没弹层 */
  const [deleteTarget, setDeleteTarget] = useState<Fragment | null>(null);
  /** 底部轻提示，复制成功 / 删除成功都走它 */
  const [toast, setToast] = useState('');
  const [composerHeight, setComposerHeight] = useState(108);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());
  const [armedNoteDelete, setArmedNoteDelete] = useState<number | null>(null);
  const [fullEdit, setFullEdit] = useState(false);
  // 待发图与定位键由 App 持有；本页只持有光标和临时展开状态。
  /** 输入框光标。插图插在光标处，不是一律追加到末尾 */
  const [sel, setSel] = useState({ start: 0, end: 0 });
  /** 加图的方式菜单（拍照 / 相册）。不用 Modal：本项目一律 absolute + 自接返回键 */
  const [imageMenu, setImageMenu] = useState(false);
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
   * 展开的「月里面的某一天」。空集合 = 全部收起。
   *
   * v0.18 把更早的月份折成「N月记录」，展开后虽然分出了天，但那些天被
   * `locked` 掉了、点不动 —— 用户 2026-11-11 报「似乎这里只有单级折叠」。
   * 现在天默认是**收起**（一行日期 + 条数 + 首条摘要），点一下才铺开，
   * 跟本月按天分区是同一套手感。默认收起而不是默认铺开，是因为展开一个月
   * 本来就是「先看看这个月都有哪几天」。
   */
  const [openedDays, setOpenedDays] = useState<Set<string>>(new Set());
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

  // 通知栏点进来：页面可能已经在这，重新把光标放回输入框
  useEffect(() => {
    if (!focusSignal) return;
    if (fullEdit) setFullEdit(false);
    const timer = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, [focusSignal]);

  // 长文记录是覆盖层而非 Modal，安卓返回键得自己处理，否则直接退出 App。
  // 顺序是「先关最上面那层」：确认弹层压在长文编辑之上。
  useEffect(() => {
    if (!deleteTarget && !fullEdit && !imageMenu && !composerBusy) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sendingRef.current || pickingRef.current) return true;
      if (imageMenu) setImageMenu(false);
      else if (deleteTarget) setDeleteTarget(null);
      else if (fullEdit) setFullEdit(false);
      return true;
    });
    return () => sub.remove();
  }, [deleteTarget, fullEdit, imageMenu, composerBusy]);

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
  /*
   * 还有多少更早的。
   *
   * 搜索时不显示：搜索是**整库**的（FTS），结果里本来就没有「更早的」这个概念，
   * 再挂一句「还有 380 条」会让人以为搜漏了。
   * 按事项筛选不一样 —— 它只在已加载的这一窗里筛，所以必须说出来，
   * 同时保留补页的入口（否则用户会以为这个事项只有两条）。
   */
  const older = searching ? 0 : olderCount(total, fragments.length);
  const todayKey = dayKey(Date.now());

  /**
   * 搜索直接在内存里过滤，不走 SQLite：碎片本来就全量躺在 props 里，
   * 再压一个查询接口下去，反而拿不到 project 这个内存字段的匹配。
   *
   * 只搜「看得见的东西」。以前还搜 tags，但标签已经不在界面上显示了 ——
   * 靠一个看不见的字段命中，用户只会觉得「搜到了什么？哪儿呢」。
   */
  /*
   * 搜索：窗口内命中的 + **整库**检索回来的。
   *
   * v0.26 之前首页拿着全量数组，`includes` 一遍就等于整库搜索；换成按页读之后
   * 只搜窗口就会变成「搜不到三个月前的词，还写着找到 0 条」——
   * 那是这个版本最容易犯、也最难被自己发现的错。
   * FTS 分不出 1 个字或 emoji，所以本地那一路留着，两路按 id 合并。
   */
  const [dbHits, setDbHits] = useState<Fragment[] | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setDbHits(null);
      return;
    }
    let alive = true;
    // 150ms：打字过程里不必每敲一个字就查一次库，但也不能等太久
    const timer = setTimeout(() => {
      repo
        .searchFragments(q, 200)
        .then((list) => { if (alive) setDbHits(list); })
        // 检索失败就只说本地命中的那些，别把「库搜不了」说成「搜不到」
        .catch(() => { if (alive) setDbHits(null); });
    }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [query]);

  const visibleFragments = useMemo(() => {
    const base = filter ? fragments.filter((f) => f.project === filter.value) : fragments;
    const q = query.trim().toLowerCase();
    if (!q) return base;
    const local = base.filter((f) => fragmentSearchText(f).toLowerCase().includes(q));
    const remote = (dbHits ?? []).filter((f) => !filter || f.project === filter.value);
    return mergeWindowHits(local, remote);
  }, [fragments, query, filter, dbHits]);

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
      return first ? previewOfItem(first) : '';
    };

    const out: DisplaySection[] = [];
    for (const sec of sections) {
      const collapsed = collapsedKeys.has(sec.key);
      if (sec.level === 'month' && !collapsed) {
        /*
         * 展开的月 = 一个月头 + 若干天。月头只画一次（点它收回去），
         * 数据全部下放到天分区 —— 不再是一大坨没有日期分隔的流水。
         * 每个天分区自己还能再折一层，这就是两级折叠。
         */
        out.push({ ...sec, data: [], total: sec.data.length, preview: '', headerOnly: true });
        const byDay = new Map<string, DisplaySection>();
        for (const item of sec.data) {
          const key = `d:${dayKey(item.at)}`;
          const spread = openedDays.has(key);
          let bucket = byDay.get(key);
          if (!bucket) {
            const day = new Date(item.at);
            day.setHours(0, 0, 0, 0);
            bucket = {
              key,
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
          bucket.total += 1;
          if (!spread) {
            // 收起时只留一句预览：这一行要能替用户判断「要不要点开」
            if (!bucket.preview) bucket.preview = previewOfItem(item);
            continue;
          }
          bucket.data.push(item);
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
  }, [sections, collapsedKeys, openedDays]);

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
    for (const f of visibleFragments) map.set(f.id, countHits(stripImageTokens(f.content), query));
    return map;
  }, [visibleFragments, query]);

  /** 命中总数，给统计行用 */
  const hitTotal = useMemo(() => {
    let n = 0;
    for (const v of hitCounts.values()) n += v;
    return n;
  }, [hitCounts]);

  const imageHitCounts = useMemo(() => {
    const counts = new Map<number, number>();
    if (!query.trim()) return counts;
    for (const fragment of visibleFragments) counts.set(fragment.id, countHits(imageTextsOf(fragment).join('\n'), query));
    return counts;
  }, [visibleFragments, query]);
  const imageHitTotal = useMemo(() => Array.from(imageHitCounts.values()).reduce((sum, count) => sum + count, 0), [imageHitCounts]);

  // 只有图没有字也能发：随手拍一张报错屏，不写备注是最常见的用法
  const canSend = (draft.trim().length > 0 || pending.length > 0) && !composerBusy;

  /** 换成多图后最多几张：九宫格是用户在手机上最熟悉的张数上限，超过就说明该拆成几条了 */
  const MAX_IMAGES = 9;

  /**
   * 选图。`camera` 走系统相机，`library` 走相册（可多选）。
   *
   * 压缩只靠 `quality`：图片落盘时统一转 JPEG，`quality` 才会真的生效。
   * 不引 `expo-image-manipulator` —— 多一个原生模块，只为省几百 KB，
   * 而这张图只在「转成文字」那一次被传上去，之后就不再传了。
   *
   * `inlineHere` = 从长文记录里点的：要给每张图在光标处留一行定位标记，
   * 这样图长在那段文字中间，而不是全都堆到正文上方。
   */
  async function pickImage(from: 'camera' | 'library', inlineHere = false) {
    if (pickingRef.current || sendingRef.current) return;
    setImageMenu(false);
    if (Platform.OS === 'web') {
      showToast('网页版加不了图片，请在手机上使用');
      return;
    }
    pickingRef.current = true;
    setPicking(true);
    try {
      if (from === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!alive.current) return;
        if (!perm.granted) {
          setComposerNotice({ kind: 'err', text: '没给相机权限，请去系统设置里打开' });
          return;
        }
      }
      const room = MAX_IMAGES - pendingRef.current.length;
      if (room <= 0) {
        showToast(`一条最多 ${MAX_IMAGES} 张图，再多请拆成两条记`);
        return;
      }
      const res = from === 'camera'
        ? await ImagePicker.launchCameraAsync({ quality: 0.5 })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'], quality: 0.5, allowsMultipleSelection: true, selectionLimit: room,
          });
      // 系统选择器回来时原页面可能已销毁，旧选择不能混入另一份输入。
      if (!alive.current || res.canceled || !res.assets?.length) return;
      const available = Math.max(0, MAX_IMAGES - pendingRef.current.length);
      const picked = res.assets.slice(0, available).map((asset) => ({ key: nextImageKey(), uri: asset.uri }));
      pendingRef.current = [...pendingRef.current, ...picked];
      setPending((previous) => [...previous, ...picked]);
      if (inlineHere && picked.length) insertTokens(picked.map((picture) => picture.key));
      if (picked.length < res.assets.length) showToast(`只加了前 ${picked.length} 张，一条最多 ${MAX_IMAGES} 张`);
    } catch (e) {
      if (alive.current) setComposerNotice({ kind: 'err', text: e instanceof Error ? `选图失败：${e.message}` : '选图失败，请重试' });
    } finally {
      pickingRef.current = false;
      if (alive.current) setPicking(false);
    }
  }

  /** 在本次光标处插入由 App 分配、不会在切页后复用的待发键。 */
  function insertTokens(keys: string[]) {
    const current = draftRef.current;
    const at = Math.min(sel.start, current.length);
    const before = current.slice(0, at);
    const after = current.slice(at);
    const block = keys.map((key) => imageToken(key)).join('\n');
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    const tail = after && !after.startsWith('\n') ? '\n' : '';
    const next = `${before}${lead}${block}${tail}${after}`;
    draftRef.current = next;
    onDraftChange(next);
    setSel({ start: at + lead.length + block.length, end: at + lead.length + block.length });
  }

  function dropPending(key: string) {
    if (sendingRef.current || pickingRef.current) return;
    pendingRef.current = pendingRef.current.filter((picture) => picture.key !== key);
    setPending((previous) => previous.filter((picture) => picture.key !== key));
    changeDraft(removeToken(draftRef.current, key));
  }

  async function submit() {
    const submittedDraft = draftRef.current;
    const text = submittedDraft.trim();
    const pictures = pendingRef.current.slice();
    if ((!text && !pictures.length) || sendingRef.current || pickingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setComposerNotice(null);
    try {
      const notice = await onAdd(text, pictures.length ? pictures : undefined);
      if (!alive.current) return;
      const submittedKeys = new Set(pictures.map((picture) => picture.key));
      pendingRef.current = pendingRef.current.filter((picture) => !submittedKeys.has(picture.key));
      setPending((previous) => previous.filter((picture) => !submittedKeys.has(picture.key)));
      // 不清空异步期间被其它来源更新的文字；只清理本次确实提交的那份。
      if (draftRef.current === submittedDraft) {
        draftRef.current = '';
        onDraftChange('');
      }
      setComposerNotice(notice ? { kind: 'ok', text: notice } : null);
      showToast(notice || '已记录');
      setCollapsedDays((previous) => {
        if (!previous || !previous.has(todayKey)) return previous;
        const next = new Set(previous);
        next.delete(todayKey);
        return next;
      });
      if (fullEdit) setFullEdit(false);
      inputRef.current?.focus();
      scrollToTopSoon();
    } catch (e) {
      if (alive.current) setComposerNotice({ kind: 'err', text: e instanceof Error ? `没记上：${e.message}` : '没记上，请重试' });
    } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
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
          animated: !reduceMotion,
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
    toastTimer.current = setTimeout(() => setToast(''), 4000);
  }

  /**
   * 长按 = 复制正文。以前长按是打开编辑小窗，但那件事在详情页里做得更好；
   * 而在时间轴上，「把这句话拿到别处去」比「就地改」常见得多。
   */
  async function copyFragment(f: Fragment) {
    /*
     * 纯图碎片没有正文。复制一个空串，用户粘出来是一片空白，
     * 却收到「已复制」的提示 —— 那是在骗他。有图文字就复制图文字。
     */
    const text = stripImageTokens(f.content).trim() || imageTextsOf(f).join('\n\n');
    if (!text) {
      setOpenRow(null);
      showToast('这条只有图片，没有可复制的文字');
      return;
    }
    await Clipboard.setStringAsync(text);
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
    try { await onDelete(id); showToast('已删除'); }
    catch (error) { showToast(error instanceof Error ? error.message : '删除失败，请重试'); }
  }

  /** 点一条碎片先读，不直接进编辑 —— 想通读长文时不该先得到一个光标 */
  function openDetail(f: Fragment, q?: string) {
    if (sendingRef.current || pickingRef.current) return;
    inputRef.current?.blur();
    setOpenRow(null);
    const i = flat.findIndex((x) => x.id === f.id);
    setDetail({ ids: flat.map((x) => x.id), index: i < 0 ? 0 : i, query: q });
  }

  /** 再点同一个事项就取消 —— 否则筛选开了没法用同一个手势关掉 */
  function toggleFilter(value: string) {
    setFilter((prev) => (prev && prev.value === value ? null : { kind: 'project', value }));
  }

  /** 展开 / 收起「月里面的某一天」。和 toggleDay 分开：两套折叠层级各记各的 */
  function toggleNestedDay(key: string) {
    setOpenedDays((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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

  /**
   * 拍照 / 相册的选择行。抽成函数是因为它要在两个地方出现：
   * 底部输入区（图落到正文上方）和长文记录（图插在光标处）。
   * `inlineHere` 决定选完图要不要一并插定位标记。
   *
   * **必须是排版里的一行，不能是浮在输入区上方的弹层**（v0.20.2）：
   * 弹层用 `position: absolute` + `bottom: 100%` 挂在输入区上边界，
   * 那个位置刚好是键盘抬起来之后被盖住的地方 —— 用户得先收起输入法才点得到，
   * 而且长文页和随手记两处同时中招。放进卡片内部当普通一行，
   * 它会跟着输入区一起被键盘顶上来，位置天然正确。
   */
  function imagePickerRow(inlineHere: boolean) {
    return (
      <View style={[styles.pickRow, inlineHere && styles.pickRowFull]}>
        <Pressable style={[styles.pickChip, styles.touchTarget]} onPress={() => void pickImage('camera', inlineHere)}>
          <Ionicons name="camera-outline" size={16} color={c.text2} />
          <Text style={styles.pickChipText}>拍一张</Text>
        </Pressable>
        <Pressable style={[styles.pickChip, styles.touchTarget]} onPress={() => void pickImage('library', inlineHere)}>
          <Ionicons name="images-outline" size={16} color={c.text2} />
          <Text style={styles.pickChipText}>从相册选</Text>
        </Pressable>
        <View style={styles.flex} />
        <Pressable onPress={() => setImageMenu(false)} style={[styles.dialogAction, styles.touchTarget]} accessibilityRole="button" accessibilityLabel="收起加图">
          <Text style={styles.pickCancel}>取消</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.pageContent} importantForAccessibility={fullEdit || deleteTarget || (detail && detailItems.length > 0) ? 'no-hide-descendants' : 'auto'}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.brand} numberOfLines={1} accessibilityRole="header">碎片</Text>
        </View>
        <View style={styles.todaySummary} accessible accessibilityLabel={`今天已记 ${todayCount} 条`}>
          <Text style={styles.todayNumber}>{todayCount}</Text>
          <Text style={styles.brandSub}>今天</Text>
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
<IconButton name="close-circle-outline" size={20} onPress={() => setQuery("")} accessibilityLabel="清除搜索" />
          ) : null}
        </View>
        {filter ? (
          <View style={styles.filterRow}>
            <Pressable
              style={({ pressed }) => [[styles.filterChip, pressed && { opacity: 0.6 }], styles.touchTarget]}
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
                : hitTotal > 0 || imageHitTotal > 0
                  ? `找到 ${searchStat.total} 条 · 正文 ${hitTotal} 处${imageHitTotal ? ` · 图片文字 ${imageHitTotal} 处` : ''}`
                  : `找到 ${searchStat.total} 条 · 事项匹配`}
          </Text>
        ) : null}
      </View>

      <View style={styles.flex}>
        {sections.length === 0 ? (
          narrowed ? (
            <EmptyState
              fill
              icon="search-outline"
              title="没有匹配的碎片"
              body={filter ? '换个事项，或点上面的胶囊清掉' : '换个词试试'}
            />
          ) : (
            /*
             * 空状态只说一句话。原来两行说明（「不用管分类」「攒够了去问里整理」）
             * 都是在解释产品，而人此刻只想记点什么 —— DeepSeek 的空屏也只有一句问候。
             *
             * tone="accent"：这是全 App 唯一一个「希望你做点什么」的空屏，
             * 其它空屏（搜不到、没待办、没文档）都是中性的浅灰。
             */
            <EmptyState fill tone="accent" icon="sparkles" title="今天记点什么？" />
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
              /*
               * 两级折叠各记各的：月头看 collapsedKeys，月里的天看 openedDays。
               * 两者默认都是收起，但含义不同 —— 月是「先看这个月有哪几天」，
               * 天是「再看那天写了什么」。
               */
              const closed = section.nested
                ? !openedDays.has(section.key)
                : collapsedKeys.has(section.key);
              const locked = searching;
              return (
                <Pressable
                  style={({ pressed }) => [[
                    styles.sectionHeader,
                    section.nested && styles.sectionHeaderNested,
                    pressed && !locked && styles.sectionHeaderPressed,
                  ], styles.touchTarget]}
                  onPress={() => {
                    if (locked) return;
                    if (section.nested) toggleNestedDay(section.key);
                    else toggleDay(section.key);
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
                    style={({ pressed }) => [[styles.noteRow, pressed && styles.rowPressed], styles.touchTarget]}
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
                            style={[styles.noteDeleteHit, styles.touchTarget]}
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
                    onPress: () => navigate(() => onOpenAsk(fragment.id)),
                  }}
                  leftInstant
                  rightAction={{
                    label: '删除',
                    icon: 'trash-outline',
                    bg: c.danger,
                    // 危险底色使用独立前景色，深色/墨水下不固定白字。
                    fg: c.onDanger,
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
                      /*
                       * 图片定位标记在这一行没有意义 —— 下面本来就有一排缩略图。
                       * 不剥的话，「展开全文」旁边会多出一行「〔图片〕」，
                       * 和缩略图说的是同一件事。
                       */
                      const shown = stripImageTokens(fragment.content);
                      // 60 字大约才三行，随手记详细一点就被折了，放宽到 100
                      const long = shown.length > 100 || shown.includes('\n');
                      const open = expandedIds.has(fragment.id);
                      return (
                        <>
                          <NoteBody
                            text={shown}
                            numberOfLines={long && !open ? 3 : undefined}
                            style={styles.content}
                            muted={merged}
                          />
                          {long ? (
                            <Pressable
                              onPress={() => toggleExpand(fragment.id)}
                              hitSlop={EXPAND_SLOP}
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
                    {/*
                      配图。缩略图一排 + 一行状态。
                      图里的字还在读时必须说出来 —— 否则用户看到的就是一张图，
                      永远不知道「模型其实还没看过它」。
                    */}
                    {fragment.images.length ? (
                      <View style={styles.imageBlock}>
                        <View style={styles.thumbRow}>
                          {fragment.images.slice(0, 4).map((img) => {
                            const st = imageStateOf(img, imageBusy, imageFail);
                            return (
                              <View key={img.id} style={styles.thumbWrap}>
                                <Image
                                  source={{ uri: fragmentImageUri(img.path) ?? undefined }}
                                  style={styles.imageThumb}
                                  resizeMode="cover"
                                />
                                {st === 'busy' ? (
                                  <View style={styles.thumbMask}>
                                    <ActivityIndicator size="small" color={c.mediaForeground} />
                                  </View>
                                ) : st === 'fail' ? (
                                  <View style={styles.thumbMask}>
                                    <Ionicons name="alert-circle-outline" size={17} color={c.mediaForeground} />
                                  </View>
                                ) : null}
                              </View>
                            );
                          })}
                          {fragment.images.length > 4 ? (
                            <View style={[styles.imageThumb, styles.thumbMore]}>
                              <Text style={styles.thumbMoreText}>
                                +{fragment.images.length - 4}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                        {(() => {
                          const texts = imageTextsOf(fragment);
                          const matchCount = imageHitCounts.get(fragment.id) ?? 0;
                           if (searching && matchCount > 0) {
                             const combined = texts.join(' · ');
                             const start = Math.max(0, combined.toLowerCase().indexOf(query.trim().toLowerCase()) - 32);
                             const excerpt = combined.slice(start, start + Math.max(150, query.trim().length + 64));
                             return (
                               <View style={styles.imageMatch}>
                                 <Text style={styles.imageMatchLabel}>图片文字命中 {matchCount} 处</Text>
                                 <Text style={styles.imageNote} numberOfLines={4}>{start ? '…' : ''}{excerpt}</Text>
                               </View>
                             );
                           }
                           const reading = fragment.images.some((i) => imageBusy.has(i.id));
                          const bad = fragment.images.find((i) => imageFail[String(i.id)]);
                          if (reading) return <Text style={styles.imageNote}>正在读图里的字…</Text>;
                          if (bad)
                            return (
                              <Pressable
                                onPress={() => onReparseImage(fragment, bad.id)} style={styles.touchTarget}
                              >
                                <Text
                                  style={[styles.imageNote, styles.imageNoteErr]}
                                  numberOfLines={2}
                                >
                                  有 {fragment.images.filter((i) => imageFail[String(i.id)]).length}{' '}
                                  张没读出文字 · 点这里重试
                                </Text>
                              </Pressable>
                            );
                          if (texts.length)
                            return (
                              <Text style={styles.imageNote} numberOfLines={3}>
                                {shortPreview(texts.join(' · '), 90)}
                              </Text>
                            );
                          const allTried = fragment.images.every((i) => i.text !== null);
                          return (
                            <Text style={styles.imageNote}>
                              {allTried
                                ? '图里没有可读的字'
                                : '图里的字还没读 · 整理或提问时会看'}
                            </Text>
                          );
                        })()}
                      </View>
                    ) : null}
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
                            accessibilityRole="button"
                            accessibilityLabel={`正文命中 ${hitCount} 处，点开查看`}
                            style={({ pressed }) => [pressed && { opacity: 0.55 }, styles.touchTarget]}
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
                            size={13}
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
            /*
             * 底栏：还有更早的记录时给一个按钮，否则只留 12 的收尾留白。
             *
             * 是**主动动作**而不是滚到底自动拉：自动加载会让「往下翻几条」
             * 变成一次不可控的读库，而用户往下翻通常只想看最近的。
             */
            ListFooterComponent={
              <>
                {filter && older > 0 ? (
                  <Text style={styles.olderHint}>
                    按事项筛选只在已加载的 {fragments.length} 条里进行，更早的还没读进来。
                  </Text>
                ) : null}
                {older > 0 || loadingOlder ? (
                  <Pressable
                    style={({ pressed }) => [[styles.olderBtn, pressed && !loadingOlder && { backgroundColor: c.accentBg }], styles.touchTarget]}
                    onPress={onLoadOlder}
                    disabled={loadingOlder}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: loadingOlder }}
                    accessibilityLabel={loadingOlder ? '正在读取更早的碎片' : `加载更早的 ${older} 条`}
                  >
                    <Text style={styles.olderText}>
                      {loadingOlder ? '读取中…' : `加载更早的 ${older} 条`}
                    </Text>
                  </Pressable>
                ) : null}
                <View style={{ height: 12 }} />
              </>
            }
          />
        )}

        <View onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)} style={[styles.composerWrap, { paddingBottom: 10 + keyboardHeight }]}>
          {/*
            输入框在上、工具行在下（用户 2026-11-12 要求，参照 DeepSeek 的输入区）：
            文字区域独占整行宽度，展开 / 加图 / 发布退到下面一排 ——
            原来四个按钮挤在同一行里，长句子写两行就被压得只剩半行宽。
          */}
          <View style={styles.composerCard}>
            {/* 墨水风格下这张卡是透明的，靠毛玻璃把下方滚过的时间轴透出来 */}
            <GlassBackdrop radius={metrics.cardRadius} />
            {composerNotice ? <Text style={[styles.composerNotice, composerNotice.kind === 'err' && styles.imageNoteErr]} accessibilityLiveRegion="polite">{composerNotice.text}</Text> : null}
            {composerBusy ? <Text style={styles.composerNotice} accessibilityLiveRegion="polite">{sending ? '正在保存，暂时不能切换页面…' : '正在选择图片…'}</Text> : null}
            <TextInput
              ref={inputRef}
              value={draft}
              onChangeText={changeDraft}
              editable={!composerBusy}
              selectionColor={c.selection}
              onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
              placeholder={pending.length ? '这张图是什么？可留空' : '随手记一条…'}
              placeholderTextColor={c.text3}
              style={styles.input}
              multiline
              maxLength={2000}
              onSubmitEditing={submit}
              blurOnSubmit={false}
              returnKeyType="default"
            />

            {/*
              选好的图。横排缩略图，每张右上角一个叉 ——
              缩略图要大一点才能确认「是不是这张」，塞进一行里只能做成一枚小图标。
            */}
            {pending.length ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.pendingStrip}
                contentContainerStyle={styles.pendingStripContent}
                keyboardShouldPersistTaps="handled"
              >
                {pending.map((p, i) => (
                  <View key={p.key} style={styles.pendingItem}>
                    <Image source={{ uri: p.uri }} style={styles.pendingThumb} />
                    <Pressable
                      onPress={() => dropPending(p.key)}
                      style={[styles.pendingRemove, styles.touchTarget]}
                      accessibilityRole="button" accessibilityLabel={`不发第 ${i + 1} 张`} disabled={composerBusy} accessibilityState={{ disabled: composerBusy }}
                    >
                      <View style={styles.pendingRemoveFace}><Ionicons name="close" size={14} color={c.mediaForeground} /></View>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            ) : null}

            {/* 加图选择行：在卡片内部，键盘弹着也点得到 */}
            {imageMenu && !fullEdit ? imagePickerRow(false) : null}

            {/*
              工具行：展开在左，图片和发布在右（用户 2026-11-12 要求把图片图标挪到右边）。
              发布贴最右是肌肉记忆的位置，图片紧挨着它才不会让人去左边找。
            */}
            <View style={styles.composerBar}>
              <Pressable
                onPress={() => {
                  // 光标默认落在末尾：展开长文时人通常是接着往下写
                  setSel({ start: draft.length, end: draft.length });
                  navigate(() => setFullEdit(true));
                }}
                style={[styles.toolBtn, styles.touchTarget]}
                accessibilityRole="button" accessibilityLabel="展开成整页写" disabled={composerBusy} accessibilityState={{ disabled: composerBusy }}
              >
                <Ionicons name="expand-outline" size={16} color={c.text2} />
                <Text style={styles.toolLabel}>展开</Text>
              </Pressable>

              <View style={styles.flex} />

              <Pressable
                onPress={() => navigate(() => setImageMenu((v) => !v))}
                disabled={composerBusy}
                accessibilityState={{ expanded: imageMenu, disabled: composerBusy }}
                style={[[styles.toolBtn, imageMenu && styles.toolBtnOn], styles.touchTarget]}
                accessibilityLabel="加图片"
              >
                <Ionicons name="image-outline" size={16} color={c.text2} />
                <Text style={styles.toolLabel}>图片</Text>
                {pending.length ? (
                  <View style={styles.toolBadge}>
                    <Text style={styles.toolBadgeText}>{pending.length}</Text>
                  </View>
                ) : null}
              </Pressable>

              <Pressable
                onPress={submit}
                disabled={!canSend}
                style={[styles.send, canSend && styles.sendActive]}
                accessibilityRole="button" accessibilityLabel={sending ? "正在保存" : "发布这条碎片"} accessibilityState={{ disabled: !canSend, busy: sending }}
              >
                {/* DeepSeek 的发送就是一个圆形箭头，不带文字。可读的名字交给 accessibilityLabel */}
                {sending ? <ActivityIndicator size="small" color={c.onAccent} /> : <Ionicons name="arrow-up" size={20} color={canSend ? c.onAccent : c.text2} />}
              </Pressable>
            </View>
          </View>
        </View>
      </View>

      {/* 轻提示排在覆盖层之前：它只该压在列表上，不该盖住确认弹层 */}
      <Toast text={toast} bottom={composerHeight + 8} />
      </View>

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
          imageBusy={imageBusy}
          imageFail={imageFail}
          onReparseImage={onReparseImage}
          onAddImages={onAddImages}
          onRemoveImage={onRemoveImage}
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
        <View accessibilityViewIsModal style={[styles.overlay, styles.dialogOverlay, { paddingBottom: keyboardHeight }]}>
          <Pressable style={[StyleSheet.absoluteFill, styles.touchTarget]} onPress={() => setDeleteTarget(null)} />
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>删除这条碎片？</Text>
            <Text style={styles.dialogBody} numberOfLines={3}>
              {deleteTarget.content}
            </Text>
            <Text style={styles.dialogHint}>删除后无法恢复。已经整理进文档的内容不会跟着消失。</Text>
            <View style={styles.dialogActions}>
              <Pressable onPress={() => setDeleteTarget(null)} style={[styles.dialogAction, styles.touchTarget]} accessibilityRole="button">
                <Text style={styles.muted}>取消</Text>
              </Pressable>
              <Pressable onPress={confirmDelete} style={[styles.dialogAction, styles.touchTarget]} accessibilityRole="button">
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
            <Pressable onPress={() => navigate(() => setFullEdit(false))} style={[styles.dialogAction, styles.touchTarget]} accessibilityRole="button" accessibilityLabel="收起长文，保留草稿" disabled={composerBusy}>
              <Text style={styles.muted}>收起</Text>
            </Pressable>
            <Text style={styles.fullTitle} accessibilityRole="header">长文记录</Text>
            <Pressable
              onPress={async () => {
                await submit();
              }}
              style={[styles.dialogAction, styles.touchTarget]}
              disabled={!canSend} accessibilityRole="button" accessibilityState={{ disabled: !canSend, busy: sending }}
            >
              <Text style={[styles.primary, !canSend && styles.muted]}>保存</Text>
            </Pressable>
          </View>
          <TextInput
            ref={fullInputRef}
            value={draft}
            onChangeText={changeDraft}
              editable={!composerBusy}
              selectionColor={c.selection}
            onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
            style={styles.fullInput}
            multiline
            placeholder="想写多少写多少。长一点也没关系，整理时 AI 会单独提炼要点。"
            placeholderTextColor={c.text3}
            maxLength={20000}
          />

          {/*
            长文里的图必须能插在正文中间（用户 2026-11-12：
            「我如果中间文本需要加一张图片就无法做到」）。
            所以这里单独给一条插图入口：选完就把 `![](img:p1)` 写进光标处。
          */}
          {pending.length ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.fullThumbs}
              contentContainerStyle={styles.fullThumbsContent}
              keyboardShouldPersistTaps="handled"
            >
              {pending.map((p, i) => (
                <View key={p.key} style={styles.pendingItem}>
                  <Image source={{ uri: p.uri }} style={styles.pendingThumb} />
                  <Pressable
                    onPress={() => dropPending(p.key)}
                    style={[styles.pendingRemove, styles.touchTarget]}
                    accessibilityRole="button" accessibilityLabel={`不发第 ${i + 1} 张`} disabled={composerBusy} accessibilityState={{ disabled: composerBusy }}
                  >
                    <View style={styles.pendingRemoveFace}><Ionicons name="close" size={14} color={c.mediaForeground} /></View>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}

          {/* 同上：选择行走正常流，贴在底栏上方，键盘弹着也点得到 */}
          {imageMenu ? imagePickerRow(true) : null}

          <View style={styles.fullBar}>
            <GlassBackdrop radius={0} tone="bar" />
            {composerNotice ? <Text style={[styles.composerNotice, composerNotice.kind === 'err' && styles.imageNoteErr]} accessibilityLiveRegion="polite">{composerNotice.text}</Text> : null}
            <Text style={styles.fullCount}>
              {draft.length} 字
              {pending.length ? ` · ${pending.length} 张图插在光标处` : ''}
            </Text>
            <Pressable
              onPress={() => navigate(() => setImageMenu((v) => !v))}
                disabled={composerBusy}
                accessibilityState={{ expanded: imageMenu, disabled: composerBusy }}
              style={[[styles.toolBtn, imageMenu && styles.toolBtnOn], styles.touchTarget]}
              accessibilityLabel="在光标处插图"
            >
              <Ionicons name="image-outline" size={18} color={c.text2} />
              {pending.length ? (
                <View style={styles.toolBadge}>
                  <Text style={styles.toolBadgeText}>{pending.length}</Text>
                </View>
              ) : null}
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  touchTarget: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight },
  pageContent: { flex: 1 },
  dialogAction: { minHeight: metrics.controlHeight, minWidth: metrics.controlHeight, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACE.sm },
  composerNotice: { ...TYPE.meta, color: c.text2, paddingVertical: 6, flexShrink: 1 },
  /** 左侧那道竖线是「这是一处正文命中」的标记；用 hair 而不是 focus —— 墨水主题的 focus 是纯黑 */
  imageMatch: { borderLeftWidth: 2, borderLeftColor: c.hair, paddingLeft: SPACE.xs, gap: SPACE.xxs },
  imageMatchLabel: { ...TYPE.label, color: c.text },
  pendingRemoveFace: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: c.mediaScrim },
  root: { flex: 1, backgroundColor: c.page },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: SPACE.md, paddingHorizontal: SPACE.md, paddingTop: 6, paddingBottom: 2,
  },
  headerLeft: { flex: 1, minWidth: 0 },
  /** 只留一个字标级标题：「碎片」+ 今日条数。上面那行小字已删（用户 2026-11-15 要求）。 */
  /*
   * 字标「碎片」：20/26 + 字距。
   *
   * 这是全项目唯一一处字标，没有第二个地方需要这个尺寸，所以不进 TYPE。
   * 它比卡片标题（18）大一点、比 display（28）小得多 —— 首页要的是
   * 「一眼知道这是哪」，不是「欢迎页」。
   */
  brand: { fontSize: 20, lineHeight: 26, fontWeight: '700', color: c.text, letterSpacing: 1 },
  brandSub: { ...TYPE.caption, color: c.text3 },
  todaySummary: { alignItems: 'center', paddingLeft: SPACE.md },
  /** 今日条数：和字标同字号、行高压紧，读成一枚数字而不是一行字 */
  todayNumber: { fontSize: 20, lineHeight: 22, fontWeight: '700', color: c.accentText, fontVariant: ['tabular-nums'] },
  // 搜索框放在页头下，用浅灰底和留白跟列表区分，不额外加边框
  searchWrap: {
    paddingHorizontal: SPACE.md,
    paddingBottom: SPACE.xs,
    borderBottomWidth: surfaceStroke(metrics),
    borderBottomColor: c.hair,
  },
  filterRow: { flexDirection: 'row', marginTop: 6 },
  filterChip: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: SPACE.xxs,
    borderRadius: R.pill,
    backgroundColor: c.accentBg,
  },
  filterText: { ...TYPE.label, color: c.accentText, maxWidth: 220 },
  /** 44 是视觉高度；搜索框是整行可点的输入控件，点哪都进，不需要 48 的方框感 */
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    backgroundColor: c.hairSoft,
    borderRadius: R.pill,
    paddingHorizontal: SPACE.md,
  },
  searchInput: { ...TYPE.body, flex: 1, color: c.text, paddingVertical: 0, ...WEB_INPUT_RESET },
  searchStat: { ...TYPE.meta, color: c.text3, marginTop: 5, paddingLeft: 2 },

  listContent: { paddingBottom: SPACE.xs },
  /** 「加载更早的」：列表最后一行，和空屏一样低调，不抢记录的注意力 */
  olderBtn: {
    marginHorizontal: SPACE.md,
    marginTop: SPACE.md,
    marginBottom: SPACE.lg,
    paddingVertical: SPACE.sm,
    alignItems: 'center',
    borderRadius: metrics.buttonRadius,
  },
  olderText: { ...TYPE.compact, color: c.accentText },
  /** 筛选中才出现的一句解释：不写就等于让人以为「这个事项只有两条」 */
  olderHint: {
    ...TYPE.meta,
    color: c.text3,
    marginHorizontal: SPACE.md,
    marginTop: SPACE.md,
  },
  // 收起态是两行（日期 + 一条预览），所以 header 从 row 改成 column
  sectionHeader: {
    paddingHorizontal: SPACE.md,
    paddingTop: 10,
    paddingBottom: 6,
    backgroundColor: c.page,
  },
  sectionHeaderPressed: { backgroundColor: c.hairSoft },
  /** 展开的月里拆出来的天：往左缩一点、小一号，视觉上挂在月头下面 */
  sectionHeaderNested: { paddingLeft: 28, paddingTop: SPACE.xs, paddingBottom: SPACE.xxs },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  sectionTitle: { ...TYPE.label, color: c.text, letterSpacing: 0.3 },
  sectionTitleNested: { ...TYPE.label, color: c.text2 },
  sectionSubNested: { color: c.text3 },
  sectionSub: { ...TYPE.meta, flex: 1, color: c.text3, fontVariant: ['tabular-nums'] },
  sectionPreview: { ...TYPE.meta, color: c.text3, marginTop: 3 },

  row: { flexDirection: 'row', paddingHorizontal: SPACE.md },
  rowPressed: { backgroundColor: c.hairSoft },
  time: { ...TYPE.meta, width: 40, color: c.text3, paddingTop: 3, fontVariant: ['tabular-nums'] },
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
  rowBody: { flex: 1, paddingBottom: 10, paddingLeft: 2 },
  /** 配图区：一排缩略图 + 下面一行状态 */
  imageBlock: { marginTop: SPACE.xs, gap: 6 },
  thumbRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  thumbWrap: { borderRadius: metrics.buttonRadius, overflow: 'hidden' },
  /** 列表缩略图 56：能认出「是不是这张」，又不至于一条碎片占掉半屏 */
  imageThumb: {
    width: 56,
    height: 56,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.hairSoft,
  },
  /** 压在图上的「正在读 / 读失败」标记：只有一层薄蒙版，不遮住图本身 */
  thumbMask: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.mediaScrim,
  },
  thumbMore: { alignItems: 'center', justifyContent: 'center' },
  thumbMoreText: { ...TYPE.label, color: c.text2 },
  imageNote: { ...TYPE.meta, color: c.text3 },
  imageNoteErr: { color: c.danger },

  content: { ...TYPE.body, color: c.text },
  /**
   * 「展开全文」原来是个 48 高的按钮，下面还压着 rowBody 的 14 底距 ——
   * 一条长碎片和它下一条之间因此空出 60 多 px，读起来像换了一页。
   *
   * 现在看得见的高度是 26（一行字 + 2 的上下留白），触控区靠 hitSlop 补到 48。
   * 收的是空白，不是可点范围。
   */
  expandBtn: { minHeight: 26, marginTop: 2, paddingVertical: 2, alignSelf: 'flex-start' },
  expandText: { ...TYPE.label, color: c.accent },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  project: { ...TYPE.meta, color: c.text3, maxWidth: 120 },
  mergedTag: { ...TYPE.meta, color: c.text3 },

  // 已完成标记：浅青底小胶囊，比标签低调，不和用户自己的 tag 抢注意力
  doneBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: c.tealBg,
    borderRadius: R.pill,
    paddingLeft: 5,
    paddingRight: SPACE.xs,
    paddingVertical: 2,
  },
  doneBadgeText: { ...TYPE.caption, color: c.tealText },
  /** 「已整理」：和「已完成」并排时不抢戏，用主色淡淡的底 */
  orgBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: c.accentBg,
    borderRadius: R.pill,
    paddingLeft: 5,
    paddingRight: SPACE.xs,
    paddingVertical: 2,
  },
  orgBadgeText: { ...TYPE.caption, color: c.accentText },
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
  hitBadgeText: { ...TYPE.meta, color: c.amberText },

  // 周期总结条目
  /** 和碎片行走同一个内边距：原来这里是写死的 20，比碎片行多缩进 4，两列对不齐 */
  noteRow: { flexDirection: 'row', paddingHorizontal: metrics.pagePadding },
  noteDot: {
    width: 9,
    height: 9,
    borderRadius: 2,
    backgroundColor: c.accent,
    marginTop: 5,
    transform: [{ rotate: '45deg' }],
  },
  /** 月总结卡：白底浮在浅灰页上就够分层了，不描边 */
  noteCard: {
    flex: 1,
    backgroundColor: c.card,
    borderRadius: metrics.cardRadius,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    marginBottom: SPACE.md,
    marginLeft: 2,
  },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: SPACE.xs },
  noteKind: { ...TYPE.label, color: c.accentText },
  notePeriod: { ...TYPE.meta, flex: 1, color: c.text3 },
  noteBody: { ...TYPE.body, color: c.text },
  noteFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  noteToggle: { ...TYPE.label, color: c.accent },
  noteDeleteHit: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight, paddingVertical: 2 },
  noteDelete: { ...TYPE.meta, color: c.danger },

  /**
   * 空态规格（全项目统一）：48 圆 + 浅灰底 + 标题 18 + 可选说明 14。
   *
   * 原来这里有三个不同尺寸的圆（52 的空态、52 的问候标记、44 的搜索图标）
   * 和三套字号，同一个 App 的空屏长得像三个产品。
   */
  composerWrap: {
    paddingHorizontal: SPACE.md,
    paddingTop: 6,
    paddingBottom: SPACE.xxs,
    backgroundColor: c.page,
  },
  /** 待发送的图：横排缩略图，每张右上角一个叉 */
  pendingStrip: { marginTop: 6 },
  pendingStripContent: { gap: 6, paddingRight: SPACE.xxs },
  pendingItem: { width: 52, height: 52 },
  pendingThumb: { width: 52, height: 52, borderRadius: metrics.buttonRadius, backgroundColor: c.hairSoft },
  pendingRemove: {
    position: 'absolute', top: -5, right: -5,
    width: 48, height: 48, padding: 5,
    alignItems: 'flex-end', justifyContent: 'flex-start',
  },
  /** 加图选择行：在输入卡片内部，跟着输入区一起被键盘顶上来的那一行 */
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.xs,
    paddingTop: SPACE.xxs,
    paddingBottom: 2,
    paddingRight: SPACE.xxs,
  },
  pickChip: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: SPACE.sm,
    paddingVertical: 7,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.hairSoft,
  },
  pickChipText: { ...TYPE.label, color: c.text },
  pickCancel: { ...TYPE.label, color: c.text3 },
  /** 长文页那一行要和正文的左边界对齐（正文用的是 pagePadding） */
  pickRowFull: { paddingHorizontal: metrics.pagePadding },
  /**
   * 输入区：DeepSeek 的那种浅灰大圆角块。
   *
   * **不用边框**。一圈 1px 的线会把输入区读成「表单里的一格」，而这里其实是个
   * 随处可写的框 —— 浅灰底 + 大圆角已经足够说明它和页面底色的区别。
   *
   * 圆角是 `cardRadius + 8`（默认 28、墨水 16）。写死 28 的话墨水主题也会得到
   * 一个圆滚滚的胶囊，和它 8 圆角的卡片摆在一起像两种语言。
   */
  composerCard: {
    backgroundColor: glassable(metrics, c.hairSoft),
    borderRadius: metrics.cardRadius + 8,
    paddingHorizontal: SPACE.md,
    paddingTop: 10,
    paddingBottom: SPACE.xs,
    overflow: 'hidden',
  },
  composerBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs, marginTop: 2,
  },
  toolBtn: {
    minWidth: 52, minHeight: metrics.controlHeight, flexDirection: 'row',
    gap: SPACE.xxs, paddingHorizontal: 6,
    borderRadius: metrics.buttonRadius, alignItems: 'center', justifyContent: 'center',
  },
  toolLabel: { ...TYPE.meta, color: c.text2, flexShrink: 1 },
  /** 菜单展开使用明确底色，不将未选中的操作都套一层卡片。 */
  toolBtnOn: { backgroundColor: c.accentBg },
  /** 已选图张数。压在图标右上角，不额外占位置 */
  toolBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 15,
    height: 15,
    borderRadius: 8,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accent,
  },
  toolBadgeText: { ...TYPE.caption, color: c.onAccent },
  /**
   * 文本区 38 高（用户 2026-11-15：看起来太高）。
   * 这是单/双行的书写密度，不是触控目标 —— 整张卡片都能点进输入框，
   * 真正需要 48 的是下面那排按钮，它们的 controlHeight 没动。
   */
  input: { ...TYPE.body, color: c.text, minHeight: 38, maxHeight: 120, paddingTop: 2, paddingBottom: SPACE.xxs, paddingRight: 6, ...WEB_INPUT_RESET },
  /** 圆形发送键：48×48 正好是触控下限，所以不用再套 touchTarget */
  send: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.hairSoft,
  },
  sendActive: { backgroundColor: c.accent },

  fullHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: metrics.pagePadding,
    paddingBottom: SPACE.sm,
    borderBottomWidth: surfaceStroke(metrics),
    borderBottomColor: c.hair,
  },
  fullTitle: { ...TYPE.title, color: c.text },
  fullInput: { ...TYPE.reading, flex: 1, color: c.text, paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.md, textAlignVertical: 'top', ...WEB_INPUT_RESET },
  fullCount: { ...TYPE.meta, flex: 1, color: c.text3 },
  /** 长文底栏：字数在左、插图在右，贴着键盘上沿 */
  fullBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.xs,
    paddingHorizontal: metrics.pagePadding,
    paddingTop: SPACE.xs,
    paddingBottom: SPACE.sm,
    borderTopWidth: surfaceStroke(metrics),
    borderTopColor: c.hair,
    backgroundColor: glassable(metrics, c.page),
    overflow: 'hidden',
  },
  fullThumbs: { flexGrow: 0 },
  fullThumbsContent: { gap: SPACE.xs, paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.xs },

  /** 覆盖整个内容区；安全区由外层 SafeAreaView 负责，这里只管层叠 */
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: c.page,
  },
  fullOverlay: { paddingTop: SPACE.sm },

  // 删除确认：压在列表正中的一块卡片，底色比 scrim 亮，一眼能分出「这是要你决定」的层
  dialogOverlay: {
    backgroundColor: c.scrim,
    justifyContent: 'center',
    paddingHorizontal: SPACE.xl,
  },
  dialog: {
    backgroundColor: c.card,
    borderRadius: metrics.cardRadius,
    padding: SPACE.lg,
    gap: 10,
  },
  dialogTitle: { ...TYPE.title, color: c.text },
  dialogBody: { ...TYPE.body, color: c.text2 },
  dialogHint: { ...TYPE.meta, color: c.text3 },
  dialogActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 26,
    marginTop: SPACE.xxs,
  },
  /** 对话框里的三个动作：都走 label 角色，原来各自写死 13 */
  dangerText: { ...TYPE.label, color: c.danger },
  muted: { ...TYPE.label, color: c.text2 },
  primary: { ...TYPE.label, color: c.accent },
});
