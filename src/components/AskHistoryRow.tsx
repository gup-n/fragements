/**
 * 历史会话列表里的一行。
 *
 * 从 `AskScreen` 搬出来的（v0.25）：它原来是个渲染函数，12 条样式和内联 JSX
 * 混在 1900 行的页面里，改一行历史样式要在整页里找。这里只有一个约束 ——
 * **不持有状态**，所有点击都往上抛，所以页面怎么管会话、这一行都不用改。
 *
 * 「已写入 N 篇」那一块是 Pressable + hitSlop 的坑：它在整行的 Pressable 里面，
 * 点它必须先被它接住，否则用户想看整理出的文档，结果把会话重新加载了一遍。
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AskSession } from '../types';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { dayKey, formatTime } from '../util/date';
import { plainPreview } from '../util/askText';
import { IconButton } from './IconButton';

interface Props {
  session: AskSession;
  /** 是不是当前打开的这场 */
  active: boolean;
  onOpen: (session: AskSession) => void;
  /** 点「已写入 N 篇」：列出这场整理出的文档 */
  onOpenDocs: (session: AskSession) => void;
  /** 右侧「⋯」：归档 / 删除 */
  onManage: (session: AskSession) => void;
}

export function AskHistoryRow({ session, active, onOpen, onOpenDocs, onManage }: Props) {
  const { styles } = useThemedStyles(makeStyles);
  const last = session.turns[session.turns.length - 1];
  const hasStatus = Boolean(
    session.documentIds.length ||
      session.documentId ||
      session.fragmentId ||
      session.scope?.kind === 'documents' ||
      session.archived ||
      active,
  );

  return (
    <View style={[styles.histRow, active && styles.histRowSelected]}>
      <Pressable
        style={styles.histMain}
        onPress={() => onOpen(session)}
        accessibilityRole="button"
        accessibilityLabel={`打开会话 ${session.title}`}
        accessibilityState={{ selected: active }}
      >
        <View style={styles.histTop}>
          <Text style={styles.histTitle} numberOfLines={2}>
            {session.title}
          </Text>
        </View>
        <Text style={styles.histMeta}>
          {dayKey(session.updatedAt)} {formatTime(session.updatedAt)} · {session.turns.length} 轮
        </Text>
        {hasStatus ? (
          <View style={styles.histStatus}>
            {active ? <Text style={styles.histScope}>当前会话</Text> : null}
            {session.documentIds.length || session.documentId ? (
              <Pressable
                onPress={() => onOpenDocs(session)}
                style={styles.histBadgeHit}
                accessibilityRole="button"
                accessibilityLabel="打开这场会话整理出的文档"
              >
                <Text style={styles.histBadge}>
                  {session.documentIds.length > 1 ? `已写入 ${session.documentIds.length} 篇` : '已写入文档'}
                </Text>
              </Pressable>
            ) : session.fragmentId ? (
              <Text style={styles.histBadge}>已整理</Text>
            ) : null}
            {session.scope?.kind === 'documents' ? (
              <Text style={styles.histScope}>文档 {session.scope.documentIds.length} 份</Text>
            ) : null}
            {session.archived ? <Text style={styles.histArchived}>已归档</Text> : null}
          </View>
        ) : null}
        {last ? (
          <Text style={styles.histPreview} numberOfLines={2}>
            {plainPreview(last.answer)}
          </Text>
        ) : null}
      </Pressable>
      <IconButton
        name="ellipsis-horizontal"
        size={18}
        tone="soft"
        diameter={30}
        onPress={() => onManage(session)}
        accessibilityLabel={`管理会话 ${session.title}`}
      />
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  histRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.xxs,
    paddingHorizontal: SPACE.sm, paddingVertical: SPACE.md, marginBottom: SPACE.xxs,
    borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair,
  },
  histRowSelected: { backgroundColor: c.accentBg, borderRadius: metrics.buttonRadius, borderLeftWidth: metrics.strokeWidth * 2, borderLeftColor: c.accent },
  histMain: { minHeight: metrics.controlHeight, justifyContent: 'center', flex: 1, minWidth: 0 },
  histTop: { alignItems: 'flex-start' },
  histTitle: { ...TYPE.title, color: c.text },
  histStatus: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs, marginTop: SPACE.xxs },
  histBadgeHit: { minHeight: metrics.controlHeight, justifyContent: 'center', paddingHorizontal: SPACE.sm, backgroundColor: c.hairSoft, borderRadius: metrics.buttonRadius },
  histBadge: { ...TYPE.label, color: c.accentText },
  histArchived: { ...TYPE.meta, color: c.text2 },
  histScope: { ...TYPE.meta, color: c.text2 },
  histMeta: { ...TYPE.meta, color: c.text2, marginTop: SPACE.xxs, fontVariant: ['tabular-nums'] },
  histPreview: { ...TYPE.body, color: c.text2, marginTop: SPACE.xs },
});
