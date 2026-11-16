import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Platform, StyleSheet, useColorScheme, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Fragment, Note, PendingFragmentImage } from './src/types';
import { checkForUpdate, getAutoCheck, setSkipVersion, type ReleaseInfo } from './src/update/check';
import { UpdateSheet } from './src/components/UpdateSheet';
import {
  normalizeThemeMode,
  normalizeThemeStyle,
  SPACE,
  ThemeProvider,
  useTheme,
  useThemedStyles,
  type Palette,
  type ThemeMode,
  type ThemeStyle,
} from './src/theme';
import { repo } from './src/db/repo';
import { importLocalFile } from './src/documents/importLocal';
import { TimelineScreen } from './src/screens/TimelineScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { ReviewScreen } from './src/screens/ReviewScreen';
import { AskScreen } from './src/screens/AskScreen';
import { DocsScreen } from './src/screens/DocsScreen';
import { TabBar, type MainTab } from './src/components/TabBar';
import { useKeyboardHeight } from './src/util/keyboard';
import { DocumentRuntime } from './src/documents/readers';
import { initDocumentJobs } from './src/documents/jobs';
import { readImageBase64, removeFragmentImage, saveFragmentImage } from './src/db/fragmentImages';
import { Toast, TAB_BAR_HEIGHT } from './src/components/Toast';
import { describeImage } from './src/ai/vision';
import { loadAiConfig } from './src/ai/config';
import { isQuickRecordEnabled, showQuickRecord, watchQuickRecord } from './src/quickRecord';
import { dropIncomingFile, takeIncomingShare } from './src/shareInbox';

/**
 * 路由就是底栏上的那五个页面，没有第六个。
 *
 * 原来这里是独立的字面量联合 + 一张 `TABS` 白名单 + 一个 `isTab` 收窄函数，
 * 三份东西描述同一件事。设置并进底栏之后它们完全重合，于是就出现了
 * 「`TABS` 里有 settings、渲染时却写 `route !== 'settings'`」这种自相矛盾 ——
 * 表现是点进设置后底栏消失，再也切不回去（v0.20.9 的实际 bug）。
 * 现在直接复用 `MainTab`，只有一处定义，不会再对不上。
 */
type Route = MainTab;

const isWeb = Platform.OS === 'web';

/** 外观偏好的存储键。放 settings 表，跟 AI 配置同一套机制 */
const K_THEME = 'ui_theme';

/**
 * 外层只做两件事：把库打开、把外观偏好读出来，然后把整棵树包进 ThemeProvider。
 *
 * 拆出来是因为 ThemeProvider 必须在所有界面之上，而 `useTheme` 只能在
 * Provider 内部调 —— 原来的 App 一个函数干完所有事，改造后只能让位给 Shell。
 */
export default function App() {
  const system = useColorScheme();
  const [mode, setMode] = useState<ThemeMode>('system');
  const [style, setStyle] = useState<ThemeStyle>('default');
  const [preferenceErrors, setPreferenceErrors] = useState<Record<string, string>>({});
  const preferenceQueue = useRef<Promise<void>>(Promise.resolve());
  const preferenceVersions = useRef<Record<string, number>>({});
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await repo.init();
        setMode(normalizeThemeMode(await repo.getSetting(K_THEME)));
        setStyle(normalizeThemeStyle(await repo.getSetting('ui_style')));
        /*
         * 文档任务服务必须在库就绪之后启动：它启动时要扫一遍
         * `state = 'parsing'` 但没有对应任务的记录，把它们标成「上次没跑完」。
         * 库还没开就去扫，只会报错然后静默跳过 —— 那界面会一直显示「解析中」。
         */
        await initDocumentJobs();
      } catch (e) {
        console.warn('[fragments] 初始化失败', e);
      } finally {
        setBooted(true);
      }
    })();
  }, []);

  const persistPreference = useCallback((key: string, value: string) => {
    const version = (preferenceVersions.current[key] ?? 0) + 1;
    preferenceVersions.current[key] = version;
    setPreferenceErrors((previous) => { const next = { ...previous }; delete next[key]; return next; });
    preferenceQueue.current = preferenceQueue.current.then(async () => {
      try {
        await repo.setSetting(key, value);
        if (preferenceVersions.current[key] === version) {
          setPreferenceErrors((previous) => { const next = { ...previous }; delete next[key]; return next; });
        }
      } catch {
        if (preferenceVersions.current[key] === version) {
          setPreferenceErrors((previous) => ({ ...previous, [key]: key === K_THEME ? '明暗模式' : '界面风格' }));
        }
      }
    });
  }, []);
  const changeMode = useCallback((next: ThemeMode) => {
    setMode(next);
    persistPreference(K_THEME, next);
  }, [persistPreference]);
  const changeStyle = useCallback((next: ThemeStyle) => {
    setStyle(next);
    persistPreference('ui_style', next);
  }, [persistPreference]);
  const saveError = Object.keys(preferenceErrors).length
    ? `本次外观已应用，但${Object.values(preferenceErrors).join('、')}未能保存；请重试选择`
    : null;

  return (
    <SafeAreaProvider>
      <ThemeProvider mode={mode} style={style} systemDark={system === 'dark'} onChangeMode={changeMode} onChangeStyle={changeStyle} saveError={saveError}>
        <Shell booted={booted} />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Shell({ booted }: { booted: boolean }) {
  const { styles } = useThemedStyles(makeStyles);
  const { dark } = useTheme();
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState<Route>('timeline');
  /**
   * 输入框草稿放在 App 里，不放在 TimelineScreen 里。
   *
   * 切到知识库/设置/回顾时 TimelineScreen 会被卸载，草稿跟着一起没：
   * 打了半句去翻一张卡，回来输入框是空的 —— 这不是「没保存」，是根本没留住。
   */
  const [draft, setDraft] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingFragmentImage[]>([]);
  const pendingImageSequence = useRef(0);
  const nextImageKey = useCallback(() => `p${++pendingImageSequence.current}`, []);
  /**
   * 从时间轴右滑一条碎片进「问」时，带上的那条碎片 id。
   * 从页头聊天按钮进来时是 null —— 两种入口共用同一个页面，但上下文不一样。
   */
  const [askContextId, setAskContextId] = useState<number | null>(null);
  /**
   * 从文档页「问这些文档」进来时带上的文档 id 集合。
   *
   * 和 `askContextId` 是两条互斥的入口：一个是「关于这条碎片」，
   * 一个是「只看这几份文档」。同时为空才是普通的全库问答。
   * 存在 App 里而不是页面里，是因为切页面会卸载 AskScreen，而范围是这场会话的契约 ——
   * 卸载一次就退回全库，等于用户勾的框白勾了。
   */
  const [askDocIds, setAskDocIds] = useState<number[] | null>(null);
  /**
   * 「问」页的关闭动作。
   *
   * 安卓返回键由这里的 BackHandler 统一接（它是后注册的，页面自己抢不过），
   * 但「退出前问要不要保留纪要」是页面内部的状态，所以必须由 App 反过来调它。
   * 页面卸载时置空，避免调到已卸载组件的 setState。
   */
  const askCloseRef = useRef<(() => void) | null>(null);
  /** 用 useCallback 固定身份：否则 AskScreen 每渲染一次都要重挂一遍 */
  const registerAskClose = useCallback((fn: (() => void) | null) => {
    askCloseRef.current = fn;
  }, []);
  /**
   * 「问」页切到别的 tab 之前的收尾。
   *
   * 和关闭按钮不是一回事：关闭是「这一页我不要了」，切 tab 是「先放着，回来接着看」。
   * 但两者都要先把会话落盘、把整理暂停 —— 页面一卸载，没落盘的轮次就没了。
   * 返回 false 表示现在不能走（正在写库），这时不切页。
   */
  const askLeaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const registerAskLeave = useCallback((fn: (() => Promise<boolean>) | null) => {
    askLeaveRef.current = fn;
  }, []);
  /** 键盘抬起时底栏要让位：它占的那 52dp 正好是输入法的位置 */
  const keyboardHeight = useKeyboardHeight();
  const [fragments, setFragments] = useState<Fragment[]>([]);
  /** 周期总结，时间轴按 period 把它们插回对应日期 */
  const [notes, setNotes] = useState<Note[]>([]);
  /** 已完成待办对应的碎片 id，用来打「已完成」标记 */
  const [doneIds, setDoneIds] = useState<Set<number>>(new Set());
  /**
   * 待提示的新版本。null = 没有。
   *
   * 只在「启动自动检查」和「设置页手动检查」两处设置它。检查失败一律静默 ——
   * 开机因为网络断了一下就弹个错误框，比不检查还烦人。
   */
  const [update, setUpdate] = useState<ReleaseInfo | null>(null);
  /**
   * 正在解析的**配图 id**（不是碎片 id）。
   *
   * 一条碎片可能带好几张图，每张各读各的；用碎片 id 做键的话，第二张图
   * 还在读时第一张也会显示成「正在读」。解析是异步的（要调模型，几秒钟），
   * 而图本身已经进库了 —— 界面上必须分开表达这两件事：**记录已经存好**，
   * 只是某张图里的字还在读。混成一句「保存中」会让用户以为记录没记上。
   */
  const [imageBusy, setImageBusy] = useState<Set<number>>(new Set());
  /** 图解析失败的原因（配图 id → 一句人话）。行上要能点重试，不能只在日志里 */
  const [imageFail, setImageFail] = useState<Record<number, string>>({});
  const [writeNotice, setWriteNotice] = useState('');
  useEffect(() => {
    if (!writeNotice) return;
    const timer = setTimeout(() => setWriteNotice(''), 5500);
    return () => clearTimeout(timer);
  }, [writeNotice]);

  /**
   * 通知栏「记一条」点进来的次数。
   *
   * 递增而不是布尔：页面已经在时间轴时不会重新挂载，只有变值才能再触发一次聚焦。
   */
  const [quickTap, setQuickTap] = useState(0);

  /*
   * 通知栏入口的启动两件事：
   * 1. 开关打开着就补发那条常驻通知（应用被杀过之后它会被系统清掉）；
   * 2. 挂点击监听 —— 包括冷启动那一次（见 quickRecord 里为什么要单独捞）。
   */
  useEffect(() => {
    if (isWeb) return;
    let alive = true;
    void isQuickRecordEnabled().then((on) => {
      if (on && alive) void showQuickRecord();
    });
    const stop = watchQuickRecord(() => {
      setRoute('timeline');
      setQuickTap((n) => n + 1);
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);

  /*
   * 启动 3 秒后查一次新版本。
   *
   * 延迟不是偷懒：首屏要读库、渲染时间轴，这时候再打一次网络请求会抢主线程；
   * 而且「一打开就被弹窗拦住」的观感很差。3 秒足够让用户先看到自己的内容。
   *
   * 三重静默：关掉了自动检查、节流窗口内、检查失败 —— 都不该有任何提示。
   */
  useEffect(() => {
    if (isWeb) return;
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        if (!(await getAutoCheck())) return;
        const r = await checkForUpdate();
        if (!alive || r.kind !== 'update' || r.skipped) return;
        setUpdate(r.release);
      } catch {
        /* 启动检查失败不提示 */
      }
    }, 3000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const reloadGeneration = useRef(0);
  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current;
    const [list, noteList, done] = await Promise.all([
      repo.listAllFragments(),
      repo.listNotes(120),
      repo.listDoneTodoSourceIds(),
    ]);
    if (reloadGeneration.current !== generation) return;
    setFragments(list);
    setNotes(noteList);
    setDoneIds(new Set(done));
  }, []);

  useEffect(() => {
    if (!booted) return;
    (async () => {
      try {
        await reload();
      } catch (e) {
        console.warn('[fragments] 读取数据失败', e);
      } finally {
        setReady(true);
      }
    })();
  }, [booted, reload]);

  /**
   * 底栏切换。
   *
   * 从「问」离开时先让它收尾（落盘会话、暂停整理）—— 页面一卸载这些就没了。
   * 收尾是异步的，所以这里等它的结果再决定切不切；其余页面直接切。
   */
  const switchTab = useCallback((next: MainTab) => {
    if (route === 'ask' && askLeaveRef.current) {
      void askLeaveRef.current().then((ok) => { if (ok) setRoute(next); });
      return;
    }
    setRoute(next);
  }, [route]);

  /**
   * 安卓返回键：在任何子页面都先回主界面，只有已经在主界面时才退出 App。
   *
   * 之前缺这一层，用户在设置/知识库/整理页按返回会直接把 Activity 结束掉，
   * 下次进来又回到上次那个页面（进程没被杀时会恢复），看起来像"退不出去也回不来"。
   *
   * 注意注册顺序：TimelineScreen 的覆盖层（长文输入）会在打开时才注册，
   * 比这里晚，所以它的返回优先级更高 —— 开着覆盖层时先关覆盖层，符合直觉。
   */
  useEffect(() => {
    if (isWeb) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route === 'ask') {
        askCloseRef.current?.();
        return true;
      }
      /*
       * 设置进了底栏之后不再有「来路」这回事：它是平级的一页，返回就是回时间轴。
       * 设置页自己的子页（配置/外观/数据/关于）由它内部的 BackHandler 先接一层，
       * 那一层在根层返回 false，才落到这里。
       */
      if (route !== 'timeline') {
        setRoute('timeline');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [route]);

  /**
   * 用户**明确点了**「让它读一遍」才走这里。
   *
   * v0.20.2 起上传不再自动解析（用户 2026-11-12：「不要上传一次解析一次」）：
   * 读图发生在整理和提问之前 —— 见 `ai/imageReads.ts`。
   * 这个入口留着，是因为「重试 / 现在就读」必须是一个看得见的按钮：
   * 整理时读失败的那张，用户得有个地方立刻再试，而不是等下一轮。
   *
   * 顺序仍然是**先存图、先插碎片，再解析**。反过来的话模型一失败，
   * 用户刚拍的那张图和写的那句话就一起没了 —— 记录应用最不能丢的就是这个。
   *
   * 失败要留痕：`imageFail` 存一句原因，行上显示「没读出文字 · 点这里重试」。
   * 静默失败会让用户以为「这张图就是没字」。
   */
  const parseImage = useCallback(
    async (imageId: number, path: string, hint: string) => {
      setImageBusy((prev) => new Set(prev).add(imageId));
      try {
        const config = await loadAiConfig();
        const base64 = await readImageBase64(path);
        const text = await describeImage({ base64, config, hint });
        await repo.setFragmentImageText(imageId, text);
        setImageFail((prev) => {
          if (!(imageId in prev)) return prev;
          const next = { ...prev };
          delete next[imageId];
          return next;
        });
        await reload();
      } catch (e) {
        setImageFail((prev) => ({
          ...prev,
          [imageId]: e instanceof Error ? e.message : '图片没读出来',
        }));
      } finally {
        setImageBusy((prev) => {
          const next = new Set(prev);
          next.delete(imageId);
          return next;
        });
      }
    },
    [reload],
  );

  const handleAdd = useCallback(
    async (text: string, images?: PendingFragmentImage[]): Promise<void | string> => {
      const paths: string[] = [];
      try {
        for (const image of images ?? []) paths.push(await saveFragmentImage(image.uri));
        await repo.insertFragment(text, 'app', undefined,
          (images ?? []).map((image, i) => ({ path: paths[i], key: image.key })));
      } catch (error) {
        // The Repo promises that a rejection means its transaction did not commit.
        for (const path of paths) await removeFragmentImage(path);
        throw error;
      }
      // Files are now owned by committed image rows. Refresh is NOT a rollback boundary.
      let notice: string | undefined;
      try { await reload(); }
      catch { notice = '记录已保存，列表暂未刷新；请重新进入时间轴，不要重复发布'; }
      if (!isWeb) {
        try {
          const Haptics = require('expo-haptics');
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        } catch { /* Haptics cannot invalidate a saved record. */ }
      }
      return notice;
    },
    [reload],
  );

  /**
   * 详情页「加图」：先落盘、再插一行配图。**不读字** ——
   * 读字统一在整理/提问前做（`ai/imageReads.ts`），也可以由用户在图下面点一下立刻读。
   *
   * 返回新建的配图（正文要拿 id 插 `![](img:id)` 定位标记）。
   */
  const handleAddImages = useCallback(
    async (fragmentId: number, uris: string[]) => {
      const paths: string[] = [];
      let added: import('./src/types').FragmentImage[];
      try {
        for (const uri of uris) paths.push(await saveFragmentImage(uri));
        added = await repo.insertFragmentImages(fragmentId, paths.map((path) => ({ path })));
      } catch (error) {
        for (const path of paths) await removeFragmentImage(path);
        throw error;
      }
      setFragments((previous) => previous.map((fragment) => fragment.id === fragmentId
        ? { ...fragment, images: [...fragment.images, ...added] } : fragment));
      try { await reload(); }
      catch { setWriteNotice('图片已保存，列表暂未刷新；请重新进入这条记录'); }
      return added;
    },
    [reload],
  );

  /**
   * 接系统分享进来的内容（原生那半边见 plugins/withShareReceiver.js）。
   *
   * 两个时机都要查：启动读完后一次；从后台回到前台一次。MainActivity 是
   * singleTask，App 已经开着时分享进来**不会重启**，只走 onNewIntent，
   * 所以必须靠 AppState 变化去捞 —— 只看启动会漏掉绝大多数分享。
   */
  useEffect(() => {
    if (isWeb || !ready) return;
    let alive = true;

    const take = async () => {
      try {
        const inc = await takeIncomingShare();
        if (!inc || !alive) return;
        if (inc.kind === 'text') {
          // 拼在已有草稿后面：用户可能已经写了一半，直接覆盖等于把他的话删了
          setDraft((prev) => (prev.trim() ? `${prev}\n${inc.text}` : inc.text));
          setRoute('timeline');
          setWriteNotice('已把分享的文字放进输入框，确认后再发布');
        } else if (inc.kind === 'image' && inc.fileUri) {
          await handleAdd(inc.text, [{ key: `p${inc.at}`, uri: inc.fileUri }]);
          // 内容已经进了碎片，中转那份留着只会让「每分享一次多存一份」
          await dropIncomingFile(inc.file);
          if (!alive) return;
          setRoute('timeline');
          setWriteNotice('已把分享的图片存成一条碎片');
        } else if (inc.fileUri && inc.file) {
          /*
           * PDF / Word / 表格这类**直接进文档库**（v0.23）。
           *
           * 原来这里只弹一句「去文档页导入更稳」—— 那是把用户已经做完的动作
           * 又让他做一遍：文件已经到私有目录了，缺的只是写一条记录。
           * 存成 `stored` 之后文档页自己会说这份能不能本地读、能不能云解析。
           */
          const saved = await importLocalFile({ uri: inc.fileUri, name: inc.name ?? inc.file });
          await dropIncomingFile(inc.file);
          if (!alive) return;
          setRoute('docs');
          setWriteNotice(`已存进文档库：${saved.name}`);
        } else {
          setWriteNotice('这次分享里没有可保存的文件');
        }
      } catch (e) {
        if (alive) {
          setWriteNotice(e instanceof Error ? `没接住这次分享：${e.message}` : '没接住这次分享');
        }
      }
    };

    void take();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void take();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, [ready, handleAdd]);

  /** 详情页删掉一张图：数据库那行先删，再删文件（顺序反了会留下指向空文件的图） */
  const handleRemoveImage = useCallback(
    async (imageId: number) => {
      const path = await repo.deleteFragmentImage(imageId);
      await removeFragmentImage(path);
      await reload();
    },
    [reload],
  );

  /** 详情页里的「重新解析」：同一张图再读一遍 */
  const handleReparseImage = useCallback(
    (fragment: Fragment, imageId: number) => {
      const image = fragment.images.find((i) => i.id === imageId);
      if (!image) return;
      void parseImage(image.id, image.path, fragment.content);
    },
    [parseImage],
  );

  const handleEdit = useCallback(
    async (id: number, text: string) => {
      await repo.updateFragmentContent(id, text);
      await reload();
    },
    [reload],
  );

  const handleDelete = useCallback(
    async (id: number) => {
      // 先把文件名捞回来，删完这些行就再也找不到图了 —— 会一直占着空间
      const paths = await repo.deleteFragment(id);
      for (const path of paths) await removeFragmentImage(path);
      await reload();
    },
    [reload],
  );

  const handleDeleteNote = useCallback(
    async (id: number) => {
      await repo.deleteNote(id);
      await reload();
    },
    [reload],
  );


  return (
    <>
      <StatusBar style={dark ? 'light' : 'dark'} />
      {/*
        文档运行时挂在**最外层**，不在文档页里面，也不在布局容器里。

        它承接 PDF 提取用的隐藏 WebView 队列：用户从文档页点「本地准备」，
        翻到别的页面、甚至一路退回时间轴，提取都得继续跑完。
        挂在页面里的话，页面一卸载 WebView 就连带销毁，任务半路断掉 ——
        v0.11.0 的「离开页面进度就断」就是这么来的。

        放在 `<View outer>` 之外，是为了它不参与任何 flex 布局（尺寸由它自己压到 1×1）；
        放在这个 fragment 里，仍然在 App 的 ThemeProvider 之内，能读主题色。
      */}
      {booted ? <DocumentRuntime /> : null}
      <View style={[styles.outer, isWeb && styles.outerWeb]}>
        <View style={[styles.app, isWeb && styles.appWeb]}>
          {ready ? (
            <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
              {route === 'timeline' && (
                <TimelineScreen
                  fragments={fragments}
                  notes={notes}
                  doneIds={doneIds}
                  draft={draft}
                  onDraftChange={setDraft}
                  pendingImages={pendingImages}
                  onPendingImagesChange={setPendingImages}
                  nextImageKey={nextImageKey}
                  onAdd={handleAdd}
                  imageBusy={imageBusy}
                  imageFail={imageFail}
                  onReparseImage={handleReparseImage}
                  onAddImages={handleAddImages}
                  onRemoveImage={handleRemoveImage}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onDeleteNote={handleDeleteNote}
                  onOpenAsk={(fragmentId) => {
                    setAskContextId(fragmentId ?? null);
                    setRoute('ask');
                  }}
                  focusSignal={quickTap}
                />
              )}
              {route === 'settings' && (
                <SettingsScreen
                  embedded
                  fragments={fragments}
                  onChanged={reload}
                />
              )}
              {route === 'review' && (
                <ReviewScreen embedded fragments={fragments} onChanged={reload} onOpenSettings={() => setRoute('settings')} />
              )}
              {route === 'docs' && (
                <DocsScreen
                  embedded
                  onAsk={(documentIds) => {
                    // 文档问和碎片问是两条入口，进来时清掉另一条，别让上一个范围残留
                    setAskContextId(null);
                    setAskDocIds(documentIds);
                    setRoute('ask');
                  }}
                />
              )}
              {route === 'ask' && (
                <AskScreen
                  embedded
                  onClose={() => {
                    setRoute('timeline');
                    setAskContextId(null);
                    setAskDocIds(null);
                  }}
                  onSaved={reload}
                  registerClose={registerAskClose}
                  registerLeave={registerAskLeave}
                  // 文档范围是会话契约：进来就锁死，页面里不许再改（改就得开新会话）
                  initialScope={askDocIds ? { kind: 'documents', documentIds: askDocIds } : undefined}
                  contextFragment={
                    askContextId === null
                      ? null
                      : fragments.find((f) => f.id === askContextId) ?? null
                  }
                />
              )}
              {/*
                底栏：五个平级页面之间切换。设置也在里面（它不再是覆盖层）。
                键盘抬起时不显示 —— 它那 50 多 dp 正好是输入法要占的地方。
              */}
              {keyboardHeight === 0 ? (
                <TabBar current={route} onChange={switchTab} />
              ) : null}
              {/*
                更新弹窗放在所有页面之后：它是覆盖层，要盖在 route 内容之上。
                放在 SafeAreaView 里面而不是外面，是为了让卡片居中时不被状态栏顶偏。
              */}
              {update ? (
                <UpdateSheet
                  release={update}
                  onClose={() => setUpdate(null)}
                  onSkipVersion={() => {
                    setSkipVersion(update.version).catch(() => undefined);
                  }}
                />
              ) : null}
              {/* 提示条要浮在底栏之上，否则「已保存」这类反馈会被底栏整个盖住 */}
              <Toast text={writeNotice} bottom={TAB_BAR_HEIGHT + 8} />
            </SafeAreaView>
          ) : (
            <View style={styles.splash} />
          )}
        </View>
      </View>
    </>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  outer: { flex: 1, backgroundColor: c.page },
  outerWeb: { alignItems: 'center', justifyContent: 'center', backgroundColor: c.shell },
  app: { flex: 1, alignSelf: 'stretch', backgroundColor: c.page },
  appWeb: {
    flex: 0,
    height: '100%',
    maxHeight: 880,
    width: 420,
    maxWidth: '100%',
    marginVertical: SPACE.md,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.shellBorder,
    overflow: 'hidden',
  },
  safe: { flex: 1, backgroundColor: c.page },
  splash: { flex: 1, backgroundColor: c.page },
});
