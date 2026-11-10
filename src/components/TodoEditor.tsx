/**
 * 待办的编辑层：新建顶层、给某条加子项、改文字与到期日，共用一个面板。
 *
 * 三种场景的字段完全一样，拆成三个面板只会让校验和保存各写三遍。
 * 差异只有标题文案，以及保存时走 insert 还是 update —— 用 `todo` 是否为 null 区分。
 *
 * 全屏覆盖层而不是 Modal：安卓上 Modal 会把返回键接管成一套自己的手势，
 * 而且键盘弹起时高度计算是另一套。项目红线见 AGENTS.md。
 */
import React, { useEffect, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Todo } from '../types';
import { repo } from '../db/repo';
import { dayKey } from '../util/date';
import { useKeyboardHeight } from '../util/keyboard';
import { R, useThemedStyles, type Palette } from '../theme';
import { ScreenHeader } from './ScreenHeader';

interface Props {
  /** null = 新建 */
  todo: Todo | null;
  /** 新建子项时的父项 id；新建顶层或编辑时传 null */
  parentId: number | null;
  /** 父项文字，只用于「加到 X 下面」这句提示 */
  parentText?: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

/** `2026-11-30` 形状对、日期也真实存在（`2026-13-01` 正则过得去但 Date 是 Invalid） */
function validDue(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

export function TodoEditor({ todo, parentId, parentText, onClose, onSaved }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const keyboardHeight = useKeyboardHeight();

  const [text, setText] = useState(todo?.text ?? '');
  const [due, setDue] = useState(todo?.dueAt ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const title = todo ? '编辑待办' : parentId === null ? '新建待办' : '加一条子项';

  async function save() {
    if (busy) return;
    const body = text.trim();
    if (!body) {
      setError('写点什么再保存');
      return;
    }
    const dueAt = due.trim();
    if (dueAt && !validDue(dueAt)) {
      setError('日期写成 2026-11-30 这样的格式');
      return;
    }

    setBusy(true);
    setError('');
    try {
      if (todo) {
        // dueAt 传 null 才是「清掉日期」；传 undefined 是「不动」，两者不能混
        await repo.updateTodo(todo.id, { text: body, dueAt: dueAt || null });
      } else {
        await repo.insertTodo({
          text: body,
          dueAt: dueAt || null,
          sourceFragmentId: null,
          parentId,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '没保存上，再试一次');
      setBusy(false);
      return;
    }

    // 内容已经写进库。刷新失败不能报成「保存失败」，否则用户会以为没存上又存一次
    try {
      await onSaved();
    } catch {
      /* 交给下次进页面 */
    }
    setBusy(false);
    onClose();
  }

  const tomorrow = dayKey(Date.now() + 86400000);

  return (
    /*
     * 键盘高度直接垫在根容器的 paddingBottom 上：这样底部按钮和输入框一起被顶上来。
     * 项目里不用 `KeyboardAvoidingView` —— 在 Android 上它的位移恒为 0，
     * 看着像「键盘盖住了输入框但页面没动」。见 AGENTS「Android UI 红线」。
     */
    <View style={[styles.root, keyboardHeight > 0 && { paddingBottom: keyboardHeight }]}>
      <ScreenHeader title={title} backIcon="close" onBack={onClose} />

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {parentId !== null && parentText ? (
          <Text style={styles.parentHint}>加到「{parentText}」下面</Text>
        ) : null}

        <Text style={styles.label}>做什么</Text>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={(v) => {
            setText(v);
            if (error) setError('');
          }}
          placeholder="一句话说清要做什么"
          placeholderTextColor={c.text3}
          multiline
          autoFocus
          maxLength={200}
        />

        <Text style={styles.label}>哪天做（可不填）</Text>
        <TextInput
          style={styles.input}
          value={due}
          onChangeText={(v) => {
            setDue(v);
            if (error) setError('');
          }}
          placeholder="2026-11-30"
          placeholderTextColor={c.text3}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={10}
        />
        <View style={styles.quickRow}>
          {[
            ['今天', dayKey(Date.now())],
            ['明天', tomorrow],
            ['清除', ''],
          ].map(([label, value]) => (
            <Pressable
              key={label}
              onPress={() => {
                setDue(value);
                if (error) setError('');
              }}
              style={({ pressed }) => [styles.quickChip, pressed && { backgroundColor: c.hairSoft }]}
            >
              <Text style={styles.quickText}>{label}</Text>
            </Pressable>
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable style={styles.ghostBtn} onPress={onClose} disabled={busy}>
          <Text style={styles.ghostText}>取消</Text>
        </Pressable>
        <Pressable
          style={[styles.primaryBtn, busy && styles.btnDisabled]}
          onPress={save}
          disabled={busy}
        >
          <Text style={styles.primaryText}>{todo ? '保存' : '加进列表'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.page },
  content: { paddingHorizontal: 16, paddingTop: 6 },

  parentHint: { fontSize: 12, color: c.text3, lineHeight: 18, marginBottom: 10 },

  label: { fontSize: 12, color: c.text3, marginTop: 18, marginBottom: 8 },
  input: {
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: 0.5,
    borderColor: c.hair,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14.5,
    lineHeight: 22,
    color: c.text,
    minHeight: 46,
  },

  quickRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  quickChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: R.pill,
    borderWidth: 0.5,
    borderColor: c.hair,
    backgroundColor: c.card,
  },
  quickText: { fontSize: 12, color: c.text2 },

  error: { fontSize: 12, color: c.danger, lineHeight: 19, marginTop: 14 },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
    backgroundColor: c.page,
  },
  primaryBtn: {
    backgroundColor: c.accent,
    borderRadius: R.btn,
    paddingHorizontal: 22,
    paddingVertical: 12,
    minWidth: 110,
    alignItems: 'center',
  },
  primaryText: { fontSize: 14, color: c.onAccent, fontWeight: '500' },
  ghostBtn: {
    borderRadius: R.btn,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 0.5,
    borderColor: c.hair,
    backgroundColor: c.card,
  },
  ghostText: { fontSize: 14, color: c.text2 },
  btnDisabled: { opacity: 0.5 },
});
