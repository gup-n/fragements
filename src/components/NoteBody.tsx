/**
 * 正文渲染：小结、问答回答、碎片详情共用这一个。
 *
 * 存进库里的 `body_md` 是 Markdown（导出要保真），但 RN 的 Text 不认 Markdown。
 * v0.7 起这里只处理标题 / 列表 / 加粗，够读小结 —— 但「问」的回答是模型自由写的，
 * 用户说一句「列个表给我」，它就会输出 GFM 表格，屏幕上只剩一串竖线。
 *
 * v0.8.7 加了表格、代码块、分隔线。**表格必须用 View 排**，不能靠空格对齐：
 * 中文和字母宽度不同，等宽字体也顶不住混排，最后一定歪。
 *
 * 两条不能丢的行为：
 * - `numberOfLines` 存在时（卡片预览）退回单个 Text。View 没法被 numberOfLines 截断，
 *   所以表格在这种模式下压成「华为 · F2 · F12」一行，够看出这是个表就行。
 * - 加粗和行内代码不能抹掉：旧小结里还有 `- **换盘**：一句话`，
 *   而路径、命令混在正文里不分字形很难扫。
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { blockHitCount, segmentHitCount } from '../documents/readers/markdownSearch';
import { findHits } from '../util/highlight';
import {
  flattenForPreview,
  parseBlocks,
  type Align,
  type Block,
  type CiteRef,
  type Seg,
  type TableBlock,
  type TextBlock,
} from '../util/mdBlocks';

const MONO = Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' });

/** 引用标记的点击回调与「这枚引用显示成几号」。两者都由调用方决定 */
type CiteProps = {
  onCite?: (ref: CiteRef) => void;
  /**
   * 返回 null 表示这枚引用不显示。
   *
   * 之所以不在这里编号：序号要按「本轮哪些引用真的被解答了」排，
   * 只有持有 citation 列表的页面知道，渲染层自己数会和面板对不上。
   */
  citeLabel?: (ref: CiteRef) => string | null;
};

/** 连续的文字块合成一组，交给一个 Text 渲染 —— 否则每行都是独立 Text，行距会散 */
type Group =
  | { type: 'text'; blocks: TextBlock[] }
  | { type: 'table'; block: TableBlock }
  | { type: 'code'; text: string }
  /** `id` = 碎片配图行；`file` = 文档内嵌图的文件名（两者只会有一个） */
  | { type: 'image'; id?: number; file?: string }
  | { type: 'hr' };

function group(blocks: Block[]): Group[] {
  const out: Group[] = [];
  let buf: TextBlock[] = [];

  const flush = () => {
    if (buf.length) {
      out.push({ type: 'text', blocks: buf });
      buf = [];
    }
  };

  for (const b of blocks) {
    if (b.kind === 'table') {
      flush();
      out.push({ type: 'table', block: b });
    } else if (b.kind === 'code') {
      flush();
      out.push({ type: 'code', text: b.text });
    } else if (b.kind === 'image') {
      flush();
      out.push({ type: 'image', ...('id' in b ? { id: b.id } : { file: b.file }) });
    } else if (b.kind === 'hr') {
      flush();
      out.push({ type: 'hr' });
    } else {
      buf.push(b);
    }
  }
  flush();
  return out;
}

/**
 * 正文里的一张图。
 *
 * 高度按图片自己的宽高比算（`aspectRatio`），不写死 4:3 —— 手机截图多是 9:19，
 * 写死会把主要内容裁掉一半。拿不到尺寸时退回 4:3，至少不塌成 0 高。
 *
 * **不在 `Text` 里**：RN 的 Text 里塞 Image 在安卓上会被压成 0 宽，
 * 所以分块解析把图片当成独立块（`kind: 'image'`），不参与行内排版。
 */
function InlineImage({ uri, onPress }: { uri: string; onPress?: () => void }) {
  const { styles } = useThemedStyles(makeStyles);
  const [aspect, setAspect] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    Image.getSize(
      uri,
      (w, h) => {
        if (alive && w > 0) setAspect(h / w);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [uri]);

  const pic = (
    <Image
      source={{ uri }}
      style={[styles.inlineImage, { aspectRatio: 1 / (aspect ?? 0.75) }]}
      resizeMode="contain" fadeDuration={0}
      accessibilityLabel="正文里的配图"
    />
  );
  if (!onPress) return pic;
  return (
    <Pressable onPress={onPress} accessibilityRole="imagebutton" accessibilityLabel="点开看大图">
      {pic}
    </Pressable>
  );
}

/**
 * 行内片段。
 *
 * 引用段单独画成小标：正文里 `[F12]` 那种原文既占宽又打断句子，
 * 用户要的是「这里有个出处，点一下」。
 */
function Inline({
  segs,
  onCite,
  citeLabel,
  variant = 'default',
  selectable,
  highlight,
  activeHit,
}: { segs: Seg[] } & CiteProps & Pick<Props, 'variant' | 'selectable' | 'highlight' | 'activeHit'>) {
  const { styles } = useThemedStyles(makeStyles);
  const reading = variant === 'reading';
  // 局部渲染游标，每次 render 从0起；不是跨渲染的可变状态。
  let hitOffset = 0;

  const withHits = (text: string) => {
    if (!highlight || !text) return text;
    const hits = findHits(text, highlight);
    const start = hitOffset;
    hitOffset += hits.length;
    if (!hits.length) return text;
    const parts: React.ReactNode[] = [];
    let last = 0;
    hits.forEach((h, i) => {
      if (h.start > last) parts.push(text.slice(last, h.start));
      parts.push(
        <Text key={i} style={[styles.hit, activeHit === start + i && styles.hitCurrent]}>
          {text.slice(h.start, h.end)}
        </Text>,
      );
      last = h.end;
    });
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  };

  return (
    <>
      {segs.map((seg, i) => {
        if (seg.cite) {
          const ref = seg.cite;
          const label = citeLabel?.(ref) ?? null;
          if (!label) return null;
          return (
            <Text
              key={i} style={styles.cite} suppressHighlighting
              accessibilityRole="button" accessibilityLabel={`查看引用 ${label}`}
              onPress={onCite ? () => onCite(ref) : undefined}
            >
              {label}
            </Text>
          );
        }
        return (
          <Text
            key={i} selectable={selectable}
            style={[seg.bold && styles.bold, seg.code && (reading ? styles.codeReading : styles.code)]}
          >
            {withHits(seg.text)}
          </Text>
        );
      })}
    </>
  );
}

const ALIGN: Record<Align, 'left' | 'center' | 'right'> = {
  left: 'left',
  center: 'center',
  right: 'right',
};

/**
 * 表格。
 *
 * 列宽按内容估的相对权重分，不是平均分 —— 三列里「品牌」两个字和「进 BIOS」
 * 一样宽的话，一半屏幕就浪费在空白上了。窄屏列多时（≥5 列）收窄内边距，
 * 保持正文字号并换行，不再用小字挤进屏幕。
 */
function Table({
  block,
  onCite,
  citeLabel,
  variant = 'default',
  selectable,
  muted,
  highlight,
  activeHit,
}: { block: TableBlock } & CiteProps & Pick<Props, 'variant' | 'selectable' | 'muted' | 'highlight' | 'activeHit'>) {
  const { styles, c } = useThemedStyles(makeStyles);
  const dense = block.head.length >= 5;
  const reading = variant === 'reading';
  const mutedStyle = muted ? { color: c.text3 } : undefined;
  let hitOffset = 0;

  const cell = (segs: Seg[], col: number, head: boolean) => {
    const start = hitOffset;
    hitOffset += highlight ? segmentHitCount(segs, highlight) : 0;
    return (
      <View key={col} style={[styles.td, dense && styles.tdDense, { flex: block.weights[col] ?? 3 }, col > 0 && styles.tdDivider]}>
        <Text
          selectable={selectable}
          style={[
            reading ? styles.tdTextReading : styles.tdText,
            head && styles.thText, mutedStyle,
            { textAlign: ALIGN[block.align[col] ?? 'left'] },
          ]}
        >
          <Inline
            segs={segs} onCite={onCite} citeLabel={citeLabel} variant={variant}
            selectable={selectable} highlight={highlight}
            activeHit={activeHit === undefined ? undefined : activeHit - start}
          />
        </Text>
      </View>
    );
  };

  return (
    /*
     * 不做横向滚动，让列自己换行。
     *
     * 加过一版 ScrollView horizontal，rollback 的原因很具体：碎片详情是横向分页的
     * FlatList，表格里再放一个横向滚动区，手指在表上左右滑就变成滚表格、翻不了页 ——
     * 这个冲突用户无法理解，也看不出提示。列多的表变高，但读得下去。
     */
    <View>
      <View style={styles.table}>
        <View style={[styles.tr, styles.trHead]}>
          {block.head.map((segs, i) => cell(segs, i, true))}
        </View>
        {block.rows.map((row, r) => (
          <View key={r} style={[styles.tr, r < block.rows.length - 1 && styles.trDivider]}>
            {row.map((segs, i) => cell(segs, i, false))}
          </View>
        ))}
      </View>
      {block.droppedCols ? (
        // 裁列是手机屏的现实，但静默裁掉会让人以为表格只有这么多列
        <Text style={[styles.tableNote, mutedStyle]}>另 {block.droppedCols} 列未显示</Text>
      ) : null}
    </View>
  );
}

interface Props {
  text: string;
  /** 折叠行数；不给表示全展开。给了就用单 Text 平铺（表格降级成一行） */
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  /** 点引用。不给就是纯阅读（卡片预览、碎片详情） */
  onCite?: (ref: CiteRef) => void;
  /** 引用显示成什么；不给或返回 null 就不画那枚小标 */
  citeLabel?: (ref: CiteRef) => string | null;
  /** 阅读态：碎片的字号比小结大一档，标题和代码也要跟着放大 */
  variant?: 'default' | 'reading';
  /** 允许长按选择文字。碎片详情要开，卡片预览不要 */
  selectable?: boolean;
  /** 已合并的碎片置灰，标题以外整体降一档颜色 */
  muted?: boolean;
  /**
   * 命中的搜索词。给了就把正文里命中的片段描一层底色（详情页从搜索进来时用）。
   * 引用小标不参与高亮 —— 那是我方编号，不是正文。
   */
  highlight?: string;
  /** 当前命中（本组件可见文字的0起序号），用下划线而非仅换底色标识。 */
  activeHit?: number;
  /**
   * 每个文字块的实测 y（相对本组件内容的顶端）。
   *
   * 给了它才逐块渲染：一个块一个 `<View onLayout>`。合并成一个大 Text 时
   * 量不出「第 3 块在哪」—— Text 只报整体高度，详情页要按块滚到命中处就没法做。
   * 不给时保持原来的合并渲染（连续文字块共用一行距，视觉更连贯）。
   */
  onBlockLayout?: (blockIndex: number, y: number) => void;
  /**
   * 关掉引用解析：`[F12]` 这类标记当**字面文字**原样显示。
   *
   * 文档阅读器和文档正文必须传。用户文档里写 `[F12]`（比如表格编号、
   * 法律条款引用）本来就是一个普通字符串，按引用解析会把它整个吞掉，
   * 屏幕上凭空少一段内容 —— 那是改用户的数据，不是显示问题。
   */
  literalCitations?: boolean;
  /**
   * 正文里 `![](img:12)` 的图去哪拿。给了才渲染图片块。
   *
   * 返回 null 表示这张图已经不在了（被删掉、文件丢了）—— 整块跳过，
   * 不画一个空格子：那会让用户以为内容丢了。
   */
  imageUri?: (id: number) => string | null;
  /**
   * 文档内嵌图 `![](doc-img:名字)` 去哪拿（v0.29）。
   *
   * 与 `imageUri` 分开是因为来源不同：前者查 `fragment_images` 的行，
   * 后者只是一个文件名。合成一个回调会让文档渲染去查碎片表。
   */
  fileUri?: (name: string) => string | null;
  /** 点正文里的图。碎片详情用它进全屏看图 */
  onImagePress?: (id: number) => void;
}

export function NoteBody({
  text,
  numberOfLines,
  style,
  onCite,
  citeLabel,
  variant = 'default',
  selectable,
  muted,
  highlight,
  activeHit,
  onBlockLayout,
  literalCitations,
  imageUri,
  fileUri,
  onImagePress,
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const reading = variant === 'reading';
  const mutedStyle = muted ? { color: c.text3 } : undefined;
  // 两个 memo 都无条件调用：条件调用 hook 会破坏顺序，哪怕只有一个分支用得到
  const blocks = useMemo(
    () => parseBlocks(text, literalCitations ? { literalCitations: true } : undefined),
    [text, literalCitations],
  );
  const flat = useMemo(() => flattenForPreview(blocks), [blocks]);
  const groups = useMemo(() => group(blocks), [blocks]);
  let hitOffset = 0;
  const nextActiveHit = (count: number) => {
    const start = hitOffset;
    hitOffset += count;
    return activeHit === undefined ? undefined : activeHit - start;
  };

  /** 文字块的内层：标题 / 列表 / 段落，样式按块种类定 */
  const blockInner = (b: TextBlock) => {
    // 空段落（作者写的空行）：它的作用只是让外层多一个换行符，自己不画东西
    if (b.kind === 'p' && b.segs.length === 0) return null;
    return (
    <Text
      style={
        b.kind === 'h'
          ? reading
            ? styles.hReading
            : styles.h
          : b.kind === 'b'
            ? styles.b
            : styles.p
      }
    >
      <Inline
        segs={b.segs}
        onCite={onCite}
        citeLabel={citeLabel}
        variant={variant}
        selectable={selectable}
        highlight={highlight}
        activeHit={nextActiveHit(highlight ? segmentHitCount(b.segs, highlight) : 0)}
      />
    </Text>
    );
  };

  /**
   * 代码块里的命中。
   *
   * 代码不认加粗/引用，但**该高亮的还得高亮** —— 用户搜一个命令，
   * 结果落在代码块里却什么都不描，会以为「搜到了但没找到」。
   * 行内样式继承外层 Text，等宽字体不会丢。
   */
  const hitParts = (text: string, current?: number) => {
    if (!highlight || !text) return text;
    const hits = findHits(text, highlight);
    if (!hits.length) return text;
    const out: React.ReactNode[] = [];
    let last = 0;
    hits.forEach((h, i) => {
      if (h.start > last) out.push(text.slice(last, h.start));
      out.push(
        <Text key={i} style={[styles.hit, current === i && styles.hitCurrent]}>
          {text.slice(h.start, h.end)}
        </Text>,
      );
      last = h.end;
    });
    if (last < text.length) out.push(text.slice(last));
    return out;
  };

  const codeView = (code: string, key: React.Key) => (
    <View key={key} style={styles.codeBox}>
      <Text style={[reading ? styles.codeTextReading : styles.codeText, mutedStyle]} selectable>
        {hitParts(code, nextActiveHit(highlight ? findHits(code, highlight).length : 0))}
      </Text>
    </View>
  );

  const tableView = (block: TableBlock, key: React.Key) => (
    <Table
      key={key}
      block={block}
      onCite={onCite}
      citeLabel={citeLabel}
      variant={variant}
      selectable={selectable}
      muted={muted}
      highlight={highlight}
      activeHit={nextActiveHit(highlight ? blockHitCount(block, highlight) : 0)}
    />
  );

  /** 正文里的图。拿不到 uri 就不画（见 `imageUri` 的约定） */
  const imageView = (source: { id?: number; file?: string }, key: React.Key) => {
    const uri = typeof source.id === 'number' ? imageUri?.(source.id) : source.file ? fileUri?.(source.file) : null;
    if (!uri) return null;
    // 只有碎片配图能进全屏看图；文档内嵌图还没有那个页面，点了不许什么都不发生
    const press = typeof source.id === 'number' && onImagePress ? () => onImagePress(source.id as number) : undefined;
    return (
      <View key={key} style={styles.imageBox}>
        <InlineImage uri={uri} onPress={press} />
      </View>
    );
  };

  // ---- 预览模式：一个 Text，靠 numberOfLines 截断 ----
  // 逐块渲染在这里没有意义：View 截不了行，卡片预览会被撑破
  if (numberOfLines !== undefined) {
    return (
      <Text
        style={[styles.root, reading && styles.rootReading, style, mutedStyle]}
        numberOfLines={numberOfLines}
        selectable={selectable}
      >
        {flat.map((line, i) => (
          <React.Fragment key={i}>
            {i === 0 ? '' : line.newlineBefore ? '\n\n' : '\n'}
            <Inline
              segs={line.segs}
              onCite={onCite}
              citeLabel={citeLabel}
              variant={variant}
              selectable={selectable}
              highlight={highlight}
            />
          </React.Fragment>
        ))}
      </Text>
    );
  }

  /*
   * ---- 逐块模式：详情页要按块滚动到命中处，所以不合并 ----
   *
   * 阅读块的间距来自共享 token；onLayout 回报留白之后的真实 y，
   * 不用字符比例猜命中位置。
   * 表格 / 代码块也要回调：命中可能落在表格单元格或代码里，只量文字块的话
   * 「第 4 / 7 处」会跳到别的段落上去。
   */
  if (onBlockLayout) {
    return (
      <View>
        {blocks.map((b, bi) => {
          const measure = (e: { nativeEvent: { layout: { y: number } } }) =>
            onBlockLayout(bi, e.nativeEvent.layout.y);
          if (b.kind === 'table') {
            return (
              <View key={bi} onLayout={measure}>
                {tableView(b, bi)}
              </View>
            );
          }
          if (b.kind === 'hr') return <View key={bi} style={styles.hr} />;
          if (b.kind === 'code') {
            return (
              <View key={bi} onLayout={measure}>
                {codeView(b.text, bi)}
              </View>
            );
          }
          if (b.kind === 'image') {
            return (
              <View key={bi} onLayout={measure}>
                {imageView('id' in b ? { id: b.id } : { file: b.file }, bi)}
              </View>
            );
          }
          return (
            <View key={bi} style={[reading && styles.textBlockReading, reading && b.kind === 'h' && bi > 0 && styles.headingBlockReading]} onLayout={measure}>
              <Text style={[styles.root, reading && styles.rootReading, style, mutedStyle]} selectable={selectable}>
                {blockInner(b)}
              </Text>
            </View>
          );
        })}
      </View>
    );
  }

  // ---- 全量模式：文字走 Text，表格和代码块走 View ----
  return (
    <View>
      {groups.map((g, gi) => {
        if (g.type === 'table') return tableView(g.block, gi);
        if (g.type === 'hr') return <View key={gi} style={styles.hr} />;
        if (g.type === 'code') return codeView(g.text, gi);
        if (g.type === 'image') return imageView(g, gi);

        return (
          <Text key={gi} style={[styles.root, reading && styles.rootReading, style, mutedStyle]} selectable={selectable}>
            {g.blocks.map((b, i) => (
              <React.Fragment key={i}>
                {/* 小标题前面空一行，读起来才有分节感 */}
                {i === 0 ? '' : b.kind === 'h' ? '\n\n' : '\n'}
                {blockInner(b)}
              </React.Fragment>
            ))}
          </Text>
        );
      })}
      {/* 表格和代码块只设了上下边距，末尾多出来的那点空隙在这里收掉 */}
      {groups.length === 0 ? <Text style={[styles.root, reading && styles.rootReading, style, mutedStyle]} selectable={selectable} /> : null}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  root: { ...TYPE.body, color: c.text },
  rootReading: { ...TYPE.reading },
  h: { ...TYPE.title, color: c.text },
  hReading: { ...TYPE.heading, color: c.text },
  b: {},
  p: {},
  textBlockReading: { paddingBottom: SPACE.xs },
  headingBlockReading: { marginTop: SPACE.md },
  bold: { fontWeight: '600' },
  hit: { backgroundColor: c.amberBg, borderRadius: 2 },
  hitCurrent: { textDecorationLine: 'underline', fontWeight: '700' },
  code: { ...TYPE.body, fontFamily: MONO },
  /*
   * 下面三个 *Reading 变体原来全部写成了 `TYPE.body` —— 名字说「阅读态」，
   * 值却是正文尺寸，于是详情页里标题 22、正文 17、代码块和表格单元格 16，
   * 一段带表格的长文里字号会来回跳。现在真的跟着 reading 走。
   */
  codeReading: { ...TYPE.reading, fontFamily: MONO },
  /**
   * 引用小标。
   *
   * 原来还叠了一条 `textDecorationLine: 'underline'` —— 淡蓝底 + 主色字 + 下划线
   * 三重强调，一段回答里有五六个引用时，整段文字看起来像满是链接的网页。
   * 底色和颜色已经说明「这里能点」，下划线去掉。
   */
  cite: {
    ...TYPE.label, color: c.accentText, backgroundColor: c.accentBg, borderRadius: metrics.buttonRadius,
    paddingHorizontal: SPACE.xxs, marginHorizontal: 1,
  },
  hr: { height: surfaceStroke(metrics), backgroundColor: c.hair, marginVertical: SPACE.lg },
  /** 代码块靠底色区分，不描边（浅灰块在浅灰页上已经是另一种材质） */
  codeBox: {
    backgroundColor: c.hairSoft, borderRadius: metrics.buttonRadius,
    paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, marginVertical: SPACE.sm,
  },
  codeText: { ...TYPE.body, fontFamily: MONO, color: c.text },
  codeTextReading: { ...TYPE.reading, fontFamily: MONO, color: c.text },
  table: { marginVertical: SPACE.sm, borderWidth: surfaceStroke(metrics), borderColor: c.hair, borderRadius: metrics.buttonRadius, overflow: 'hidden' },
  tr: { flexDirection: 'row', alignItems: 'stretch' },
  trHead: { backgroundColor: c.hairSoft, borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair },
  tableNote: { ...TYPE.meta, color: c.text2, marginTop: SPACE.xxs, marginBottom: SPACE.sm, paddingHorizontal: SPACE.xxs },
  trDivider: { borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair },
  imageBox: { marginVertical: SPACE.sm },
  inlineImage: { width: '100%', borderRadius: metrics.cardRadius, backgroundColor: c.hairSoft },
  td: { paddingHorizontal: SPACE.xs, paddingVertical: SPACE.sm, justifyContent: 'center', minWidth: 0 },
  tdDense: { paddingHorizontal: SPACE.xxs },
  tdDivider: { borderLeftWidth: surfaceStroke(metrics), borderLeftColor: c.hair },
  tdText: { ...TYPE.body, color: c.text },
  tdTextReading: { ...TYPE.reading, color: c.text },
  thText: { fontWeight: '600', color: c.text },
});
