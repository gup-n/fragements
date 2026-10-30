const assert = require('node:assert');
const { parseBlocks, parseInline, splitRow, isTableStart, flattenForPreview } = require('./mdBlocks.js');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const kinds = (bs) => bs.map((b) => b.kind).join(',');
const plain = (segs) => segs.map((s) => s.text).join('');

// 截图里那张表的原文
const SHOT = `你的记录里没有「知识库」这个模块的快捷键汇总表，只有几条零散的设备记录，我按品牌整理如下：
| 品牌 | 进 BIOS | 进引导 |
|---|----|----|
| 华为 | F2 [F55] | F12 [F55] |
| ThinkPad（联想） | F1 [F54] | F12 [F54] |
| 华硕 ASUS | F2 或 Del [F46] | F12 [F46] |
| Dell | F2 [F41] | F12 [F41] |
| 宏碁 Acer | F2 [F50] | — |
补充两点：Dell 若进不去 BIOS，需在 Boot Configuration 里关掉 Secure Boot。`;

ok('截图那张表：段落 + 表格 + 段落', () => {
  const b = parseBlocks(SHOT);
  assert.strictEqual(kinds(b), 'p,table,p');
  const t = b[1];
  assert.strictEqual(t.head.length, 3);
  assert.strictEqual(t.rows.length, 5);
  assert.strictEqual(plain(t.head[0]), '品牌');
  assert.strictEqual(plain(t.rows[0][1]), 'F2 [F55]');
  assert.strictEqual(plain(t.rows[4][2]), '—');
  // 表格后面的正文不能被吞进表里
  assert.ok(plain(b[2].segs).startsWith('补充两点'));
});

ok('对齐标记', () => {
  const b = parseBlocks('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |');
  assert.deepStrictEqual(b[0].align, ['left', 'center', 'right']);
});

ok('少列补空、多列截断', () => {
  const b = parseBlocks('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |');
  assert.strictEqual(b[0].rows[0].length, 3);
  assert.strictEqual(plain(b[0].rows[0][2]), '');
  assert.strictEqual(b[0].rows[1].length, 3);
});

ok('转义竖线与行内代码里的竖线', () => {
  assert.deepStrictEqual(splitRow('| a\\|b | `x | y` |'), ['a|b', '`x | y`']);
  const b = parseBlocks('| 命令 | 说明 |\n|---|---|\n| `grep -E "a\\|b"` | 或 |');
  const cell = b[0].rows[0][0];
  assert.strictEqual(cell.some((s) => s.code), true, '应保留行内代码标记');
  assert.ok(plain(cell).includes('a|b'));
});

ok('单独一条 --- 是分隔线，不是表格', () => {
  const b = parseBlocks('上面\n\n---\n\n下面');
  assert.strictEqual(kinds(b), 'p,hr,p');
  assert.strictEqual(isTableStart(['---', 'abc'], 0), false);
});

ok('正文里出现 | 不算表格（下一行不是分隔行）', () => {
  const b = parseBlocks('A | B 两个方案都试过\n都没成');
  assert.strictEqual(kinds(b), 'p,p');
});

ok('表格后面紧跟标题会停住', () => {
  const b = parseBlocks('| a | b |\n|---|---|\n| 1 | 2 |\n## 下一节');
  assert.strictEqual(kinds(b), 'table,h');
});

ok('代码块里的 | 和 # 原样保留', () => {
  const b = parseBlocks('```bash\nls | grep a\n# 注释\n```');
  assert.strictEqual(kinds(b), 'code');
  assert.strictEqual(b[0].text, 'ls | grep a\n# 注释');
});

ok('列宽按内容估，不是平均分', () => {
  const b = parseBlocks('| 品牌 | 说明 |\n|---|---|\n| 华为 | 一段很长的说明文字，比品牌长很多 |');
  const w = b[0].weights;
  assert.ok(w[1] > w[0], `第二列应更宽，实际 ${JSON.stringify(w)}`);
  assert.ok(w[1] <= 18, '上限 18');
  assert.ok(w[0] >= 3, '下限 3');
});

ok('旧小结的加粗仍生效', () => {
  const b = parseBlocks('- **换盘**：把 4 号盘换掉');
  assert.strictEqual(b[0].kind, 'b');
  assert.strictEqual(b[0].segs[0].text, '· ');
  assert.strictEqual(b[0].segs[1].bold, true);
  assert.strictEqual(b[0].segs[1].text, '换盘');
});

ok('行内代码不会被当成加粗', () => {
  const segs = parseInline('执行 `npm run **x**` 再看');
  assert.strictEqual(segs[1].code, true);
  assert.strictEqual(segs[1].text, 'npm run **x**');
  assert.strictEqual(segs.some((s) => s.bold), false);
});

ok('标题层级与引用前缀', () => {
  assert.strictEqual(parseBlocks('## 重点')[0].kind, 'h');
  assert.strictEqual(parseBlocks('### 三级')[0].kind, 'h');
  assert.strictEqual(plain(parseBlocks('> 引用一句')[0].segs), '引用一句');
});

ok('编号列表', () => {
  const b = parseBlocks('1. 第一\n2) 第二');
  assert.strictEqual(b[0].segs[0].text, '1. ');
  assert.strictEqual(b[1].segs[0].text, '2. ');
});

ok('预览模式：表格压成行，不丢内容', () => {
  const flat = flattenForPreview(parseBlocks('| 品牌 | BIOS |\n|---|---|\n| 华为 | F2 |'));
  assert.strictEqual(flat.length, 2);
  assert.strictEqual(plain(flat[0].segs), '品牌 · BIOS');
  assert.strictEqual(plain(flat[1].segs), '华为 · F2');
});

ok('预览模式：旧小结的首行不加空行、标题前加空行', () => {
  const flat = flattenForPreview(parseBlocks('## 重点\n- 一条\n## 进展\n- 两条'));
  assert.deepStrictEqual(flat.map((x) => x.newlineBefore), [false, false, true, false]);
});

ok('空输入不抛错', () => {
  assert.deepStrictEqual(parseBlocks(''), []);
  assert.strictEqual(parseBlocks('\n\n  \n').length, 0);
});

ok('单行超长表格不会把整段吞掉', () => {
  const b = parseBlocks('| a | b |\n|---|---|');
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].rows.length, 0);
});

console.log(`\n${n} 项全部通过`);
