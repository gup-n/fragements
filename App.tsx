import React, { useCallback, useEffect, useState } from 'react';
import { BackHandler, Platform, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Fragment } from './src/types';
import { C } from './src/theme';
import { repo } from './src/db/repo';
import { TimelineScreen } from './src/screens/TimelineScreen';
import { OrganizeScreen } from './src/screens/OrganizeScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { KnowledgeScreen } from './src/screens/KnowledgeScreen';
import { ReviewScreen } from './src/screens/ReviewScreen';

type Route = 'timeline' | 'organize' | 'settings' | 'knowledge' | 'review';

const isWeb = Platform.OS === 'web';

export default function App() {
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState<Route>('timeline');
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [inboxCount, setInboxCount] = useState(0);

  const reload = useCallback(async () => {
    const list = await repo.listFragments();
    setFragments(list);
    setInboxCount(await repo.countInbox());
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
    for (const [offset, text] of samples) {
      await repo.insertFragment(text, 'app', now - offset);
    }
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
                  inboxCount={inboxCount}
                  onAdd={handleAdd}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
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
              {route === 'review' && <ReviewScreen onClose={() => setRoute('timeline')} />}
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
