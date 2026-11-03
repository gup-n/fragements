/**
 * Excel / CSV 的只读解析与切片。**纯函数，不碰文件系统**，所以能拿 node 跑断言。
 *
 * 三个必须守住的点：
 *
 * 1. **不按 `!ref` 遍历。** SheetJS 给的范围来自工作表声明，一个被 Excel
 *    整列刷过格式的空表会声称 `A1:XFD1048576`（一万亿格）。照着它 for 循环
 *    就是死机。这里只遍历真实存在的单元格键（`Object.keys`），并按**实际非空
 *    单元格数**计数、受 `LOCAL_READER_LIMITS.excelCells` 限制。
 * 2. **宽表不丢列。** 展示层（`mdBlocks`）有 8 列上限，那是排版妥协；提取结果
 *    必须把每一列都带上，否则用户问「第 12 列那一栏」时资料里根本没有。
 * 3. **不重算公式。** SheetJS 不算公式，只给 Excel 上次保存的缓存值。
 *    缓存值没有时**显示 `=公式原文`**，让用户看见「这里是个公式」，
 *    而不是显示空白、看起来像原表就是空的。
 */
import * as XLSX from 'xlsx';
import type { DocumentChunkInput, DocumentContentInput, DocumentLocator } from '../../types';
import { LOCAL_READER_LIMITS } from '../formats';
import { assertBody, assertChunkCount } from './chunk';
import { ReaderError } from './errors';

/** 稀疏单元格表。键是 `${row},${col}`（0 起），值是显示文本 */
export interface SheetTable {
  name: string;
  cells: Map<string, string>;
  /** 真实非空单元格撑出来的行数 / 列数（不是 !ref） */
  rows: number;
  cols: number;
  /** 本表统计到的非空格数 */
  cellCount: number;
}

export interface WorkbookView {
  sheets: SheetTable[];
  cellCount: number;
  /** 是否在单元格上限处停下 —— 停下就说明提取不完整，必须明确失败 */
  truncated: boolean;
  limit: number;
}

export interface ReadWorkbookOptions {
  /** 只给断言用（构造超限场景），生产走 LOCAL_READER_LIMITS.excelCells */
  maxCells?: number;
}

/**
 * 单元格显示文本。
 *
 * 优先 `w`（SheetJS 按数字格式生成的文本）：日期在原始值里是序列号 45292，
 * 直接给用户看 "45292" 是没有意义的。`w` 缺失时才按类型回落。
 */
function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return '';
  const w = (cell as { w?: unknown }).w;
  if (typeof w === 'string' && w.length) return w;

  const v = cell.v;
  if (v === null || v === undefined) {
    // 公式没有缓存值：如实显示公式，不假装单元格是空的
    return cell.f ? `=${cell.f}` : '';
  }
  if (cell.t === 'b') return v ? 'TRUE' : 'FALSE';
  if (cell.t === 'd') return v instanceof Date ? v.toISOString() : String(v);
  if (cell.t === 'e') return String(v);
  return String(v);
}

/**
 * 认文件头，判断这坨字节像不像一个真表格。
 *
 * 为什么不能只靠 `XLSX.read` 抛错：SheetJS 认不出格式时会**当纯文本读**，
 * 一张 "not a spreadsheet at all" 的 txt 会解析出名为 Sheet1 的表，正文写着
 * 那句话。用户看到的是「导入成功，内容乱码」，比直接报错还难查。
 * 所以先按魔数分流，认不出来就明确说「这不是表格文件」。
 */
function sniffTableKind(data: ArrayBuffer | Uint8Array): 'zip' | 'cfb' | 'markup' | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 4) return null;

  // xlsx / 含宏的 xlsm 都是 OOXML：ZIP 容器
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip';
  // 老版 xls 是 OLE 复合文档
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'cfb';

  // Excel 2003 XML / 网页另存的 .xls（国内老系统常见）是真表格，SheetJS 也认。
  // 只放行明确的标记开头，不拿「第一个非空字符是 <」当判据 —— 那太松。
  const head = new TextDecoder('utf-8')
    .decode(bytes.subarray(0, 512))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<html') || head.startsWith('<table')) {
    return 'markup';
  }
  return null;
}

/**
 * 解析工作簿成稀疏视图。
 *
 * `dense:false` 是默认的表结构（对象键），只有对象键才能 `Object.keys` 稀疏遍历。
 * `sheetStubs:false` 防止 Excel 里刷过格式的空格变成一堆空单元格对象。
 */
export function readWorkbook(
  data: ArrayBuffer | Uint8Array,
  opts: ReadWorkbookOptions = {},
): WorkbookView {
  const limit = opts.maxCells ?? LOCAL_READER_LIMITS.excelCells;

  if (!sniffTableKind(data)) {
    throw new ReaderError(
      'corrupt',
      '这个文件不是表格：它的内容和 xlsx / xls 都对不上。可能是改了扩展名的其它文件，或者在传输中被截断了。',
    );
  }

  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(data, {
      type: 'array',
      // 只读：不解析样式/VBA/HTML，减少内存与不可控输入面
      cellStyles: false,
      cellHTML: false,
      cellNF: false,
      cellDates: false,
      sheetStubs: false,
      bookVBA: false,
      dense: false,
      // CSV 统一按 UTF-8 解；GBK 的 CSV 会显示乱码，但不会崩，也不会静默改字符
      codepage: 65001,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ReaderError(
      'corrupt',
      `这个表格读不动：${msg}。如果文件设了打开密码，请先在 Excel 里去掉密码再导入。`,
    );
  }

  return workbookToView(book, limit);
}

/**
 * 已解析的工作簿 → 稀疏视图。
 *
 * 单独拆出来是**为了让断言能测**：「不按 !ref 遍历」这条得靠一个声明范围
 * 是整张表的工作表来验，而 SheetJS 自己写出这种表会先卡死（write 时按范围
 * 展开），根本造不出样本文件。直接对着内存里的 WorkBook 跑就没有这个问题。
 */
export function workbookToView(book: XLSX.WorkBook, limit: number): WorkbookView {
  const sheets: SheetTable[] = [];
  let total = 0;
  let truncated = false;

  for (const name of book.SheetNames) {
    const ws = book.Sheets[name];
    if (!ws) continue;

    const cells = new Map<string, string>();
    let rows = 0;
    let cols = 0;
    let count = 0;

    for (const key of Object.keys(ws)) {
      // `!ref` / `!merges` 这类是工作表元数据，不是单元格
      if (key.charCodeAt(0) === 33 /* ! */) continue;
      const text = cellText((ws as Record<string, XLSX.CellObject>)[key]);
      if (!text) continue;
      if (total + count >= limit) {
        truncated = true;
        break;
      }
      // 键就是 "A1" 这种地址，解出 0 起的行列；不依赖 !ref 的范围
      const addr = XLSX.utils.decode_cell(key);
      if (addr.r >= rows) rows = addr.r + 1;
      if (addr.c >= cols) cols = addr.c + 1;
      cells.set(`${addr.r},${addr.c}`, text);
      count++;
    }

    total += count;
    sheets.push({ name, cells, rows, cols, cellCount: count });
    if (truncated) break;
  }

  return { sheets, cellCount: total, truncated, limit };
}

/** 一行在稀疏表里的文本：从最左非空列排到最右非空列，中间空的地方留空串 */
function rowText(sheet: SheetTable, row: number): string {
  const out: string[] = [];
  for (let c = 0; c < sheet.cols; c++) out.push(sheet.cells.get(`${row},${c}`) ?? '');
  // 去掉行尾连续空列，只影响空白，不丢任何有内容的单元格
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join('\t');
}

/** 有内容的行号（0 起），升序。中间的空行不产出切片，但行号仍是真实行号 */
function filledRows(sheet: SheetTable): number[] {
  const set = new Set<number>();
  for (const key of sheet.cells.keys()) {
    set.add(Number(key.slice(0, key.indexOf(','))));
  }
  return [...set].sort((a, b) => a - b);
}

export interface SheetRow {
  /** 0 起的真实行号；界面上显示 +1 */
  row: number;
  cells: { col: number; text: string }[];
}

/**
 * 只读视图要的行列表：只包含**有内容的行**，行号保持原样。
 *
 * 稀疏表里第 2 行后面直接是第 500 行，所以视图必须显示真实行号，
 * 不能按数组下标标 1、2、3 —— 那样用户对着 Excel 找不到位置。
 */
export function listSheetRows(sheet: SheetTable): SheetRow[] {
  return filledRows(sheet).map((row) => {
    const cells: { col: number; text: string }[] = [];
    for (let c = 0; c < sheet.cols; c++) {
      const text = sheet.cells.get(`${row},${c}`);
      if (text) cells.push({ col: c, text });
    }
    return { row, cells };
  });
}

/** 长文本硬切，代理对不切断。和 chunk.ts 里的规则一致 */
function hardSplit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    let end = Math.min(text.length, at + limit);
    if (end < text.length) {
      const high = text.charCodeAt(end - 1);
      if (high >= 0xd800 && high <= 0xdbff) end -= 1;
    }
    if (end <= at) end = Math.min(text.length, at + limit);
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

/**
 * 切成可入库的正文与片段。
 *
 * 超限（`truncated`）直接失败：切一半交上去，用户问的问题落在后半张表里
 * 就会得到「资料里没有」—— 比明确报错糟得多。
 */
export function workbookToContent(view: WorkbookView): DocumentContentInput {
  if (view.truncated) {
    throw new ReaderError(
      'too-many-cells',
      `这张表有超过 ${view.limit} 个有效单元格，超出应用内阅读上限。` +
        '原件仍在本机，可以用 Excel 打开；这篇暂不支持应用内阅读与提问。',
    );
  }

  const parts: string[] = [];
  const chunks: DocumentChunkInput[] = [];
  const limit = LOCAL_READER_LIMITS.chunkChars;

  for (const sheet of view.sheets) {
    if (!sheet.cellCount) continue;
    const rows = filledRows(sheet);
    parts.push(`## ${sheet.name}`);

    let buf: string[] = [];
    let bufLen = 0;
    let rowStart = 0;
    let rowEnd = 0;

    const flush = () => {
      if (!buf.length) return;
      const locator: DocumentLocator = {
        kind: 'sheet',
        sheet: sheet.name,
        rowStart,
        rowEnd,
      };
      chunks.push({ text: buf.join('\n'), locator });
      // bodyMd 里紧跟在这些行后面，顺序与切片一致
      parts.push(buf.join('\n'));
      buf = [];
      bufLen = 0;
    };

    for (const row of rows) {
      const text = rowText(sheet, row);
      if (!text) continue;

      if (text.length > limit) {
        flush();
        for (const piece of hardSplit(text, limit)) {
          chunks.push({
            text: piece,
            locator: { kind: 'sheet', sheet: sheet.name, rowStart: row + 1, rowEnd: row + 1 },
          });
          parts.push(piece);
        }
        continue;
      }

      if (buf.length && bufLen + 1 + text.length > limit) flush();
      if (!buf.length) rowStart = row + 1;
      bufLen += (buf.length ? 1 : 0) + text.length;
      buf.push(text);
      rowEnd = row + 1;
    }
    flush();
  }

  const bodyMd = parts.join('\n\n');
  assertBody(bodyMd);
  assertChunkCount(chunks.length);

  return { bodyMd, chunks, source: 'excel', pages: null };
}
