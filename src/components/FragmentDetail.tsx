/**
 * 碎片详情页：全屏阅读，左右滑动看上一条 / 下一条，右上角原地改。
 *
 * 编辑**不再另开小窗**：点「编辑」时这一页整屏切成输入态，字号和行高与阅读态一致
 * （17 / 30），光标落下的位置就是刚才读到的地方。之前的弹层是 15px 的小框，
 * 长文在框里只露三行，改一段要来回滚 —— 那跟详情页本身的目的（舒服地读长文）是矛盾的。
 *
 * 横向翻页用 FlatList 而不是手写 PanResponder / ScrollView：
 * `windowSize=3` 自带窗口化，几百条也只挂三页；分页吸附、惯性、回弹全是系统原生。
 * 自己维护 contentOffset 的写法在安卓上尤其容易抖。
 *
 * v0.20 起这里也是图片的主场：一条碎片可以带多张图，点图全屏看，
 * 阅读态和编辑态都能就地加图（用户 2026-11-12：「全屏时无法插图」）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  FlatList,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import type { Fragment, FragmentImage, Note } from '../types';
import { SPACE, TYPE, surfaceStroke, useTheme, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { BusyIndicator as ActivityIndicator } from './BusyIndicator';
import { fragmentReaderHits, type FragmentReaderHit } from '../documents/readers/fragmentSearch';
import { ScreenHeader } from './ScreenHeader';
import { NoteBody } from './NoteBody';
import { IconButton } from './IconButton';
import { daySubLabel, formatTime, monthKey, periodLabel } from '../util/date';
import { findHits } from '../util/highlight';
import { useKeyboardHeight } from '../util/keyboard';
import { imageStateOf, imageTextsOf } from '../util/fragmentText';
import { imageToken, looseImages, removeImageToken } from '../util/inlineImages';
import { fragmentImageUri } from '../db/fragmentImages';

/**
 * ScrollView 的实例类型。RN 0.88 里 `typeof ScrollView` 是组件本身，
 * 不能当实例用（`scrollTo` 不在上面）—— 取 ref 的类型才拿到实例。
 */
type ScrollViewInstance = React.ComponentRef<typeof ScrollView>;

interface Props {
  /** 进入时的上下文序列。时间轴进入就是时间轴顺序，搜索进入就是搜索结果顺序 */
  items: Fragment[];
  initialIndex: number;
  doneIds: Set<number>;
  /** 全部周期总结，详情页自己挑出落在这一天的那些 */
  notes: Note[];
  /**
   * 从搜索进来时带上的查询词。
   *
   * 给了就做两件事：正文里描出命中，顶部多一组「第 i / N 处」上下跳。
   * 不给时整页与以前完全一致（不多挂 onLayout，也不多一行工具栏）。
   */
  highlightQuery?: string;
  onClose: () => void;
  /** 保存正文。父组件负责写库并刷新，这里拿 Promise 是为了显示保存中状态 */
  onSave: (id: number, text: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /** 正在读字的**配图 id**（一条可能好几张，各读各的） */
  imageBusy: Set<number>;
  /** 读图失败的原因（配图 id → 一句话） */
  imageFail: Record<string, string>;
  onReparseImage: (fragment: Fragment, imageId: number) => void;
  /** 给这条补图。返回落库后的配图（id 用来在正文里插定位标记） */
  onAddImages: (
    fragmentId: number,
    uris: string[],
  ) => Promise<{ id: number; path: string }[]>;
  /** 删掉一张图（同时删文件） */
  onRemoveImage: (imageId: number) => Promise<void>;
}

export function FragmentDetail({
  items,
  initialIndex,
  doneIds,
  notes,
  highlightQuery,
  onClose,
  onSave,
  onDelete,
  imageBusy,
  imageFail,
  onReparseImage,
  onAddImages,
  onRemoveImage,
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const { reduceMotion } = useTheme();
  const window = useWindowDimensions();
  /**
   * 用实测容器宽度，不用 useWindowDimensions：桌面预览把 App 关在 420px 的壳里，
   * 窗口宽度和这一页的宽度不是一回事，用后者会让每页都宽出一大截、翻页还错位。
   */
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(initialIndex);
  const listRef = useRef<FlatList<Fragment>>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);
  const keyboardHeight = useKeyboardHeight();
  /** 全屏看图：图在这条碎片里的下标。null = 没开 */
  const [viewer, setViewer] = useState<number | null>(null);
  /** 加图菜单（拍照 / 相册）。和阅读、编辑共用一套 —— 两个状态各写一份迟早对不上 */
  const [imageMenu, setImageMenu] = useState(false);
  const [addingImage, setAddingImage] = useState(false);
  const [toast, setToast] = useState('');
  /** 待二次确认删除的那张图。图删掉就找不回来了，不能一步到位 */
  const [armedImage, setArmedImage] = useState<number | null>(null);
  /** 编辑态光标位置。插图要插在光标处，而不是一律追加到末尾 */
  const [sel, setSel] = useState({ start: 0, end: 0 });

  const fragment = items[current] ?? items[initialIndex];

  const startEdit = useCallback(() => {
    if (!fragment) return;
    setDraft(fragment.content);
    // 光标默认在末尾：改一段长文时人通常是接着往下写的
    setSel({ start: fragment.content.length, end: fragment.content.length });
    setArmedDelete(false);
    setArmedImage(null);
    setEditing(true);
  }, [fragment]);

  const stopEdit = useCallback(() => {
    if (saving || addingImage) { setToast('正在保存或加入图片，请稍候'); return; }
    setEditing(false);
    setArmedDelete(false);
    setArmedImage(null);
    setImageMenu(false);
  }, [saving, addingImage]);

  // 覆盖层不是 Modal，安卓返回键得自己接。层级从高到低：
  // 全屏看图 → 加图菜单 → 编辑态 → 关页面
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (viewer !== null) {
        setViewer(null);
        return true;
      }
      if (imageMenu) {
        setImageMenu(false);
        return true;
      }
      if (armedImage !== null) {
        setArmedImage(null);
        return true;
      }
      if (armedDelete) {
        setArmedDelete(false);
        return true;
      }
      if (editing) {
        stopEdit();
        return true;
      }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [editing, imageMenu, stopEdit, onClose, viewer, armedImage, armedDelete]);

  /** 底部的左右箭头：滑动手势之外再给一个确定性的入口，也给「这里能滑」一个提示 */
  const jump = useCallback(
    (delta: number) => {
      const next = current + delta;
      if (next < 0 || next >= items.length) return;
      setCurrent(next);
      listRef.current?.scrollToIndex({ index: next, animated: !reduceMotion });
    },
    [current, items.length, reduceMotion],
  );

  /* ---------------- 搜索命中：高亮 + 逐处跳转 ---------------- */

  /** 当前停在第几处。换页归零，否则上一页的 3/5 会带到下一屏 */
  const [hitIndex, setHitIndex] = useState(0);
  /**
   * 每页各自的「文字块下标 → 实测 y」，按碎片 id 分开存。
   *
   * 不共用一份：横向 FlatList 会同时挂着相邻几页，共用的话后挂载的那页
   * 会把当前页的 y 覆盖掉，跳转就跳到别人的高度上。
   */
  const blockY = useRef(new Map<number, Map<string, number>>());
  /** 每页的 ScrollView，跳转时按碎片 id 取当前这一页的 */
  const pageRefs = useRef(new Map<number, ScrollViewInstance>());

  /**
   * 第 i 处落在哪个块。数组长度就是命中总数。
   *
   * 口径必须和 NoteBody 对得上：同一个 parseBlocks、同一批 seg、同一个 countHits。
   * 不按字符比例估位置 —— 中文一行约 18 字、英文能塞 40 个，估出来的 y 常常差半屏。
   */
  const hitBlocks = useMemo(
    () => fragment ? fragmentReaderHits(fragment, highlightQuery ?? '') : [],
    [fragment?.content, fragment?.images, fragment?.project, highlightQuery],
  );

  const hitTotal = hitBlocks.length;
  /** 换页那一帧 hitIndex 可能还落在旧的范围内，读的时候夹一下，不会显示「第 4 / 2 处」 */
  const shownHit = hitTotal > 0 ? Math.min(hitIndex, hitTotal - 1) : 0;

  useEffect(() => {
    setHitIndex(0);
  }, [current, highlightQuery]);

  const registerScroll = useCallback((id: number, view: ScrollViewInstance | null) => {
    if (view) pageRefs.current.set(id, view);
    else pageRefs.current.delete(id);
  }, []);

  const registerBlock = useCallback((id: number, blockIndex: string, y: number) => {
    let m = blockY.current.get(id);
    if (!m) {
      m = new Map();
      blockY.current.set(id, m);
    }
    m.set(blockIndex, y);
  }, []);

  const goHit = useCallback(
    (delta: number) => {
      const last = hitTotal - 1;
      if (last < 0 || !fragment) return;
      const next = Math.min(Math.max(shownHit + delta, 0), last);
      setHitIndex(next);
      const y = blockY.current.get(fragment.id)?.get(hitBlocks[next].blockKey);
      // 还没量到这一块（刚换页的那一帧）就不滚：高亮本身已经在屏幕上，
      // 按 undefined 硬滚一下反而会跳回顶部
      if (y !== undefined) {
        pageRefs.current.get(fragment.id)?.scrollTo({ y: Math.max(0, y - 16), animated: !reduceMotion });
      }
    },
    [fragment, hitBlocks, hitTotal, shownHit, reduceMotion],
  );

  async function save() {
    if (!fragment || saving) return;
    const text = draft.trim();
    // 清空等于删掉内容，不给它这个机会 —— 要删请走显式的删除
    if (!text || text === fragment.content) {
      stopEdit();
      return;
    }
    setSaving(true);
    try {
      await onSave(fragment.id, text);
      stopEdit();
    } catch (e) {
      setToast(e instanceof Error ? `保存失败：${e.message}` : '保存失败，正文仍在编辑器里');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!fragment) return;
    if (!armedDelete) {
      setArmedDelete(true);
      return;
    }
    await onDelete(fragment.id);
    // 删掉的那条已经不在序列里了，留在详情页只会滑到别人的内容上
    onClose();
  }

  /**
   * 选图并加进来。相册可多选 —— 「一条只能放一张」正是用户这次要改掉的限制。
   * 只对相机请求权限：相册走系统 Photo Picker，Android 13+ 不需要 READ_MEDIA_IMAGES，
   * 主动去 request 反而会因为清单里没有这个权限而被拒。
   */
  async function pickImages(from: 'camera' | 'library') {
    setImageMenu(false);
    if (!fragment) return;
    if (Platform.OS === 'web') {
      setToast('网页版加不了图片，在手机上用可以');
      return;
    }
    try {
      if (from === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          setToast('没给相机权限，去系统设置里打开');
          return;
        }
      }
      const res =
        from === 'camera'
          ? await ImagePicker.launchCameraAsync({ quality: 0.5 })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              quality: 0.5,
              allowsMultipleSelection: true,
              selectionLimit: 9,
            });
      if (res.canceled || !res.assets?.length) return;
      setAddingImage(true);
      try {
        const added = await onAddImages(
          fragment.id,
          res.assets.map((a) => a.uri),
        );
        /*
         * 编辑态加图 = 在光标处留一行定位标记，图就长在这一段文字中间；
         * 阅读态加图没有光标可依，图落到正文上方的「未定位」区。
         */
        if (editing && added.length) insertTokens(added.map((a) => a.id));
        setToast(
          editing
            ? `加了 ${res.assets.length} 张图，插在光标处`
            : // 不读字了，别再说「正在读」—— 那句话会一直停在那里不被兑现
              `加了 ${res.assets.length} 张图，整理或提问时会读图里的字`,
        );
      } finally {
        setAddingImage(false);
      }
    } catch (e) {
      setToast(e instanceof Error ? `没加上：${e.message}` : '加图失败');
    }
  }

  /** 在光标处插一行 `![](img:id)`。多张时按顺序各占一行 */
  function insertTokens(ids: number[]) {
    const at = Math.min(sel.start, draft.length);
    const before = draft.slice(0, at);
    const after = draft.slice(at);
    const block = ids.map((id) => imageToken(id)).join('\n');
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    const tail = after && !after.startsWith('\n') ? '\n' : '';
    const next = `${before}${lead}${block}${tail}${after}`;
    setDraft(next);
    setSel({ start: at + lead.length + block.length, end: at + lead.length + block.length });
  }

  async function removeImage(image: FragmentImage) {
    if (armedImage !== image.id) {
      setArmedImage(image.id);
      return;
    }
    setArmedImage(null);
    await onRemoveImage(image.id);
    // 正文里指向它的那一行也要去掉，否则会留一条看不见的标记
    if (editing) setDraft((prev) => removeImageToken(prev, image.id));
    // 删掉的那张不在序列里了，全屏看图的下标要跟着收
    setViewer(null);
  }

  // 轻提示自己消失：这里没有 Toast 组件可复用，一行字挂 2 秒就够
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  if (!fragment) return null;

  const images = fragment.images;

  const imageMenuLayer = imageMenu ? (
    <View style={styles.imageSheet}>
      <Pressable style={styles.imageSheetRow} onPress={() => void pickImages('camera')}>
        <Ionicons name="camera-outline" size={18} color={c.text2} />
        <Text style={styles.imageSheetText}>拍一张</Text>
      </Pressable>
      <Pressable style={styles.imageSheetRow} onPress={() => void pickImages('library')}>
        <Ionicons name="images-outline" size={18} color={c.text2} />
        <Text style={styles.imageSheetText}>从相册选（可多选）</Text>
      </Pressable>
      <Pressable style={styles.imageSheetCancel} onPress={() => setImageMenu(false)}>
        <Text style={styles.imageSheetText}>取消</Text>
      </Pressable>
    </View>
  ) : null;

  if (editing) {
    const canSave = draft.trim().length > 0 && !saving && !addingImage;
    return (
      <View style={[styles.root, { paddingBottom: keyboardHeight }]} accessibilityViewIsModal>
        <ScreenHeader
          title="编辑碎片" subtitle={`${draft.length} 字`} backIcon="close" backLabel="取消编辑" onBack={stopEdit}
          right={
            <Pressable
              onPress={save} disabled={!canSave} accessibilityRole="button" accessibilityLabel="保存碎片"
              accessibilityState={{ disabled: !canSave, busy: saving }}
              style={({ pressed }) => [styles.editBtn, styles.saveBtn, !canSave && styles.saveBtnOff, pressed && canSave && { opacity: 0.7 }]}
            >
              {saving ? <ActivityIndicator size="small" color={c.onAccent} /> : <Text style={[styles.saveText, !canSave && styles.saveTextOff]}>保存</Text>}
            </Pressable>
          }
        />

        {/*
          编辑态的配图条：删图必须在这里做，而且要点两次 ——
          图删掉文件就没了，误触一次就少一张。
        */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.editImages}
          contentContainerStyle={styles.editImagesContent}
          keyboardShouldPersistTaps="handled"
        >
          {images.map((img, i) => (
            <View key={img.id} style={styles.editImageItem}>
              <Image
                source={{ uri: fragmentImageUri(img.path) ?? undefined }}
                style={styles.editImageThumb}
                resizeMode="contain" fadeDuration={0}
              />
              <Pressable
                onPress={() => void removeImage(img)}
                disabled={saving || addingImage}
                accessibilityRole="button"
                accessibilityState={{ disabled: saving || addingImage }}
                style={[styles.editImageRemove, armedImage === img.id && styles.editImageRemoveArmed]}
                accessibilityLabel={
                  armedImage === img.id ? `再点一次删除第 ${i + 1} 张图` : `删除第 ${i + 1} 张图`
                }
              >
                <Text style={[styles.editImageRemoveText, armedImage === img.id && styles.editImageRemoveArmedText]}>
                  {armedImage === img.id ? '确认删除' : '删除图片'}
                </Text>
              </Pressable>
            </View>
          ))}
          <Pressable
            onPress={() => setImageMenu((v) => !v)}
            style={styles.editImageAdd}
            disabled={saving || addingImage}
            accessibilityRole="button"
            accessibilityState={{ disabled: saving || addingImage, busy: addingImage }}
            accessibilityLabel="加一张图"
          >
            {addingImage ? (
              <ActivityIndicator size="small" color={c.text3} />
            ) : (
              <>
                <Ionicons name="add" size={20} color={c.text2} />
                <Text style={styles.editImageAddText}>加图</Text>
              </>
            )}
          </Pressable>
        </ScrollView>

        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
          style={styles.editInput}
          multiline
          autoFocus
          maxLength={20000}
          textAlignVertical="top"
          placeholder="写点什么…"
          placeholderTextColor={c.text3}
          accessibilityLabel="编辑碎片正文"
          selectionColor={c.selection}
          editable={!saving && !addingImage}
        />

        <View style={styles.editFoot}>
          <Pressable onPress={remove} style={styles.deleteButton} accessibilityRole="button" disabled={saving || addingImage}>
            <Text style={styles.deleteText}>
              {armedDelete ? '再点一次确认删除' : '删除这条碎片'}
            </Text>
          </Pressable>
          <Text style={styles.editHint}>
            {armedImage ? '点「确认删除」才会真删' : '「加图」插在光标处'}
          </Text>
        </View>

        {imageMenuLayer}
        {toast ? <View style={styles.toast}><Text style={styles.toastText}>{toast}</Text></View> : null}
      </View>
    );
  }

  const atEnd = current >= items.length - 1;
  /**
   * 全屏看图的页宽。用实测宽度而不是窗口宽度：桌面预览把 App 关在 420px 的壳里，
   * 用窗口宽度算偏移，翻第二张就会错位。
   */
  const pageWidth = width > 0 ? width : window.width;

  return (
    <View
      style={styles.root}
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        if (w > 0 && w !== width) setWidth(w);
      }}
    >
      <View style={styles.main} importantForAccessibility={viewer !== null ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={viewer !== null}>
      <ScreenHeader
        title={daySubLabel(fragment.createdAt)}
        subtitle={`${formatTime(fragment.createdAt)}${items.length > 1 ? ` · ${current + 1} / ${items.length}` : ''}`}
        backIcon="close" backLabel="关闭碎片" onBack={onClose}
        right={<IconButton name="create-outline" label="编辑" tone="soft" onPress={startEdit} accessibilityLabel="编辑这条碎片" />}
      />

      {/*
        「第 i / N 处」只在有命中时出现。单独占一行而不是塞进标题栏：
        一行里已经有关闭、日期、编辑三样，再挤两个箭头，日期会被压成「10月2…」。
        禁用态降透明度而不是隐藏 —— 按钮位置来回变比灰一点更难受。
      */}
      {hitTotal > 0 ? (
        <View style={styles.hitBar}>
          <Pressable style={styles.hitCurrentButton} onPress={() => goHit(0)} accessibilityRole="button" accessibilityLabel="定位当前命中">
            <Text style={styles.hitQuery} numberOfLines={2}>查找「{highlightQuery}」</Text>
            <Text style={styles.hitBarText}>第 {shownHit + 1} / {hitTotal > 99 ? '99+' : hitTotal} 处</Text>
            <Text style={styles.hitLocation}>点按定位 · {hitBlocks[shownHit]?.section.startsWith('image:') ? '图中文字' : hitBlocks[shownHit]?.section === 'project' ? '事项' : '正文'}</Text>
          </Pressable>
          <View style={styles.hitBarBtns}>
            <IconButton
              name="chevron-up"
              size={16}
              tone="soft"
              color={c.text2}
              diameter={34}
              disabled={shownHit <= 0}
              onPress={() => goHit(-1)}
              accessibilityLabel="上一处命中"
            />
            <IconButton
              name="chevron-down"
              size={16}
              tone="soft"
              color={c.text2}
              diameter={34}
              disabled={shownHit >= hitTotal - 1}
              onPress={() => goHit(1)}
              accessibilityLabel="下一处命中"
            />
          </View>
        </View>
      ) : null}

      {/*
        必须等实测宽度到手再挂 FlatList：initialScrollIndex 和 getItemLayout 都按
        每页宽度算偏移，宽度还是 0 的时候挂上去会停在第一页，跳到第 5 条就失效了。
      */}
      {width > 0 ? (
        <FlatList
          ref={listRef}
          data={items}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={(f) => String(f.id)}
          initialScrollIndex={current}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          windowSize={3}
          initialNumToRender={1}
          maxToRenderPerBatch={1}
          onMomentumScrollEnd={(e) => {
            const i = Math.round(e.nativeEvent.contentOffset.x / width);
            if (i >= 0 && i < items.length) setCurrent(i);
          }}
          renderItem={({ item }) => (
            <Page
              fragment={item}
              width={width}
              done={doneIds.has(item.id)}
              notes={notes}
              imageBusy={imageBusy}
              imageFail={imageFail}
              onReparseImage={onReparseImage}
              onOpenImage={(i) => setViewer(i)}
              onAddImage={() => setImageMenu((v) => !v)}
              addingImage={addingImage}
              highlight={highlightQuery}
              activeHit={item.id === fragment.id ? hitBlocks[shownHit] : undefined}
              registerScroll={registerScroll}
              registerBlock={registerBlock}
            />
          )}
        />
      ) : null}

      {items.length > 1 ? (
        <View style={styles.footer}>
          <IconButton name="chevron-back" onPress={() => jump(-1)} disabled={current === 0} accessibilityLabel="上一条碎片" />
          {/* 「左右滑动，或点箭头翻篇」已删：两个箭头和「3 / 12」已经把这件事说完了 */}
          <Text style={styles.pageCount}>{current + 1} / {items.length}</Text>
          <IconButton name="chevron-forward" onPress={() => jump(1)} disabled={atEnd} accessibilityLabel="下一条碎片" />
        </View>
      ) : null}

      {imageMenuLayer}
      {toast ? (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}

      </View>

      {/*
        全屏看图。黑底、整屏、点一下关掉 —— 看截图时不该有一圈白边和标题栏。
        用 FlatList 横向翻页而不是一张一张点：一屏之内就能左右比较两张截图。
      */}
      {viewer !== null && images[viewer] ? (
        <View style={styles.viewer} accessibilityViewIsModal>
          <FlatList
            style={styles.viewerList}
            data={images}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(img) => String(img.id)}
            initialScrollIndex={Math.min(viewer, images.length - 1)}
            getItemLayout={(_, i) => ({ length: pageWidth, offset: pageWidth * i, index: i })}
            onMomentumScrollEnd={(e) => {
              const i = Math.round(e.nativeEvent.contentOffset.x / pageWidth);
              if (i >= 0 && i < images.length) setViewer(i);
            }}
            renderItem={({ item }) => (
              <Pressable style={[styles.viewerPage, { width: pageWidth }]} onPress={() => setViewer(null)}>
                <Image
                  source={{ uri: fragmentImageUri(item.path) ?? undefined }}
                  style={styles.viewerImage}
                  resizeMode="contain" fadeDuration={0}
                />
              </Pressable>
            )}
          />
          <View style={styles.viewerBar} pointerEvents="box-none">
            <Text style={styles.viewerCount}>
              {Math.min(viewer, images.length - 1) + 1} / {images.length}
            </Text>
            <Pressable onPress={() => setViewer(null)} style={styles.viewerClose} accessibilityRole="button" accessibilityLabel="关闭图片">
              <Ionicons name="close" size={20} color={c.mediaForeground} />
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

type ReaderSectionProps = React.ComponentProps<typeof NoteBody> & {
  sectionKey: string;
  fragmentId: number;
  registerBlock: (id: number, block: string, y: number) => void;
  label?: string;
  containerStyle?: React.ComponentProps<typeof View>['style'];
};

/** 每块的y必须加上整个正文区在页面里的实测位置，不能把图高或标题高漏掉。 */
function ReaderTextSection({ sectionKey, fragmentId, registerBlock, label, containerStyle, ...body }: ReaderSectionProps) {
  const { styles } = useThemedStyles(makeStyles);
  const layout = useRef({ top: 0, content: 0, blocks: new Map<number, number>() });
  const publish = () => {
    const p = layout.current;
    for (const [block, y] of p.blocks) registerBlock(fragmentId, `${sectionKey}:${block}`, p.top + p.content + y);
  };
  return (
    <View style={containerStyle} onLayout={(e) => { layout.current.top = e.nativeEvent.layout.y; publish(); }}>
      {label ? <Text style={styles.imageTextLabel}>{label}</Text> : null}
      <View onLayout={(e) => { layout.current.content = e.nativeEvent.layout.y; publish(); }}>
        <NoteBody
          {...body}
          onBlockLayout={body.highlight ? (index, y) => {
            const p = layout.current;
            p.blocks.set(index, y);
            registerBlock(fragmentId, `${sectionKey}:${index}`, p.top + p.content + y);
          } : undefined}
        />
      </View>
    </View>
  );
}

function LiteralHits({ text, query, activeHit }: { text: string; query?: string; activeHit?: number }) {
  const { styles } = useThemedStyles(makeStyles);
  const hits = query ? findHits(text, query) : [];
  const out: React.ReactNode[] = [];
  let last = 0;
  hits.forEach((hit, i) => {
    if (hit.start > last) out.push(text.slice(last, hit.start));
    out.push(<Text key={i} style={[styles.plainHit, i === activeHit && styles.plainCurrentHit]}>{text.slice(hit.start, hit.end)}</Text>);
    last = hit.end;
  });
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/**
 * 这条碎片所属月份的月总结。
 *
 * v0.15 之前是三级降级：当天的日小结 → 当周周总结 → 当月月总结。
 * 日/周两种粒度下线之后只剩「当月」一种，三级降级就退化成一条 —
 * 留着分支只会让人以为那两种还在（而且它们的数据已经被迁移删掉了）。
 */
function notesOn(day: number, notes: Note[]): Note[] {
  const key = monthKey(day);
  return notes.filter((n) => n.type === 'monthly' && n.period === key);
}

function Page({
  fragment,
  width,
  done,
  notes,
  highlight,
  activeHit,
  imageBusy,
  imageFail,
  onReparseImage,
  onOpenImage,
  onAddImage,
  addingImage,
  registerScroll,
  registerBlock,
}: {
  fragment: Fragment;
  width: number;
  done: boolean;
  notes: Note[];
  highlight?: string;
  activeHit?: FragmentReaderHit;
  imageBusy: Set<number>;
  imageFail: Record<string, string>;
  onReparseImage: (fragment: Fragment, imageId: number) => void;
  onOpenImage: (index: number) => void;
  onAddImage: () => void;
  addingImage: boolean;
  registerScroll: (id: number, view: ScrollViewInstance | null) => void;
  registerBlock: (id: number, blockIndex: string, y: number) => void;
}) {
  const { c, styles, metrics } = useThemedStyles(makeStyles);
  /**
   * 每张图的原始宽高比，按配图 id 记。
   *
   * 不写死成 4:3：手机拍的报错屏常常是 9:19，写死会把主要内容裁掉；
   * 拿不到尺寸时退回 4:3，至少不塌成 0 高。
   */
  const [aspects, setAspects] = useState<Record<number, number>>({});
  const paths = fragment.images.map((i) => i.path).join('|');
  useEffect(() => {
    let alive = true;
    for (const img of fragment.images) {
      const uri = fragmentImageUri(img.path);
      if (!uri) continue;
      Image.getSize(
        uri,
        (w, h) => {
          if (alive && w > 0) setAspects((prev) => (prev[img.id] ? prev : { ...prev, [img.id]: h / w }));
        },
        () => undefined,
      );
    }
    return () => {
      alive = false;
    };
    // 只在图变了的时候重量：images 数组每次渲染都是新引用
  }, [paths]); // eslint-disable-line react-hooks/exhaustive-deps

  const merged = fragment.mergedInto !== null;
  const hasMeta = !!fragment.project || fragment.source !== 'app';
  const dayNotes = notesOn(fragment.createdAt, notes);
  const texts = imageTextsOf(fragment);
  /** 正文里没用 `![](img:N)` 定位过的图 —— 铺在正文上方 */
  const loose = looseImages(fragment);
  // 身份要稳：内联箭头每次渲染都会换新，React 会把 ref 先置 null 再挂回去
  const setScrollRef = useCallback(
    (view: ScrollViewInstance | null) => registerScroll(fragment.id, view),
    [fragment.id, registerScroll],
  );

  return (
    <ScrollView
      ref={setScrollRef}
      style={{ width }}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {done || merged || !!fragment.organizedAt ? (
        <View style={styles.badges}>
          {done ? (
            <View style={styles.doneBadge}>
              <Ionicons name="checkmark" size={11} color={c.tealText} />
              <Text style={styles.doneText}>已完成</Text>
            </View>
          ) : null}
          {!!fragment.organizedAt ? (
            <View style={styles.orgBadge}>
              <Ionicons name="sparkles" size={10} color={c.accentText} />
              <Text style={styles.orgText}>已整理</Text>
            </View>
          ) : null}
          {merged ? <Text style={styles.merged}>已合并到另一条</Text> : null}
        </View>
      ) : null}

      {/*
        配图：**只画正文里没定位的那些**。已经在正文 `![](img:12)` 位置上的图
        跟着文字走（见下面 NoteBody 的 `imageUri`），这里再画一遍就是同一张图出现两次。
        竖着排，按原始比例给高度，一张都不裁；点一下进全屏。
      */}
      {loose.length ? (
        <View style={styles.imageList}>
          {loose.map((img) => {
            const i = fragment.images.findIndex((x) => x.id === img.id);
            const st = imageStateOf(img, imageBusy, imageFail);
            const reason = imageFail[String(img.id)];
            return (
              <View key={img.id} style={styles.imageBox}>
                <Pressable
                  onPress={() => onOpenImage(i)}
                  accessibilityRole="imagebutton"
                  accessibilityLabel={`第 ${i + 1} 张图，点开全屏查看`}
                >
                  <Image
                    source={{ uri: fragmentImageUri(img.path) ?? undefined }}
                    style={[
                      styles.imageBig,
                      {
                        width: Math.max(0, width - metrics.pagePadding * 2),
                        height: Math.max(0, width - metrics.pagePadding * 2) * (aspects[img.id] ?? 0.75),
                      },
                    ]}
                    resizeMode="contain" fadeDuration={0}
                  />
                  {fragment.images.length > 1 ? (
                    <View style={styles.imageIndex}>
                      <Text style={styles.imageIndexText}>{i + 1}</Text>
                    </View>
                  ) : null}
                </Pressable>
                {/* 状态行就在图下面：读者下一眼看到的就是「它读出来没有」 */}
                {st === 'busy' ? (
                  <Text style={styles.imageState}>正在读图里的字…</Text>
                ) : st === 'fail' ? (
                  <Pressable style={styles.imageReadButton} onPress={() => onReparseImage(fragment, img.id)} accessibilityRole="button">
                    <Text style={[styles.imageState, styles.imageStateErr]} numberOfLines={3}>
                      没读出文字：{reason} · 点这里重试
                    </Text>
                  </Pressable>
                ) : st === 'read' ? (
                  <Pressable style={styles.imageReadButton} onPress={() => onReparseImage(fragment, img.id)} accessibilityRole="button">
                    <Text style={styles.imageState}>图里的字 · 点一下重读</Text>
                  </Pressable>
                ) : st === 'empty' ? (
                  <Text style={styles.imageState}>这张图里没读出字</Text>
                ) : (
                  <Pressable style={styles.imageReadButton} onPress={() => onReparseImage(fragment, img.id)} accessibilityRole="button">
                    <Text style={styles.imageState}>
                      还没读过 · 整理或提问时会看，也可以点这里现在读
                    </Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>
      ) : null}

      {texts.length ? fragment.images.map((img, i) => {
        const text = (img.text ?? '').trim();
        if (!text) return null;
        const section = `image:${img.id}`;
        return (
          <ReaderTextSection
            key={img.id} sectionKey={section} fragmentId={fragment.id} registerBlock={registerBlock}
            containerStyle={styles.imageTextBox}
            label={fragment.images.length > 1 ? `图中文字 · 第 ${i + 1} 张` : '图中文字'}
            text={text} style={styles.imageTextBody} variant="reading" selectable literalCitations
            highlight={highlight} activeHit={activeHit?.section === section ? activeHit.localIndex : undefined}
          />
        );
      }) : null}

      <ReaderTextSection
        sectionKey="body" fragmentId={fragment.id} registerBlock={registerBlock}
        text={fragment.content} style={styles.body} variant="reading" selectable muted={merged}
        highlight={highlight} activeHit={activeHit?.section === 'body' ? activeHit.localIndex : undefined}
        imageUri={(id) => {
          const img = fragment.images.find((x) => x.id === id);
          return img ? fragmentImageUri(img.path) : null;
        }}
        onImagePress={(id) => {
          const i = fragment.images.findIndex((x) => x.id === id);
          if (i >= 0) onOpenImage(i);
        }}
      />

      {/* 阅读态仍可补图；工具放在正文之后，不打断正文与图文字。 */}
      <Pressable
        onPress={onAddImage}
        style={({ pressed }) => [styles.addImageBtn, pressed && { opacity: 0.6 }]}
        accessibilityRole="button"
        accessibilityLabel="给这条碎片加图片"
        disabled={addingImage}
        accessibilityState={{ disabled: addingImage, busy: addingImage }}
      >
        {addingImage ? (
          <ActivityIndicator size="small" color={c.text3} />
        ) : (
          <>
            <Ionicons name="image-outline" size={15} color={c.text2} />
            <Text style={styles.addImageText}>
              {fragment.images.length ? '再加一张图' : '加一张图'}
            </Text>
          </>
        )}
      </Pressable>

      {hasMeta ? (
        <View style={styles.meta} onLayout={(e) => { if (highlight && fragment.project) registerBlock(fragment.id, 'project:0', e.nativeEvent.layout.y); }}>
          {fragment.project ? <Text style={styles.project}><LiteralHits text={fragment.project} query={highlight} activeHit={activeHit?.section === 'project' ? activeHit.localIndex : undefined} /></Text> : null}
          {fragment.source !== 'app' ? (
            <View style={styles.source}>
              <Ionicons
                name={fragment.source === 'notif' ? 'notifications-outline' : 'share-outline'}
                size={13}
                color={c.text3}
              />
              <Text style={styles.sourceText}>
                {fragment.source === 'notif' ? '来自通知' : '来自分享'}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <Text style={styles.count}>
        {fragment.content.length} 字
        {fragment.images.length ? ` · ${fragment.images.length} 张图` : ''} ·{' '}
        {new Date(fragment.createdAt).getFullYear()}-{String(new Date(fragment.createdAt).getMonth() + 1).padStart(2, '0')}-
        {String(new Date(fragment.createdAt).getDate()).padStart(2, '0')}
      </Text>

      {/*
        月总结是这个月的结论。看完当天的零碎记录后紧接着看到它，
        不用退回时间轴再翻一遍。它和碎片是两种东西，所以用浅蓝卡片隔开。
      */}
      {dayNotes.map((n) => (
        <View key={n.id} style={styles.noteCard}>
          <View style={styles.noteHead}>
            <Ionicons name="sparkles" size={13} color={c.accent} />
            <Text style={styles.noteKind}>当月总结</Text>
            <Text style={styles.notePeriod}>{periodLabel(n.period)}</Text>
          </View>
          <NoteBody text={n.bodyMd} style={styles.noteBody} selectable />
        </View>
      ))}
    </ScrollView>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.page },
  main: { flex: 1 },
  editBtn: { minWidth: 64, minHeight: metrics.controlHeight, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs, borderRadius: metrics.buttonRadius, alignItems: 'center', justifyContent: 'center', borderWidth: surfaceStroke(metrics), borderColor: c.hair },
  hitBar: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.xs, backgroundColor: c.page, borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair },
  hitCurrentButton: { flex: 1, minWidth: 0, minHeight: metrics.controlHeight, justifyContent: 'center', gap: SPACE.xxs },
  hitQuery: { ...TYPE.meta, color: c.text2 },
  hitBarText: { ...TYPE.body, color: c.text, fontWeight: '600', fontVariant: ['tabular-nums'] },
  hitLocation: { ...TYPE.meta, color: c.text2 },
  hitBarBtns: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs },
  plainHit: { backgroundColor: c.amberBg },
  plainCurrentHit: { textDecorationLine: 'underline', fontWeight: '700' },
  content: { paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.xl, paddingBottom: SPACE.xxl },
  imageList: { gap: SPACE.md, marginBottom: SPACE.lg },
  imageBox: { gap: SPACE.xs },
  imageBig: { borderRadius: metrics.cardRadius, backgroundColor: c.hairSoft, alignSelf: 'center' },
  imageIndex: { position: 'absolute', top: SPACE.xs, left: SPACE.xs, minWidth: 24, minHeight: 24, borderRadius: metrics.buttonRadius, paddingHorizontal: SPACE.xs, alignItems: 'center', justifyContent: 'center', backgroundColor: c.mediaScrim },
  imageIndexText: { ...TYPE.label, color: c.mediaForeground },
  /** 图下方的状态行是辅助信息，用 compact；原来是 body（16/26），两行大字把正文压下去 */
  imageState: { ...TYPE.compact, color: c.text2 },
  imageStateErr: { color: c.danger },
  imageReadButton: { minHeight: metrics.controlHeight, paddingVertical: SPACE.xs, justifyContent: 'center' },
  /** 补图入口：浅灰底就够，不描边 */
  addImageBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, minHeight: metrics.controlHeight, paddingVertical: SPACE.sm, marginTop: SPACE.xl, marginBottom: SPACE.xs, borderRadius: metrics.buttonRadius, backgroundColor: c.hairSoft },
  addImageText: { ...TYPE.label, color: c.text2 },
  imageTextBox: { marginBottom: SPACE.xl, paddingLeft: SPACE.md, borderLeftWidth: surfaceStroke(metrics), borderLeftColor: c.hair },
  imageTextLabel: { ...TYPE.label, color: c.text2, marginBottom: SPACE.sm },
  imageTextBody: { ...TYPE.reading, color: c.text },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs, marginBottom: SPACE.lg },
  /** 两个状态胶囊：底色已经是信号，再套 0.5 的框只是让边缘发毛 */
  doneBadge: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs, backgroundColor: c.tealBg, borderRadius: metrics.buttonRadius, paddingHorizontal: SPACE.xs, paddingVertical: SPACE.xxs },
  doneText: { ...TYPE.label, color: c.tealText },
  orgBadge: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs, backgroundColor: c.hairSoft, borderRadius: metrics.buttonRadius, paddingHorizontal: SPACE.xs, paddingVertical: SPACE.xxs },
  orgText: { ...TYPE.label, color: c.text2 },
  merged: { ...TYPE.meta, color: c.text2 },
  body: { ...TYPE.reading, color: c.text },
  meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACE.xs, marginTop: SPACE.xl, paddingTop: SPACE.md, borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair },
  project: { ...TYPE.body, color: c.text2 },
  source: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs },
  sourceText: { ...TYPE.meta, color: c.text2 },
  count: { ...TYPE.meta, color: c.text2, marginTop: SPACE.md, fontVariant: ['tabular-nums'] },
  noteCard: { marginTop: SPACE.xxl, paddingTop: SPACE.lg, borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair },
  noteHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs, marginBottom: SPACE.md },
  noteKind: { ...TYPE.title, color: c.text },
  notePeriod: { ...TYPE.meta, color: c.text2 },
  noteBody: { ...TYPE.body, color: c.text },
  saveBtn: { backgroundColor: c.accent, borderColor: c.accent },
  saveBtnOff: { backgroundColor: c.hairSoft, borderColor: c.hair },
  saveText: { ...TYPE.body, color: c.onAccent, fontWeight: '600' },
  saveTextOff: { color: c.text3 },
  editImages: { flexGrow: 0, borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair },
  editImagesContent: { gap: SPACE.sm, paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.sm, alignItems: 'center' },
  editImageItem: { width: 96 },
  editImageThumb: { width: 96, height: 72, borderRadius: metrics.buttonRadius, backgroundColor: c.hairSoft },
  /** 删图按钮：浅灰底，点一次变红底要求确认 —— 变色本身就是反馈，不用再套边框 */
  editImageRemove: { minHeight: metrics.controlHeight, width: 96, paddingHorizontal: SPACE.xxs, borderRadius: metrics.buttonRadius, alignItems: 'center', justifyContent: 'center', backgroundColor: c.hairSoft },
  editImageRemoveArmed: { backgroundColor: c.danger },
  editImageRemoveText: { ...TYPE.label, color: c.text2 },
  editImageRemoveArmedText: { color: c.onDanger },
  editImageAdd: { width: 88, minHeight: 120, borderRadius: metrics.buttonRadius, alignItems: 'center', justifyContent: 'center', gap: SPACE.xxs, backgroundColor: c.hairSoft },
  editImageAddText: { ...TYPE.label, color: c.text2 },
  editInput: { flex: 1, ...TYPE.reading, color: c.text, paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.md },
  editFoot: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.xs, paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.xs, borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair },
  deleteButton: { minHeight: metrics.controlHeight, justifyContent: 'center', paddingHorizontal: SPACE.xs },
  deleteText: { ...TYPE.label, color: c.danger },
  editHint: { flexShrink: 1, ...TYPE.meta, color: c.text2 },
  // 菜单留在布局流里，沿用当前键盘与返回行为。
  imageSheet: { marginHorizontal: metrics.pagePadding, marginVertical: SPACE.xs, backgroundColor: c.card, borderRadius: metrics.cardRadius, paddingVertical: SPACE.xxs },
  imageSheetRow: { minHeight: metrics.controlHeight, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm },
  imageSheetCancel: { minHeight: metrics.controlHeight, justifyContent: 'center', paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm },
  imageSheetText: { ...TYPE.body, color: c.text },
  toast: { paddingHorizontal: metrics.pagePadding, paddingBottom: SPACE.xs, alignItems: 'center' },
  toastText: { ...TYPE.compact, color: c.text2, backgroundColor: c.card, borderRadius: metrics.buttonRadius, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm },
  viewer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.mediaBackground },
  viewerPage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewerList: { flex: 1 },
  viewerImage: { width: '100%', height: '100%' },
  viewerBar: { position: 'absolute', top: SPACE.xs, left: SPACE.md, right: SPACE.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  viewerCount: { ...TYPE.label, color: c.mediaForeground, backgroundColor: c.mediaScrim, paddingHorizontal: SPACE.xs, paddingVertical: SPACE.xxs, fontVariant: ['tabular-nums'] },
  viewerClose: { width: metrics.controlHeight, height: metrics.controlHeight, borderRadius: metrics.buttonRadius, alignItems: 'center', justifyContent: 'center', backgroundColor: c.mediaScrim },
  /** 翻页条：箭头加页码，中间不再挂一行操作说明 */
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.xs, paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.xs, borderTopWidth: surfaceStroke(metrics), borderTopColor: c.hair },
  pageCount: { ...TYPE.label, color: c.text, fontVariant: ['tabular-nums'] },
});
