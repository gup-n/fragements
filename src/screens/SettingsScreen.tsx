import { BusyIndicator as ActivityIndicator } from '../components/BusyIndicator';
import React, { useEffect, useState } from 'react';
import {
  BackHandler,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReasoningEffort } from '../types';
import type { BackupManifest } from '../util/backupPlan';
import { humanBytes } from '../util/backupPlan';
import { isQuickRecordBlocked, isQuickRecordEnabled, setQuickRecordEnabled } from '../quickRecord';
import { digestReminderState, setDigestReminderEnabled } from '../digestReminder';
import { reminderWhenLabel } from '../util/digestReminder';
import type { SearchProbe } from '../db/types';
import {
  R,
  SPACE,
  TYPE,
  surfaceStroke,
  THEME_MODE_LABEL,
  THEME_STYLE_LABEL,
  TYPE_SCALE_LABEL,
  useTheme,
  useThemedStyles,
  type Palette,
  type ThemeMetrics,
} from '../theme';
import { WEB_INPUT_RESET } from '../util/platformStyle';
import { repo } from '../db/repo';
import { loadAiConfig, saveAiConfig } from '../ai/config';
import { AiError, testConnection } from '../ai/chat';
import { balanceLine, fetchBalance, officialOrigin, type BalanceResult } from '../ai/balance';
import { DEFAULT_AI_CONFIG } from '../types';
import { exportMarkdown } from '../export/markdown';
import { applyImport, pickMarkdown, previewImport, type ImportPreview } from '../db/importMd';
import { looksBinary } from '../util/mdParse';
import { ImportSheet } from '../components/ImportSheet';
import { APP_VERSION } from '../version';
import { ScreenHeader } from '../components/ScreenHeader';
import { TrashPane } from '../components/TrashPane';
import { ChoiceChip } from '../components/ChoiceChip';
import { useKeyboardHeight } from '../util/keyboard';
import { UpdateSheet } from '../components/UpdateSheet';
import {
  RELEASES_WEB,
  REPO_WEB,
  checkForUpdate,
  getAutoCheck,
  setAutoCheck,
  type ReleaseInfo,
} from '../update/check';
import { getDownloadBase, setDownloadBase } from '../update/mirror';
import { getMineruToken, setMineruToken } from '../ai/mineru';
import { versionLabel } from '../util/semver';
import { IconButton, type IoniconName } from '../components/IconButton';

interface Props {
  /** 作为底栏 tab 常驻时不画返回箭头（子页仍然要能回菜单） */
  embedded?: boolean;
  onClose?: () => void;
  /** 导入会新增碎片，得让 App 重新拉一遍时间轴 */
  onChanged: () => void;
  /**
   * 通知类开关拨完之后，让 App 拿当前数据对齐那条通知。
   *
   * 为什么要回到 App 做：对齐要知道「哪些月还没写」，而 App 手上已经有
   * 每次 reload 都取的每月条数与 notes。设置页只负责拨开关，不碰判据。
   */
  onReminderChange?: () => void | Promise<unknown>;
}

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  low: '轻',
  high: '标准',
  max: '深',
};

/**
 * 设置页的四个模块。
 *
 * 为什么拆开（用户 2026-11-12：「目前的设置界面功能较为杂乱，能否在其中进行分离」）：
 * 原来是一根长滚动条 —— 主题、Key、模型、思考强度、MinerU、统计、索引、导入导出、
 * 更新、包名连着排下来。找「主题」要滑过一整屏跟它无关的接口配置，
 * 找一个开关得先读完整页才能确定它在不在。
 *
 * 现在的分层和用户说的四个模块一一对应：
 * - `config`     配置：LLM 地址/Key/模型、思考过程与强度、MinerU Token
 * - `appearance` 外观：主题（字体 / 背景 / 风格后续也放这里）
 * - `data`       数据：条数、索引、导入导出（将来云端也放这里）
 * - `about`      关于：版本、更新、仓库、包名
 */
type Pane = 'root' | 'config' | 'appearance' | 'data' | 'trash' | 'about';

const PANE_TITLE: Record<Pane, string> = {
  root: '设置',
  config: '配置',
  appearance: '外观',
  data: '数据',
  trash: '回收站',
  about: '关于',
};

export function SettingsScreen({ embedded = false, onClose, onChanged, onReminderChange }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const { mode, setMode, style: themeStyle, setStyle, typeScale, setTypeScale, saveError } = useTheme();
  const keyboardHeight = useKeyboardHeight();
  /** 当前在哪一层。`root` 是模块菜单，其余是子页 */
  const [pane, setPane] = useState<Pane>('root');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [thinking, setThinking] = useState(true);
  const [effort, setEffort] = useState<ReasoningEffort>('high');
  const [showKey, setShowKey] = useState(false);
  /** 第三方接口设置。默认折叠起来 —— 绝大多数人只需要填一把 Key */
  const [showCustom, setShowCustom] = useState(false);
  /** 余额。null = 还没查 / 还没填 Key */
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [balanceBusy, setBalanceBusy] = useState(false);
  const [stats, setStats] = useState({ total: 0, pending: 0, todoOpen: 0 });
  const [busy, setBusy] = useState<
    | 'idle'
    | 'saving'
    | 'testing'
    | 'exporting'
    | 'indexing'
    | 'picking'
    | 'importing'
    | 'backing'
    | 'restoring'
  >('idle');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /** 完整备份的反馈。和 Markdown 的提示分开：两件事的失败原因完全不同 */
  const [bkMsg, setBkMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /** 通知栏常驻入口的开关状态。默认关：常驻通知该是用户主动开的 */
  const [quickOn, setQuickOn] = useState(false);
  const [quickMsg, setQuickMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /** 小结提醒开关。同样默认关：主动提醒该由用户点开 */
  const [remindOn, setRemindOn] = useState(false);
  const [remindMsg, setRemindMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /**
   * 开关开着、但系统里已经把通知关掉了。
   *
   * 两个开关共用一行提示：用户去系统设置里关一次权限，App 里那两行还都显示「开启」，
   * 之后再也没响过 —— 他只会觉得「这个功能坏了」。状态要在这里说出来。
   */
  const [quickBlocked, setQuickBlocked] = useState(false);
  const [remindBlocked, setRemindBlocked] = useState(false);
  /** 已经排定的提醒时刻（0 = 还没排）。这条提醒在响之前没有别的可见效果 */
  const [remindAt, setRemindAt] = useState(0);
  /**
   * 选好但还没确认的备份包。
   *
   * 恢复会覆盖当前数据库，所以必须先把它「是什么」摆出来（哪天的、
   * 多少条、来自哪个版本、有没有缺文件），再由用户按下确认。
   */
  const [restoreAsk, setRestoreAsk] = useState<{
    uri: string;
    name: string;
    manifest: BackupManifest;
    bytes: number;
    blocked: string | null;
  } | null>(null);
  /**
   * 数据区自己的反馈位。
   *
   * 原来所有操作共用上面那个 `msg`，而 `msg` 渲染在「AI 接口」卡片里 ——
   * 人在页面最下面点「重建搜索索引」，提示出现在屏幕上方几十甚至几百像素外，
   * 看起来就是「点了没反应」。分开之后，谁触发的就显示在谁旁边。
   */
  const [indexMsg, setIndexMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /** 导出/导入的反馈，渲染在它们自己的按钮下方 */
  const [ioMsg, setIoMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /** 启动时自动检查更新（默认开，存在 settings 表） */
  const [autoCheck, setAutoCheckOn] = useState(true);
  /** 自定义下载基础地址（自建 / 镜像），空串 = 走官方直连 + 镜像兜底 */
  const [downloadBase, setDownloadBaseOn] = useState('');
  const [baseMsg, setBaseMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /** MinerU Token。填了才能解 >10 MB / >20 页 / .doc/.ppt/.xls */
  const [mineruToken, setMineruTokenOn] = useState('');
  const [tokenMsg, setTokenMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkState, setCheckState] = useState<'idle' | 'latest' | 'update' | 'error'>('idle');
  const [checkMsg, setCheckMsg] = useState('');
  /** 设置页自己查到的更新，就地弹窗，不用回主界面 */
  const [update, setUpdate] = useState<ReleaseInfo | null>(null);
  /** 索引健康度。null = 还没查出来 */
  const [indexState, setIndexState] = useState<{ indexed: number; total: number } | null>(null);
  /** 搜索自检结果。checked = 抽了几条，hit = 有几条能搜回来 */
  const [probe, setProbe] = useState<SearchProbe | null>(null);
  /** 非空时弹导入确认页。选完文件先看预览，确认了才写库 */
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  /**
   * 回收站里有多少条。
   *
   * 它是「有没有东西等我处理」的提示，不需要实时 —— 进根页、从回收站退回来时各读一次就够。
   * v0.30 起放在**设置根页**（用户 2026-11-19 要求从「数据与备份」里独立出来）：
   * 删完东西想找回，去翻一个二级页是多余的。
   */
  const [trashCount, setTrashCount] = useState(0);

  useEffect(() => {
    if (pane !== 'root' && pane !== 'data' && pane !== 'trash') return;
    let cancelled = false;
    repo
      .trashCount()
      .then((n) => { if (!cancelled) setTrashCount(n); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [pane, stats.total]);

  useEffect(() => {
    (async () => {
      const cfg = await loadAiConfig();
      setBaseUrl(cfg.baseUrl);
      setModel(cfg.model);
      setApiKey(cfg.apiKey);
      setThinking(cfg.thinking);
      setEffort(cfg.effort);
      setAutoCheckOn(await getAutoCheck());
      setDownloadBaseOn(await getDownloadBase());
      setMineruTokenOn(await getMineruToken());
      /*
       * 余额先查一次。查不到不提示：设置页一打开就飘一条红字说「余额查询失败」，
       * 而用户只是来看看主题色的，那种体验比不显示更糟。
       */
      if (cfg.apiKey) {
        void fetchBalance(cfg).then(setBalance);
      }
      setStats(await repo.stats());
      // 先出条数（一次 COUNT，很快），自检要真跑几次搜索，后到不影响阅读
      setIndexState(await repo.searchIndexStats());
      setProbe(await repo.selfTestSearch(5));
      setQuickOn(await isQuickRecordEnabled());
      setQuickBlocked(await isQuickRecordBlocked());
      const remind = await digestReminderState();
      setRemindOn(remind.on);
      setRemindBlocked(remind.blocked);
      setRemindAt(remind.at);
    })();
  }, []);

  /**
   * 子页里的返回键先回模块菜单，再由 App 那一层决定是不是回时间轴。
   *
   * 不在 `pane` 变了才注册、而是首次就注册、内部判 `pane`：
   * 后者会让「从子页返回」变成先关掉整个设置页 —— 用户刚点进去就被弹出去了。
   * 这里只在子页时拦截，`root` 时 `return false` 让上层接手。
   */
  useEffect(() => {
    if (Platform.OS === 'web' || pane === 'root') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setPane('root');
      return true;
    });
    return () => sub.remove();
  }, [pane]);

  /**
   * 官方接口 = baseUrl 的域名是 api.deepseek.com。
   *
   * 不另存一个 provider 字段：两份状态迟早对不上（改了地址忘了改 provider，
   * 界面显示「官方」而请求打去了第三方）。地址就是唯一判据。
   */
  const official = officialOrigin(baseUrl) !== null;

  /** 查余额。失败不拦任何操作，只是这一行字 */
  async function refreshBalance(force = false) {
    if (!apiKey.trim()) {
      setBalance({ kind: 'error', message: '还没填 API Key' });
      return;
    }
    setBalanceBusy(true);
    try {
      setBalance(await fetchBalance({ baseUrl, model, apiKey, thinking, effort }, force));
    } finally {
      setBalanceBusy(false);
    }
  }

  function switchToOfficial() {
    setBaseUrl(DEFAULT_AI_CONFIG.baseUrl);
    setModel(DEFAULT_AI_CONFIG.model);
    setMsg({ kind: 'ok', text: '已切回官方地址和默认模型，记得点保存' });
  }

  async function handleSave() {
    setBusy('saving');
    setMsg(null);
    try {
      await saveAiConfig({ baseUrl, model, apiKey, thinking, effort });
      setMsg({ kind: 'ok', text: '已保存' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy('idle');
    }
  }

  async function handleTest() {
    setBusy('testing');
    setMsg(null);
    try {
      const text = await testConnection({ baseUrl, model, apiKey, thinking, effort });
      setMsg({ kind: 'ok', text });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as AiError).message || '连接失败' });
    } finally {
      setBusy('idle');
    }
  }

  /**
   * 重建全文索引。「问」和搜索都靠它；迁移回填失败、或者从别处导入了
   * 一批碎片之后，这里的兜底入口能让搜索重新可用，不用重装 App。
   */
  async function handleRebuildIndex() {
    setBusy('indexing');
    setIndexMsg(null);
    try {
      const before = indexState?.indexed ?? null;
      const { indexed } = await repo.rebuildSearchIndex();
      const [nextIndex, nextProbe] = await Promise.all([
        repo.searchIndexStats(),
        repo.selfTestSearch(5),
      ]);
      setIndexState(nextIndex);
      setProbe(nextProbe);

      // 报「修了什么」，不只报「成功了」：条数没变就说没变，别让人误以为修好了什么
      const parts = [`已重建 ${indexed} 条`];
      if (nextProbe.checked > 0) parts.push(`自检 ${nextProbe.hit}/${nextProbe.checked} 通过`);
      if (before !== null && before !== indexed) parts.push(`原来 ${before} 条`);
      setIndexMsg({ kind: 'ok', text: parts.join(' · ') });
    } catch (e) {
      setIndexMsg({ kind: 'err', text: (e as Error).message || '重建失败' });
    } finally {
      setBusy('idle');
    }
  }

  async function handlePickImport() {
    setBusy('picking');
    setIoMsg(null);
    try {
      const file = await pickMarkdown();
      if (!file) return;
      if (looksBinary(file.text)) {
        setIoMsg({
          kind: 'err',
          text: '这个文件读不出文本。可能是选错了文件，或者它是 GBK 编码——用记事本另存为 UTF-8 再试。',
        });
        return;
      }
      const preview = await previewImport(file);
      if (!preview.total) {
        setIoMsg({
          kind: 'err',
          text: '文件里没找到能导入的条目。需要 `- 内容` 这样的列表行，上面最好有 `### 2026-10-25` 这样的日期标题。',
        });
        return;
      }
      setImportPreview(preview);
    } catch (e) {
      setIoMsg({ kind: 'err', text: (e as Error).message || '读取文件失败' });
    } finally {
      setBusy('idle');
    }
  }

  async function handleConfirmImport() {
    if (!importPreview || busy === 'importing') return;
    setBusy('importing');
    setIoMsg(null);
    try {
      let inserted: number;
      try {
        ({ inserted } = await applyImport(importPreview.fresh));
      } catch (error) {
        // 部分成功、源行位置等证据由导入层提供；确认页保留以便安全重试。
        setIoMsg({ kind: 'err', text: error instanceof Error ? error.message : '导入中断，可以重试未导入的内容' });
        return;
      }
      setImportPreview(null);
      let refreshNote = '';
      try {
        setStats(await repo.stats());
        await onChanged();
      } catch {
        refreshNote = '；内容已写入，但页面刷新失败，请返回后重新查看，不要重复导入';
      }
      setIoMsg({ kind: 'ok', text: `已导入 ${inserted} 条${refreshNote}` });
    } finally {
      setBusy('idle');
    }
  }

  async function handleExport() {
    setBusy('exporting');
    setIoMsg(null);
    try {
      // 导出是完整读取，不能复用首页可能只有500条的渲染窗口。
      const [allFragments, todos] = await Promise.all([repo.listAllFragments(), repo.listTodos()]);
      const { message } = await exportMarkdown(allFragments, todos);
      setIoMsg({ kind: 'ok', text: message });
    } catch (e) {
      setIoMsg({ kind: 'err', text: (e as Error).message || '导出失败' });
    } finally {
      setBusy('idle');
    }
  }

  /**
   * 打包完整备份。
   *
   * 三步都是必答的：库快照（VACUUM INTO，不拷正在写的主文件）、配图、
   * 文档原件。最后交给系统分享面板 —— App 不自己挑目录，也不往外传。
   */
  async function handleFullBackup() {
    setBusy('backing');
    setBkMsg(null);
    try {
      const out = await repo.exportBackup(APP_VERSION);
      const Sharing = require('expo-sharing');
      let shared = false;
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(out.uri, {
          mimeType: 'application/zip',
          dialogTitle: '保存完整备份',
        });
        shared = true;
      }
      setBkMsg({
        kind: 'ok',
        text: `已生成 ${out.name}（${humanBytes(out.bytes)}）：${out.counts.fragments} 条碎片 · ${
          out.counts.images
        } 张图 · ${out.counts.documents} 份文档${shared ? '' : `。文件在 ${out.uri}`}`,
      });
    } catch (e) {
      setBkMsg({ kind: 'err', text: (e as Error).message || '打包失败' });
    } finally {
      setBusy('idle');
    }
  }

  /** 选一个备份包，先只读清单 —— 覆盖之前必须让人看清里面是什么 */
  async function handlePickBackup() {
    setBusy('picking');
    setBkMsg(null);
    setRestoreAsk(null);
    try {
      const DocumentPicker = require('expo-document-picker');
      const res = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (!res || res.canceled || !res.assets || !res.assets.length) return;
      const asset = res.assets[0];
      const peek = await repo.peekBackup(asset.uri);
      setRestoreAsk({
        uri: asset.uri,
        name: asset.name || '备份包',
        manifest: peek.manifest,
        bytes: peek.bytes,
        blocked: peek.blockedReason,
      });
    } catch (e) {
      setBkMsg({ kind: 'err', text: (e as Error).message || '读不了这个文件' });
    } finally {
      setBusy('idle');
    }
  }

  /** 真正覆盖。恢复点由数据层负责留，这里只负责把结果如实说出来 */
  async function handleConfirmRestore() {
    if (!restoreAsk || busy === 'restoring') return;
    const name = restoreAsk.name;
    setBusy('restoring');
    setBkMsg(null);
    try {
      const out = await repo.restoreBackup(restoreAsk.uri);
      setRestoreAsk(null);
      onChanged();
      setBkMsg({
        kind: 'ok',
        text: `已从 ${name} 恢复：${out.counts.fragments} 条碎片 · ${out.counts.images} 张图 · ${
          out.counts.documents
        } 份文档。覆盖前的旧库已另存为 ${out.safetyName}（${humanBytes(out.safetyBytes)}）${
          out.missing.length ? `；包里缺 ${out.missing.length} 个文件` : ''
        }`,
      });
    } catch (e) {
      setBkMsg({ kind: 'err', text: (e as Error).message || '恢复失败' });
    } finally {
      setBusy('idle');
    }
  }

  /** 通知栏入口的开关。失败要把原因说出来（权限被拒是最常见的） */
  async function handleToggleQuick() {
    const next = !quickOn;
    setQuickOn(next);
    setQuickMsg(null);
    const res = await setQuickRecordEnabled(next);
    setQuickBlocked(await isQuickRecordBlocked());
    if (!res.ok) {
      setQuickOn(!next);
      setQuickMsg({ kind: 'err', text: res.reason });
    } else {
      setQuickMsg({ kind: 'ok', text: next ? '已放到通知栏' : '已撤掉' });
    }
  }

  /**
   * 小结提醒的开关。
   *
   * 打开时先要权限再落库（在 `setDigestReminderEnabled` 里），被拒就把开关弹回去
   * 并把原因写出来 —— 显示「开着」但永远发不出来是最糟的状态。
   * 拨成功之后立刻让 App 对齐那条通知，不等下一次数据变化：
   * 用户可能就是在月底这一天打开开关的，等到明天才排就已经错过了。
   */
  async function handleToggleRemind() {
    const next = !remindOn;
    setRemindOn(next);
    setRemindMsg(null);
    const res = await setDigestReminderEnabled(next);
    if (!res.ok) {
      setRemindOn(!next);
      setRemindBlocked((await digestReminderState()).blocked);
      setRemindMsg({ kind: 'err', text: res.reason });
      return;
    }
    // 等 App 真的排完再读状态：不然「下次提醒」会停在 0，用户以为没排上
    await onReminderChange?.();
    const state = await digestReminderState();
    setRemindBlocked(state.blocked);
    setRemindAt(state.at);
    setRemindMsg({
      kind: 'ok',
      text: next ? '有月份的小结没写时，晚上 8 点提醒一次' : '已关掉',
    });
  }

  /** 保存自定义下载地址。空串 = 清掉，退回「官方直连 → 镜像兜底」 */
  async function saveDownloadBase() {
    setBaseMsg(null);
    try {
      await setDownloadBase(downloadBase);
      setBaseMsg({ kind: 'ok', text: '已保存' });
    } catch (e) {
      setBaseMsg({ kind: 'err', text: (e as Error).message });
    }
  }

  /** 保存 MinerU Token。空串 = 清掉，只剩免 Token 的轻量通道 */
  async function saveMineruToken() {
    setTokenMsg(null);
    try {
      await setMineruToken(mineruToken);
      setTokenMsg({
        kind: 'ok',
        text: mineruToken.trim() ? '已保存，文档页可上传更大的文件' : '已清空，只用轻量接口',
      });
    } catch (e) {
      setTokenMsg({ kind: 'err', text: (e as Error).message });
    }
  }

  /**
   * 手动检查更新。force 绕过节流 —— 用户点了就说明他现在就想知道。
   *
   * 三种结果都要说清楚：已是最新（给出版本号，否则用户不知道"最新"是指哪个）、
   * 有新版本（直接弹窗）、检查失败（把 GitHub 的具体原因带出来，
   * 403 限流和 404 没发布是完全不同的两件事）。
   */
  async function handleCheckUpdate() {
    if (checking) return;
    setChecking(true);
    setCheckState('idle');
    setCheckMsg('');
    try {
      const r = await checkForUpdate({ force: true });
      if (r.kind === 'update') {
        setCheckState('update');
        setCheckMsg(`发现 ${versionLabel(r.release.version)}`);
        setUpdate(r.release);
      } else if (r.kind === 'latest') {
        setCheckState('latest');
        setCheckMsg(`当前 ${versionLabel(r.current)} 已是最新`);
      } else if (r.kind === 'none') {
        setCheckState('error');
        setCheckMsg('仓库还没发布过版本，暂时无处可查');
      } else {
        setCheckState('error');
        setCheckMsg('刚检查过，过几分钟再试');
      }
    } catch (e) {
      setCheckState('error');
      setCheckMsg(e instanceof Error ? e.message : '检查失败');
    } finally {
      setChecking(false);
    }
  }

  // 索引状态分两层说：条数对不对是「完整性」，自检命中率是「可用性」。
  // 只报完整可能是「全建了但搜不出来」，只报自检又看不出漏了哪几条。
  const indexOk = !!indexState && indexState.indexed === indexState.total;
  /*
   * 只要没有 misses 就算健康。
   *
   * 「内容重复导致搜回另一条」不算问题 —— 那条内容确实在索引里，
   * 只是库里有两条一样的。原来的判定把它算成失败，于是界面只能说
   * 「4/5，搜索可能不准」，用户根本不知道要不要管。
   */
  const probeOk = !probe || probe.checked === 0 || probe.misses.length === 0;
  const indexHealthy = indexOk && probeOk;
  // 空库谈不上健康，别给它打绿勾
  const indexEmpty = !!indexState && indexState.total === 0;
  const indexColor =
    !indexState || indexEmpty ? c.text2 : indexHealthy ? c.tealText : c.danger;
  const indexIcon: IoniconName = !indexState
    ? 'ellipsis-horizontal-circle-outline'
    : indexEmpty
      ? 'information-circle-outline'
      : indexHealthy
        ? 'checkmark-circle-outline'
        : 'alert-circle-outline';
  const indexLine = !indexState
    ? '正在检查索引…'
    : indexState.total === 0
      ? '库里还没有碎片'
      : indexOk
        ? `索引完整 · ${indexState.total} 条全部可搜`
        : `索引不全 · ${indexState.total} 条里缺 ${indexState.total - indexState.indexed} 条`;
  const probeLine = !probe
    ? '正在自检…'
    : probe.checked === 0
      ? indexEmpty
        ? '空库没有可自检的碎片'
        : '能自检的碎片还不够（太短），先记几条长一点的'
      : probe.misses.length === 0
        ? probe.viaDuplicate > 0
          ? `抽样自检：${probe.checked} 条全部能搜到（其中 ${probe.viaDuplicate} 条内容与另一条重复，不影响搜索）`
          : `抽样自检：拿正文中的一段往回搜，${probe.checked} 条全部搜回`
        : `抽样自检：${probe.checked} 条里 ${probe.hit} 条能搜回，${probe.misses.length} 条搜不回`;

  /** 真搜不回时才给具体条目，让用户知道不是随口一句「可能不准」 */
  const probeDetail =
    probe && probe.misses.length > 0
      ? `搜不回的是 #${probe.misses
          .slice(0, 3)
          .map((m) => m.id)
          .join('、#')}${probe.misses.length > 3 ? ' 等' : ''}（用「${probe.misses[0].needle}」去搜没命中自己）。建议点下面的「重建搜索索引」`
      : '';

  /* ---- 菜单行右侧那句「现在是什么」 ---- */
  const aiValue = official
    ? `DeepSeek 官方 · ${model === 'deepseek-v4-pro' ? 'Pro' : 'Flash'}`
    : model || '自定义接口';
  const dataValue = `${stats.total} 条 · ${stats.pending} 待整理`;

  return (
    <View style={[styles.root, { paddingBottom: keyboardHeight }]}><View style={styles.normalContent} importantForAccessibility={importPreview || update ? "no-hide-descendants" : "auto"}>
      <ScreenHeader
        title={PANE_TITLE[pane]}
        subtitle={pane === 'root' ? 'v' + APP_VERSION : undefined}
        onBack={pane === 'root' ? (embedded ? undefined : onClose) : () => setPane('root')}
        backLabel={pane === 'root' ? '返回' : '回到设置'}
      />

      {/* ---------------- 模块菜单（根层） ---------------- */}
      {pane === 'root' ? (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/*
            不再写「按你的习惯来 / 模型、外观和本地数据，分开管理。」——
            四行标题本身就是这四个模块，上面再解释一遍等于重复标题（用户 2026-11-15 要求删）。
          */}
          <View style={styles.menuStack}>
            <View style={styles.cardTight}>
              <MenuRow icon="options-outline" label="接口与模型" value={aiValue}
                onPress={() => setPane('config')} last />
            </View>
            <View style={styles.cardTight}>
              <MenuRow icon="contrast-outline" label="外观" value={`${THEME_MODE_LABEL[mode]} · ${THEME_STYLE_LABEL[themeStyle]}`}
                onPress={() => setPane('appearance')} last />
            </View>
            {/*
              回收站是根页的一行（用户 2026-11-19 要求从「数据与备份」里独立出来）。
              它不是「备份」的一部分：里面是刚删掉的东西，找它的心情和翻备份完全不同。
            */}
            <View style={styles.cardTight}>
              <MenuRow icon="trash-outline" label="回收站" value={trashCount > 0 ? `${trashCount} 条待处理` : '空'}
                onPress={() => setPane('trash')} last />
            </View>
            <View style={styles.cardTight}>
              <MenuRow icon="file-tray-full-outline" label="数据与备份" value={dataValue}
                onPress={() => setPane('data')} last />
            </View>
            <View style={styles.cardTight}>
              <MenuRow icon="information-circle-outline" label="关于碎片" value={'v' + APP_VERSION}
                onPress={() => setPane('about')} last />
            </View>
          </View>
        </ScrollView>
      ) : null}

      {/* ---------------- 配置 ---------------- */}
      {pane === 'config' ? (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <GroupTitle text="模型服务" />
          <View style={styles.card}>
            {/*
              默认就是官方：只需要一把 Key。地址和模型不是「配置项」，
              而是「换服务商时才要动的东西」，收进下面的折叠区。
            */}
            <View style={styles.officialHead}>
              <Ionicons name="shield-checkmark-outline" size={15} color={c.accentText} />
              <Text style={styles.officialTitle}>DeepSeek 官方</Text>
              <View style={{ flex: 1 }} />
              {official ? (
                <Text style={styles.officialTag}>当前</Text>
              ) : (
                <Pressable onPress={switchToOfficial} style={styles.touchTarget}>
                  <Text style={styles.linkText}>切回官方</Text>
                </Pressable>
              )}
            </View>

            <Field label="API Key" last>
              <View style={styles.keyRow}>
                <TextInput
                  value={apiKey}
                  onChangeText={setApiKey}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry={!showKey}
                  placeholder="sk-…"
                  placeholderTextColor={c.text3}
                  style={[styles.input, styles.keyInput]}
                />
<IconButton name={showKey ? "eye-off-outline" : "eye-outline"} size={20} onPress={() => setShowKey((value) => !value)} accessibilityLabel={showKey ? "隐藏API Key" : "显示API Key"} accessibilityState={{ expanded: showKey }} />
              </View>
            </Field>

            {/* 余额。只有官方地址查得到；第三方接口这里会说清原因，而不是转圈 */}
            <View style={styles.balanceRow}>
              <Ionicons name="wallet-outline" size={14} color={c.text3} />
              <Text style={styles.balanceText} numberOfLines={2}>
                {balanceBusy
                  ? '正在查余额…'
                  : balance
                    ? balanceLine(balance)
                    : apiKey.trim()
                      ? '还没查余额'
                      : '填了 Key 才能查余额'}
              </Text>
              <Pressable
                onPress={() => void refreshBalance(true)}
                accessibilityLabel="刷新余额" style={styles.touchTarget}
              >
                {balanceBusy ? (
                  <ActivityIndicator size="small" color={c.text3} />
                ) : (
                  <Ionicons name="refresh" size={13} color={c.text3} />
                )}
              </Pressable>
            </View>

            <View style={styles.linkRow}>
              <Pressable
                style={[styles.linkBtn, styles.touchTarget]}
                onPress={() => {
                  Linking.openURL('https://platform.deepseek.com/api_keys').catch(() => undefined);
                }}
              >
                <Ionicons name="key-outline" size={12} color={c.accentText} />
                <Text style={styles.linkText}>去领 Key</Text>
              </Pressable>
              <Pressable
                style={[styles.linkBtn, styles.touchTarget]}
                onPress={() => {
                  Linking.openURL('https://platform.deepseek.com/top_up').catch(() => undefined);
                }}
              >
                <Ionicons name="card-outline" size={12} color={c.accentText} />
                <Text style={styles.linkText}>充值</Text>
              </Pressable>
              <Pressable
                style={[styles.linkBtn, styles.touchTarget]}
                onPress={() => {
                  Linking.openURL('https://platform.deepseek.com/usage').catch(() => undefined);
                }}
              >
                <Ionicons name="stats-chart-outline" size={12} color={c.accentText} />
                <Text style={styles.linkText}>用量</Text>
              </Pressable>
            </View>

            {balance?.kind === 'error' && balance.raw ? (
              <Text style={styles.hintErr} numberOfLines={4}>
                {balance.raw}
              </Text>
            ) : null}

            <View style={styles.modelField}>
              <Text style={styles.fieldLabel}>模型</Text>
              <View style={styles.chipRow}>
                {([
                  ['deepseek-flash', 'Flash（默认）'],
                  ['deepseek-v4-pro', 'Pro（更强）'],
                ] as const).map(([id, label]) => (
                  <ChoiceChip key={id} label={label} selected={model === id} onPress={() => setModel(id)} />
                ))}
              </View>
            </View>

            <View style={styles.btnRow}>
              <Pressable style={[styles.ghostBtn, styles.touchTarget]} onPress={handleSave} disabled={busy !== 'idle'}>
                <Text style={styles.ghostBtnText}>
                  {busy === 'saving' ? '保存中…' : '保存'}
                </Text>
              </Pressable>
              <Pressable style={[styles.solidBtn, styles.touchTarget]} onPress={handleTest} disabled={busy !== 'idle'}>
                {busy === 'testing' ? (
                  <ActivityIndicator size="small" color={c.onAccent} />
                ) : (
                  <Text style={styles.solidBtnText}>测试连接</Text>
                )}
              </Pressable>
            </View>

            {msg && (
              <Text accessibilityLiveRegion="polite" style={[styles.msg, msg.kind === 'err' ? styles.msgErr : styles.msgOk]}>
                {msg.text}
              </Text>
            )}

            {/* 第三方接口：默认收起。打开它的人才需要看 Base URL */}
            <Pressable style={[styles.customToggle, styles.touchTarget]} onPress={() => setShowCustom((v) => !v)}>
              <Ionicons
                name={showCustom ? 'chevron-down' : 'chevron-forward'}
                size={13}
                color={c.text3}
              />
              <Text style={styles.customToggleText}>使用第三方接口（OpenAI 兼容）</Text>
            </Pressable>

            {showCustom ? (
              <View style={styles.customBox}>
                <Field label="Base URL">
                  <TextInput
                    value={baseUrl}
                    onChangeText={setBaseUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={DEFAULT_AI_CONFIG.baseUrl}
                    placeholderTextColor={c.text3}
                    style={styles.input}
                  />
                </Field>
                <Field label="模型" last>
                  <TextInput
                    value={model}
                    onChangeText={setModel}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={DEFAULT_AI_CONFIG.model}
                    placeholderTextColor={c.text3}
                    style={styles.input}
                  />
                </Field>
                <Text style={styles.fieldHint}>
                  第三方网关一般不认 DeepSeek 的思考参数，输出额度也小得多（8K 上限），
                  也查不到账户余额。整理长文档时容易半路截断。
                </Text>
              </View>
            ) : null}
          </View>

          <GroupTitle text="思考过程" />
          <View style={styles.card}>
            <Field label="让模型先想再答" last={!thinking}>
              <View style={styles.toggleRow}>
                <ChoiceChip
                  label={thinking ? '开启' : '关闭'}
                  accessibilityLabel="让模型先想再答"
                  role="switch"
                  selected={thinking}
                  onPress={() => setThinking((value) => !value)}
                />
                <Text style={styles.toggleHint}>
                  {thinking ? '整理时能看到它怎么想的' : '关掉后更快更省钱，但看不到过程'}
                </Text>
              </View>
            </Field>

            {thinking && (
              <Field label="思考强度" last>
                <View style={styles.chipRow}>
                  {(['low', 'high', 'max'] as const).map((e) => (
<ChoiceChip key={e} label={EFFORT_LABEL[e]} selected={effort === e} onPress={() => setEffort(e)} />
                  ))}
                </View>
                {/* 「改完记得点保存」已删：保存按钮就在同一张卡的上方 */}
              </Field>
            )}
          </View>

          <GroupTitle text="文档解析（MinerU）" />
          <View style={styles.card}>
            <Field label="MinerU Token" last>
              <TextInput
                value={mineruToken}
                onChangeText={setMineruTokenOn}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="留空 = 只用免 Token 的轻量解析"
                placeholderTextColor={c.text3}
                style={styles.input}
                returnKeyType="done"
                onSubmitEditing={saveMineruToken}
                onEndEditing={saveMineruToken}
              />
              <Text style={styles.fieldHint}>
                填了才能解超过 10 MB / 20 页的文件，以及 doc / ppt / xls。Token 在
                mineru.net 的「API 管理」里创建，每天 1000 页额度。
              </Text>
              {tokenMsg ? (
                <Text style={tokenMsg.kind === 'ok' ? styles.hintOk : styles.hintErr}>
                  {tokenMsg.text}
                </Text>
              ) : null}
            </Field>
          </View>
        </ScrollView>
      ) : null}

      {/* ---------------- 外观 ---------------- */}
      {pane === 'appearance' ? (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <GroupTitle text="明暗" />
          <View style={styles.card}>
            <View style={styles.chipRow} accessibilityLabel="明暗偏好">
              {(['light', 'dark', 'system'] as const).map((m) => (
                <ChoiceChip key={m} label={THEME_MODE_LABEL[m]} selected={mode === m} onPress={() => setMode(m)} />
              ))}
            </View>
          </View>
          {/*
            三句说明都删了（用户 2026-11-15）：「立即生效不用保存」是显然的，
            「跟随系统只改明暗」是两组开关摆在一起就能看出来的，
            「切回默认不会回退版本」更是只在担心时才有用 —— 而担心的时候它也不在眼前。
            留下两组 chips，选中的样子自己会说话。
          */}
          <GroupTitle text="界面风格" />
          <View style={styles.card}>
            <View style={styles.chipRow} accessibilityLabel="界面风格">
              {(['default', 'ink'] as const).map((choice) => (
                <ChoiceChip key={choice} label={THEME_STYLE_LABEL[choice]} selected={themeStyle === choice} onPress={() => setStyle(choice)} />
              ))}
            </View>
          </View>

          {/*
            字号（v0.26）。只放大文字与行高，不动间距与控件高度 ——
            间距是「格子」，字号是「格子里的字」；一起放大会把所有一屏能放下的东西
            挤掉，而用户要的只是看清。
          */}
          <GroupTitle text="字号" />
          <View style={styles.card}>
            <View style={styles.chipRow} accessibilityLabel="字号">
              {(['small', 'normal', 'large', 'xlarge'] as const).map((choice) => (
                <ChoiceChip key={choice} label={TYPE_SCALE_LABEL[choice]} selected={typeScale === choice} onPress={() => setTypeScale(choice)} />
              ))}
            </View>
          </View>
          {saveError ? (
            <Text style={[styles.msg, styles.msgErr]} accessibilityLiveRegion="polite">{saveError}</Text>
          ) : null}
        </ScrollView>
      ) : null}

      {/* ---------------- 回收站（根页独立一页） ---------------- */}
      {pane === 'trash' ? (
        <TrashPane
          onChanged={() => {
            onChanged();
            // 根页那一行的「N 条待处理」要跟着变：恢复完退回去还写着 5 条就是错的
            void repo.trashCount().then(setTrashCount).catch(() => undefined);
          }}
        />
      ) : null}

      {/* ---------------- 数据 ---------------- */}
      {pane === 'data' ? (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <GroupTitle text="现在有多少" />
          <View style={styles.card}>
            <View style={styles.statRow}>
              <Stat num={stats.total} label="总条数" />
              <Stat num={stats.pending} label="待整理" />
              <Stat num={stats.todoOpen} label="未完成待办" />
            </View>
          </View>

          <GroupTitle text="搜索索引" />
          <View style={styles.card}>
            <View style={styles.indexBox}>
              <View style={styles.indexHead}>
                <Ionicons name={indexIcon} size={14} color={indexColor} />
                <Text style={[styles.indexTitle, { color: indexColor }]}>{indexLine}</Text>
              </View>
              <Text style={styles.indexHint}>{probeLine}</Text>
              {probeDetail ? (
                <Text style={[styles.indexHint, styles.msgErr]}>{probeDetail}</Text>
              ) : null}
              {indexMsg && (
                <Text
                  style={[styles.indexHint, indexMsg.kind === 'err' ? styles.msgErr : styles.msgOk]}
                >
                  {indexMsg.text}
                </Text>
              )}
            </View>

            <Pressable
              style={[styles.ghostBtnWide, styles.touchTarget]}
              onPress={handleRebuildIndex}
              disabled={busy !== 'idle'}
            >
              <Ionicons name="refresh-outline" size={15} color={c.text} />
              <Text style={styles.ghostBtnText}>
                {busy === 'indexing' ? '正在重建…' : '重建搜索索引'}
              </Text>
            </Pressable>
          </View>

          <GroupTitle text="导入导出" />
          <View style={styles.card}>
            <Pressable style={[styles.ghostBtnWide, styles.touchTarget]} onPress={handleExport} disabled={busy !== 'idle'}>
              <Ionicons name="download-outline" size={15} color={c.text} />
              <Text style={styles.ghostBtnText}>
                {busy === 'exporting' ? '正在导出…' : '导出 Markdown'}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.ghostBtnWide, styles.touchTarget]}
              onPress={handlePickImport}
              disabled={busy !== 'idle'}
            >
              <Ionicons name="cloud-upload-outline" size={15} color={c.text} />
              <Text style={styles.ghostBtnText}>
                {busy === 'picking' ? '正在读取…' : '从 Markdown 导入'}
              </Text>
            </Pressable>
            {ioMsg && (
              <Text style={[styles.msg, ioMsg.kind === 'err' ? styles.msgErr : styles.msgOk]}>
                {ioMsg.text}
              </Text>
            )}
            <Text style={styles.fieldHint}>正文、事项和时间都在里面。</Text>
          </View>

          <GroupTitle text="完整备份" />
          <View style={styles.card}>
            <Pressable
              style={[styles.ghostBtnWide, styles.touchTarget]}
              onPress={handleFullBackup}
              disabled={busy !== 'idle'}
            >
              <Ionicons name="archive-outline" size={15} color={c.text} />
              <Text style={styles.ghostBtnText}>
                {busy === 'backing' ? '正在打包…' : '打包完整备份（含图片与文档）'}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.ghostBtnWide, styles.touchTarget]}
              onPress={handlePickBackup}
              disabled={busy !== 'idle'}
            >
              <Ionicons name="cloud-download-outline" size={15} color={c.text} />
              <Text style={styles.ghostBtnText}>
                {busy === 'picking' ? '正在读取…' : '从备份恢复'}
              </Text>
            </Pressable>

            {restoreAsk ? (
              <View style={styles.warnBox}>
                <Text style={styles.warnTitle}>这个包里是这些内容，确认覆盖？</Text>
                <Text style={styles.warnLine}>
                  {new Date(restoreAsk.manifest.createdAt).toLocaleString()} · App{' '}
                  {restoreAsk.manifest.appVersion || '未知版本'} · 库 v
                  {restoreAsk.manifest.schemaVersion} · {humanBytes(restoreAsk.bytes)}
                </Text>
                <Text style={styles.warnLine}>
                  {restoreAsk.manifest.counts.fragments} 条碎片 ·{' '}
                  {restoreAsk.manifest.counts.images} 张图 ·{' '}
                  {restoreAsk.manifest.counts.documents} 份文档
                </Text>
                {restoreAsk.blocked ? (
                  <Text style={styles.warnLine}>{restoreAsk.blocked}</Text>
                ) : null}
                <Text style={styles.warnLine}>
                  当前 {stats.total} 条会被覆盖。覆盖前会把现在这份库另存到 App 私有目录的
                  backups/ 下，并告诉你文件名。
                </Text>
                <View style={styles.warnActions}>
                  <Pressable
                    style={styles.warnGhost}
                    onPress={() => setRestoreAsk(null)}
                    disabled={busy === 'restoring'}
                  >
                    <Text style={styles.ghostBtnText}>取消</Text>
                  </Pressable>
                  <Pressable
                    style={styles.warnSolid}
                    onPress={handleConfirmRestore}
                    disabled={busy === 'restoring'}
                  >
                    <Text style={styles.warnSolidText}>
                      {busy === 'restoring' ? '正在恢复…' : '覆盖并恢复'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {bkMsg && (
              <Text style={[styles.msg, bkMsg.kind === 'err' ? styles.msgErr : styles.msgOk]}>
                {bkMsg.text}
              </Text>
            )}
            <Text style={styles.fieldHint}>
              一个 zip：数据库、配图、文档原件。
            </Text>
          </View>

          {/*
            两组都是「碎片会在什么时候主动出声」，所以合成一组，不再分「快捷入口」
            和「提醒」—— 分开之后用户要滑两处才知道自己能收到哪些通知。
          */}
          <GroupTitle text="通知" />
          <View style={styles.card}>
            <View style={styles.toggleRow}>
              <ChoiceChip
                label={quickOn ? '开启' : '关闭'}
                accessibilityLabel="通知栏常驻「记一条」"
                role="switch"
                selected={quickOn}
                onPress={() => void handleToggleQuick()}
              />
              <Text style={styles.toggleHint}>
                通知栏常驻一条「记一条」，点一下直接落到输入框
              </Text>
            </View>
            {quickMsg && (
              <Text style={[styles.msg, quickMsg.kind === 'err' ? styles.msgErr : styles.msgOk]}>
                {quickMsg.text}
              </Text>
            )}

            <View style={[styles.toggleRow, styles.toggleRowNext]}>
              <ChoiceChip
                label={remindOn ? '开启' : '关闭'}
                accessibilityLabel="有月份的小结没写时提醒"
                role="switch"
                selected={remindOn}
                onPress={() => void handleToggleRemind()}
              />
              <Text style={styles.toggleHint}>
                有月份的小结没写时，晚上 8 点提醒一次；点开直接到回顾页
              </Text>
            </View>
            {remindMsg && (
              <Text style={[styles.msg, remindMsg.kind === 'err' ? styles.msgErr : styles.msgOk]}>
                {remindMsg.text}
              </Text>
            )}
            {/*
              开关在 App 里，权限在系统里：用户去系统设置关一次通知，这里两行还都写着「开启」。
              不说出来的话，他只会以为是这功能坏了 —— 而这句解释是唯一能找到原因的地方。
            */}
            {/*
              三种状态要分开说，不能把过去那一刻当「下次」：
              排在未来 → 下次是几号；已经响过了 → 说明 3 天冷却；从没排上 → 说明为什么没排。
            */}
            {remindOn && !remindBlocked && remindAt > Date.now() ? (
              <Text style={[styles.msg, styles.msgMuted]}>下次提醒：{reminderWhenLabel(remindAt)}</Text>
            ) : null}
            {remindOn && !remindBlocked && remindAt > 0 && remindAt <= Date.now() ? (
              <Text style={[styles.msg, styles.msgMuted]}>
                已经提醒过一次（{reminderWhenLabel(remindAt)}）；小结还没写的话，3 天后会再提醒。
              </Text>
            ) : null}
            {remindOn && !remindBlocked && remindAt === 0 ? (
              <Text style={[styles.msg, styles.msgMuted]}>
                现在没有欠着的小结，所以还不会提醒；等有月份没写时自动排上。
              </Text>
            ) : null}
            {(quickOn && quickBlocked) || (remindOn && remindBlocked) ? (
              <Text style={[styles.msg, styles.msgErr]}>
                系统里没有通知权限，开着的那条发不出来。到系统设置 → 应用 → 碎片 → 通知里打开。
              </Text>
            ) : null}
          </View>
        </ScrollView>
      ) : null}

      {/* ---------------- 关于 ---------------- */}
      {pane === 'about' ? (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <GroupTitle text="关于" />
          <View style={styles.cardTight}>
            <View style={styles.aboutRow}>
              <Text style={styles.aboutKey}>版本</Text>
              <Text style={styles.aboutVal}>{APP_VERSION}</Text>
            </View>

            {/*
              两行纯网页链接，安卓之外也显示 —— 没有安装包可下，但「这个 App 从哪来、
              改过什么」在浏览器里一样能看。更新说明本体在 GitHub，App 内不再排一遍。
            */}
            <Pressable
              style={[styles.aboutRow, styles.touchTarget]}
              onPress={() => {
                Linking.openURL(REPO_WEB).catch(() => undefined);
              }}
            >
              <Text style={styles.aboutKey}>GitHub 仓库</Text>
              <View style={styles.updateValue}>
                <Text style={styles.aboutVal}>gup-n/fragements</Text>
                <Ionicons name="chevron-forward" size={13} color={c.text3} />
              </View>
            </Pressable>

            <Pressable
              style={[styles.aboutRow, styles.touchTarget]}
              onPress={() => {
                Linking.openURL(RELEASES_WEB).catch(() => undefined);
              }}
            >
              <Text style={styles.aboutKey}>更新记录</Text>
              <View style={styles.updateValue}>
                <Text style={styles.aboutVal}>全部版本</Text>
                <Ionicons name="chevron-forward" size={13} color={c.text3} />
              </View>
            </Pressable>

            {/*
              只有 Android 能装包，web 上不显示这两行 —— 摆一个点了没反应的
              「检查更新」比不摆更让人困惑。
            */}
            {Platform.OS === 'android' ? (
              <>
                <Pressable
                  style={[styles.aboutRow, styles.touchTarget]}
                  onPress={handleCheckUpdate}
                  disabled={checking}
                >
                  <Text style={styles.aboutKey}>检查更新</Text>
                  <View style={styles.updateValue}>
                    {checking ? (
                      <ActivityIndicator size="small" color={c.text3} />
                    ) : (
                      <>
                        <Text
                          style={[
                            styles.updateState,
                            checkState === 'update' && styles.updateStateNew,
                            checkState === 'error' && styles.updateStateErr,
                          ]}
                          numberOfLines={2}
                        >
                          {checkMsg || '点这里检查'}
                        </Text>
                        <Ionicons name="chevron-forward" size={13} color={c.text3} />
                      </>
                    )}
                  </View>
                </Pressable>

                <View style={styles.aboutRow}>
                  <Text style={styles.aboutKey}>启动时自动检查</Text>
                  <ChoiceChip
                    label={autoCheck ? '开启' : '关闭'}
                    accessibilityLabel="启动时自动检查更新"
                    role="switch"
                    selected={autoCheck}
                    onPress={() => {
                      const next = !autoCheck;
                      setAutoCheckOn(next);
                      setAutoCheck(next).catch(() => setCheckMsg('本次已切换，但自动检查偏好没有保存成功'));
                    }}
                  />
                </View>
              </>
            ) : null}

            <View style={styles.aboutRow}>
              <Text style={styles.aboutKey}>包名</Text>
              <Text style={styles.aboutVal}>com.local.fragments</Text>
            </View>
            <View style={[styles.aboutRow, { borderBottomWidth: 0 }]}>
              <Text style={styles.aboutKey}>运行环境</Text>
              <Text style={styles.aboutVal}>{Platform.OS}</Text>
            </View>
          </View>

          {Platform.OS === 'android' ? (
            <>
              <GroupTitle text="下载地址" />
              <View style={styles.card}>
                <Field label="自定义镜像" last>
                  <TextInput
                    value={downloadBase}
                    onChangeText={setDownloadBaseOn}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="留空 = GitHub 官方直连"
                    placeholderTextColor={c.text3}
                    style={styles.input}
                    returnKeyType="done"
                    onSubmitEditing={saveDownloadBase}
                    onEndEditing={saveDownloadBase}
                  />
                  <Text style={styles.fieldHint}>
                    填自建或镜像的基础地址（以 / 结尾），下载时拼上 APK 文件名；留空则先连
                    GitHub 官方，连不上或卡住才退到内置镜像。
                  </Text>
                  {baseMsg ? (
                    <Text style={baseMsg.kind === 'ok' ? styles.hintOk : styles.hintErr}>
                      {baseMsg.text}
                    </Text>
                  ) : null}
                </Field>
              </View>
            </>
          ) : null}
        </ScrollView>
      ) : null}

      </View>
      {importPreview && (
        <ImportSheet
          preview={importPreview}
          busy={busy === 'importing'}
          onCancel={() => setImportPreview(null)}
          onConfirm={handleConfirmImport}
          error={ioMsg?.kind === 'err' ? ioMsg.text : undefined}
        />
      )}

      {/* 设置页手动查到的更新就地弹，不用回主界面再等一次启动检查 */}
      {update && (
        <UpdateSheet
          release={update}
          onClose={() => setUpdate(null)}
          onSkipVersion={() => undefined}
        />
      )}
    </View>
  );
}

/** 分组标题。十几处各写一遍 fontSize/margin，改一次要全都改 */
function GroupTitle({ text }: { text: string }) {
  const { styles } = useThemedStyles(makeStyles);
  return <Text style={styles.groupTitle}>{text}</Text>;
}

/**
 * 菜单里的一行：图标 + 名称 + 右侧「现在是什么」+ 箭头。
 *
 * 右侧那句值是这个模块的意义所在：不点进去也能知道当前配置是什么、
 * 数据有多少条、索引正不正常。
 *
 * 曾经还有一行 `description`（「模型服务 · 思考强度 · 文档解析」这种），
 * 四行菜单各挂一句 —— 那是在用标签解释标签，用户 2026-11-15 要求删。
 */
function MenuRow({
  icon, label, value, onPress, last, tone = 'normal', busy,
}: {
  icon: IoniconName;
  label: string;
  value?: string;
  onPress: () => void;
  last?: boolean;
  tone?: 'normal' | 'warn' | 'link';
  busy?: boolean;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
  return (
    <Pressable
      style={({ pressed }) => [styles.menuRow, last && styles.menuRowLast, pressed && styles.rowPressed, styles.touchTarget]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[label, value].filter(Boolean).join('，')}
    >
      <View style={styles.menuIcon}>
        <Ionicons name={icon} size={18} color={tone === 'warn' ? c.danger : c.accentText} accessible={false} />
      </View>
      <View style={styles.menuCopy}>
        <Text style={styles.menuLabel}>{label}</Text>
        {busy ? <ActivityIndicator size="small" color={c.text3} /> : value ? (
          <Text style={[styles.menuValue, tone === 'warn' && styles.menuValueWarn, tone === 'link' && styles.menuValueLink]} numberOfLines={2}>{value}</Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={c.text3} accessible={false} />
    </Pressable>
  );
}

function Field({
  label,
  children,
  last,
}: {
  label: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  const { styles } = useThemedStyles(makeStyles);
  return (
    <View style={[styles.field, last && { borderBottomWidth: 0 }]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Stat({ num, label }: { num: number; label: string }) {
  const { styles } = useThemedStyles(makeStyles);
  return (
    <View style={styles.stat}>
      <Text style={styles.statNum}>{num}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  touchTarget: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight },
  normalContent: { flex: 1 },
  root: { flex: 1, backgroundColor: c.page },

  content: { paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.xxs, paddingBottom: SPACE.xl },
  menuStack: { gap: SPACE.xs },
  menuIcon: {
    width: 32, height: 32, borderRadius: metrics.buttonRadius,
    alignItems: 'center', justifyContent: 'center', backgroundColor: c.accentBg,
  },
  menuCopy: { flex: 1, minWidth: 0, gap: 1 },
  groupTitle: { ...TYPE.label, color: c.text2, letterSpacing: 0.6, marginTop: SPACE.md, marginBottom: SPACE.xs, marginLeft: SPACE.xxs },
  /**
   * 表单卡：白底浮在浅灰页上就够分层了（v0.21 起 page 不再是纯白），不描边。
   *
   * 这里曾经是 `c.card` + 无边框，而 page 也是纯白 —— 于是整个设置子页
   * 就是一片没有边界的文字，分组之间只靠 14 的内边距分开。
   */
  card: {
    backgroundColor: c.card,
    borderRadius: metrics.cardRadius,
    padding: SPACE.sm,
  },
  /** 菜单卡片自己不留内边距 —— 行内才有，否则左右会多出一圈空白 */
  cardTight: {
    backgroundColor: c.card,
    borderRadius: metrics.cardRadius,
    overflow: 'hidden',
  },

  /* ---- 菜单行 ---- */
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.xs,
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.xs,
    borderBottomWidth: surfaceStroke(metrics),
    borderBottomColor: c.hair,
  },
  menuRowLast: { borderBottomWidth: 0 },
  rowPressed: { backgroundColor: c.hairSoft },
  /** 和正文同字号、只加粗一档：菜单行的标题不该比设置项本身更响 */
  menuLabel: { ...TYPE.body, fontWeight: '600', color: c.text },
  menuValue: { ...TYPE.meta, color: c.text2 },
  menuValueWarn: { color: c.danger },
  menuValueLink: { color: c.accentText, fontWeight: '600' },

  field: {
    paddingVertical: SPACE.xs,
    borderBottomWidth: surfaceStroke(metrics),
    borderBottomColor: c.hair,
  },
  fieldLabel: { ...TYPE.label, color: c.text3, marginBottom: SPACE.xxs },
  fieldHint: { ...TYPE.meta, color: c.text3, marginTop: SPACE.xxs },
  hintOk: { ...TYPE.meta, color: c.accentText, marginTop: SPACE.xxs },
  hintErr: { ...TYPE.meta, color: c.danger, marginTop: SPACE.xxs },
  input: { ...TYPE.body, minHeight: metrics.controlHeight, color: c.text, paddingVertical: 2, ...WEB_INPUT_RESET },
  keyRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  keyInput: { flex: 1 },

  btnRow: { flexDirection: 'row', gap: SPACE.xs, marginTop: SPACE.sm },
  /** 次要按钮：浅灰底、无边框。带边框的次要按钮在灰页上会读成「两个白框」 */
  ghostBtn: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACE.xs,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.hairSoft,
  },
  ghostBtnWide: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.xs,
    paddingVertical: SPACE.xs,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.hairSoft,
    marginTop: SPACE.sm,
  },
  ghostBtnText: { ...TYPE.label, color: c.text },
  solidBtn: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACE.xs,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.accent,
  },
  solidBtnText: { ...TYPE.label, color: c.onAccent },

  msg: { ...TYPE.compact, marginTop: SPACE.sm },
  /** 「下次提醒」这种纯信息行：不是成功也不是失败，别用绿/红 */
  msgMuted: { color: c.text3 },
  msgOk: { color: c.tealText },
  msgErr: { color: c.danger },

  /*
   * 恢复确认块。整块用 dangerBg 起底 —— 覆盖数据是这个 App 里唯一
   * 「按下去就回不来」的动作，它不该长得和别的按钮一样。
   */
  warnBox: {
    marginTop: SPACE.sm,
    padding: SPACE.sm,
    borderRadius: metrics.cardRadius,
    backgroundColor: c.dangerBg,
    gap: SPACE.xxs,
  },
  warnTitle: { ...TYPE.label, color: c.danger },
  warnLine: { ...TYPE.meta, color: c.text2 },
  warnActions: { flexDirection: 'row', gap: SPACE.xs, marginTop: SPACE.xxs },
  /** 这两个按钮原来写死 44 高，低于 48 的触控下限，和同一页其它按钮对不齐 */
  warnGhost: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: metrics.controlHeight,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.card,
  },
  warnSolid: {
    flex: 1.4,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: metrics.controlHeight,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.danger,
  },
  warnSolidText: { ...TYPE.label, color: c.onDanger },

  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  /** 同一张卡里的第二条：一条发丝线分开，否则两眼开关挤成一块 */
  toggleRowNext: {
    marginTop: SPACE.sm,
    paddingTop: SPACE.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hairSoft,
  },
  toggleHint: { ...TYPE.meta, flex: 1, color: c.text3 },

  /* ---- 配置：官方区块 ---- */
  officialHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginBottom: 2 },
  officialTitle: { ...TYPE.label, color: c.text },
  officialTag: { ...TYPE.caption, color: c.accentText, backgroundColor: c.accentBg, borderRadius: R.pill, paddingHorizontal: 7, paddingVertical: 1, overflow: 'hidden' },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.xs,
    marginTop: SPACE.xs,
    paddingHorizontal: SPACE.xs,
    paddingVertical: SPACE.xs,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.hairSoft,
  },
  balanceText: { ...TYPE.meta, flex: 1, color: c.text2 },
  linkRow: { flexDirection: 'row', gap: SPACE.xs, marginTop: SPACE.xs, flexWrap: 'wrap' },
  linkBtn: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.xxs,
    paddingHorizontal: 10,
    borderRadius: R.pill,
    backgroundColor: c.accentBg,
  },
  linkText: { ...TYPE.label, color: c.accentText },
  modelField: { marginTop: SPACE.sm, gap: SPACE.xxs },

  /* ---- 配置：第三方折叠 ---- */
  customToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.xxs,
    marginTop: SPACE.sm,
    paddingTop: SPACE.sm,
    borderTopWidth: surfaceStroke(metrics),
    borderTopColor: c.hair,
  },
  customToggleText: { ...TYPE.label, color: c.text3 },
  customBox: { marginTop: SPACE.xxs, paddingTop: SPACE.xxs, borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },

  statRow: { flexDirection: 'row', gap: SPACE.xs, marginBottom: SPACE.xxs },
  stat: {
    flex: 1,
    backgroundColor: c.hairSoft,
    borderRadius: metrics.buttonRadius,
    paddingVertical: SPACE.sm,
    alignItems: 'center',
  },
  statNum: { ...TYPE.heading, color: c.text },
  statLabel: { ...TYPE.meta, color: c.text3, marginTop: 2 },

  indexBox: {
    marginTop: SPACE.xxs,
    backgroundColor: c.hairSoft,
    borderRadius: metrics.buttonRadius,
    paddingHorizontal: SPACE.xs,
    paddingVertical: SPACE.xs,
  },
  indexHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs },
  indexTitle: { ...TYPE.label, flex: 1 },
  indexHint: { ...TYPE.meta, color: c.text3, marginTop: SPACE.xxs },

  updateValue: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs, flexShrink: 1 },
  updateState: { ...TYPE.meta, color: c.text3, maxWidth: 210 },
  updateStateNew: { color: c.accentText, fontWeight: '600' },
  updateStateErr: { color: c.danger },

  aboutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: SPACE.xs,
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.xs,
    borderBottomWidth: surfaceStroke(metrics),
    borderBottomColor: c.hair,
  },
  aboutKey: { ...TYPE.label, color: c.text2 },
  aboutVal: { ...TYPE.meta, color: c.text3, fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right' },
});
