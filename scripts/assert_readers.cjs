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
const color = require(path.join(outDir, 'documents', 'readers', 'color.js'));
const formats = require(path.join(outDir, 'documents', 'formats.js'));
const XLSX = require('xlsx');

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

check('超过单元格上限明确失败', () => {
  const aoa = [Array.from({ length: 10 }, (_, i) => `c${i}`), Array.from({ length: 10 }, (_, i) => `d${i}`)];
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
// 4. locator 与 formats 的口径对得上
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
// 收尾
// ---------------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n✗ ${failures.length} 项失败，${passed} 项通过`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`\n✓ 阅读器断言全部通过（${passed} 项）`);
