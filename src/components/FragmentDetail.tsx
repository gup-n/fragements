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
  ActivityIndicator,
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
import { R, useThemedStyles, type Palette } from '../theme';
import { NoteBody } from './NoteBody';
import { IconButton } from './IconButton';
import { daySubLabel, formatTime, monthKey, periodLabel } from '../util/date';
import { countHits } from '../util/highlight';
import { parseBlocks } from '../util/mdBlocks';
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
    hint: string,
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
    setEditing(false);
    setArmedDelete(false);
    setArmedImage(null);
    setImageMenu(false);
  }, []);

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
      if (editing) {
        stopEdit();
        return true;
      }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [editing, imageMenu, stopEdit, onClose, viewer]);

  /** 底部的左右箭头：滑动手势之外再给一个确定性的入口，也给「这里能滑」一个提示 */
  const jump = useCallback(
    (delta: number) => {
      const next = current + delta;
      if (next < 0 || next >= items.length) return;
      setCurrent(next);
      listRef.current?.scrollToIndex({ index: next, animated: true });
    },
    [current, items.length],
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
  const blockY = useRef(new Map<number, Map<number, number>>());
  /** 每页的 ScrollView，跳转时按碎片 id 取当前这一页的 */
  const pageRefs = useRef(new Map<number, ScrollViewInstance>());

  /**
   * 第 i 处落在哪个块。数组长度就是命中总数。
   *
   * 口径必须和 NoteBody 对得上：同一个 parseBlocks、同一批 seg、同一个 countHits。
   * 不按字符比例估位置 —— 中文一行约 18 字、英文能塞 40 个，估出来的 y 常常差半屏。
   */
  const hitBlocks = useMemo(() => {
    const q = highlightQuery?.trim() ?? '';
    const at: number[] = [];
    if (!q) return at;
    parseBlocks(fragment?.content ?? '').forEach((b, bi) => {
      // 分隔线没有文字；表格和代码块有，而且 NoteBody 现在也给它们量位置，
      // 漏掉的话「共 5 处」只能跳到 3 处，编号和正文对不上
      let n = 0;
      if (b.kind === 'table') {
        for (const seg of b.head.flat()) n += countHits(seg.text, q);
        for (const row of b.rows) for (const seg of row.flat()) n += countHits(seg.text, q);
      } else if (b.kind === 'code') {
        n = countHits(b.text, q);
      } else if (b.kind !== 'hr' && b.kind !== 'image') {
        for (const seg of b.segs) n += countHits(seg.text, q);
      }
      for (let k = 0; k < n; k++) at.push(bi);
    });
    return at;
  }, [fragment?.content, highlightQuery]);

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

  const registerBlock = useCallback((id: number, blockIndex: number, y: number) => {
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
      if (next === shownHit) return;
      setHitIndex(next);
      const y = blockY.current.get(fragment.id)?.get(hitBlocks[next]);
      // 还没量到这一块（刚换页的那一帧）就不滚：高亮本身已经在屏幕上，
      // 按 undefined 硬滚一下反而会跳回顶部
      if (y !== undefined) {
        pageRefs.current.get(fragment.id)?.scrollTo({ y: Math.max(0, y - 16), animated: true });
      }
    },
    [fragment, hitBlocks, hitTotal, shownHit],
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
          draft.trim() || fragment.content,
        );
        /*
         * 编辑态加图 = 在光标处留一行定位标记，图就长在这一段文字中间；
         * 阅读态加图没有光标可依，图落到正文上方的「未定位」区。
         */
        if (editing && added.length) insertTokens(added.map((a) => a.id));
        setToast(
          editing
            ? `加了 ${res.assets.length} 张图，插在光标处`
            : `加了 ${res.assets.length} 张图，正在读图里的字`,
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
    const canSave = draft.trim().length > 0 && !saving;
    return (
      <View style={[styles.root, { paddingBottom: keyboardHeight }]}>
        <View style={styles.topBar}>
          {/* 和阅读态用同一个关闭钮，切进编辑时顶部不会整排跳位 */}
          <IconButton
            name="close"
            size={22}
            color={c.text2}
            onPress={stopEdit}
            accessibilityLabel="取消编辑"
          />
          <View style={styles.topCenter}>
            <Text style={styles.topDate}>编辑碎片</Text>
            <Text style={styles.topTime}>{draft.length} 字</Text>
          </View>
          <Pressable
            onPress={save}
            disabled={!canSave}
            hitSlop={8}
            style={({ pressed }) => [
              styles.editBtn,
              styles.saveBtn,
              !canSave && styles.saveBtnOff,
              pressed && canSave && { opacity: 0.7 },
            ]}
          >
            {saving ? (
              <ActivityIndicator size="small" color={c.onAccent} />
            ) : (
              <Text style={[styles.saveText, !canSave && styles.saveTextOff]}>保存</Text>
            )}
          </Pressable>
        </View>

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
                resizeMode="cover"
              />
              <Pressable
                onPress={() => void removeImage(img)}
                hitSlop={8}
                style={[styles.editImageRemove, armedImage === img.id && styles.editImageRemoveArmed]}
                accessibilityLabel={
                  armedImage === img.id ? `再点一次删除第 ${i + 1} 张图` : `删除第 ${i + 1} 张图`
                }
              >
                {armedImage === img.id ? (
                  <Text style={styles.editImageRemoveText}>删?</Text>
                ) : (
                  <Ionicons name="close" size={12} color="#FFFFFF" />
                )}
              </Pressable>
            </View>
          ))}
          <Pressable
            onPress={() => setImageMenu((v) => !v)}
            style={styles.editImageAdd}
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
        />

        <View style={styles.editFoot}>
          <Pressable onPress={remove} hitSlop={8}>
            <Text style={styles.deleteText}>
              {armedDelete ? '再点一次确认删除' : '删除这条碎片'}
            </Text>
          </Pressable>
          <Text style={styles.editHint}>
            {armedImage ? '再点一次图上的叉号才会真删' : '「加图」插在光标处'}
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
      <View style={styles.topBar}>
        <IconButton name="close" size={22} color={c.text2} onPress={onClose} accessibilityLabel="关闭" />
        <View style={styles.topCenter}>
          <Text style={styles.topDate}>{daySubLabel(fragment.createdAt)}</Text>
          <Text style={styles.topTime}>
            {formatTime(fragment.createdAt)}
            {items.length > 1 ? ` · ${current + 1} / ${items.length}` : ''}
          </Text>
        </View>
        <Pressable
          onPress={startEdit}
          hitSlop={8}
          style={({ pressed }) => [styles.editBtn, pressed && { opacity: 0.6 }]}
        >
          <Ionicons name="create-outline" size={17} color={c.accentText} />
          <Text style={styles.editText}>编辑</Text>
        </Pressable>
      </View>

      {/*
        「第 i / N 处」只在有命中时出现。单独占一行而不是塞进标题栏：
        一行里已经有关闭、日期、编辑三样，再挤两个箭头，日期会被压成「10月2…」。
        禁用态降透明度而不是隐藏 —— 按钮位置来回变比灰一点更难受。
      */}
      {hitTotal > 0 ? (
        <View style={styles.hitBar}>
          <Text style={styles.hitBarText}>
            第 {shownHit + 1} / {hitTotal} 处
          </Text>
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
          initialScrollIndex={initialIndex}
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
              registerScroll={registerScroll}
              registerBlock={registerBlock}
            />
          )}
        />
      ) : null}

      {items.length > 1 ? (
        <View style={styles.footer}>
          <Pressable
            onPress={() => jump(-1)}
            disabled={current === 0}
            hitSlop={12}
            style={({ pressed }) => [styles.navBtn, pressed && current > 0 && { opacity: 0.5 }]}
          >
            <Ionicons name="chevron-back" size={19} color={current === 0 ? c.hair : c.text2} />
          </Pressable>
          <Text style={styles.hint}>左右滑动查看上一条</Text>
          <Pressable
            onPress={() => jump(1)}
            disabled={atEnd}
            hitSlop={12}
            style={({ pressed }) => [styles.navBtn, pressed && !atEnd && { opacity: 0.5 }]}
          >
            <Ionicons name="chevron-forward" size={19} color={atEnd ? c.hair : c.text2} />
          </Pressable>
        </View>
      ) : null}

      {imageMenuLayer}
      {toast ? (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}

      {/*
        全屏看图。黑底、整屏、点一下关掉 —— 看截图时不该有一圈白边和标题栏。
        用 FlatList 横向翻页而不是一张一张点：一屏之内就能左右比较两张截图。
      */}
      {viewer !== null && images[viewer] ? (
        <View style={styles.viewer}>
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
                  resizeMode="contain"
                />
              </Pressable>
            )}
          />
          <View style={styles.viewerBar} pointerEvents="box-none">
            <Text style={styles.viewerCount}>
              {Math.min(viewer, images.length - 1) + 1} / {images.length}
            </Text>
            <Pressable onPress={() => setViewer(null)} hitSlop={12} style={styles.viewerClose}>
              <Ionicons name="close" size={20} color="#FFFFFF" />
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
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
  imageBusy: Set<number>;
  imageFail: Record<string, string>;
  onReparseImage: (fragment: Fragment, imageId: number) => void;
  onOpenImage: (index: number) => void;
  onAddImage: () => void;
  addingImage: boolean;
  registerScroll: (id: number, view: ScrollViewInstance | null) => void;
  registerBlock: (id: number, blockIndex: number, y: number) => void;
}) {
  const { c, styles } = useThemedStyles(makeStyles);
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
                        width: Math.max(0, width - 44),
                        height: Math.max(0, width - 44) * (aspects[img.id] ?? 0.75),
                      },
                    ]}
                    resizeMode="contain"
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
                  <Pressable onPress={() => onReparseImage(fragment, img.id)} hitSlop={8}>
                    <Text style={[styles.imageState, styles.imageStateErr]} numberOfLines={3}>
                      没读出文字：{reason} · 点这里重试
                    </Text>
                  </Pressable>
                ) : st === 'read' ? (
                  <Pressable onPress={() => onReparseImage(fragment, img.id)} hitSlop={8}>
                    <Text style={styles.imageState}>图里的字 · 点一下重读</Text>
                  </Pressable>
                ) : st === 'empty' ? (
                  <Text style={styles.imageState}>这张图里没读出字</Text>
                ) : (
                  <Pressable onPress={() => onReparseImage(fragment, img.id)} hitSlop={8}>
                    <Text style={styles.imageState}>还没读过这张图 · 点一下让它读</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>
      ) : null}

      {/*
        加图入口在阅读态也留着（用户 2026-11-12：「全屏时无法插图」）：
        翻旧记录时想起还有一张图要补，不该逼人先进编辑态。
      */}
      <Pressable
        onPress={onAddImage}
        style={({ pressed }) => [styles.addImageBtn, pressed && { opacity: 0.6 }]}
        accessibilityRole="button"
        accessibilityLabel="给这条碎片加图片"
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

      {/* 图里的字单独一块：用户要能核对模型抄得对不对，而不是只能信 */}
      {texts.length ? (
        <View style={styles.imageTextBox}>
          <Text style={styles.imageTextLabel}>
            {fragment.images.length > 1 ? `图里的字（${texts.length} 张有字）` : '图里的字'}
          </Text>
          {fragment.images.map((img, i) => {
            const t = (img.text ?? '').trim();
            if (!t) return null;
            return (
              <View key={img.id} style={styles.imageTextGroup}>
                {fragment.images.length > 1 ? (
                  <Text style={styles.imageTextIndex}>第 {i + 1} 张</Text>
                ) : null}
                <NoteBody text={t} style={styles.imageTextBody} variant="reading" selectable />
              </View>
            );
          })}
        </View>
      ) : null}

      {/* 碎片正文也走 Markdown 渲染：会话转出来的碎片有标题 / 列表 / 表格 / 代码 */}
      <NoteBody
        text={fragment.content}
        style={styles.body}
        variant="reading"
        selectable
        muted={merged}
        highlight={highlight}
        // 正文里 `![](img:12)` 那一行画成这张图；点它进同一个全屏看图
        imageUri={(id) => {
          const img = fragment.images.find((x) => x.id === id);
          return img ? fragmentImageUri(img.path) : null;
        }}
        onImagePress={(id) => {
          const i = fragment.images.findIndex((x) => x.id === id);
          if (i >= 0) onOpenImage(i);
        }}
        // 只有搜索进来才逐块渲染：平时合并成一个大 Text，行距更连贯
        onBlockLayout={highlight ? (bi, y) => registerBlock(fragment.id, bi, y) : undefined}
      />

      {hasMeta ? (
        <View style={styles.meta}>
          {fragment.project ? <Text style={styles.project}>{fragment.project}</Text> : null}
          {fragment.source !== 'app' ? (
            <View style={styles.source}>
              <Ionicons
                name={fragment.source === 'notif' ? 'notifications-outline' : 'share-outline'}
                size={12.5}
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
          <NoteBody text={n.bodyMd} style={styles.noteBody} />
        </View>
      ))}
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: c.page,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  topCenter: { flex: 1, alignItems: 'center' },
  topDate: { fontSize: 13.5, color: c.text, fontWeight: '600' },
  topTime: { fontSize: 11, color: c.text3, marginTop: 2, fontVariant: ['tabular-nums'] },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: c.accentBg,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: R.pill,
  },
  editText: { fontSize: 12.5, color: c.accentText, fontWeight: '600' },

  /**
   * 命中跳转条。底色用 amberBg —— 和正文里的高亮块是同一个颜色，
   * 「这条在这里」和「正文里描的那几段」一眼就是同一件事。
   */
  hitBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 20,
    paddingRight: 12,
    paddingVertical: 3,
    backgroundColor: c.amberBg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  hitBarText: { fontSize: 11.5, color: c.amberText, fontWeight: '600', fontVariant: ['tabular-nums'] },
  hitBarBtns: { flexDirection: 'row', alignItems: 'center', gap: 4 },

  content: { paddingHorizontal: 22, paddingTop: 22, paddingBottom: 48 },
  /** 配图：竖排，每张按原始比例给高度，不裁剪 */
  imageList: { gap: 10, marginBottom: 14 },
  imageBox: { gap: 6 },
  imageBig: { borderRadius: R.card, backgroundColor: c.hairSoft, alignSelf: 'center' },
  /** 多图时左上角标序号：点开的全屏和这里是同一份顺序，能对得上 */
  imageIndex: {
    position: 'absolute',
    top: 8,
    left: 8,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  imageIndexText: { fontSize: 11, color: '#FFFFFF', fontWeight: '600' },
  imageState: { fontSize: 11.5, lineHeight: 17, color: c.text3 },
  imageStateErr: { color: c.danger },
  /** 阅读态的加图入口：虚线框，看起来就是「这里还可以放东西」 */
  addImageBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    marginBottom: 16,
    borderRadius: R.btn,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderColor: c.hair,
  },
  addImageText: { fontSize: 12.5, color: c.text2 },
  /** 「图里的字」单独一块，方便核对模型抄得对不对 */
  imageTextBox: {
    marginBottom: 16,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
    borderRadius: R.card,
    backgroundColor: c.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hair,
  },
  imageTextLabel: { fontSize: 11, color: c.text3, letterSpacing: 0.4, marginBottom: 6 },
  imageTextGroup: { marginBottom: 6 },
  imageTextIndex: { fontSize: 10.5, color: c.text3, marginBottom: 2 },
  imageTextBody: { fontSize: 14, lineHeight: 23, color: c.text2 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  doneBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: c.tealBg,
    borderRadius: R.pill,
    paddingLeft: 5,
    paddingRight: 9,
    paddingVertical: 3,
  },
  doneText: { fontSize: 10.5, lineHeight: 15, color: c.tealText },
  orgBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: c.accentBg,
    borderRadius: R.pill,
    paddingLeft: 5,
    paddingRight: 9,
    paddingVertical: 3,
  },
  orgText: { fontSize: 10.5, lineHeight: 15, color: c.accentText },
  merged: { fontSize: 11, color: c.text3 },

  /* 详情页是「阅读」场景，字号和行高都比列表放宽一档 */
  body: { fontSize: 17, lineHeight: 30, color: c.text, letterSpacing: 0.2 },

  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 26,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
  },
  project: { fontSize: 12, color: c.text2 },
  source: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  sourceText: { fontSize: 11.5, color: c.text3 },

  count: { fontSize: 11, color: c.text3, marginTop: 14, fontVariant: ['tabular-nums'] },

  // 当天小结
  noteCard: {
    marginTop: 26,
    backgroundColor: c.accentBg,
    borderRadius: R.card,
    paddingHorizontal: 15,
    paddingVertical: 13,
  },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  noteKind: { fontSize: 11.5, color: c.accentText, fontWeight: '600' },
  notePeriod: { flex: 1, fontSize: 11, color: c.text3 },
  noteBody: { fontSize: 14.5, lineHeight: 24, color: c.text },

  // 编辑态：整屏输入，字号与阅读态一致
  saveBtn: { backgroundColor: c.accent, minWidth: 62, justifyContent: 'center' },
  saveBtnOff: { backgroundColor: c.hairSoft },
  saveText: { fontSize: 12.5, color: c.onAccent, fontWeight: '600' },
  saveTextOff: { color: c.text3 },
  editImages: {
    flexGrow: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
  },
  editImagesContent: { gap: 8, paddingHorizontal: 22, paddingVertical: 10, alignItems: 'center' },
  editImageItem: { width: 56, height: 56 },
  editImageThumb: { width: 56, height: 56, borderRadius: R.btn, backgroundColor: c.hairSoft },
  editImageRemove: {
    position: 'absolute',
    top: -5,
    right: -5,
    width: 19,
    height: 19,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  /** 二次确认态：红底 + 「删?」，和碎片删除的两次点击是同一套手感 */
  editImageRemoveArmed: { width: 26, height: 19, borderRadius: 10, backgroundColor: c.danger },
  editImageRemoveText: { fontSize: 9, color: '#FFFFFF', fontWeight: '600' },
  editImageAdd: {
    width: 56,
    height: 56,
    borderRadius: R.btn,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    backgroundColor: c.hairSoft,
  },
  editImageAddText: { fontSize: 10, color: c.text3 },
  editInput: {
    flex: 1,
    fontSize: 17,
    lineHeight: 30,
    letterSpacing: 0.2,
    color: c.text,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 22,
  },
  editFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 10,
    paddingBottom: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
  },
  deleteText: { fontSize: 12.5, color: c.danger },
  editHint: { fontSize: 11, color: c.text3 },

  /** 加图菜单：贴在底部，阅读态和编辑态共用 */
  imageSheet: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 64,
    backgroundColor: c.card,
    borderRadius: R.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hair,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  imageSheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  imageSheetCancel: { paddingHorizontal: 16, paddingVertical: 12 },
  imageSheetText: { fontSize: 13.5, color: c.text },
  toast: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 86,
    alignItems: 'center',
  },
  toastText: {
    fontSize: 12,
    lineHeight: 18,
    color: c.text2,
    backgroundColor: c.card,
    borderRadius: R.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hair,
  },

  /** 全屏看图：纯黑底，只留计数和关闭 */
  viewer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#000000',
  },
  viewerPage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewerList: { flex: 1 },
  viewerImage: { width: '100%', height: '100%' },
  viewerBar: {
    position: 'absolute',
    top: 10,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  viewerCount: { fontSize: 12, color: 'rgba(255,255,255,0.85)', fontVariant: ['tabular-nums'] },
  viewerClose: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
  },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hair,
  },
  navBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  hint: { fontSize: 11.5, color: c.text3 },
});
