import React, { useCallback, useEffect, useState } from 'react';
import { BackHandler, Platform, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Fragment, Note } from './src/types';
import { C } from './src/theme';
import { repo } from './src/db/repo';
import { TimelineScreen } from './src/screens/TimelineScreen';
import { OrganizeScreen } from './src/screens/OrganizeScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { KnowledgeScreen } from './src/screens/KnowledgeScreen';
import { ReviewScreen } from './src/screens/ReviewScreen';
import { dayKey } from './src/util/date';

type Route = 'timeline' | 'organize' | 'settings' | 'knowledge' | 'review';

const isWeb = Platform.OS === 'web';

export default function App() {
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState<Route>('timeline');
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
      if (route !== 'timeline') {
        setRoute('timeline');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [route]);

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

    // 顺带造几张知识卡：预览里 otherwise 知识库永远是空的，
    // 「主题 → 小方向」两级和主题整理入口就没东西可看
    const seedCards: { topic: string; subtopic: string | null; title: string; gist: string; body: string }[] = [
      {
        topic: 'NAS 维护',
        subtopic: '换盘',
        title: 'RAID5 降级后先确认故障盘再拔',
        gist: '- 先看存储池状态确认降级位置\n- 热备会自动顶上重建，拔错盘直接报废\n- 新盘先跑 SMART 长检再插',
        body: 'RAID5 降级后先别急着拔盘，得先确认哪一块是热备、哪一块是真正故障的。热备会自动顶上开始重建，这时候拔错盘直接阵列报废。',
      },
      {
        topic: 'NAS 维护',
        subtopic: '备份',
        title: '配置备份要脚本化定时跑',
        gist: '- 群晖配置备份不能靠手点\n- 计划任务每周跑一次，存到独立卷',
        body: '群晖的配置备份一直没做，得写个脚本定时跑。',
      },
      {
        topic: 'NAS 维护',
        subtopic: null,
        title: 'SHR 比 RAID5 更适合混插盘位',
        gist: '- SHR 允许不同容量混插\n- RAID5 按最小盘算，大盘浪费',
        body: '整理旧笔记时发现：同容量盘才用 RAID5，混插一律 SHR。',
      },
      {
        topic: '装机',
        subtopic: null,
        title: 'Ventoy 升级后要重新校验启动',
        gist: '- 升级 Ventoy 会重写引导区\n- 老机器上要再验一次 UEFI 启动',
        body: 'Ventoy 更新了，回头升级 U 盘。',
      },
      {
        topic: '工具',
        subtopic: null,
        title: '批量做启动盘可以脚本化',
        gist: '- 用 diskpart + imagex 组合\n- 一次做十张，别一张张点',
        body: '想起上周答应给行政做一批 U 盘启动盘。',
      },
      {
        topic: '资讯',
        subtopic: null,
        title: '长文档问答的关键是切片粒度',
        gist: '- 切太碎丢上下文，切太大挤爆窗口\n- 按语义段落切比按字数切稳',
        body: '看了一篇讲 RAG 的文章，说切片粒度比模型选型更影响效果。',
      },
    ];
    for (const c of seedCards) {
      await repo.insertKnowledgeCard({ ...c, sourceIds: [] });
    }

    // 一条当天小结：否则详情页底部「当天小结」那块在预览里永远是空的
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

    // 一条问答记录：预览里「问答记录」那个扁平和区才有东西可看
    await repo.insertAskLog({
      scope: 'NAS 维护',
      question: '群晖换盘之后还要做什么？',
      answer:
        '换完新盘先别急着结束：先在存储池页面确认重建已经跑起来，重建期间别动其他盘位。重建完成后跑一次数据一致性检查，再确认 SMART 没有新增告警。',
      reasoning: '',
      citedIds: [],
      web: [],
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
                  onAdd={handleAdd}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onDeleteNote={handleDeleteNote}
                  onOpenOrganize={() => setRoute('organize')}
                  onOpenSettings={() => setRoute('settings')}
                  onOpenKnowledge={() => setRoute('knowledge')}
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
                  onOpenSettings={() => setRoute('settings')}
                />
              )}
              {route === 'settings' && (
                <SettingsScreen fragments={fragments} onClose={() => setRoute('timeline')} />
              )}
              {route === 'knowledge' && (
                <KnowledgeScreen onClose={() => setRoute('timeline')} />
              )}
              {route === 'review' && (
                <ReviewScreen onClose={() => setRoute('timeline')} onChanged={reload} />
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
