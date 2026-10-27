/**
 * 标签管理：改名 / 合并 / 删除。
 *
 * 有三个刻意的选择：
 * - **没有单独的「合并」按钮**。把名字改成一个已有标签，本来就是合并 ——
 *   两个入口做同一件事，用户得先想「我这个情况算改名还是算合并」。
 *   现在只有一个输入框，输入已有名字就是并过去，输入新名字就是改名。
 * - **就地展开，不用弹层**。Android 上 `Modal` 和自绘覆盖层都要自己接
 *   BackHandler，为了一个输入框不值当；就地展开还顺带保留了上下文。
 * - **删除要两步**。删标签虽然不动碎片正文，但「这个标签下有哪些东西」
 *   这条线索会永久消失，误触一下代价太大。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { TagStat } from '../types';
import { R, useThemedStyles, type Palette, tagColor } from '../theme';
import { repo } from '../db/repo';
import { cleanTag, normalizeTag, sameTag } from '../util/tokenize';
import { useKeyboardHeight } from '../util/keyboard';

interface Props {
  /** 标签变了（时间轴上的标签会跟着变），通知外层刷新 */
  onChanged?: () => void | Promise<void>;
}

export function TagPanel({ onChanged }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [tags, setTags] = useState<TagStat[]>([]);
  const [loading, setLoading] = useState(true);
  /** 正在编辑的标签原名 */
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const keyboardHeight = useKeyboardHeight();

  const reload = useCallback(async () => {
    const list = await repo.listTags();
    setTags(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const total = useMemo(() => tags.reduce((n, t) => n + t.count, 0), [tags]);

  function open(tag: TagStat) {
    if (editing === tag.name) {
      setEditing(null);
      return;
    }
    setEditing(tag.name);
    setText(tag.name);
    setArmed(false);
    setMsg('');
  }

  async function save() {
    if (!editing || busy) return;
    const name = cleanTag(text);
    if (!normalizeTag(name)) {
      setMsg('标签不能为空');
      return;
    }
    if (sameTag(name, editing)) {
      setEditing(null);
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const hit = tags.find((t) => t.name !== editing && sameTag(t.name, name));
      if (hit) {
        const { changed } = await repo.mergeTags([editing], hit.name);
        setMsg(`已合并到「${hit.name}」，${changed} 条碎片受影响`);
      } else {
        const { changed } = await repo.renameTag(editing, name);
        setMsg(`已改名为「${name}」，${changed} 条碎片受影响`);
      }
      setEditing(null);
      await reload();
      await onChanged?.();
    } catch (e) {
      setMsg((e as Error)?.message || '改不动，再试一次');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing || busy) return;
    if (!armed) {
      setArmed(true);
      setMsg('删除后这个标签从所有碎片上消失，正文不受影响。再点一次确认。');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const { changed } = await repo.deleteTag(editing);
      setMsg(`已删除，${changed} 条碎片受影响`);
      setEditing(null);
      setArmed(false);
      await reload();
      await onChanged?.();
    } catch (e) {
      setMsg((e as Error)?.message || '删不掉，再试一次');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={[styles.content, keyboardHeight > 0 && { paddingBottom: keyboardHeight + 24 }]}
      keyboardShouldPersistTaps="handled"
    >
      {tags.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>还没有标签</Text>
          <Text style={styles.emptyBody}>
            整理一轮之后，模型会给每条碎片打 1-3 个标签。{'\n'}
            这里可以改名、合并、删掉不想要的。
          </Text>
        </View>
      ) : (
        <>
          <Text style={styles.hint}>
            共 {tags.length} 个标签、{total} 次使用。改名只改标签，不动碎片正文。
          </Text>

          <View style={styles.group}>
            {tags.map((tag, i) => {
              const col = tagColor(c, tag.name);
              const isOpen = editing === tag.name;
              return (
                <View key={tag.name}>
                  <Pressable
                    onPress={() => open(tag)}
                    style={({ pressed }) => [
                      styles.row,
                      i === tags.length - 1 && !isOpen && styles.rowLast,
                      pressed && { backgroundColor: c.hairSoft },
                    ]}
                  >
                    <View style={[styles.pill, { backgroundColor: col.bg }]}>
                      <Text style={[styles.pillText, { color: col.fg }]}>{tag.name}</Text>
                    </View>
                    <Text style={styles.count}>{tag.count}</Text>
                    <Ionicons
                      name={isOpen ? 'chevron-up' : 'chevron-down'}
                      size={13}
                      color={c.text3}
                    />
                  </Pressable>

                  {isOpen && (
                    <View style={styles.editor}>
                      <TextInput
                        value={text}
                        onChangeText={(v) => {
                          setText(v);
                          setArmed(false);
                        }}
                        placeholder="改成什么？输入已有标签名就是合并"
                        placeholderTextColor={c.text3}
                        style={styles.input}
                        maxLength={12}
                        autoFocus
                        returnKeyType="done"
                        onSubmitEditing={save}
                      />
                      <Text style={styles.editorHint}>
                        输入一个已有标签名 = 合并到那个标签；输入新名字 = 改名。
                      </Text>
                      <View style={styles.actionRow}>
                        <Pressable
                          style={[styles.saveBtn, busy && styles.btnOff]}
                          onPress={save}
                          disabled={busy}
                        >
                          <Text style={styles.saveText}>{busy ? '处理中…' : '保存'}</Text>
                        </Pressable>
                        <Pressable
                          style={[styles.delBtn, armed && styles.delBtnArmed]}
                          onPress={remove}
                          disabled={busy}
                        >
                          <Text style={[styles.delText, armed && styles.delTextArmed]}>
                            {armed ? '确认删除' : '删除标签'}
                          </Text>
                        </Pressable>
                        <Pressable
                          style={styles.cancelBtn}
                          onPress={() => {
                            setEditing(null);
                            setArmed(false);
                            setMsg('');
                          }}
                        >
                          <Text style={styles.cancelText}>取消</Text>
                        </Pressable>
                      </View>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        </>
      )}

      {!!msg && <Text style={styles.msg}>{msg}</Text>}
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  center: { paddingVertical: 80, alignItems: 'center' },
  content: { paddingHorizontal: 16, paddingBottom: 28 },
  hint: { fontSize: 12, color: c.text3, marginBottom: 10, lineHeight: 18 },

  empty: { alignItems: 'center', paddingTop: 90 },
  emptyTitle: { fontSize: 15, color: c.text2, fontWeight: '500' },
  emptyBody: { fontSize: 13, color: c.text3, textAlign: 'center', lineHeight: 21, marginTop: 10 },

  group: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  rowLast: { borderBottomWidth: 0 },
  pill: { borderRadius: R.pill, paddingHorizontal: 9, paddingVertical: 3 },
  pillText: { fontSize: 12.5, lineHeight: 17, fontWeight: '500' },
  count: { flex: 1, fontSize: 12, color: c.text3, textAlign: 'right' },

  editor: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 14,
    gap: 8,
    backgroundColor: c.hairSoft,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  input: {
    backgroundColor: c.card,
    borderRadius: R.btn,
    borderWidth: 0.5,
    borderColor: c.hair,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: c.text,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
  },
  editorHint: { fontSize: 11, color: c.text3, lineHeight: 16 },
  actionRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  saveBtn: {
    backgroundColor: c.accent,
    borderRadius: R.btn,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  saveText: { fontSize: 13, color: c.onAccent, fontWeight: '500' },
  btnOff: { opacity: 0.6 },
  delBtn: {
    borderRadius: R.btn,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 0.5,
    borderColor: c.hair,
  },
  delBtnArmed: { borderColor: c.danger, backgroundColor: c.dangerBg },
  delText: { fontSize: 13, color: c.text2 },
  delTextArmed: { color: c.danger, fontWeight: '500' },
  cancelBtn: { paddingHorizontal: 8, paddingVertical: 8 },
  cancelText: { fontSize: 13, color: c.text3 },

  msg: { fontSize: 12, color: c.text2, lineHeight: 18, marginTop: 12, paddingHorizontal: 2 },
});
