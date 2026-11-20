/**
 * 回收站（v0.28）。
 *
 * 位置：设置 → 回收站（v0.30 起从「数据与备份」里独立出来，用户 2026-11-19 要求）。
 * 它仍然不是一个独立底栏项：回收站是「收拾东西」的地方，一年也开不了几次，
 * 占一个底栏位置就是天天挡路。
 *
 * **多选是默认形态**（用户 2026-11-18 明确要求恢复也要能多选）：
 * 一次删掉十条碎片、发现删错了，逐条恢复要点十次 —— 而那十条通常是同一批误操作。
 *
 * 两类动作的语气必须不一样：
 * - 恢复：就地生效，只有一句结果；
 * - 彻底删除：两步确认，并且说清「图片和原件也会一起没」——
 *   它之后数据库里连一条记录都不剩，30 天的后悔期到此为止。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { TrashEntry, TrashKind } from '../types';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { BusyIndicator as ActivityIndicator } from '../components/BusyIndicator';
import { EmptyState } from '../components/EmptyState';
import { repo } from '../db/repo';
import { dayLabel, formatTime } from '../util/date';
import { hasRef, toggleRef, trashActionText, trashLeftText, trashSummary } from '../util/trash';
import { deleteTrashFile, runTrashCleanup } from '../db/trashFiles';

interface Props {
  /** 恢复或彻底删除之后，让 App 重读一遍数据 */
  onChanged: () => void;
}

const KIND_LABEL: Record<TrashKind, string> = {
  fragment: '碎片',
  document: '文档',
  ask_session: '问答',
};

export function TrashPane({ onChanged }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [picked, setPicked] = useState<TrashEntry[]>([]);
  const [busy, setBusy] = useState<'idle' | 'restoring' | 'purging'>('idle');
  const [armed, setArmed] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await repo.listTrash();
      if (!alive.current) return;
      setEntries(list);
      // 列表变了，勾选跟着收：留下的勾选指向已经不在的行，按下去什么都不会发生
      setPicked((prev) => prev.filter((p) => list.some((e) => e.kind === p.kind && e.id === p.id)));
    } catch (e) {
      if (alive.current) {
        setEntries([]);
        setMsg({ kind: 'err', text: e instanceof Error ? e.message : '读取回收站失败' });
      }
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /*
   * 30 天到期清理。放在这里跑一次而不是 App 启动时：
   * 清理要删文件（配图、原件），失败时用户得能看见 —— 在启动流程里悄悄失败，
   * 空间就一直不回。这一页本来就是「我删了什么」的入口，在这里清最容易被发现。
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await runTrashCleanup();
      if (cancelled || !result.files) return;
      await refresh();
      if (alive.current) setMsg({ kind: 'ok', text: `已清理 ${result.files} 个到期文件` });
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  const allPicked = !!entries?.length && picked.length === entries.length;

  function pickAll() {
    setArmed(false);
    setPicked(allPicked ? [] : [...(entries ?? [])]);
  }

  async function restore() {
    if (!picked.length || busy !== 'idle') return;
    setBusy('restoring');
    setArmed(false);
    setMsg(null);
    try {
      const n = await repo.restoreTrash(picked.map(({ kind, id }) => ({ kind, id })));
      if (!alive.current) return;
      setMsg({ kind: 'ok', text: n > 0 ? `已恢复 ${n} 条` : '这些已经不在回收站里了' });
      setPicked([]);
      await refresh();
      onChanged();
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: e instanceof Error ? e.message : '恢复失败' });
    } finally {
      if (alive.current) setBusy('idle');
    }
  }

  async function purge() {
    if (!picked.length || busy !== 'idle') return;
    // 破坏性动作必须两步：第一次只把话说清，第二次才真删
    if (!armed) { setArmed(true); return; }
    setBusy('purging');
    setMsg(null);
    try {
      const files = await repo.purgeTrash(picked.map(({ kind, id }) => ({ kind, id })));
      if (!alive.current) return;
      const failed: string[] = [];
      for (const file of files) {
        const cleaned = await deleteTrashFile(file);
        if (!cleaned) failed.push(file);
      }
      setMsg({
        kind: failed.length ? 'err' : 'ok',
        text: failed.length
          ? `记录已经删掉，但有 ${failed.length} 个文件没删成（可能被别的应用占用），下次打开会再试`
          : `已彻底删除 ${picked.length} 条`,
      });
      setPicked([]);
      setArmed(false);
      await refresh();
      onChanged();
    } catch (e) {
      if (alive.current) setMsg({ kind: 'err', text: e instanceof Error ? e.message : '删除失败' });
    } finally {
      if (alive.current) setBusy('idle');
    }
  }

  if (entries === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={c.text3} />
        <Text style={styles.hint}>正在读取回收站…</Text>
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.summary}>{trashSummary(entries, Date.now())}</Text>

        {entries.length ? (
          <View style={styles.toolbar}>
            <Pressable
              style={({ pressed }) => [styles.selectAll, pressed && { opacity: 0.7 }]}
              onPress={pickAll}
              accessibilityRole="button"
              accessibilityState={{ selected: allPicked }}
              accessibilityLabel={allPicked ? '取消全选' : '全选回收站里的条目'}
            >
              <Ionicons name={allPicked ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={allPicked ? c.accent : c.text3} />
              <Text style={styles.selectAllText}>{allPicked ? '取消全选' : '全选'}</Text>
            </Pressable>
            <Text style={styles.pickedCount}>已选 {picked.length} / {entries.length}</Text>
          </View>
        ) : null}

        {msg ? (
          <Text style={[styles.msg, msg.kind === 'err' ? styles.msgErr : styles.msgOk]} accessibilityLiveRegion="polite">
            {msg.text}
          </Text>
        ) : null}

        {entries.length === 0 ? (
          <EmptyState
            icon="trash-outline"
            title="回收站是空的"
            body="删除的碎片、文档和问答会话会先到这里，30 天后自动清空。"
          />
        ) : (
          <View style={styles.card}>
            {entries.map((entry, index) => {
              const on = hasRef(picked, entry);
              return (
                <Pressable
                  key={`${entry.kind}:${entry.id}`}
                  style={({ pressed }) => [
                    styles.row,
                    index > 0 && styles.rowLine,
                    pressed && { backgroundColor: c.hairSoft },
                  ]}
                  onPress={() => { setArmed(false); setPicked((prev) => toggleRef(prev, entry)); }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${on ? '取消选择' : '选择'} ${KIND_LABEL[entry.kind]} ${entry.title}`}
                >
                  <Ionicons
                    name={on ? 'checkmark-circle' : 'ellipse-outline'}
                    size={20}
                    color={on ? c.accent : c.text3}
                  />
                  <View style={styles.rowBody}>
                    <Text style={styles.rowTitle} numberOfLines={2}>{entry.title}</Text>
                    <View style={styles.rowMeta}>
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{KIND_LABEL[entry.kind]}</Text>
                      </View>
                      <Text style={styles.rowDetail}>
                        {entry.detail} · 删于 {dayLabel(entry.deletedAt)} {formatTime(entry.deletedAt)} ·{' '}
                        {trashLeftText(entry.deletedAt, Date.now())}
                      </Text>
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}

        {entries.length ? (
          <Text style={styles.hint}>
            彻底删除之后，图片和文档原件也会一起删掉，数据库里不再有这条记录。
          </Text>
        ) : null}
      </ScrollView>

      {entries.length ? (
        <View style={styles.bar}>
          <Pressable
            style={({ pressed }) => [
              styles.btn,
              !picked.length && styles.btnOff,
              pressed && picked.length ? { opacity: 0.85 } : null,
            ]}
            onPress={() => void restore()}
            disabled={!picked.length || busy !== 'idle'}
            accessibilityRole="button"
            accessibilityState={{ disabled: !picked.length || busy !== 'idle' }}
            accessibilityLabel={trashActionText('恢复', picked.length)}
          >
            <Ionicons name="arrow-undo-outline" size={16} color={picked.length ? c.onAccent : c.text3} />
            <Text style={[styles.btnText, !picked.length && styles.btnTextOff]}>
              {busy === 'restoring' ? '正在恢复…' : trashActionText('恢复', picked.length)}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.btn,
              styles.dangerBtn,
              !picked.length && styles.btnOff,
              pressed && picked.length ? { opacity: 0.85 } : null,
            ]}
            onPress={() => void purge()}
            disabled={!picked.length || busy !== 'idle'}
            accessibilityRole="button"
            accessibilityState={{ disabled: !picked.length || busy !== 'idle' }}
            accessibilityLabel={armed ? '确认彻底删除，无法恢复' : trashActionText('彻底删除', picked.length)}
          >
            <Ionicons name="trash-outline" size={16} color={picked.length ? c.onDanger : c.text3} />
            <Text style={[styles.dangerText, !picked.length && styles.btnTextOff]}>
              {busy === 'purging' ? '正在删除…' : armed ? '确认彻底删除' : trashActionText('彻底删除', picked.length)}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {armed ? (
        <Text style={styles.armText} accessibilityLiveRegion="polite">
          再按一次就真的删了：这 {picked.length} 条连同它们的图片和原件都不会留下。
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACE.sm },
  content: { paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.md, gap: SPACE.sm },
  summary: { ...TYPE.compact, color: c.text2 },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: metrics.controlHeight },
  selectAll: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 36 },
  selectAllText: { ...TYPE.label, color: c.text },
  pickedCount: { ...TYPE.meta, color: c.text2, fontVariant: ['tabular-nums'] },
  msg: { ...TYPE.compact },
  msgOk: { color: c.tealText },
  msgErr: { color: c.danger },
  card: { backgroundColor: c.card, borderRadius: metrics.cardRadius, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, minHeight: 56 },
  rowLine: { borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { ...TYPE.compact, color: c.text, fontWeight: '600' },
  rowMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  badge: { backgroundColor: c.hairSoft, borderRadius: 4, paddingHorizontal: 5 },
  badgeText: { ...TYPE.caption, color: c.text2, fontWeight: '600' },
  rowDetail: { ...TYPE.meta, color: c.text2, flexShrink: 1 },
  hint: { ...TYPE.meta, color: c.text2 },
  bar: {
    flexDirection: 'row', gap: SPACE.xs, paddingHorizontal: metrics.pagePadding,
    paddingVertical: SPACE.sm, borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair,
  },
  btn: {
    flex: 1, minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: SPACE.xs, borderRadius: metrics.buttonRadius, backgroundColor: c.accent,
  },
  btnOff: { backgroundColor: c.hairSoft },
  btnText: { ...TYPE.body, color: c.onAccent, fontWeight: '600' },
  btnTextOff: { color: c.text3 },
  dangerBtn: { backgroundColor: c.dangerBg },
  dangerText: { ...TYPE.body, color: c.danger, fontWeight: '600' },
  armText: {
    ...TYPE.compact, color: c.danger, backgroundColor: c.dangerBg,
    paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.sm,
  },
});
