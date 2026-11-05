/**
 * 表格视图的「列窗口」计算。
 *
 * 单独抽成纯函数，是因为分列渲染最容易出的错不是崩，而是**左右占位加起来
 * 和总宽对不上** —— 表现是横向滚动到某处突然跳一下，或者列与列之间多出一段
 * 空白。这种错在真机上要滚很久才看得见，肉眼看不出是哪一列算错了；
 * 放到 node 里就能直接把不变量断言出来（`assert_readers.cjs` 里有）。
 *
 * 行号列（gutter）是定宽且不参与横向滚动的，所以所有偏移都从 gutter 之后算起。
 */

/** 行号列宽。必须和 `SheetReader` 里 `styles.gutter` 的 width 一致 */
export const SHEET_GUTTER = 52;

/** 每列的左边界（相对内容左侧，已包含 gutter） */
export function columnOffsets(widths: number[], gutter: number = SHEET_GUTTER): number[] {
  const out = new Array<number>(widths.length);
  let x = gutter;
  for (let i = 0; i < widths.length; i++) {
    out[i] = x;
    x += widths[i];
  }
  return out;
}

/**
 * 当前视口应该渲染 `[start, end)` 这一段列。
 *
 * 两侧各留 `overscan`：横向滑动时下一列已经在屏幕外画好了，滚过去不会先白一下。
 */
export function visibleColumns(
  offsets: number[],
  widths: number[],
  scrollX: number,
  viewport: number,
  overscan: number,
): { start: number; end: number } {
  const n = widths.length;
  if (!n) return { start: 0, end: 0 };

  const left = scrollX - overscan;
  const right = scrollX + viewport + overscan;

  // 第一列「右边界越过左界限」的列。offsets 递增、widths 为正，谓词单调，可以二分
  let lo = 0;
  let hi = n - 1;
  let start = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] + widths[mid] > left) {
      start = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  // 最后一列「左边界还在右界限内」的列
  lo = start;
  hi = n - 1;
  let end = start + 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < right) {
      end = mid + 1;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (end <= start) end = start + 1;
  return { start, end };
}

/**
 * 行内左右占位的宽度。
 *
 * 不变量：`left + 窗口内各列宽之和 + right === gridWidth - gutter`。
 * 破了这条，横向滚动范围就会变，列也会错位。
 */
export function spacerWidths(
  offsets: number[],
  widths: number[],
  start: number,
  end: number,
  gridWidth: number,
  gutter: number = SHEET_GUTTER,
): { left: number; right: number } {
  const n = widths.length;
  if (!n) return { left: 0, right: 0 };
  const s = Math.max(0, Math.min(start, n - 1));
  const e = Math.max(s + 1, Math.min(end, n));
  const left = Math.max(0, offsets[s] - gutter);
  const lastRight = offsets[e - 1] + widths[e - 1];
  return { left, right: Math.max(0, gridWidth - lastRight) };
}
