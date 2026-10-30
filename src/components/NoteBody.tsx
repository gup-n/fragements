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
  type Seg,
  type TableBlock,
  type TextBlock,
} from '../util/mdBlocks';

const MONO = Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' });

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

function Inline({ segs }: { segs: Seg[] }) {
  const { styles } = useThemedStyles(makeStyles);
  return (
    <>
      {segs.map((seg, i) => (
        <Text key={i} style={seg.bold ? styles.bold : seg.code ? styles.code : undefined}>
          {seg.text}
        </Text>
      ))}
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
function Table({ block }: { block: TableBlock }) {
  const { styles } = useThemedStyles(makeStyles);
  const dense = block.head.length >= 5;

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
        style={[styles.tdText, dense && styles.tdTextDense, head && styles.thText, { textAlign: ALIGN[block.align[col] ?? 'left'] }]}
      >
        <Inline segs={segs} />
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
}

export function NoteBody({ text, numberOfLines, style }: Props) {
  const { styles } = useThemedStyles(makeStyles);
  // 两个 memo 都无条件调用：条件调用 hook 会破坏顺序，哪怕只有一个分支用得到
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const flat = useMemo(() => flattenForPreview(blocks), [blocks]);
  const groups = useMemo(() => group(blocks), [blocks]);

  // ---- 预览模式：一个 Text，靠 numberOfLines 截断 ----
  if (numberOfLines !== undefined) {
    return (
      <Text style={[styles.root, style]} numberOfLines={numberOfLines}>
        {flat.map((line, i) => (
          <React.Fragment key={i}>
            {i === 0 ? '' : line.newlineBefore ? '\n\n' : '\n'}
            <Inline segs={line.segs} />
          </React.Fragment>
        ))}
      </Text>
    );
  }

  // ---- 全量模式：文字走 Text，表格和代码块走 View ----
  return (
    <View>
      {groups.map((g, gi) => {
        if (g.type === 'table') return <Table key={gi} block={g.block} />;
        if (g.type === 'hr') return <View key={gi} style={styles.hr} />;
        if (g.type === 'code') {
          return (
            <View key={gi} style={styles.codeBox}>
              <Text style={styles.codeText} selectable>
                {g.text}
              </Text>
            </View>
          );
        }

        return (
          <Text key={gi} style={[styles.root, style]}>
            {g.blocks.map((b, i) => (
              <React.Fragment key={i}>
                {/* 小标题前面空一行，读起来才有分节感 */}
                {i === 0 ? '' : b.kind === 'h' ? '\n\n' : '\n'}
                <Text style={b.kind === 'h' ? styles.h : b.kind === 'b' ? styles.b : styles.p}>
                  <Inline segs={b.segs} />
                </Text>
              </React.Fragment>
            ))}
          </Text>
        );
      })}
      {/* 表格和代码块只设了上下边距，末尾多出来的那点空隙在这里收掉 */}
      {groups.length === 0 ? <Text style={[styles.root, style]} /> : null}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { fontSize: 14, lineHeight: 23, color: c.text },
  h: { fontSize: 12, lineHeight: 20, color: c.accentText, fontWeight: '600' },
  b: { color: c.text },
  p: { color: c.text },
  /** 加粗的关键词用正文色 + 稍重字重：强调要点，但不至于整段花花绿绿 */
  bold: { fontWeight: '600', color: c.text },
  /** 行内代码只换字形加浅底，不加边框 —— 正文里到处是补丁框会更乱 */
  code: { fontFamily: MONO, fontSize: 13, color: c.text2 },

  hr: { height: StyleSheet.hairlineWidth, backgroundColor: c.hair, marginVertical: 12 },

  codeBox: {
    backgroundColor: c.hairSoft,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 9,
    marginVertical: 8,
  },
  codeText: { fontFamily: MONO, fontSize: 12.5, lineHeight: 19, color: c.text2 },

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
  tdTextDense: { fontSize: 11.5, lineHeight: 17 },
  /** 表头压成正文色 + 稍重：小结和回答里的表通常是参考数据，不该抢视线 */
  thText: { fontWeight: '600', color: c.text2 },
});
