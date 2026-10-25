import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Platform, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Fragment, Note } from './src/types';
import { C } from './src/theme';
import { repo } from './src/db/repo';
import { TimelineScreen } from './src/screens/TimelineScreen';
import { OrganizeScreen } from './src/screens/OrganizeScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { ReviewScreen } from './src/screens/ReviewScreen';
import { AskScreen } from './src/screens/AskScreen';
import { dayKey } from './src/util/date';

type Route = 'timeline' | 'organize' | 'settings' | 'review' | 'ask';

const isWeb = Platform.OS === 'web';

export default function App() {
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
  const [inboxCount, setInboxCount] = useState(0);

  const reload = useCallback(async () => {
    const [list, inbox, noteList, done] = await Promise.all([
      repo.listFragments(),
      repo.countInbox(),
      repo.listNotes(120),
      repo.listDoneTodoSourceIds(),
    ]);
    setFragments(list);
    setInboxCount(inbox);
    setNotes(noteList);
    setDoneIds(new Set(done));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await repo.init();
        await reload();
      } catch (e) {
        console.warn('[fragments] 初始化失败', e);
      } finally {
        setReady(true);
      }
    })();
  }, [reload]);

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

  const handleAdd = useCallback(
    async (text: string) => {
      await repo.insertFragment(text, 'app');
      await reload();
      if (!isWeb) {
        try {
          const Haptics = require('expo-haptics');
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } catch {
          /* 震动失败不影响记录 */
        }
      }
    },
    [reload],
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
      await repo.deleteFragment(id);
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
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <View style={[styles.outer, isWeb && styles.outerWeb]}>
        <View style={[styles.app, isWeb && styles.appWeb]}>
          {ready ? (
            <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
              {route === 'timeline' && (
                <TimelineScreen
                  fragments={fragments}
                  notes={notes}
                  inboxCount={inboxCount}
                  doneIds={doneIds}
                  draft={draft}
                  onDraftChange={setDraft}
                  onAdd={handleAdd}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onDeleteNote={handleDeleteNote}
                  onOpenOrganize={() => setRoute('organize')}
                  onOpenSettings={() => {
                    setSettingsFrom('timeline');
                    setRoute('settings');
                  }}
                  onOpenAsk={() => setRoute('ask')}
                  onOpenReview={() => setRoute('review')}
                  onSeed={isWeb ? handleSeed : undefined}
                />
              )}
              {route === 'organize' && (
                <OrganizeScreen
                  fragments={fragments}
                  notes={notes}
                  onClose={() => setRoute('timeline')}
                  onApplied={reload}
                  onOpenSettings={() => {
                    setSettingsFrom('organize');
                    setRoute('settings');
                  }}
                />
              )}
              {route === 'settings' && (
                <SettingsScreen
                  fragments={fragments}
                  onClose={() => setRoute(settingsFrom)}
                />
              )}
              {route === 'review' && (
                <ReviewScreen onClose={() => setRoute('timeline')} onChanged={reload} />
              )}
              {route === 'ask' && (
                <AskScreen
                  onClose={() => setRoute('timeline')}
                  onSaved={reload}
                  registerClose={registerAskClose}
                />
              )}
            </SafeAreaView>
          ) : (
            <View style={styles.splash} />
          )}
        </View>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  outer: { flex: 1, backgroundColor: C.page },
  outerWeb: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#EDEDE7' },
  app: { flex: 1, alignSelf: 'stretch', backgroundColor: C.page },
  appWeb: {
    flex: 0,
    height: '100%',
    maxHeight: 880,
    width: 420,
    maxWidth: '100%',
    marginVertical: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DEDED6',
    overflow: 'hidden',
  },
  safe: { flex: 1, backgroundColor: C.page },
  splash: { flex: 1, backgroundColor: C.page },
});
