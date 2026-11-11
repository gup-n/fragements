import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Platform, StyleSheet, useColorScheme, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Fragment, Note } from './src/types';
import { checkForUpdate, getAutoCheck, setSkipVersion, type ReleaseInfo } from './src/update/check';
import { UpdateSheet } from './src/components/UpdateSheet';
import {
  normalizeThemeMode,
  ThemeProvider,
  useTheme,
  useThemedStyles,
  type Palette,
  type ThemeMode,
} from './src/theme';
import { repo } from './src/db/repo';
import { TimelineScreen } from './src/screens/TimelineScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { ReviewScreen } from './src/screens/ReviewScreen';
import { AskScreen } from './src/screens/AskScreen';
import { DocsScreen } from './src/screens/DocsScreen';
import { DocumentRuntime } from './src/documents/readers';
import { initDocumentJobs } from './src/documents/jobs';
import { dayKey } from './src/util/date';
import { readImageBase64, removeFragmentImage, saveFragmentImage } from './src/db/fragmentImages';
import { describeImage } from './src/ai/vision';
import { loadAiConfig } from './src/ai/config';

type Route = 'timeline' | 'settings' | 'review' | 'ask' | 'docs';

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
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await repo.init();
        setMode(normalizeThemeMode(await repo.getSetting(K_THEME)));
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

  const changeMode = useCallback((next: ThemeMode) => {
    setMode(next);
    // 存盘失败不拦着切换：这次会话照常用新外观，下次启动退回跟随系统
    repo.setSetting(K_THEME, next).catch(() => {});
  }, []);

  return (
    <SafeAreaProvider>
      <ThemeProvider mode={mode} systemDark={system === 'dark'} onChangeMode={changeMode}>
        <Shell booted={booted} />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Shell({ booted }: { booted: boolean }) {
  const { c, styles } = useThemedStyles(makeStyles);
  const { dark } = useTheme();
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState<Route>('timeline');
  /**
   * 从哪个页面进的设置页。
   *
   * 原来是「一律回时间轴」：整理页在缺 API Key 时会给一个「去设置里填」的入口，
   * 点进去填完，回来人已经站在时间轴上了，之前那一屏全白点。
   * 现在记住来路，关掉设置就回原地。
   */
  const [settingsFrom, setSettingsFrom] = useState<Route>('timeline');
  /**
   * 输入框草稿放在 App 里，不放在 TimelineScreen 里。
   *
   * 切到知识库/设置/回顾时 TimelineScreen 会被卸载，草稿跟着一起没：
   * 打了半句去翻一张卡，回来输入框是空的 —— 这不是「没保存」，是根本没留住。
   */
  const [draft, setDraft] = useState('');
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
   * 正在解析配图的碎片 id。
   *
   * 解析是异步的（要调模型，几秒钟），而图本身已经进库了。界面上必须
   * 分开表达这两件事：**记录已经存好**，只是图片里的字还在读。
   * 混成一句「保存中」会让用户以为记录没记上。
   */
  const [imageBusy, setImageBusy] = useState<Set<number>>(new Set());
  /** 图解析失败的原因（id → 一句人话）。行上要能点重试，不能只在日志里 */
  const [imageFail, setImageFail] = useState<Record<number, string>>({});

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

  const reload = useCallback(async () => {
    const [list, noteList, done] = await Promise.all([
      repo.listFragments(),
      repo.listNotes(120),
      repo.listDoneTodoSourceIds(),
    ]);
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
      if (route === 'settings') {
        // 设置页回到它来时的那个页面，不要一律弹回时间轴
        setRoute(settingsFrom);
        return true;
      }
      if (route !== 'timeline') {
        setRoute('timeline');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [route, settingsFrom]);

  /**
   * 把一张图的文字读出来，写回那一条。
   *
   * 顺序很重要：**先存图、先插碎片，再解析**。反过来的话模型一失败，
   * 用户刚拍的那张图和写的那句话就一起没了 —— 而记录应用最不能丢的就是这个。
   *
   * 失败要留痕：`imageFail` 存一句原因，行上显示「没读出文字 · 重试」。
   * 静默失败会让用户以为「这张图就是没字」。
   */
  const parseImageFor = useCallback(
    async (id: number, path: string, hint: string) => {
      setImageBusy((prev) => new Set(prev).add(id));
      try {
        const config = await loadAiConfig();
        const base64 = await readImageBase64(path);
        const text = await describeImage({ base64, config, hint });
        await repo.setFragmentImageText(id, text);
        setImageFail((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        await reload();
      } catch (e) {
        setImageFail((prev) => ({
          ...prev,
          [id]: e instanceof Error ? e.message : '图片没读出来',
        }));
      } finally {
        setImageBusy((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [reload],
  );

  const handleAdd = useCallback(
    async (text: string, imageUri?: string) => {
      if (imageUri) {
        /*
         * 配图：先落盘再插库。文件存成了但插库失败，会留下一张没人引用的图 ——
         * 比起「记录里有条指向空文件的碎片」，前者只是浪费几百 KB。
         */
        const path = await saveFragmentImage(imageUri);
        let id: number;
        try {
          id = await repo.insertFragment(text, 'app', undefined, { path });
        } catch (e) {
          await removeFragmentImage(path);
          throw e;
        }
        await reload();
        // 解析不 await：用户已经可以去记下一条了
        void parseImageFor(id, path, text);
      } else {
        await repo.insertFragment(text, 'app');
        await reload();
      }
      if (!isWeb) {
        try {
          const Haptics = require('expo-haptics');
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } catch {
          /* 震动失败不影响记录 */
        }
      }
    },
    [parseImageFor, reload],
  );

  /** 详情页里的「重新解析」：同一张图再读一遍 */
  const handleReparseImage = useCallback(
    (fragment: Fragment) => {
      if (!fragment.imagePath) return;
      void parseImageFor(fragment.id, fragment.imagePath, fragment.content);
    },
    [parseImageFor],
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
      // 先把文件名捞回来，删完那行就再也找不到这张图了 —— 会一直占着空间
      const imagePath = await repo.deleteFragment(id);
      await removeFragmentImage(imagePath);
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

  /** 仅浏览器预览使用：写入一批带历史时间的示例碎片，方便看真实排版 */
  const handleSeed = useCallback(async () => {
    const now = Date.now();
    const min = 60 * 1000;
    const samples: [number, string][] = [
      [14 * min, '财务说要补一张 9 月的报销单，明天上午弄完'],
      [2 * 60 * min + 10 * min, '老张说 NAS 4 号盘有异响，可能是轴承'],
      [3 * 60 * min + 40 * min, '明天带 U 盘给小李，装系统用的'],
      [6 * 60 * min + 5 * min, '办公室空调漏水，报修单还没提'],
      [26 * 60 * min, '群晖的配置备份一直没做，得写个脚本定时跑'],
      [28 * 60 * min + 20 * min, '客户那台笔记本开机蓝屏，怀疑内存条'],
      [31 * 60 * min, '想起上周答应给行政做一批 U 盘启动盘'],
      [
        40 * 60 * min,
        '今天换 NAS 那块盘算是搞明白了一件事：RAID5 降级后先别急着拔盘，得先确认哪一块是热备、哪一块是真正故障的。热备会自动顶上开始重建，这时候拔错盘直接阵列报废。正确顺序是先看存储池状态确认降级位置，等重建跑完再换新盘。另外新盘插进去之前一定要先跑一次 SMART 长检，别拿一块本身有问题的盘去重建。',
      ],
      [50 * 60 * min, '2.5 寸螺丝刀丢了一把，买新的'],
      [52 * 60 * min + 30 * min, 'Ventoy 更新了，回头升级 U 盘'],
      [55 * 60 * min, '想给家里 NAS 加个远程访问，Tailscale 还是 RustDesk'],
    ];
    const ids: number[] = [];
    for (const [offset, text] of samples) {
      ids.push(await repo.insertFragment(text, 'app', now - offset));
    }

    // 给几条打上标签：真机上标签是整理时 AI 打的，但 Web 预览不会跑 AI，
    // 不打标签的话「点标签筛选」这个功能在预览里根本没法试
    const seedTags: [number, string[], string | null][] = [
      [0, ['财务', '待办'], '报销'],
      [1, ['设备', 'NAS'], 'NAS 维护'],
      [4, ['NAS', '备份'], 'NAS 维护'],
      [6, ['工具', '装机'], '装机'],
      [7, ['坑', 'NAS'], 'NAS 维护'],
      [9, ['工具', '装机'], '装机'],
      [10, ['网络', '方案'], null],
    ];
    for (const [i, labels, project] of seedTags) {
      if (ids[i] !== undefined) await repo.applyTags(ids[i], labels, project);
    }

    // 顺带造一条当天小结：否则详情页底部「当天小结」那块在预览里永远是空的
    await repo.upsertNote({
      type: 'daily',
      title: null,
      period: dayKey(now),
      bodyMd: [
        '## 今天主要花在三件事上',
        '',
        '- NAS 换盘：确认了 RAID5 降级后先看存储池状态，别急着拔盘',
        '- 一批启动盘还欠着行政，得排个时间',
        '- 报销单明天上午补完',
      ].join('\n'),
    });

    await reload();
  }, [reload]);

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
                  onAdd={handleAdd}
                  imageBusy={imageBusy}
                  imageFail={imageFail}
                  onReparseImage={handleReparseImage}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onDeleteNote={handleDeleteNote}
                  onOpenSettings={() => {
                    setSettingsFrom('timeline');
                    setRoute('settings');
                  }}
                  onOpenAsk={(fragmentId) => {
                    setAskContextId(fragmentId ?? null);
                    setRoute('ask');
                  }}
                  onOpenReview={() => setRoute('review')}
                  onOpenDocs={() => setRoute('docs')}
                  onSeed={isWeb ? handleSeed : undefined}
                />
              )}
              {route === 'settings' && (
                <SettingsScreen
                  fragments={fragments}
                  onClose={() => setRoute(settingsFrom)}
                  onChanged={reload}
                />
              )}
              {route === 'review' && (
                <ReviewScreen onClose={() => setRoute('timeline')} onChanged={reload} />
              )}
              {route === 'docs' && (
                <DocsScreen
                  onClose={() => setRoute('timeline')}
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
                  onClose={() => {
                    setRoute('timeline');
                    setAskContextId(null);
                    setAskDocIds(null);
                  }}
                  onSaved={reload}
                  registerClose={registerAskClose}
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
    marginVertical: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.shellBorder,
    overflow: 'hidden',
  },
  safe: { flex: 1, backgroundColor: c.page },
  splash: { flex: 1, backgroundColor: c.page },
});
