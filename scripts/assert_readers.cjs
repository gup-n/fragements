#!/usr/bin/env node
/**
 * 阅读器纯逻辑断言。**不联网、不调用任何 AI、不需要模拟器。**
 *
 * 覆盖的是「跑在 node 里就能证明」的那部分：
 *   - 切片不漏末尾、单片不超长、超限明确失败；
 *   - 稀疏表 `A1:XFD1048576` 不会把进程拖死；
 *   - 宽表不裁列、行号是真实行号；
 *   - locator 的形状和 `formats.locatorLabel` 对得上；
 *   - TXT 编码判定、空文本合法。
 *
 * 跑不起来的那部分必须在报告里显式标注「未验证」：WebView 里的 PDF.js 渲染、
 * 查找高亮、跳转定位，只有真机装 APK 才能验。**不要用「断言通过」冒充它们验过了。**
 *
 * 用法：node scripts/assert_readers.cjs
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.tmp-assert-readers');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}：${e && e.message ? e.message : e}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
  }
}

/** 去掉所有空白后比较：切片允许在边界上少几个空行，但不许少一个字符 */
function squish(s) {
  return s.replace(/\s+/g, '');
}

function hasLoneSurrogate(s) {
  return /[\uD800-\uDBFF]$/.test(s) || /^[\uDC00-\uDFFF]/.test(s);
}

// ---------------------------------------------------------------------------
// 编译纯函数模块（和 test:md 同样的做法：只编需要的几个文件，跑完删掉）
// ---------------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true });
/**
 * 直接调 typescript 自己的入口，不走 `npx`：
 * Windows 上 `npx` 要走 shell，某些环境下会把子进程信号带偏（实测被杀且没有输出）。
 */
const tscArgs = [
  require.resolve('typescript/bin/tsc'),
  '--ignoreConfig',
  'src/documents/readers/chunk.ts',
  'src/documents/readers/textDecode.ts',
  'src/documents/readers/excelWorkbook.ts',
  'src/documents/readers/sheetWindow.ts',
  'src/documents/readers/workbookCache.ts',
  'src/documents/readers/textBlocks.ts',
  'src/documents/readers/color.ts',
  '--rootDir',
  'src',
  '--outDir',
  path.relative(root, outDir),
  '--module',
  'commonjs',
  '--target',
  'es2020',
  '--moduleResolution',
  'node',
  '--skipLibCheck',
  '--esModuleInterop',
  '--ignoreDeprecations',
  '6.0',
];

try {
  execFileSync(process.execPath, tscArgs, { cwd: root, stdio: 'inherit' });
} catch {
  console.error('\n✗ tsc 编译失败，断言没有运行');
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

const chunk = require(path.join(outDir, 'documents', 'readers', 'chunk.js'));
const decode = require(path.join(outDir, 'documents', 'readers', 'textDecode.js'));
const excel = require(path.join(outDir, 'documents', 'readers', 'excelWorkbook.js'));
const sheetWindow = require(path.join(outDir, 'documents', 'readers', 'sheetWindow.js'));
const wbCache = require(path.join(outDir, 'documents', 'readers', 'workbookCache.js'));
const textBlocks = require(path.join(outDir, 'documents', 'readers', 'textBlocks.js'));
const color = require(path.join(outDir, 'documents', 'readers', 'color.js'));
const formats = require(path.join(outDir, 'documents', 'formats.js'));
const XLSX = require('xlsx');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

const LIMIT = formats.LOCAL_READER_LIMITS.chunkChars;

// ---------------------------------------------------------------------------
// 1. 纯文本 / Markdown 切片
// ---------------------------------------------------------------------------

check('短文本切成一片，locator 是真实行号', () => {
  const c = chunk.contentFromText('第一行\n第二行\n第三行');
  eq(c.source, 'text', 'source');
  eq(c.pages, null, 'pages');
  eq(c.chunks.length, 1, '片数');
  eq(c.chunks[0].locator.kind, 'text', 'locator.kind');
  eq(c.chunks[0].locator.lineStart, 1, 'lineStart');
  eq(c.chunks[0].locator.lineEnd, 3, 'lineEnd');
  eq(c.chunks[0].text, '第一行\n第二行\n第三行', '片文本');
});

check('空文本是合法的空正文，不是错误', () => {
  const c = chunk.contentFromText('');
  eq(c.bodyMd, '', 'bodyMd');
  eq(c.chunks.length, 0, '片数');
});

check('只有空白的文本也不炸', () => {
  const c = chunk.contentFromText('\n\n   \n\n');
  eq(c.bodyMd, '\n\n   \n\n', 'bodyMd 原样保留');
  eq(c.chunks.length, 0, '没有可切的文字');
});

check('切片不漏末尾（最后一小段必须有片）', () => {
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(`第 ${i + 1} 行的内容，用来把正文撑过一片的上限。`);
  const text = lines.join('\n') + '\n最后的尾巴 END-OF-DOC';
  const c = chunk.contentFromText(text);
  assert(c.chunks.length > 1, '这段文本应该不止一片');
  const last = c.chunks[c.chunks.length - 1];
  assert(last.text.includes('END-OF-DOC'), '最后一片里没有末尾内容');
  // 全部切片按顺序拼起来，非空白字符一个不少
  eq(squish(c.chunks.map((x) => x.text).join('')), squish(text), '正文有丢失');
});

check('每片都不超过 chunkChars', () => {
  const text = Array.from({ length: 300 }, (_, i) => `第 ${i} 段：` + '内容'.repeat(30)).join('\n');
  const c = chunk.contentFromText(text);
  for (const s of c.chunks) {
    assert(s.text.length <= LIMIT, `有一片是 ${s.text.length} 字，超过 ${LIMIT}`);
  }
});

check('超长单行被硬切，行号仍是同一行', () => {
  const line = 'x'.repeat(10_000);
  const c = chunk.contentFromText(line);
  eq(c.chunks.length, 3, '10000 / 4000 应该是 3 片');
  for (const s of c.chunks) {
    assert(s.text.length <= LIMIT, '单片超长');
    eq(s.locator.lineStart, 1, 'lineStart');
    eq(s.locator.lineEnd, 1, 'lineEnd');
  }
  eq(c.chunks.map((s) => s.text).join(''), line, '硬切后拼不回原文');
});

check('硬切不切断代理对（emoji 不会变成两个乱码）', () => {
  const text = 'a'.repeat(3999) + '😀'.repeat(300);
  const c = chunk.contentFromText(text);
  for (const s of c.chunks) {
    assert(!hasLoneSurrogate(s.text), '有一片断在代理对中间');
  }
});

check('超过 bodyChars 明确失败，不截断', () => {
  const big = 'a'.repeat(formats.LOCAL_READER_LIMITS.bodyChars + 1);
  let err = null;
  try {
    chunk.contentFromText(big);
  } catch (e) {
    err = e;
  }
  assert(err, '应该抛错');
  eq(err.code, 'too-long', '错误码');
  assert(err.message.includes('上限'), '错误消息要说明超了上限');
});

check('片数超限明确失败', () => {
  let err = null;
  try {
    chunk.assertChunkCount(formats.LOCAL_READER_LIMITS.chunks + 1);
  } catch (e) {
    err = e;
  }
  assert(err, '应该抛错');
  eq(err.code, 'too-many-chunks', '错误码');
});

check('Markdown 带章节与真实行号', () => {
  const body = ['# 报销', '', '第一段内容', '', '## 子节', '第二段内容'].join('\n');
  const c = chunk.contentFromText(body, 'markdown');
  eq(c.source, 'markdown', 'source');
  eq(c.chunks[0].locator.kind, 'markdown', 'locator.kind');
  eq(c.chunks[0].locator.section, '报销', 'section 应取最近的 `#` 标题');
  eq(c.chunks[0].locator.lineStart, 1, 'lineStart');
});

check('Markdown 的 [F12] 原样保留（不当引用标记吃掉）', () => {
  const c = chunk.contentFromText('# 标题\n\n见 [F12] 与 [W3]', 'markdown');
  assert(c.bodyMd.includes('[F12]'), 'bodyMd 里丢了 [F12]');
  assert(c.chunks[0].text.includes('[F12]'), '切片里丢了 [F12]');
  assert(c.chunks[0].text.includes('[W3]'), '切片里丢了 [W3]');
});

check('旧正文（legacy）按 markdown 定位，不猜原文件位置', () => {
  const c = chunk.contentFromText('## 旧缓存\n正文', 'legacy');
  eq(c.chunks[0].locator.kind, 'markdown', 'locator.kind');
  eq(c.chunks[0].locator.page, undefined, '不许有页码');
});

// ---------------------------------------------------------------------------
// 2. 文本编码判定
// ---------------------------------------------------------------------------

check('正常中文文本不误报', () => {
  eq(decode.textEncodingProblem('这是一个正常的中文段落，带标点。'), null, '不该报编码问题');
  eq(decode.textEncodingProblem(''), null, '空文本不算问题');
});

check('NUL 字节判为 UTF-16 / 二进制', () => {
  const p = decode.textEncodingProblem('a\u0000b\u0000c');
  assert(p && p.code === 'encoding', '应判为编码问题');
  assert(p.message.includes('UTF-16') || p.message.includes('NUL'), '消息要能指导用户');
});

check('大量替换字符判为 GBK 之类', () => {
  const p = decode.textEncodingProblem('\uFFFD'.repeat(50) + '正常文字');
  assert(p && p.code === 'encoding', '应判为编码问题');
  assert(p.message.includes('GBK') || p.message.includes('UTF-8'), '消息要说明该怎么另存');
});

check('BOM 会被剥掉', () => {
  eq(decode.stripBom('\uFEFFabc'), 'abc', 'BOM');
  eq(decode.stripBom('abc'), 'abc', '无 BOM');
});

// ---------------------------------------------------------------------------
// 3. Excel
// ---------------------------------------------------------------------------

function makeBook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const { name, aoa, ref } of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (ref) ws['!ref'] = ref;
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

check('宽表不丢列（20 列全在正文和切片里）', () => {
  const header = Array.from({ length: 20 }, (_, i) => `列${i + 1}`);
  const row = Array.from({ length: 20 }, (_, i) => `值${i + 1}`);
  const buf = makeBook([{ name: '宽表', aoa: [header, row] }]);
  const view = excel.readWorkbook(buf);
  eq(view.sheets[0].cols, 20, '列数');
  const content = excel.workbookToContent(view);
  assert(content.bodyMd.includes('列20'), '正文里没有第 20 列');
  assert(content.bodyMd.includes('值20'), '正文里没有第 20 列的数据');
  assert(content.chunks[0].text.includes('值20'), '切片里没有第 20 列');
});

check('稀疏 !ref 不会把进程拖死（只认真实单元格）', () => {
  const ws = XLSX.utils.aoa_to_sheet([['A'], [''], ['', '', 'C']]);
  // 内存里伪造「整张表都被刷过格式」：SheetJS 会为 [''] 造出 A2/A3/B3 三个空串单元格，
  // 空串不算内容，所以有内容的只有 A1 和 C3。
  // **不写成文件**：XLSX.write 会按 !ref 展开，写这种表自己就会卡死（实测 >120s），
  // 用它造样本等于用一个 bug 去测另一个 bug。
  ws['!ref'] = 'A1:XFD1048576';
  const book = { SheetNames: ['稀疏'], Sheets: { 稀疏: ws } };

  const started = Date.now();
  const view = excel.workbookToView(book, 10000);
  const cost = Date.now() - started;
  assert(cost < 2000, `解析花了 ${cost}ms，说明还在按 !ref 遍历`);
  eq(view.cellCount, 2, '只该数到 2 个有内容的单元格（A1、C3）');
  eq(view.sheets[0].rows, 3, '行数来自真实单元格');
  eq(view.sheets[0].cols, 3, '列数来自真实单元格');
});

/*
 * 上一项验的是「我们自己不按 !ref 遍历」。这一项验的是**解析器那边**：
 * v0.14.0 换成 `dense:true`（二维数组）之后，一份声明范围是整张表的真实文件
 * 会不会被按范围预分配 —— 那才是真正的内存炸弹，一万亿格。
 * 做法：正常写一份小文件，把里面那行 `<dimension ref>` 改成整张表，再读回来。
 */
check('dense 模式下声明范围是整张表也不按范围分配', () => {
  const raw = makeBook([{ name: '表', aoa: [['甲', '', '丙']] }]);
  const files = unzipSync(new Uint8Array(raw));
  const sheetPath = Object.keys(files).find((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));
  assert(sheetPath, '应该能在 zip 里找到工作表 XML');
  const patchedXml = strFromU8(files[sheetPath]).replace(
    /<dimension ref="[^"]*"\/>/,
    '<dimension ref="A1:XFD1048576"/>',
  );
  assert(patchedXml.includes('XFD1048576'), 'dimension 没被改掉，样本无效');
  files[sheetPath] = strToU8(patchedXml);

  const started = Date.now();
  const book = XLSX.read(zipSync(files), {
    type: 'array',
    dense: true,
    cellStyles: false,
    cellHTML: false,
    cellNF: false,
    sheetStubs: false,
  });
  const cost = Date.now() - started;
  assert(cost < 2000, `解析花了 ${cost}ms，说明按 !ref 展开分配了`);

  const data = book.Sheets['表']['!data'];
  assert(Array.isArray(data), 'dense 读出来的应该是 !data 二维数组');
  eq(data.length, 1, '行数组只该有真实存在的 1 行，不是 1048576 行');
  eq(excel.workbookToView(book, 10000).cellCount, 2, '有内容的只有甲、丙两格');
});

check('超过单元格上限明确失败', () => {  const aoa = [Array.from({ length: 10 }, (_, i) => `c${i}`), Array.from({ length: 10 }, (_, i) => `d${i}`)];
  const buf = makeBook([{ name: 'S', aoa }]);
  const view = excel.readWorkbook(buf, { maxCells: 12 });
  eq(view.truncated, true, '应该在 12 个格子处停下');
  let err = null;
  try {
    excel.workbookToContent(view);
  } catch (e) {
    err = e;
  }
  assert(err, '应该抛错');
  eq(err.code, 'too-many-cells', '错误码');
});

check('行号是真实行号，切片能回到原表位置', () => {
  const aoa = [['表头1', '表头2'], ['a', 'b'], ['c', 'd']];
  const buf = makeBook([{ name: '数据', aoa }]);
  const view = excel.readWorkbook(buf);
  const content = excel.workbookToContent(view);
  eq(content.chunks.length, 1, '片数');
  eq(content.chunks[0].locator.kind, 'sheet', 'locator.kind');
  eq(content.chunks[0].locator.sheet, '数据', 'sheet 名');
  eq(content.chunks[0].locator.rowStart, 1, 'rowStart');
  eq(content.chunks[0].locator.rowEnd, 3, 'rowEnd');
  // 末尾内容必须在片子里
  assert(content.chunks[0].text.includes('d'), '最后一行丢了');
});

check('稀疏表的行号不重排（第 10 行还是第 10 行）', () => {
  const ws = { A1: { t: 's', v: 'top' }, A10: { t: 's', v: 'bottom' }, '!ref': 'A1:A10' };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const view = excel.readWorkbook(buf);
  const rows = excel.listSheetRows(view.sheets[0]);
  eq(rows.length, 2, '只有两行有内容');
  eq(rows[0].row, 0, '第一行');
  eq(rows[1].row, 9, '第二行是真实第 10 行（0 起 9）');
  const content = excel.workbookToContent(view);
  eq(content.chunks[0].locator.rowStart, 1, 'rowStart');
  eq(content.chunks[0].locator.rowEnd, 10, 'rowEnd');
});

check('公式没有缓存值时显示公式原文，不假装空格', () => {
  const ws = { A1: { t: 'n', f: 'SUM(B1:B3)' }, B1: { t: 'n', v: 1 }, '!ref': 'A1:B1' };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const content = excel.workbookToContent(excel.readWorkbook(buf));
  assert(content.bodyMd.includes('=SUM(B1:B3)'), '公式应该以 =公式 的形式显示');
});

check('空工作簿是空正文，不是崩溃', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), '空表');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const content = excel.workbookToContent(excel.readWorkbook(buf));
  eq(content.bodyMd, '', 'bodyMd');
  eq(content.chunks.length, 0, '片数');
});

check('坏文件给出可读错误', () => {
  let err = null;
  try {
    excel.readWorkbook(Buffer.from('not a spreadsheet at all'));
  } catch (e) {
    err = e;
  }
  assert(err, '应该抛错');
  eq(err.code, 'corrupt', '错误码');
});

// ---------------------------------------------------------------------------
// 4. 表格分列窗口（v0.12.1）
// ---------------------------------------------------------------------------

check('列偏移从 gutter 之后开始累加', () => {
  const offsets = sheetWindow.columnOffsets([100, 50, 80]);
  eq(offsets[0], sheetWindow.SHEET_GUTTER, '第一列左边界');
  eq(offsets[1], sheetWindow.SHEET_GUTTER + 100, '第二列');
  eq(offsets[2], sheetWindow.SHEET_GUTTER + 150, '第三列');
});

check('空表没有窗口，也不会算出负数', () => {
  const w = sheetWindow.visibleColumns([], [], 0, 400, 240);
  eq(w.start, 0, 'start');
  eq(w.end, 0, 'end');
});

check('scrollX=0 时窗口从第一列开始，且不把整表算进来', () => {
  const widths = Array.from({ length: 30 }, () => 100);
  const offsets = sheetWindow.columnOffsets(widths);
  const w = sheetWindow.visibleColumns(offsets, widths, 0, 400, 240);
  eq(w.start, 0, 'start');
  // 可见 0..4（0..400）再加右侧 overscan 240 → 至少到第 6 列
  assert(w.end >= 6, `窗口太窄：只到第 ${w.end} 列`);
  assert(w.end < 30, '不该把整表都算进窗口');
});

check('滚到最右，窗口必须包含最后一列', () => {
  const widths = Array.from({ length: 30 }, () => 100);
  const offsets = sheetWindow.columnOffsets(widths);
  const gridWidth = sheetWindow.SHEET_GUTTER + 3000;
  const w = sheetWindow.visibleColumns(offsets, widths, gridWidth - 400, 400, 240);
  eq(w.end, 30, '最后一列必须在窗口里');
  assert(w.start > 0, '不该还从第一列开始');
});

check('两侧占位 + 窗口内列宽 === 总宽（破了横向滚动会跳）', () => {
  const widths = [64, 120, 240, 64, 88, 240, 64, 64];
  const offsets = sheetWindow.columnOffsets(widths);
  const gridWidth = sheetWindow.SHEET_GUTTER + widths.reduce((a, b) => a + b, 0);
  const content = gridWidth - sheetWindow.SHEET_GUTTER;
  for (let x = 0; x <= gridWidth; x += 37) {
    const w = sheetWindow.visibleColumns(offsets, widths, x, 360, 240);
    const { left, right } = sheetWindow.spacerWidths(offsets, widths, w.start, w.end, gridWidth);
    let sum = 0;
    for (let i = w.start; i < w.end; i++) sum += widths[i];
    eq(left + sum + right, content, `x=${x} 时占位对不上`);
    assert(w.end > w.start, `x=${x} 时窗口是空的`);
  }
});

check('窗口不越界（回弹到负数、滚过头都不许出界）', () => {
  const widths = Array.from({ length: 5 }, () => 100);
  const offsets = sheetWindow.columnOffsets(widths);
  for (const x of [-999, 0, 250, 99999]) {
    const w = sheetWindow.visibleColumns(offsets, widths, x, 300, 240);
    assert(w.start >= 0 && w.start < 5, `x=${x} 时 start 越界：${w.start}`);
    assert(w.end > w.start && w.end <= 5, `x=${x} 时 end 越界：${w.end}`);
  }
});

// ---------------------------------------------------------------------------
// 5. 解析结果缓存
// ---------------------------------------------------------------------------

check('缓存只认同一个键：换文件、换大小都不命中', () => {
  wbCache.forgetWorkbook();
  const view = { sheets: [], cellCount: 0, truncated: false, limit: 1 };
  const key = wbCache.workbookKey('file:///a.xlsx', 1024);
  eq(key, 'file:///a.xlsx|1024', '键 = uri + size');
  wbCache.rememberWorkbook(key, view);
  eq(wbCache.recallWorkbook(key), view, '同一个键要命中');
  eq(wbCache.recallWorkbook(wbCache.workbookKey('file:///a.xlsx', 2048)), null, '大小变了不该命中');
  eq(wbCache.recallWorkbook(wbCache.workbookKey('file:///b.xlsx', 1024)), null, '换文件不该命中');
  eq(wbCache.recallWorkbook(null), null, '没有键返回 null');
  wbCache.forgetWorkbook();
  eq(wbCache.recallWorkbook(key), null, '清掉之后不该再命中');
});

check('没有原文件的记录不产生缓存键', () => {
  eq(wbCache.workbookKey(null, 100), null, 'null uri');
});

// ---------------------------------------------------------------------------
// 5b. 解析结果落盘（v0.14.0）
// ---------------------------------------------------------------------------

/** 两张表、带中文和空行的小样本 */
function sampleBook() {
  const a = XLSX.utils.aoa_to_sheet([
    ['地区', '销售额', '备注'],
    ['华东', 1234.5, '含税'],
    [],
    ['华南', 99, ''],
  ]);
  const b = XLSX.utils.aoa_to_sheet([
    ['月份', '数量'],
    [1, 2],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, a, '台账');
  XLSX.utils.book_append_sheet(wb, b, '汇总');
  return wb;
}

check('落盘缓存往返：表名、坐标、正文一个字不差', () => {
  const view = excel.workbookToView(sampleBook(), 1000);
  const back = excel.decodeView(excel.encodeView(view, 4096), 4096);
  assert(back, '同一份内容必须解得出来');
  eq(back.sheets.length, view.sheets.length, '表数');
  eq(
    back.sheets.map((s) => s.name).join(','),
    view.sheets.map((s) => s.name).join(','),
    '表名与顺序',
  );
  eq(back.cellCount, view.cellCount, '总格数');
  eq(back.limit, view.limit, '上限');
  eq(back.truncated, view.truncated, '截断标记');
  for (let i = 0; i < view.sheets.length; i++) {
    const a = view.sheets[i];
    const b = back.sheets[i];
    eq(b.rows, a.rows, `${a.name} 行数`);
    eq(b.cols, a.cols, `${a.name} 列数`);
    eq(b.cells.size, a.cells.size, `${a.name} 格数`);
    for (const [k, v] of a.cells) eq(b.cells.get(k), v, `${a.name} 的 ${k}`);
  }
  // 最终判据不是「结构像」，而是「读出来给人看的东西一样」
  eq(excel.workbookToContent(back).bodyMd, excel.workbookToContent(view).bodyMd, '正文');
});

check('dense 表结构与对象键表结构读出同一份正文', () => {
  const wb = sampleBook();
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  // readWorkbook 走 dense:true；wb 本身是 aoa_to_sheet 建的对象键结构。
  // 两条路必须得到同一份正文 —— 否则「换了解析方式」= 悄悄改了用户的表。
  const dense = excel.readWorkbook(bytes);
  const object = excel.workbookToView(wb, formats.LOCAL_READER_LIMITS.excelCells);
  eq(dense.cellCount, object.cellCount, '格数');
  eq(excel.workbookToContent(dense).bodyMd, excel.workbookToContent(object).bodyMd, '正文');
});

check('缓存不认版本不对、大小不对、内容损坏的', () => {
  const view = excel.workbookToView(sampleBook(), 1000);
  const json = excel.encodeView(view, 4096);
  assert(excel.decodeView(json, 4096), '正常内容要认');
  eq(excel.decodeView(json, 4097), null, '大小对不上要作废（同名文件被换掉的情况）');
  eq(excel.decodeView(json.slice(0, json.length >> 1), 4096), null, '写了一半的文件要作废');
  eq(excel.decodeView('null'), null, 'null');
  eq(excel.decodeView('{"v":1}'), null, '字段缺失');
  eq(
    excel.decodeView(
      JSON.stringify({
        v: excel.VIEW_CACHE_VERSION + 1,
        size: 4096,
        cellCount: 0,
        truncated: false,
        limit: 1,
        sheets: [],
      }),
      4096,
    ),
    null,
    '版本升级后旧缓存自动失效，不需要迁移代码',
  );
});

check('缓存里格子的值不是字符串一律作废', () => {
  const withCells = (cells) =>
    JSON.stringify({
      v: excel.VIEW_CACHE_VERSION,
      size: 4096,
      cellCount: 1,
      truncated: false,
      limit: 1000,
      sheets: [{ name: '表', rows: 1, cols: 1, cellCount: 1, cells }],
    });
  // 直接 `new Map(pairs)` 只会检查「长度 2」，数字也能塞进去，
  // 然后渲染层对数字取 `.length` 就崩 —— 值类型必须在这里挡住
  eq(excel.decodeView(withCells([['0,0', 42]]), 4096), null, '数字值');
  eq(excel.decodeView(withCells([['0,0', null]]), 4096), null, 'null 值');
  eq(excel.decodeView(withCells([['0,0']]), 4096), null, '长度不是 2');
  eq(excel.decodeView(withCells(['0,0']), 4096), null, '不是数组');
  assert(excel.decodeView(withCells([['0,0', '文本']]), 4096), '正常的一对要认');
});

// ---------------------------------------------------------------------------
// 6. locator 与 formats 的口径对得上
// ---------------------------------------------------------------------------

check('locatorLabel 认得我们生成的三种 locator', () => {
  eq(formats.locatorLabel({ kind: 'pdf', page: 3 }), '第 3 页', 'PDF');
  eq(
    formats.locatorLabel({ kind: 'sheet', sheet: '数据', rowStart: 2, rowEnd: 5 }).includes('数据'),
    true,
    '工作表名应该出现',
  );
  assert(
    formats.locatorLabel({ kind: 'text', lineStart: 3, lineEnd: 9 }).includes('3'),
    '文本行号应该出现',
  );
});

check('withAlpha 输出半透明色（高亮不能盖住 PDF 的字）', () => {
  eq(color.withAlpha('#FAEEDA', 0.5), 'rgba(250,238,218,0.5)', 'rgba 转换');
  eq(color.withAlpha('#abc', 1), 'rgba(170,187,204,1)', '三位简写');
  eq(color.withAlpha('not-a-color', 0.4), 'not-a-color', '非法输入原样返回');
});

// ---------------------------------------------------------------------------
// 7. 正文分块（TXT / Markdown / 云解析快照共用）
// ---------------------------------------------------------------------------

check('分块拼回去一个字不少', () => {
  const text = [
    '# 标题',
    '',
    '第一段正文，包含中文和 English mixed 内容。',
    '',
    '- 列表项一',
    '- 列表项二',
    '',
    '| 项目 | 标准 |',
    '| --- | --- |',
    '| 住宿 | 600 |',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '结尾一段。',
  ].join('\n');
  const blocks = textBlocks.buildBlocks(text);
  // 行首空行会被丢掉（既省预算又不让「第 N 行」指到空行），所以按非空白比较
  eq(squish(blocks.map((b) => b.text).join('')), squish(text), '分块前后正文必须一致');
});

check('块的 start 是真实偏移（TXT 靠它把命中映射回块）', () => {
  const text = '甲'.repeat(2000) + '\n\n' + '乙'.repeat(2000) + '\n\n' + '丙'.repeat(500);
  const blocks = textBlocks.buildBlocks(text);
  assert(blocks.length > 1, '应该切成多块');
  for (const b of blocks) {
    eq(text.slice(b.start, b.start + b.text.length), b.text, 'start 处的切片必须等于块内容');
  }
});

check('块的起始行号对得上原文', () => {
  const text = '第一行\n第二行\n\n第四行\n第五行';
  const blocks = textBlocks.buildBlocks(text);
  const lines = text.split('\n');
  for (const b of blocks) {
    eq(lines[b.lineStart - 1], b.text.split('\n')[0], 'lineStart 应该指到块的第一行');
    eq(lines[b.lineEnd - 1], b.text.split('\n').slice(-1)[0], 'lineEnd 应该指到块的最后一行');
  }
});

check('代码围栏不被切断（切开就是半个 ```，后面全变代码）', () => {
  const code = Array.from({ length: 120 }, (_, i) => `console.log(${i});`).join('\n');
  const text = `前言\n\n\`\`\`js\n${code}\n\`\`\`\n\n后记`;
  const blocks = textBlocks.buildBlocks(text);
  for (const b of blocks) {
    const fences = b.text.split('\n').filter((l) => /^\s*```/.test(l)).length;
    eq(fences % 2, 0, '每个块里的围栏标记必须是成对的');
  }
});

check('表格不被切成两段（GFM 要求连续）', () => {
  const rows = Array.from({ length: 200 }, (_, i) => `| 行 ${i} | 值 ${i} |`).join('\n');
  const blocks = textBlocks.buildBlocks(`| 项目 | 值 |\n| --- | --- |\n${rows}\n\n结尾`);
  for (let i = 0; i + 1 < blocks.length; i++) {
    const tail = blocks[i].text.split('\n').filter(Boolean).slice(-1)[0] || '';
    const head = blocks[i + 1].text.split('\n').filter(Boolean)[0] || '';
    if (tail.includes('|') && head.includes('|')) {
      throw new Error(`第 ${i} 块和第 ${i + 1} 块之间切断了表格`);
    }
  }
});

check('空文本不产出块', () => {
  eq(textBlocks.buildBlocks('').length, 0, '空串');
  eq(textBlocks.buildBlocks('\n\n\n').length, 0, '只有空行');
});

check('命中偏移落到正确的块（含边界）', () => {
  const text = '甲'.repeat(1500) + '\n\n' + '乙'.repeat(1500);
  const blocks = textBlocks.buildBlocks(text);
  assert(blocks.length === 2, `应该正好两块，实际 ${blocks.length}`);
  eq(textBlocks.blockAt(blocks, 0), 0, '开头');
  eq(textBlocks.blockAt(blocks, blocks[0].start + 10), 0, '第一块内部');
  eq(textBlocks.blockAt(blocks, blocks[1].start), 1, '第二块起点');
  eq(textBlocks.blockAt(blocks, blocks[1].start + 100), 1, '第二块内部');
});

// ---------------------------------------------------------------------------
// 8. 阅读器页面里的内联脚本
// ---------------------------------------------------------------------------

/**
 * `reader.template.html` 里那段 JS 是字符串，`tsc` 检查不到它 ——
 * 语法错一个括号，表现是「打开 PDF 一片空白」，真机上才看得见。
 * 这里只做**解析**（`vm.Script` 不执行），能在十几毫秒里把这类错误挡在提交前。
 */
check('reader.template.html 的内联脚本语法正确', () => {
  const html = fs.readFileSync(
    path.join(root, 'src', 'documents', 'readers', 'pdfjs', 'reader.template.html'),
    'utf8',
  );
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert(blocks.length >= 2, `应该找到至少 2 段内联脚本，实际 ${blocks.length}`);
  for (let i = 0; i < blocks.length; i++) {
    try {
      new vm.Script(blocks[i], { filename: `reader.template.html#script${i + 1}` });
    } catch (e) {
      throw new Error(`第 ${i + 1} 段脚本语法错误：${e.message}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n✗ ${failures.length} 项失败，${passed} 项通过`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`\n✓ 阅读器断言全部通过（${passed} 项）`);
