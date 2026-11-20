/**
 * 待办的编辑层：新建顶层、给某条加子项、改文字与到期日，共用一个面板。
 *
 * 三种场景的字段完全一样，拆成三个面板只会让校验和保存各写三遍。
 * 差异只有标题文案，以及保存时走 insert 还是 update —— 用 `todo` 是否为 null 区分。
 *
 * 全屏覆盖层而不是 Modal：安卓上 Modal 会把返回键接管成一套自己的手势，
 * 而且键盘弹起时高度计算是另一套。项目红线见 AGENTS.md。
 */
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Todo } from '../types';
import { repo } from '../db/repo';
import { dayKey } from '../util/date';
import { useKeyboardHeight } from '../util/keyboard';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
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
  const saveLock = useRef(false);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!saveLock.current) onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const title = todo ? '编辑待办' : parentId === null ? '新建待办' : '加一条子项';

  async function save() {
    if (saveLock.current) return;
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

    saveLock.current = true;
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
      saveLock.current = false;
      setBusy(false);
      return;
    }

    // 内容已经写进库。刷新失败不能报成「保存失败」，否则用户会以为没存上又存一次
    try {
      await onSaved();
    } catch {
      /* 交给下次进页面 */
    }
    saveLock.current = false;
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
      <ScreenHeader title={title} backIcon="close" onBack={busy ? undefined : onClose} />

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {parentId !== null && parentText ? (
          <Text style={styles.parentHint}>加到「{parentText}」下面</Text>
        ) : null}

        <Text style={styles.label}>做什么</Text>
        <TextInput
          style={styles.input}
          value={text} accessibilityLabel="待办内容" editable={!busy}
          onChangeText={(v) => {
            setText(v);
            if (error) setError('');
          }}
          placeholder="一句话说清要做什么"
          placeholderTextColor={c.text3} selectionColor={c.selection}
          multiline
          autoFocus
          maxLength={200}
        />

        <Text style={styles.label}>截止日期（可不填）</Text>
        <TextInput
          style={[styles.input, styles.dateInput]}
          value={due} accessibilityLabel="到期日期，可不填" editable={!busy}
          onChangeText={(v) => {
            setDue(v);
            if (error) setError('');
          }}
          placeholder="2026-11-30"
          placeholderTextColor={c.text3} selectionColor={c.selection}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={10}
        />
        {/* placeholder 里已经有 2026-11-30 的形状，这里只说留空的意思 */}
        <Text style={styles.fieldHint}>留空不设到期日。</Text>
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
              style={({ pressed }) => [[styles.quickChip, pressed && { backgroundColor: c.hairSoft }], styles.touchTarget]}
            >
              <Text style={styles.quickText}>{label}</Text>
            </Pressable>
          ))}
        </View>

        {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable style={[styles.ghostBtn, styles.touchTarget]} onPress={onClose} disabled={busy}>
          <Text style={styles.ghostText}>取消</Text>
        </Pressable>
        <Pressable
          style={[[styles.primaryBtn, busy && styles.btnDisabled], styles.touchTarget]}
          onPress={save}
          disabled={busy} accessibilityRole="button" accessibilityState={{ disabled: busy, busy }}
        >
          <Text style={styles.primaryText}>{busy ? '保存中…' : todo ? '保存' : '加进列表'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  touchTarget: { minWidth: metrics.controlHeight, minHeight: metrics.controlHeight },
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.page },
  content: { paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.xs, paddingBottom: SPACE.xl },
  parentHint: { ...TYPE.compact, color: c.text2, padding: SPACE.sm, backgroundColor: c.hairSoft, borderRadius: metrics.buttonRadius, marginBottom: SPACE.xs },
  /** 字段标签是标签，不是标题：原来用 title（18/26 粗体），比输入的字还大 */
  label: { ...TYPE.label, color: c.text3, marginTop: SPACE.md, marginBottom: SPACE.xs },
  /**
   * 输入框：浅灰底、无边框，和首页/问页的书写区同一套。
   * 高度从 120 收到 88 —— 待办正文上限 200 字，120 的框空着大半。
   */
  input: {
    backgroundColor: c.hairSoft, borderRadius: metrics.cardRadius + 8,
    paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm,
    ...TYPE.reading, color: c.text, minHeight: 88, textAlignVertical: 'top',
  },
  dateInput: { ...TYPE.body, minHeight: metrics.controlHeight, textAlignVertical: 'center' },
  fieldHint: { ...TYPE.meta, color: c.text2, marginTop: SPACE.xxs },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs, marginTop: SPACE.xs },
  quickChip: {
    minWidth: metrics.controlHeight, minHeight: metrics.controlHeight, paddingHorizontal: SPACE.md,
    borderRadius: metrics.buttonRadius, backgroundColor: c.hairSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  quickText: { ...TYPE.label, color: c.text2 },
  error: { ...TYPE.compact, color: c.danger, marginTop: SPACE.sm },
  footer: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'stretch', justifyContent: 'flex-end', gap: SPACE.sm,
    paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.sm, paddingBottom: SPACE.md,
    borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair, backgroundColor: c.page,
  },
  primaryBtn: {
    flexGrow: 1.4, flexBasis: 110, minHeight: metrics.controlHeight, minWidth: 110, backgroundColor: c.accent,
    borderRadius: metrics.buttonRadius, paddingHorizontal: SPACE.xl, alignItems: 'center', justifyContent: 'center',
  },
  primaryText: { ...TYPE.body, color: c.onAccent, fontWeight: '600', textAlign: 'center' },
  ghostBtn: {
    flexGrow: 1, flexBasis: 80, minWidth: 80, minHeight: metrics.controlHeight, borderRadius: metrics.buttonRadius,
    paddingHorizontal: SPACE.md, backgroundColor: c.hairSoft, alignItems: 'center', justifyContent: 'center',
  },
  ghostText: { ...TYPE.body, color: c.text2 },
  btnDisabled: { opacity: 0.5 },
});
