/**
 * 写文档（v0.28）。
 *
 * 新建和编辑是**同一个界面**：两件事的差别只有「有没有 id」，
 * 分成两个组件就会有两套输入框、两套键盘避让、两套标签栏 —— 迟早只改了一边。
 *
 * 保存后**直接入库**（用户 2026-11-18 定的「自动入库」）。没有「草稿区」：
 * 草稿是新建文档默认挂的标签，不是另一块存放处。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { DocTag } from '../types';
import { R, SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { WEB_INPUT_RESET } from '../util/platformStyle';
import { BusyIndicator as ActivityIndicator } from '../components/BusyIndicator';
import { ScreenHeader } from '../components/ScreenHeader';
import { repo } from '../db/repo';
import { AUTHORED_TITLE_MAX, createAuthoredDoc, saveDocBody, renameDoc } from '../documents/authored';
import { DEFAULT_DOC_TAG, normalizeTagName } from '../util/docTags';

interface Props {
  /** null = 新建；有值 = 编辑这一篇 */
  docId: number | null;
  /** 新建时的初始标题（比如从搜索框带过来的词） */
  initialTitle?: string;
  onClose: () => void;
  onSaved: (info: { docId: number; created: boolean }) => void;
}

const isWeb = Platform.OS === 'web';

export function DocEditor({ docId, initialTitle, onClose, onSaved }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [title, setTitle] = useState(initialTitle ?? '');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState<DocTag[]>([]);
  const [allTags, setAllTags] = useState<DocTag[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [loading, setLoading] = useState(docId !== null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  /** 写了没保存就想退出：先在页脚问一句，不弹系统框 */
  const [askDiscard, setAskDiscard] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, doc] = await Promise.all([
        repo.listDocTags(),
        docId === null ? Promise.resolve(null) : repo.findDocument(docId),
      ]);
      if (!alive.current) return;
      setAllTags(list);
      if (doc) {
        setTitle(doc.name);
        setBody(doc.bodyMd);
        setTags(doc.tags);
      }
      setError(docId !== null && !doc ? '这篇文档已经不在了' : '');
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : '读取文档失败');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [docId]);

  useEffect(() => { void load(); }, [load]);

  /**
   * 关之前问一句。
   *
   * 写了半屏东西，一个返回手势就全没 —— 这是编辑器里最让人火的一种丢失。
   * 第一次返回只把「放弃 / 继续写」摆出来，第二次真的按了放弃才关。
   */
  const attemptClose = useCallback(() => {
    if (saving) return;
    if (!dirty) { onClose(); return; }
    setAskDiscard(true);
  }, [dirty, onClose, saving]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { attemptClose(); return true; });
    return () => sub.remove();
  }, [attemptClose]);

  function touch() {
    if (!dirty) setDirty(true);
  }

  function toggleTag(tag: DocTag) {
    touch();
    setTags((prev) => (prev.some((t) => t.id === tag.id) ? prev.filter((t) => t.id !== tag.id) : [...prev, tag]));
  }

  async function addTagByName() {
    const name = normalizeTagName(tagInput);
    if (!name) return;
    try {
      const tag = await repo.createDocTag(name, 'approved');
      if (!alive.current) return;
      setTagInput('');
      setAllTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]));
      setTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]));
      touch();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : '建标签失败');
    }
  }

  async function save() {
    if (saving) return;
    if (!body.trim()) { setError('正文还是空的，写点什么再保存'); return; }
    setSaving(true);
    setError('');
    try {
      let id = docId;
      if (id === null) {
        id = await createAuthoredDoc({
          title,
          bodyMd: body,
          tagNames: tags.map((t) => t.name).filter((n) => n !== DEFAULT_DOC_TAG),
        });
      } else {
        // 先标题后正文：正文写入会推进版本号，标题改的是另一列，互不影响
        await renameDoc(id, title);
        await saveDocBody(id, body);
        await repo.setDocumentTags(id, tags.map((t) => t.id));
      }
      if (!alive.current) return;
      setDirty(false);
      onSaved({ docId: id, created: docId === null });
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  const chars = body.trim().length;

  return (
    <View style={styles.root} accessibilityViewIsModal>
      <ScreenHeader
        title={docId === null ? '新建文档' : '编辑文档'}
        subtitle={loading ? undefined : docId === null ? '保存后直接在文档库里' : '改的是这一篇本身'}
        backIcon="close"
        backLabel="关闭编辑器"
        onBack={attemptClose}
        right={
          docId === null ? (
            <Pressable
              style={({ pressed }) => [styles.saveBtn, pressed && { opacity: 0.85 }, saving && styles.saveBtnBusy]}
              onPress={() => void save()}
              disabled={saving}
              accessibilityRole="button"
              accessibilityState={{ disabled: saving, busy: saving }}
              accessibilityLabel={saving ? '正在保存' : '保存文档'}
            >
              {saving ? <ActivityIndicator size="small" color={c.onAccent} /> : <Text style={styles.saveText}>保存</Text>}
            </Pressable>
          ) : undefined
        }
      />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.text3} />
          <Text style={styles.hint}>正在读取…</Text>
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            style={styles.fill}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
          >
            <TextInput
              value={title}
              onChangeText={(text) => { setTitle(text); touch(); }}
              placeholder="标题"
              placeholderTextColor={c.text3}
              style={styles.titleInput}
              maxLength={AUTHORED_TITLE_MAX}
              accessibilityLabel="文档标题"
              selectionColor={c.selection}
            />

            <TextInput
              value={body}
              onChangeText={(text) => { setBody(text); touch(); }}
              placeholder="正文。可以用 # 标题、- 列表、> 引用，和平时记东西一样。"
              placeholderTextColor={c.text3}
              style={styles.bodyInput}
              multiline
              textAlignVertical="top"
              accessibilityLabel="文档正文"
              selectionColor={c.selection}
            />

            <Text style={styles.count}>{chars.toLocaleString()} 字</Text>

            <Text style={styles.label}>标签</Text>
            <View style={styles.tagWrap}>
              {tags.map((tag) => (
                <Pressable
                  key={tag.id}
                  style={({ pressed }) => [styles.tag, pressed && styles.tagPressed]}
                  onPress={() => toggleTag(tag)}
                  accessibilityRole="button"
                  accessibilityLabel={`取消标签 ${tag.name}`}
                >
                  <Text style={styles.tagText}>{tag.name}</Text>
                  <Ionicons name="close" size={12} color={c.text2} />
                </Pressable>
              ))}
              {/* 还没挂上的标签也列出来：这里是「选」，不是「搜」 */}
              {allTags
                .filter((tag) => !tags.some((t) => t.id === tag.id))
                .slice(0, 12)
                .map((tag) => (
                  <Pressable
                    key={tag.id}
                    style={({ pressed }) => [styles.tag, styles.tagOff, pressed && styles.tagPressed]}
                    onPress={() => toggleTag(tag)}
                    accessibilityRole="button"
                    accessibilityLabel={`加上标签 ${tag.name}`}
                  >
                    <Ionicons name="add" size={12} color={c.text3} />
                    <Text style={[styles.tagText, styles.tagTextOff]}>{tag.name}</Text>
                  </Pressable>
                ))}
            </View>

            <View style={styles.tagInputRow}>
              <TextInput
                value={tagInput}
                onChangeText={setTagInput}
                placeholder="新标签名"
                placeholderTextColor={c.text3}
                style={styles.tagInput}
                accessibilityLabel="新标签名"
                selectionColor={c.selection}
                returnKeyType="done"
                onSubmitEditing={() => void addTagByName()}
                maxLength={12}
              />
              <Pressable
                style={({ pressed }) => [styles.tagAddBtn, pressed && { opacity: 0.8 }]}
                onPress={() => void addTagByName()}
                accessibilityRole="button"
                accessibilityLabel="新建这个标签"
              >
                <Text style={styles.tagAddText}>新建</Text>
              </Pressable>
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}
            {isWeb ? <Text style={styles.hint}>网页版只能看，不能写文档。</Text> : null}
          </ScrollView>

          {askDiscard ? (
            <View style={styles.discardBar}>
              <Text style={styles.discardText}>改动还没保存，关掉就没了。</Text>
              <Pressable
                style={({ pressed }) => [styles.discardBtn, pressed && { opacity: 0.7 }]}
                onPress={() => setAskDiscard(false)}
                accessibilityRole="button"
                accessibilityLabel="继续写"
              >
                <Text style={styles.discardKeep}>继续写</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.discardBtn, styles.discardDanger, pressed && { opacity: 0.7 }]}
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="放弃改动并关闭"
              >
                <Text style={styles.discardDrop}>放弃</Text>
              </Pressable>
            </View>
          ) : null}

          {docId !== null ? (
            <View style={styles.footer}>
              <Pressable
                style={({ pressed }) => [styles.primary, pressed && { opacity: 0.85 }, saving && styles.saveBtnBusy]}
                onPress={() => void save()}
                disabled={saving}
                accessibilityRole="button"
                accessibilityState={{ disabled: saving, busy: saving }}
                accessibilityLabel={saving ? '正在保存' : '保存改动'}
              >
                {saving ? <ActivityIndicator size="small" color={c.onAccent} /> : <Text style={styles.primaryText}>保存改动</Text>}
              </Pressable>
            </View>
          ) : null}
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.page },
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACE.sm },
  content: { paddingHorizontal: metrics.pagePadding, paddingBottom: SPACE.xl, gap: SPACE.sm },
  titleInput: {
    minHeight: metrics.controlHeight, ...TYPE.heading, color: c.text,
    paddingVertical: SPACE.xs, ...WEB_INPUT_RESET,
  },
  bodyInput: {
    minHeight: 260, ...TYPE.body, color: c.text, lineHeight: 24,
    paddingTop: SPACE.xs, paddingBottom: SPACE.xs, ...WEB_INPUT_RESET,
  },
  count: { ...TYPE.meta, color: c.text2, fontVariant: ['tabular-nums'] },
  label: { ...TYPE.label, color: c.text2, fontWeight: '600' },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  tag: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 32, paddingHorizontal: SPACE.sm,
    borderRadius: R.pill, backgroundColor: c.accentBg,
  },
  tagOff: { backgroundColor: c.hairSoft },
  tagPressed: { opacity: 0.7 },
  tagText: { ...TYPE.label, color: c.accentText },
  tagTextOff: { color: c.text2 },
  tagInputRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  tagInput: {
    flex: 1, minHeight: metrics.controlHeight, paddingHorizontal: SPACE.md, borderRadius: metrics.buttonRadius,
    backgroundColor: c.card, ...TYPE.compact, color: c.text, ...WEB_INPUT_RESET,
  },
  tagAddBtn: {
    minHeight: metrics.controlHeight, paddingHorizontal: SPACE.md, borderRadius: metrics.buttonRadius,
    backgroundColor: c.hairSoft, alignItems: 'center', justifyContent: 'center',
  },
  tagAddText: { ...TYPE.label, color: c.text },
  error: { ...TYPE.compact, color: c.danger },
  hint: { ...TYPE.meta, color: c.text2 },
  saveBtn: {
    minHeight: 36, paddingHorizontal: SPACE.md, borderRadius: R.pill,
    backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center',
  },
  saveBtnBusy: { opacity: 0.6 },
  saveText: { ...TYPE.label, color: c.onAccent, fontWeight: '600' },
  footer: {
    paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.sm,
    borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair, backgroundColor: c.page,
  },
  discardBar: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs,
    paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.sm, backgroundColor: c.dangerBg,
  },
  discardText: { flex: 1, minWidth: 140, ...TYPE.compact, color: c.danger },
  discardBtn: { minHeight: 36, paddingHorizontal: SPACE.sm, borderRadius: metrics.buttonRadius, justifyContent: 'center' },
  discardKeep: { ...TYPE.label, color: c.text },
  discardDanger: { backgroundColor: c.danger },
  discardDrop: { ...TYPE.label, color: c.onDanger, fontWeight: '600' },
  primary: {
    minHeight: metrics.controlHeight, borderRadius: metrics.buttonRadius, backgroundColor: c.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  primaryText: { ...TYPE.body, color: c.onAccent, fontWeight: '600' },
});
