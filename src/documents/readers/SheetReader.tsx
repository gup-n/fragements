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
 *
 * v0.12.1 起这一页的三处开销被砍掉（原因见 CHANGELOG）：
 * - 解析结果按文件缓存，退出再进来不再重解析；
 * - 搜索索引推迟到真正输入时才建（以前一开屏就给每个单元格建一个 span 对象）；
 * - 只物化当前工作表，列按视口窗口渲染（以前一屏最多 20 行 × 60 列 = 1200 个节点）。
 *
 * v0.14.0 起缓存不只在内存里：解析结果会落盘，**重启 App 之后再打开也不用重解析**。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import type { Document } from '../../types';
import { SPACE, TYPE, surfaceStroke, useTheme, useThemedStyles, type Palette, type ThemeMetrics } from '../../theme';
import { BusyIndicator as ActivityIndicator } from '../../components/BusyIndicator';
import { findHits } from '../../util/highlight';
import { visualLen } from '../../util/text';
import {
  listSheetRows,
  readWorkbook,
  type SheetRow,
  type SheetTable,
  type WorkbookView,
} from './excelWorkbook';
import { readDocBytes } from './readerFiles';
import { readerMessage, formatSize } from './errors';
import { recallWorkbook, rememberWorkbook, workbookKey } from './workbookCache';
import { readViewCache, writeViewCache } from './viewCache';
import { SHEET_GUTTER, columnOffsets, spacerWidths, visibleColumns } from './sheetWindow';
import { SearchBar } from './SearchBar';

const MAX_HITS = 999;
/** 视图的行/列显示上限。超了在顶部明说，不影响提取（提取走另一条路） */
const VIEW_ROWS = 1200;
const VIEW_COLS = 60;
/** 列窗口两侧多画几列，横向滑动时不会先看到一块空白 */
const COL_OVERSCAN = 240;

function columnWidths(sheet: SheetTable, rows: SheetRow[]): number[] {
  const widths = new Array<number>(Math.min(sheet.cols, VIEW_COLS)).fill(64);
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.col >= widths.length) continue;
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

interface SearchEntry {
  text: string;
  spans: { start: number; end: number; row: number; col: number }[];
}

/** 建索引的结果绑在具体的 `book` 上：换文件即失效，不需要额外的清空动作 */
interface BuiltIndex {
  book: WorkbookView;
  entries: SearchEntry[];
}

interface RowProps {
  row: SheetRow;
  alt: boolean;
  widths: number[];
  offsets: number[];
  start: number;
  end: number;
  gridWidth: number;
  hitCells: Set<string>;
  currentKey: string;
  styles: ReturnType<typeof makeStyles>;
}

/**
 * 一行。**只画窗口内的列**，两边用空白占位撑出原始宽度。
 *
 * 用游标而不是 Map：`row.cells` 天生按列升序（`listSheetRows` 就是这么造的），
 * 一行一次线性推进就够，省掉每行一个 Map 的分配。
 */
const SheetRowView = React.memo(function SheetRowView({
  row,
  alt,
  widths,
  offsets,
  start,
  end,
  gridWidth,
  hitCells,
  currentKey,
  styles,
}: RowProps) {
  const { left, right } = spacerWidths(offsets, widths, start, end, gridWidth);
  const cells: React.ReactNode[] = [];
  let cursor = 0;

  for (let col = start; col < end; col++) {
    while (cursor < row.cells.length && row.cells[cursor].col < col) cursor++;
    const text = row.cells[cursor]?.col === col ? row.cells[cursor].text : '';
    const key = `${row.row},${col}`;
    const isHit = hitCells.size > 0 && hitCells.has(key);
    cells.push(
      <View key={col} style={[styles.td, { width: widths[col] }]}>
        <Text
          selectable
          accessibilityLabel={key === currentKey ? `当前命中，第 ${row.row + 1} 行，第 ${col + 1} 列：${text}` : undefined}
          style={[styles.cellText, isHit && styles.cellHit, key === currentKey && styles.cellCurrent]}
        >
          {text}
        </Text>
        {key === currentKey ? <View pointerEvents="none" style={styles.currentOutline} /> : null}
      </View>,
    );
  }

  return (
    <View style={[styles.tr, alt && styles.trAlt]}>
      <View style={styles.gutter}>
        <Text style={styles.gutterText}>{row.row + 1}</Text>
      </View>
      {left > 0 ? <View style={{ width: left }} /> : null}
      {cells}
      {right > 0 ? <View style={{ width: right }} /> : null}
    </View>
  );
});

export function SheetReader({ document: doc }: { document: Document }) {
  const { c, styles } = useThemedStyles(makeStyles);
  const { reduceMotion } = useTheme();
  const { width: viewWidth } = useWindowDimensions();
  const [book, setBook] = useState<WorkbookView | null>(null);
  const [phase, setPhase] = useState<'reading' | 'parsing'>('reading');
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const [hitIndex, setHitIndex] = useState(0);
  const [built, setBuilt] = useState<BuiltIndex | null>(null);
  const [scrollX, setScrollX] = useState(0);
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
    setPhase('reading');
    setError(null);
    setActive(0);
    setHitIndex(0);
    setQuery('');
    setBuilt(null);
    setScrollX(0);
    let cancelled = false;

    const key = workbookKey(doc.fileUri, doc.size);
    const uri = doc.fileUri ?? '';
    (async () => {
      try {
        // 命中内存缓存就直接出图：这是「退出再进来」的常见路径，不该再解析一遍
        const cached = recallWorkbook(key);
        if (cached) {
          if (!cancelled && alive.current) setBook(cached);
          return;
        }

        /*
         * 磁盘上的那份解析结果。走这条路时**原件连读都不读** ——
         * 一张 4 MB 的表光是读成 ArrayBuffer 再交给 SheetJS 就是几百毫秒，
         * 而上次解析出来的东西一直躺在旁边。重启 App 之后仍然有效。
         */
        const onDisk = await readViewCache(doc.fileUri, doc.size);
        if (cancelled || !alive.current) return;
        if (onDisk) {
          rememberWorkbook(key, onDisk);
          setBook(onDisk);
          return;
        }

        const buf = await readDocBytes(uri);
        if (cancelled || !alive.current) return;

        /*
         * `XLSX.read` 是同步的，进去就交不出主线程。先让「正在解析 3.7 MB」
         * 这一帧画出来，再进解析 —— 否则用户看到的是一个不动的圈，
         * 分不清是在读还是在等死。`setTimeout(0)` 是真的让出一次事件循环，
         * `await` 一个已 resolve 的 Promise 只会走微任务，画不了帧。
         */
        setPhase('parsing');
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (cancelled || !alive.current) return;

        const view = readWorkbook(buf);
        rememberWorkbook(key, view);
        if (!cancelled && alive.current) setBook(view);

        /*
         * 落盘放在首屏之后：一张 10 万格的表要写 1.9 MB，和第一帧抢同一个
         * JS 线程不值得。这里不 await，也不管成败 —— 缓存写不进去最多是
         * 下次再解析一次，不能影响这次阅读。
         */
        setTimeout(() => {
          void writeViewCache(doc.fileUri, doc.size, view);
        }, 300);
      } catch (e) {
        if (!cancelled && alive.current) setError(readerMessage(e, '读不了这个表格'));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc.fileUri, doc.id, doc.size]);

  /**
   * 每张表的行列表**按需**物化。
   *
   * 以前一开屏就把所有工作表都算出来（`searchIndex` 里又算了一遍），
   * 10 万格的表光这一项就是两次全量 Map 查找。现在只有当前表会算，
   * 切表时才算下一张，搜索时才把全部算出来（反正那时候也要用）。
   */
  const rowCache = useMemo(() => new Map<number, SheetRow[]>(), [book]);
  const rowsOf = useCallback(
    (index: number): SheetRow[] => {
      if (!book) return [];
      const hit = rowCache.get(index);
      if (hit) return hit;
      const sheet = book.sheets[index];
      const next = sheet ? listSheetRows(sheet) : [];
      rowCache.set(index, next);
      return next;
    },
    [book, rowCache],
  );

  const sheet = book?.sheets[active] ?? null;
  const rows = useMemo(() => rowsOf(active), [rowsOf, active]);
  const viewRows = useMemo(() => (rows.length > VIEW_ROWS ? rows.slice(0, VIEW_ROWS) : rows), [rows]);
  const rowKeys = useMemo(() => viewRows.map((r) => r.row), [viewRows]);
  const widths = useMemo(() => (sheet ? columnWidths(sheet, viewRows) : []), [sheet, viewRows]);
  const gridWidth = useMemo(
    () => SHEET_GUTTER + widths.reduce((a, b) => a + b, 0),
    [widths],
  );
  const offsets = useMemo(() => columnOffsets(widths), [widths]);

  const win = useMemo(
    () => visibleColumns(offsets, widths, scrollX, viewWidth, COL_OVERSCAN),
    [offsets, widths, scrollX, viewWidth],
  );
  const winRef = useRef(win);
  winRef.current = win;

  /*
   * 换表：横向回到最左。
   *
   * 在**渲染期**归零而不是等 effect：effect 跑在提交之后，那一帧已经用上一张表的
   * `scrollX` 算过窗口了，切过去会先闪一下最右边那几列。渲染期 setState 会被 React
   * 丢弃并立刻用新值重渲染，这一帧就不会提交。ref 先更新，所以不会死循环。
   */
  const lastSheet = useRef(sheet);
  if (lastSheet.current !== sheet) {
    lastSheet.current = sheet;
    setScrollX(0);
  }

  useEffect(() => {
    hRef.current?.scrollTo({ x: 0, animated: false });
  }, [sheet]);

  /** 只有「窗口变了」才 setState —— 每一帧滚动都重渲染等于把省下的又还回去 */
  const onGridScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = e.nativeEvent.contentOffset.x;
      const next = visibleColumns(offsets, widths, x, viewWidth, COL_OVERSCAN);
      const cur = winRef.current;
      if (next.start === cur.start && next.end === cur.end) return;
      setScrollX(x);
    },
    [offsets, widths, viewWidth],
  );

  const index = built && built.book === book ? built.entries : null;

  /**
   * 搜索索引**推迟到用户真的开始查**。
   *
   * 以前它是随文档一起建的：10 万格 = 10 万个 span 对象，用户可能这辈子都
   * 不搜一次。放在定时器里而不是直接算，是为了让刚敲下的那个字先上屏。
   */
  useEffect(() => {
    if (!book || index) return;
    if (!query.trim()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      const entries: SearchEntry[] = book.sheets.map((_, si) => {
        let text = '';
        const spans: SearchEntry['spans'] = [];
        for (const r of rowsOf(si)) {
          for (const cell of r.cells) {
            const start = text.length;
            text += cell.text;
            spans.push({ start, end: text.length, row: r.row, col: cell.col });
            text += '\n';
          }
        }
        return { text, spans };
      });
      setBuilt({ book, entries });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [book, index, query, rowsOf]);

  const hits = useMemo(() => {
    const q = query.trim();
    if (!index || !q) return [] as Hit[];
    const out: Hit[] = [];
    for (let s = 0; s < index.length && out.length < MAX_HITS; s++) {
      const { text, spans } = index[s];
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
  }, [query, index]);

  const total = hits.length;
  const shown = total > 0 ? Math.min(hitIndex, total - 1) : 0;
  const current = hits[shown];

  useEffect(() => {
    setHitIndex(0);
  }, [query]);

  /** 真实行号 → 视图下标。跳转要用，做成一次 Map 而不是每次线性扫 */
  const rowIndexIn = useMemo(() => {
    const map = new Map<number, number>();
    viewRows.forEach((r, i) => map.set(r.row, i));
    return map;
  }, [viewRows]);

  /** 跳到某一格：竖滚到行 + 横滚到列。两件都做才算「落到真实位置」 */
  const scrollToCell = useCallback(
    (h: Hit) => {
      const idx = rowIndexIn.get(h.row) ?? -1;
      if (idx >= 0) {
        try {
          listRef.current?.scrollToIndex({ index: idx, animated: !reduceMotion, viewPosition: 0.2 });
        } catch {
          /* onScrollToIndexFailed 兜住 */
        }
      }
      // 目标列左边界再往左留 60：命中格不会贴着屏幕右缘。
      // 必须夹到最大滚动量上：ScrollView 会自己夹，但这里的 scrollX 不会，
      // 不夹的话窗口会按一个滚不到的位置算，目标列就被算到窗口左边、高亮不出现
      const maxX = Math.max(0, gridWidth - viewWidth);
      const x = Math.min(maxX, Math.max(0, (offsets[h.col] ?? SHEET_GUTTER) - 60));
      hRef.current?.scrollTo({ x, animated: !reduceMotion });
      // 横向是动画滚过去的，窗口要立刻跟上，否则高亮要等动画结束才出现
      setScrollX(x);
    },
    [rowIndexIn, offsets, gridWidth, viewWidth, reduceMotion],
  );

  /**
   * 跨表跳转要读**切表之后**的 `offsets` / `rowIndexIn`。
   *
   * `go` 在 `setActive` 那一刻就把当时的 `scrollToCell` 闭包逮住了，140 ms 后
   * 执行的是上一张表的列宽 —— 横向会滚到一个毫无关系的位置。旧版也是这样，
   * 只是那时列不加窗口，错了也不明显。用 ref 拿最新的那份。
   */
  const scrollToCellRef = useRef(scrollToCell);
  scrollToCellRef.current = scrollToCell;

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
        setTimeout(() => scrollToCellRef.current(h), 140);
        return;
      }
      scrollToCell(h);
    },
    [active, hits, scrollToCell, total],
  );

  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    if (hits.length) goRef.current(0);
  }, [hits]);

  const hitCells = useMemo(() => {
    const set = new Set<string>();
    for (const h of hits) if (h.sheet === active) set.add(`${h.row},${h.col}`);
    return set;
  }, [hits, active]);

  const currentKey = current?.sheet === active ? `${current.row},${current.col}` : '';

  /*
   * 换表那一帧，`win` 还是按上一张表的列宽算的（重置 scrollX 的 effect 在提交后才跑），
   * 所以这里夹一次，避免 `widths[col]` 越界取到 undefined —— 那会让单元格宽度变成 auto，
   * 一闪而过但确实会跳一下。
   */
  const colStart = Math.min(win.start, Math.max(0, widths.length - 1));
  const colEnd = Math.min(win.end, widths.length);

  const renderRow = useCallback(
    ({ index }: { index: number }) => (
      <SheetRowView
        row={viewRows[index]}
        alt={index % 2 === 1}
        widths={widths}
        offsets={offsets}
        start={colStart}
        end={colEnd}
        gridWidth={gridWidth}
        hitCells={hitCells}
        currentKey={currentKey}
        styles={styles}
      />
    ),
    [viewRows, widths, offsets, colStart, colEnd, gridWidth, hitCells, currentKey, styles],
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
        <Text style={styles.stateHint}>
          {phase === 'parsing' ? `正在解析 ${formatSize(doc.size)} 的表格…` : '正在读取文件…'}
        </Text>
        {phase === 'parsing' ? (
          <Text style={styles.stateTip}>大表格要几秒，解析完会立刻显示，期间点按没反应是正常的。</Text>
        ) : null}
      </View>
    );
  }

  const q = query.trim();

  return (
    <View style={styles.root}>
      <SearchBar
        value={query}
        onChange={setQuery}
        total={q && !index ? -1 : q ? total : -1}
        current={total ? shown + 1 : 0}
        busy={!!q && !index}
        note={current
          ? `${book.sheets[current.sheet]?.name ?? '工作表'} · 第 ${current.row + 1} 行，第 ${current.col + 1} 列`
          : q ? `全部 ${book.sheets.length} 个工作表` : undefined}
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
                  accessibilityRole="tab"
                  accessibilityLabel={`工作表 ${s.name}`}
                  accessibilityState={{ selected: i === active }}
                >
                  <Text style={[styles.tabText, i === active && styles.tabTextOn]}>
                    {i === active ? '✓ ' : ''}{s.name}
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

          {current?.sheet === active && (!rowIndexIn.has(current.row) || current.col >= widths.length) ? (
            <Text style={styles.notice}>当前命中在第 {current.row + 1} 行、第 {current.col + 1} 列，超出本页显示范围。请用「打开原件」查看，不会把未显示的单元格当作已读。</Text>
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
              onScroll={onGridScroll}
              scrollEventThrottle={32}
              style={styles.gridScroll}
              contentContainerStyle={styles.gridContent}
            >
              <View style={{ width: gridWidth, flexGrow: 1 }}>
                <FlatList
                  ref={listRef}
                  data={rowKeys}
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
                        animated: !reduceMotion,
                        viewPosition: 0.2,
                      });
                    }, 60);
                  }}
                  renderItem={renderRow}
                />
              </View>
            </ScrollView>
          )}
        </>
      )}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  root: { flex: 1 },
  tabsWrap: { borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair, backgroundColor: c.page },
  tabs: { paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.xs, gap: SPACE.xs },
  tab: {
    maxWidth: 220, minWidth: metrics.controlHeight, minHeight: metrics.controlHeight,
    paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderRadius: metrics.buttonRadius,
    borderWidth: surfaceStroke(metrics), borderColor: c.hair, backgroundColor: c.card, justifyContent: 'center',
  },
  /** 选中只换颜色，不换宽度，也不用 `focus`（墨水主题是纯黑，会变成一个黑框） */
  tabOn: { backgroundColor: c.accentBg, borderColor: c.accentHair },
  tabText: { ...TYPE.body, color: c.text2 },
  tabTextOn: { color: c.accentText, fontWeight: '600' },
  notice: { ...TYPE.body, color: c.amberText, backgroundColor: c.amberBg, paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.sm },
  gridScroll: { flex: 1 },
  gridContent: { flexGrow: 1 },
  grid: { flex: 1 },
  tr: { flexDirection: 'row', borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair },
  trAlt: { backgroundColor: c.hairSoft },
  gutter: { width: SHEET_GUTTER, paddingHorizontal: SPACE.xs, paddingVertical: SPACE.sm, borderRightWidth: metrics.strokeWidth, borderRightColor: c.hair, alignItems: 'flex-end' },
  gutterText: { ...TYPE.meta, color: c.text2, fontVariant: ['tabular-nums'] },
  td: { paddingHorizontal: SPACE.xs, paddingVertical: SPACE.sm, borderRightWidth: surfaceStroke(metrics), borderRightColor: c.hair },
  cellText: { ...TYPE.body, color: c.text },
  cellHit: { backgroundColor: c.amberBg },
  cellCurrent: { textDecorationLine: 'underline', fontWeight: '700' },
  currentOutline: { position: 'absolute', top: 1, left: 1, right: 1, bottom: 1, borderWidth: 2, borderColor: c.focus },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl, gap: SPACE.sm },
  stateTitle: { ...TYPE.heading, color: c.text, textAlign: 'center' },
  stateHint: { ...TYPE.body, color: c.text2, textAlign: 'center', maxWidth: 360 },
  stateTip: { ...TYPE.body, color: c.text2, textAlign: 'center', maxWidth: 360 },
});
