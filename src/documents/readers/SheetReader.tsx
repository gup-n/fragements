/**
 * Excel / CSV 只读阅读器。
 *
 * 三条设计取舍：
 *
 * 1. **只显示有内容的行，但标真实行号。** 稀疏表的第 2 行后面可能就是第 500 行，
 *    按数组下标标 1/2/3 会让用户对着 Excel 找不到位置。
 * 2. **不裁列。** 提取结果本来就不裁列，视图也横向滚动到底 —— 现有 `mdBlocks`
 *    的 8 列上限是排版妥协，不能带到这里来。视图本身有行/列显示上限，
 *    超了会在顶上写明，不是悄悄省略。
 * 3. **不做公式重算、不执行宏、不开外链。** SheetJS 只给上次保存的缓存值；
 *    没有缓存值的公式显示成 `=SUM(A1:A3)`，让用户知道这里本来是个公式。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ScrollViewInstance,
} from 'react-native';
import type { Document } from '../../types';
import { R, useThemedStyles, type Palette } from '../../theme';
import { findHits } from '../../util/highlight';
import {
  listSheetRows,
  readWorkbook,
  type SheetTable,
  type WorkbookView,
} from './excelWorkbook';
import { readDocBytes } from './readerFiles';
import { readerMessage } from './errors';
import { SearchBar } from './SearchBar';

const MAX_HITS = 999;
/** 视图的行/列显示上限。超了在顶部明说，不影响提取（提取走另一条路） */
const VIEW_ROWS = 1200;
const VIEW_COLS = 60;

/** 中日韩按两格宽估列宽，否则中文列会挤成一条 */
function visualLen(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    n +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
        ? 2
        : 1;
  }
  return n;
}

function columnWidths(sheet: SheetTable, rows: ReturnType<typeof listSheetRows>): number[] {
  const widths = new Array<number>(Math.min(sheet.cols, VIEW_COLS)).fill(64);
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.col >= widths.length) continue;
      // 只取样一部分单元格即可，全表扫一遍在大表上没必要
      const want = Math.min(28, visualLen(cell.text)) * 7 + 20;
      if (want > widths[cell.col]) widths[cell.col] = want;
    }
  }
  return widths.map((w) => Math.max(64, Math.min(240, w)));
}

interface Hit {
  sheet: number;
  row: number;
  col: number;
}

export function SheetReader({ document: doc }: { document: Document }) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [book, setBook] = useState<WorkbookView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const [hitIndex, setHitIndex] = useState(0);
  const listRef = useRef<FlatList<number>>(null);
  const hRef = useRef<ScrollViewInstance>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    setBook(null);
    setError(null);
    setActive(0);
    setHitIndex(0);
    setQuery('');
    let cancelled = false;
    (async () => {
      try {
        const buf = await readDocBytes(doc.fileUri ?? '');
        const view = readWorkbook(buf);
        if (!cancelled && alive.current) setBook(view);
      } catch (e) {
        if (!cancelled && alive.current) setError(readerMessage(e, '读不了这个表格'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc.fileUri, doc.id, doc.updatedAt]);

  /** 每个工作表的行列表算一次，视图、查找、列宽都复用它 */
  const rowsBySheet = useMemo(
    () => (book ? book.sheets.map((s) => listSheetRows(s)) : []),
    [book],
  );

  const sheet = book?.sheets[active] ?? null;
  const rows = rowsBySheet[active] ?? [];
  const viewRows = rows.length > VIEW_ROWS ? rows.slice(0, VIEW_ROWS) : rows;
  const widths = useMemo(() => (sheet ? columnWidths(sheet, viewRows) : []), [sheet, viewRows]);
  const gridWidth = useMemo(() => 52 + widths.reduce((a, b) => a + b, 0), [widths]);

  /**
   * 查找索引：每张表拼一段文本 + 单元格区间。
   *
   * 只依赖工作簿、不依赖查询词 —— 否则每敲一个字都要把几万个单元格重新拼一遍。
   */
  const searchIndex = useMemo(() => {
    if (!book) return null;
    return book.sheets.map((s) => {
      let text = '';
      const spans: { start: number; end: number; row: number; col: number }[] = [];
      for (const r of listSheetRows(s)) {
        for (const cell of r.cells) {
          const start = text.length;
          text += cell.text;
          spans.push({ start, end: text.length, row: r.row, col: cell.col });
          text += '\n';
        }
      }
      return { text, spans };
    });
  }, [book]);

  const hits = useMemo(() => {
    const q = query.trim();
    if (!searchIndex || !q) return [] as Hit[];
    const out: Hit[] = [];
    for (let s = 0; s < searchIndex.length && out.length < MAX_HITS; s++) {
      const { text, spans } = searchIndex[s];
      const found = findHits(text, q, MAX_HITS - out.length);
      for (const h of found) {
        // 命中的起点落在哪个单元格（跨单元格的匹配归到起点那格）
        let lo = 0;
        let hi = spans.length - 1;
        let at = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (spans[mid].start <= h.start) {
            at = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        if (at >= 0) out.push({ sheet: s, row: spans[at].row, col: spans[at].col });
      }
    }
    return out;
  }, [query, searchIndex]);

  const total = hits.length;
  const shown = total > 0 ? Math.min(hitIndex, total - 1) : 0;
  const current = hits[shown];

  useEffect(() => {
    setHitIndex(0);
  }, [query]);

  /** 单元格下标 → 行在视图里的位置，跳转要按这个来 */
  const rowIndexIn = useCallback(
    (sheetIdx: number, row: number) => {
      const list = rowsBySheet[sheetIdx] ?? [];
      const limit = list.length > VIEW_ROWS ? VIEW_ROWS : list.length;
      for (let i = 0; i < limit; i++) {
        if (list[i].row === row) return i;
      }
      return -1;
    },
    [rowsBySheet],
  );

  /** 跳到某一格：竖滚到行 + 横滚到列。两件都做才算「落到真实位置」 */
  const scrollToCell = useCallback(
    (h: Hit) => {
      const idx = rowIndexIn(h.sheet, h.row);
      if (idx >= 0) {
        try {
          listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.2 });
        } catch {
          /* onScrollToIndexFailed 兜住 */
        }
      }
      const before = widths.slice(0, h.col).reduce((a, b) => a + b, 0);
      hRef.current?.scrollTo({ x: Math.max(0, 52 + before - 60), animated: true });
    },
    [rowIndexIn, widths],
  );

  /** 跳到第 n 处。命中可能在别的工作表，得先切表再滚 */
  const go = useCallback(
    (next: number) => {
      if (!total) return;
      const clamped = Math.min(Math.max(next, 0), total - 1);
      setHitIndex(clamped);
      const h = hits[clamped];
      if (!h) return;
      if (h.sheet !== active) {
        setActive(h.sheet);
        // 换表后 FlatList 是新挂的，等一帧再滚
        setTimeout(() => scrollToCell(h), 140);
        return;
      }
      scrollToCell(h);
    },
    [active, hits, scrollToCell, total],
  );

  if (error) {
    return (
      <View style={styles.state}>
        <Text style={styles.stateTitle}>打不开这个表格</Text>
        <Text style={styles.stateHint}>{error}</Text>
      </View>
    );
  }

  if (!book) {
    return (
      <View style={styles.state}>
        <ActivityIndicator color={c.accent} />
        <Text style={styles.stateHint}>正在读取工作表…</Text>
      </View>
    );
  }

  const q = query.trim();
  const hitCells = new Set(
    hits.filter((h) => h.sheet === active).map((h) => `${h.row},${h.col}`),
  );
  const currentKey = current ? `${current.row},${current.col}` : '';

  return (
    <View style={styles.root}>
      <SearchBar
        value={query}
        onChange={setQuery}
        total={q ? total : -1}
        current={shown + 1}
        note={q ? `全部 ${book.sheets.length} 个工作表` : undefined}
        onPrev={() => go(shown - 1)}
        onNext={() => go(shown + 1)}
        placeholder="在全部工作表里查找"
      />

      {book.sheets.length === 0 ? (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>这个表格里没有工作表</Text>
          <Text style={styles.stateHint}>文件可能是空的，或者结构与 xlsx 不符。</Text>
        </View>
      ) : (
        <>
          <View style={styles.tabsWrap}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
              {book.sheets.map((s, i) => (
                <Pressable
                  key={s.name}
                  onPress={() => setActive(i)}
                  style={[styles.tab, i === active && styles.tabOn]}
                  accessibilityRole="button"
                  accessibilityLabel={`工作表 ${s.name}`}
                >
                  <Text style={[styles.tabText, i === active && styles.tabTextOn]} numberOfLines={1}>
                    {s.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>

          {book.truncated ? (
            <Text style={styles.notice}>
              这张表有超过 {book.limit} 个有效单元格，应用内只读取到上限为止：视图和正文都不会是完整的，
              请用 Excel 打开原件。
            </Text>
          ) : null}
          {sheet && (rows.length > VIEW_ROWS || sheet.cols > VIEW_COLS) ? (
            <Text style={styles.notice}>
              只显示前 {Math.min(VIEW_ROWS, rows.length)} 行、{Math.min(VIEW_COLS, sheet.cols)} 列
              （原表 {rows.length} 行、{sheet.cols} 列）。提取正文时不受这个显示限制。
            </Text>
          ) : null}

          {!sheet || rows.length === 0 ? (
            <View style={styles.state}>
              <Text style={styles.stateTitle}>这个工作表是空的</Text>
              <Text style={styles.stateHint}>没有单元格可以显示。</Text>
            </View>
          ) : (
            <ScrollView
              ref={hRef}
              horizontal
              showsHorizontalScrollIndicator
              style={styles.gridScroll}
              contentContainerStyle={styles.gridContent}
            >
              <View style={{ width: gridWidth, flexGrow: 1 }}>
                <FlatList
                  ref={listRef}
                  data={viewRows.map((r) => r.row)}
                  keyExtractor={(r) => String(r)}
                  style={styles.grid}
                  initialNumToRender={20}
                  maxToRenderPerBatch={20}
                  windowSize={11}
                  removeClippedSubviews
                  onScrollToIndexFailed={(info) => {
                    listRef.current?.scrollToOffset({
                      offset: info.averageItemLength * info.index,
                      animated: false,
                    });
                    setTimeout(() => {
                      listRef.current?.scrollToIndex({
                        index: info.index,
                        animated: true,
                        viewPosition: 0.2,
                      });
                    }, 60);
                  }}
                  renderItem={({ item, index }) => {
                    const row = viewRows[index];
                    const byCol = new Map(row.cells.map((cell) => [cell.col, cell.text]));
                    return (
                      <View style={[styles.tr, index % 2 === 1 && styles.trAlt]}>
                        <View style={styles.gutter}>
                          <Text style={styles.gutterText}>{item + 1}</Text>
                        </View>
                        {widths.map((w, col) => {
                          const key = `${item},${col}`;
                          const text = byCol.get(col) ?? '';
                          const isHit = hitCells.has(key);
                          return (
                            <View key={col} style={[styles.td, { width: w }]}>
                              <Text
                                selectable
                                style={[
                                  styles.cellText,
                                  isHit && styles.cellHit,
                                  key === currentKey && styles.cellCurrent,
                                ]}
                              >
                                {text}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    );
                  }}
                />
              </View>
            </ScrollView>
          )}
        </>
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1 },
  tabsWrap: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hair,
    backgroundColor: c.page,
  },
  tabs: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  tab: {
    maxWidth: 160,
    paddingHorizontal: 12,
    height: 30,
    borderRadius: R.pill,
    backgroundColor: c.hairSoft,
    justifyContent: 'center',
  },
  tabOn: { backgroundColor: c.accentBg },
  tabText: { fontSize: 12.5, color: c.text2 },
  tabTextOn: { color: c.accentText, fontWeight: '600' },

  notice: {
    fontSize: 11.5,
    lineHeight: 18,
    color: c.amberText,
    backgroundColor: c.amberBg,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },

  gridScroll: { flex: 1 },
  gridContent: { flexGrow: 1 },
  grid: { flex: 1 },

  tr: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.hair },
  trAlt: { backgroundColor: c.hairSoft },
  gutter: {
    width: 52,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: c.hair,
    alignItems: 'flex-end',
  },
  gutterText: { fontSize: 10.5, color: c.text3, fontVariant: ['tabular-nums'] },
  td: {
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: c.hair,
  },
  cellText: { fontSize: 12.5, lineHeight: 19, color: c.text },
  cellHit: { backgroundColor: c.amberBg },
  /** 当前这一处再重一档：同一屏里可能有好几处命中，得知道跳到哪一格 */
  cellCurrent: { backgroundColor: c.amberText, color: c.page },

  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  stateTitle: { fontSize: 15, color: c.text, fontWeight: '600' },
  stateHint: { fontSize: 12.5, lineHeight: 19, color: c.text3, textAlign: 'center', maxWidth: 300 },
});
