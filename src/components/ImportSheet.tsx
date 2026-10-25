import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { C, R } from '../theme';
import type { ImportPreview } from '../db/importMd';

interface Props {
  preview: ImportPreview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 导入前的确认页。
 *
 * 为什么非要这一层：导入是**往库里加东西**，而且用户往往是在慌的时候用
 * （刚换手机、刚重装）。这时候更需要先看清「要进来多少、跳过多少、时间跨度对不对」，
 * 而不是点一下就闷头写。选错文件、选成旧备份，都靠这一层拦下来。
 */
export function ImportSheet({ preview, busy, onCancel, onConfirm }: Props) {
  const nothing = preview.fresh.length === 0;

  // 返回键只在挂载时注册一次：onCancel 每次渲染都是新函数，
  // 放进依赖里会导致每帧卸载重挂监听器
  const live = useRef({ busy, onCancel });
  live.current = { busy, onCancel };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!live.current.busy) live.current.onCancel();
      return true;
    });
    return () => sub.remove();
  }, []);

  const notes: string[] = [];
  if (preview.withoutDate > 0) notes.push(`${preview.withoutDate} 条没写日期，会记在今天`);
  if (preview.badDateCount > 0) {
    notes.push(`有 ${preview.badDateCount} 个日期读不懂，那些条目也记在今天`);
  }
  if (preview.mergedSkipped > 0) notes.push(`跳过 ${preview.mergedSkipped} 条当初已合并的旧记录`);

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.backdrop} onPress={busy ? undefined : onCancel} />

      <View style={styles.card}>
        <View style={styles.head}>
          <View style={styles.iconWrap}>
            <Ionicons name="cloud-upload-outline" size={17} color={C.accentText} />
          </View>
          <Text style={styles.title}>导入 Markdown</Text>
        </View>

        <Text style={styles.file} numberOfLines={1}>
          {preview.fileName}
        </Text>
        <Text style={styles.scope}>
          共读到 {preview.total} 条 · {preview.from} ~ {preview.to}
        </Text>

        <View style={styles.grid}>
          <View style={styles.cell}>
            <Text style={styles.cellNum}>{preview.fresh.length}</Text>
            <Text style={styles.cellLabel}>会导入</Text>
          </View>
          <View style={styles.cellDivider} />
          <View style={styles.cell}>
            <Text style={[styles.cellNum, styles.cellNumMute]}>{preview.duplicates}</Text>
            <Text style={styles.cellLabel}>跳过</Text>
          </View>
        </View>

        <Text style={styles.dupHint}>
          {preview.duplicates > 0
            ? '跳过的这些库里已经有了（或者文件里写了两遍），不会再导一份。'
            : '库里没有重复内容，全部都是新的。'}
        </Text>

        {notes.map((n) => (
          <View key={n} style={styles.noteRow}>
            <Ionicons name="alert-circle-outline" size={13} color={C.amberText} />
            <Text style={styles.noteText}>{n}</Text>
          </View>
        ))}

        {nothing && (
          <Text style={styles.emptyHint}>没有可导入的新内容，这份文件可能已经导过了。</Text>
        )}

        <View style={styles.actions}>
          <Pressable
            style={({ pressed }) => [styles.cancelBtn, pressed && { backgroundColor: C.hairSoft }]}
            onPress={onCancel}
            disabled={busy}
          >
            <Text style={styles.cancelText}>取消</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              styles.okBtn,
              nothing && styles.okBtnOff,
              pressed && !nothing && { opacity: 0.85 },
            ]}
            onPress={onConfirm}
            disabled={busy || nothing}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.okText}>{nothing ? '没有新内容' : `导入 ${preview.fresh.length} 条`}</Text>
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  card: {
    backgroundColor: C.card,
    borderRadius: R.card + 4,
    padding: 18,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: C.accentBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 16, fontWeight: '600', color: C.text },
  file: { marginTop: 12, fontSize: 13, color: C.text, fontWeight: '500' },
  scope: { marginTop: 3, fontSize: 12, color: C.text3 },

  grid: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.hair,
  },
  cell: { flex: 1, alignItems: 'center' },
  cellDivider: { width: StyleSheet.hairlineWidth, height: 28, backgroundColor: C.hair },
  cellNum: { fontSize: 20, fontWeight: '600', color: C.accentText },
  cellNumMute: { color: C.text3 },
  cellLabel: { marginTop: 2, fontSize: 11, color: C.text2 },

  dupHint: { marginTop: 10, fontSize: 12, lineHeight: 18, color: C.text2 },

  noteRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 5, marginTop: 8 },
  noteText: { flex: 1, fontSize: 12, lineHeight: 17, color: C.amberText },

  emptyHint: { marginTop: 10, fontSize: 12, lineHeight: 18, color: C.text3 },

  actions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  cancelBtn: {
    flex: 1,
    height: 42,
    borderRadius: R.btn,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.hair,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: { fontSize: 14, color: C.text2 },
  okBtn: {
    flex: 1.4,
    height: 42,
    borderRadius: R.btn,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  okBtnOff: { backgroundColor: C.hair },
  okText: { fontSize: 14, fontWeight: '600', color: '#FFFFFF' },
});
