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
import React, { useMemo } from 'react';
import { Platform, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { useThemedStyles, type Palette } from '../theme';
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
type Group = { type: 'text'; blocks: TextBlock[] } | { type: 'table'; block: TableBlock } | { type: 'code'; text: string } | { type: 'hr' };

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
}: { segs: Seg[] } & CiteProps & Pick<Props, 'variant' | 'selectable'>) {
  const { styles } = useThemedStyles(makeStyles);
  const reading = variant === 'reading';
  return (
    <>
      {segs.map((seg, i) => {
        if (seg.cite) {
          const ref = seg.cite;
          const label = citeLabel?.(ref) ?? null;
          // 拿不到序号就不显示 —— 画一个点不开的编号比不画更让人困惑
          if (!label) return null;
          return (
            <Text
              key={i}
              style={styles.cite}
              suppressHighlighting
              accessibilityRole="button"
              accessibilityLabel={`查看引用 ${label}`}
              onPress={onCite ? () => onCite(ref) : undefined}
            >
              {label}
            </Text>
          );
        }
        return (
          <Text
            key={i}
            selectable={selectable && !seg.cite}
            style={
              seg.bold
                ? styles.bold
                : seg.code
                  ? reading
                    ? styles.codeReading
                    : styles.code
                  : undefined
            }
          >
            {seg.text}
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
 * 一样宽的话，一半屏幕就浪费在空白上了。窄屏列多时（≥5 列）整体缩字号，
 * 因为那时候再换行也读不出结构。
 */
function Table({
  block,
  onCite,
  citeLabel,
  variant = 'default',
  selectable,
  muted,
}: { block: TableBlock } & CiteProps & Pick<Props, 'variant' | 'selectable' | 'muted'>) {
  const { styles, c } = useThemedStyles(makeStyles);
  const dense = block.head.length >= 5;
  const reading = variant === 'reading';
  const mutedStyle = muted ? { color: c.text3 } : undefined;

  const cell = (segs: Seg[], col: number, head: boolean) => (
    <View
      key={col}
      style={[
        styles.td,
        { flex: block.weights[col] ?? 3 },
        col > 0 && styles.tdDivider,
      ]}
    >
      <Text
        selectable={selectable}
        style={[
          reading ? styles.tdTextReading : styles.tdText,
          dense && styles.tdTextDense,
          head && styles.thText,
          mutedStyle,
          { textAlign: ALIGN[block.align[col] ?? 'left'] },
        ]}
      >
        <Inline
          segs={segs}
          onCite={onCite}
          citeLabel={citeLabel}
          variant={variant}
          selectable={selectable}
        />
      </Text>
    </View>
  );

  return (
    /*
     * 不做横向滚动，让列自己换行。
     *
     * 加过一版 ScrollView horizontal，rollback 的原因很具体：碎片详情是横向分页的
     * FlatList，表格里再放一个横向滚动区，手指在表上左右滑就变成滚表格、翻不了页 ——
     * 这个冲突用户无法理解，也看不出提示。列多的表变高，但读得下去。
     */
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
}: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const reading = variant === 'reading';
  const mutedStyle = muted ? { color: c.text3 } : undefined;
  // 两个 memo 都无条件调用：条件调用 hook 会破坏顺序，哪怕只有一个分支用得到
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const flat = useMemo(() => flattenForPreview(blocks), [blocks]);
  const groups = useMemo(() => group(blocks), [blocks]);

  // ---- 预览模式：一个 Text，靠 numberOfLines 截断 ----
  if (numberOfLines !== undefined) {
    return (
      <Text
        style={[styles.root, style, mutedStyle]}
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
            />
          </React.Fragment>
        ))}
      </Text>
    );
  }

  // ---- 全量模式：文字走 Text，表格和代码块走 View ----
  return (
    <View>
      {groups.map((g, gi) => {
        if (g.type === 'table') {
          return (
            <Table
              key={gi}
              block={g.block}
              onCite={onCite}
              citeLabel={citeLabel}
              variant={variant}
              selectable={selectable}
              muted={muted}
            />
          );
        }
        if (g.type === 'hr') return <View key={gi} style={styles.hr} />;
        if (g.type === 'code') {
          return (
            <View key={gi} style={styles.codeBox}>
              <Text
                style={[reading ? styles.codeTextReading : styles.codeText, mutedStyle]}
                selectable
              >
                {g.text}
              </Text>
            </View>
          );
        }

        return (
          <Text key={gi} style={[styles.root, style, mutedStyle]} selectable={selectable}>
            {g.blocks.map((b, i) => (
              <React.Fragment key={i}>
                {/* 小标题前面空一行，读起来才有分节感 */}
                {i === 0 ? '' : b.kind === 'h' ? '\n\n' : '\n'}
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
                  />
                </Text>
              </React.Fragment>
            ))}
          </Text>
        );
      })}
      {/* 表格和代码块只设了上下边距，末尾多出来的那点空隙在这里收掉 */}
      {groups.length === 0 ? <Text style={[styles.root, style, mutedStyle]} selectable={selectable} /> : null}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { fontSize: 14, lineHeight: 23, color: c.text },
  h: { fontSize: 12, lineHeight: 20, color: c.accentText, fontWeight: '600' },
  /** 碎片详情是阅读态：标题要比正文大，不然会像一行小标签 */
  hReading: { fontSize: 16, lineHeight: 25, color: c.accentText, fontWeight: '600' },
  b: {},
  p: {},
  /** 加粗的关键词略重字重：颜色继承正文，已合并的碎片才能整体置灰 */
  bold: { fontWeight: '600' },
  /** 行内代码只换字形加浅底，不加边框 —— 正文里到处是补丁框会更乱 */
  code: { fontFamily: MONO, fontSize: 13, color: c.text2 },
  codeReading: { fontFamily: MONO, fontSize: 15, color: c.text2 },
  /**
   * 引用小标：浅蓝底 + 一个序号。
   *
   * 字号压到 11 是因为它必须能嵌在 14px 的正文行里不把行高顶开；
   * 颜色走 accent 系，和正文拉开但不抢视线 —— 它是辅助信息，不是内容。
   */
  cite: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '600',
    color: c.accentText,
    backgroundColor: c.accentBg,
    borderRadius: 4,
    paddingHorizontal: 3.5,
    marginHorizontal: 1,
    overflow: 'hidden',
  },

  hr: { height: StyleSheet.hairlineWidth, backgroundColor: c.hair, marginVertical: 12 },

  codeBox: {
    backgroundColor: c.hairSoft,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 9,
    marginVertical: 8,
  },
  codeText: { fontFamily: MONO, fontSize: 12.5, lineHeight: 19, color: c.text2 },
  codeTextReading: { fontFamily: MONO, fontSize: 14.5, lineHeight: 22, color: c.text2 },

  table: {
    marginVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hair,
    borderRadius: 8,
    overflow: 'hidden',
  },
  tr: { flexDirection: 'row', alignItems: 'stretch' },
  trHead: { backgroundColor: c.hairSoft },
  trDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.hair },

  td: { paddingHorizontal: 9, paddingVertical: 7, justifyContent: 'center', minWidth: 0 },
  tdDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: c.hair },
  tdText: { fontSize: 12.5, lineHeight: 19, color: c.text },
  tdTextReading: { fontSize: 14, lineHeight: 21, color: c.text },
  tdTextDense: { fontSize: 11.5, lineHeight: 17 },
  /** 表头压成正文色 + 稍重：小结和回答里的表通常是参考数据，不该抢视线 */
  thText: { fontWeight: '600', color: c.text2 },
});
