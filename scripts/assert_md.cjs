/**
 * 导入 / 导出 / 分词的回归断言。跑法：`npm run test:md`
 *
 * 为什么这个脚本留在仓库里，而别的断言跑完就删：**导入导出是备份链路**。
 * 导出格式一改、解析规则一改，必须两边同时改，靠这里的往返测试（碎片 → md → 碎片）
 * 才拦得住。删了它，下次改格式就只能靠人眼比对了。
 *
 * 它不含任何 UI、网络、数据库依赖，只在 node 里跑纯函数。
 */

const assert = require('node:assert');
const {
  parseMarkdown,
  splitTrailingTags,
  fragmentKey,
  looksBinary,
} = require('../.tmp-assert/util/mdParse.js');
const { buildMarkdown } = require('../.tmp-assert/util/mdBuild.js');

let n = 0;
const ok = (name, fn) => {
  fn();
  n++;
  console.log('  ok  ' + name);
};

const DAY = new Date(2026, 9, 25, 12, 0).getTime();
const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm).getTime();

// ─────────────── 解析 ───────────────

ok('读得懂自己导出的格式', () => {
  const md = [
    '# 碎片导出 · 2026-10-25',
    '',
    '共 2 条碎片，覆盖 1 天。',
    '',
    '---',
    '',
    '## 时间轴',
    '',
    '### 2026-10-25 周六',
    '',
    '- 09:12 给 NAS 换风扇 #NAS #硬件',
    '- 21:40 报销单还没提交 #报销',
    '',
  ].join('\n');
  const r = parseMarkdown(md, DAY);
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.items[0].content, '给 NAS 换风扇');
  assert.deepStrictEqual(r.items[0].tags, ['NAS', '硬件']);
  assert.strictEqual(r.items[0].createdAt, at(2026, 10, 25, 9, 12));
  assert.strictEqual(r.items[1].createdAt, at(2026, 10, 25, 21, 40));
  assert.strictEqual(r.withoutDate, 0);
});

ok('待办段与标签索引段整段忽略', () => {
  const md = [
    '## 时间轴',
    '### 2026-10-25 周六',
    '- 09:00 一条正文',
    '',
    '---',
    '## 待办',
    '### 未完成（2）',
    '- [ ] 给 NAS 换风扇',
    '- [x] 报销',
    '',
    '## 标签索引',
    '- #NAS（3 条）',
    '',
  ].join('\n');
  const r = parseMarkdown(md, DAY);
  assert.strictEqual(r.items.length, 1, '只应剩下 1 条');
  assert.ok(r.sectionSkipped >= 3, '跳过的行数 ' + r.sectionSkipped);
});

ok('「（已合并）」不导入', () => {
  const md = ['### 2026-10-25 周六', '- 09:00 旧内容（已合并） #a', '- 10:00 留下的'].join('\n');
  const r = parseMarkdown(md, DAY);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.mergedSkipped, 1);
  assert.strictEqual(r.items[0].content, '留下的');
});

ok('没有日期的条目落到 fallbackDay 并计数', () => {
  const md = ['- 早上想到一个点子', '- 还有一条'].join('\n');
  const r = parseMarkdown(md, DAY);
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.withoutDate, 2);
  const base = new Date(2026, 9, 25, 0, 0).getTime();
  assert.strictEqual(r.items[0].createdAt, base + 8 * 3600000);
  assert.strictEqual(r.items[1].createdAt, base + 8 * 3600000 + 60000);
});

ok('同一天混排：没写时间的跟在前一条之后，不撞车', () => {
  const md = ['### 2026-10-25', '- 07:30 早', '- 没写时间的一条', '- 21:00 晚'].join('\n');
  const r = parseMarkdown(md, DAY);
  assert.strictEqual(r.items.length, 3);
  assert.strictEqual(new Set(r.items.map((i) => i.createdAt)).size, 3, '三条时间必须互不相同');
  const noTime = r.items.find((i) => i.content === '没写时间的一条');
  assert.strictEqual(noTime.createdAt, at(2026, 10, 25, 7, 31), '跟在前一条之后一分钟');
  assert.deepStrictEqual(
    r.items.map((i) => i.content),
    ['早', '没写时间的一条', '晚'],
    '文件顺序 = 时间轴顺序',
  );
});

ok('无时间条目排在末尾时，接在当天最晚那条之后', () => {
  const md = ['### 2026-10-25', '- 21:00 晚', '- 补记一条'].join('\n');
  const r = parseMarkdown(md, DAY);
  const late = r.items.find((i) => i.content === '补记一条');
  assert.strictEqual(late.createdAt, at(2026, 10, 25, 21, 1));
});

ok('读不懂的日期会被报出来，但内容不丢（落到 fallback）', () => {
  const md = ['### 2026-13-99', '- 这条不该丢', '### 2026-02-30', '- 这条也不该丢'].join('\n');
  const r = parseMarkdown(md, DAY);
  assert.strictEqual(r.badDates.length, 2, '两个坏日期都要报');
  assert.strictEqual(r.items.length, 2, '内容不能丢');
  assert.strictEqual(r.withoutDate, 2, '要算进「没有日期」让用户看见');
});

ok('日期标题后面跟了文字，仍按那天算', () => {
  const md = ['### 2026-10-24 复盘', '- 一条'].join('\n');
  const r = parseMarkdown(md, DAY);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(new Date(r.items[0].createdAt).getDate(), 24);
});

ok('未来日期照收（挪到今天反而会把内容混进今天）', () => {
  const md = ['### 2026-12-31', '- 未来的事'].join('\n');
  const r = parseMarkdown(md, DAY);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].createdAt, at(2026, 12, 31, 8, 0));
  assert.strictEqual(r.badDates.length, 0);
});

ok('兼容手写：星号列表 / 中文日期 / 无 #', () => {
  const md = ['## 2026年10月24日 星期六', '* 下午去了一趟医院', '+ 顺手买了药'].join('\n');
  const r = parseMarkdown(md, DAY);
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.items[0].content, '下午去了一趟医院');
  assert.strictEqual(r.items[0].tags.length, 0);
});

ok('CRLF 与 BOM 不影响', () => {
  const md = '\uFEFF### 2026-10-25\r\n- 09:00 正文\r\n';
  const r = parseMarkdown(md, DAY);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].content, '正文');
});

ok('C# 和 #include 不被当成标签', () => {
  assert.deepStrictEqual(splitTrailingTags('在学 C#'), { text: '在学 C#', tags: [] });
  assert.deepStrictEqual(splitTrailingTags('#include <stdio.h>'), {
    text: '#include <stdio.h>',
    tags: [],
  });
  assert.deepStrictEqual(splitTrailingTags('读完 #Rust'), { text: '读完', tags: ['Rust'] });
});

ok('标签尾巴上的标点被剥掉，正文里的井号留着', () => {
  assert.deepStrictEqual(splitTrailingTags('换盘完成 #NAS。'), { text: '换盘完成', tags: ['NAS'] });
  assert.deepStrictEqual(splitTrailingTags('第 3 项 #1 才算'), {
    text: '第 3 项 #1 才算',
    tags: [],
  });
});

ok('乱序文件按时间排好', () => {
  const md = ['### 2026-10-25', '- 21:00 晚', '- 08:00 早'].join('\n');
  const r = parseMarkdown(md, DAY);
  assert.strictEqual(r.items[0].content, '早');
  assert.strictEqual(r.items[1].content, '晚');
});

ok('指纹只看 天+分+归一化正文', () => {
  const a = fragmentKey(at(2026, 10, 25, 9, 12), '给 NAS 换风扇');
  const b = fragmentKey(at(2026, 10, 25, 9, 12), '给NAS换风扇 ');
  const c = fragmentKey(at(2026, 10, 25, 9, 13), '给 NAS 换风扇');
  assert.strictEqual(a, b, '空白与标点差异应视为同一条');
  assert.notStrictEqual(a, c, '差一分钟就是新的');
  assert.ok(a.startsWith('2026-10-25|09:12|'), a);
});

ok('空文件与纯说明文字不产生条目', () => {
  assert.strictEqual(parseMarkdown('', DAY).items.length, 0);
  assert.strictEqual(parseMarkdown('# 标题\n\n正文一段\n', DAY).items.length, 0);
});

ok('二进制文件能被识别出来（选错文件 / GBK）', () => {
  assert.strictEqual(looksBinary(''), true);
  assert.strictEqual(looksBinary('正常的中文内容，带 #标签 也没问题'), false);
  assert.strictEqual(looksBinary('abc\u0000def'), true, 'NUL 字节');
  assert.strictEqual(looksBinary('\uFFFD'.repeat(50) + 'abc'), true, '编码不对');
  assert.strictEqual(
    looksBinary('很长的正常文本'.repeat(200) + '\uFFFD'),
    false,
    '零星替换字符不算',
  );
});

// ─────────────── 往返 ───────────────

const frag = (id, createdAt, content, tags = [], mergedInto = null) => ({
  id,
  content,
  createdAt,
  source: 'app',
  status: mergedInto === null ? 'tagged' : 'merged',
  tags,
  project: null,
  mergedInto,
  nature: null,
});

const data = [
  frag(1, at(2026, 10, 24, 9, 12), '给 NAS 换风扇', ['NAS', '硬件']),
  frag(2, at(2026, 10, 24, 21, 40), '报销单还没提交', ['报销']),
  frag(3, at(2026, 10, 25, 8, 0), '早上想到一个点子'),
  frag(4, at(2026, 10, 25, 13, 5), '多行内容\n第二行', ['想法']),
  frag(5, at(2026, 10, 25, 15, 30), '被合并掉的那条', ['旧'], 3),
];

const todos = [
  {
    id: 1,
    text: '打电话给物业',
    dueAt: '2026-10-30',
    done: false,
    sourceFragmentId: null,
    createdAt: 0,
    mergedInto: null,
  },
];

const md = buildMarkdown(data, todos).content;
const back = parseMarkdown(md, DAY);

ok('往返：条数对得上，已合并的不回来', () => {
  assert.strictEqual(back.items.length, 4);
  assert.strictEqual(back.mergedSkipped, 1);
});

ok('往返：时间精确到分钟', () => {
  assert.strictEqual(back.items[0].createdAt, at(2026, 10, 24, 9, 12));
  assert.strictEqual(back.items[1].createdAt, at(2026, 10, 24, 21, 40));
  assert.strictEqual(back.items[2].createdAt, at(2026, 10, 25, 8, 0));
  assert.strictEqual(back.items[3].createdAt, at(2026, 10, 25, 13, 5));
});

ok('往返：正文与标签原样回来', () => {
  assert.strictEqual(back.items[0].content, '给 NAS 换风扇');
  assert.deepStrictEqual(back.items[0].tags, ['NAS', '硬件']);
  assert.strictEqual(back.items[1].content, '报销单还没提交');
  assert.deepStrictEqual(back.items[1].tags, ['报销']);
  assert.deepStrictEqual(back.items[2].tags, []);
});

ok('往返：多行正文被压成一行（导出层的既成事实）', () => {
  assert.strictEqual(back.items[3].content, '多行内容 第二行');
});

ok('往返：待办与标签索引不会变成碎片', () => {
  for (const it of back.items) {
    assert.ok(!it.content.includes('打电话给物业'), '待办混进碎片了：' + it.content);
    assert.ok(!/\（\d+ 条\）/.test(it.content), '标签索引混进碎片了：' + it.content);
  }
});

ok('往返：再走一遍结果完全一致（稳定收敛）', () => {
  const round2 = buildMarkdown(
    back.items.map((it, i) => frag(i + 1, it.createdAt, it.content, it.tags)),
    [],
  ).content;
  const again = parseMarkdown(round2, DAY);
  assert.strictEqual(again.items.length, back.items.length);
  for (let i = 0; i < back.items.length; i++) {
    assert.strictEqual(again.items[i].createdAt, back.items[i].createdAt);
    assert.strictEqual(again.items[i].content, back.items[i].content);
    assert.deepStrictEqual(again.items[i].tags, back.items[i].tags);
  }
});

ok('往返：正文里的井号与代码片段不串行', () => {
  const tricky = [
    frag(1, at(2026, 10, 25, 10, 0), '讨论 #include <stdio.h> 的用法'),
    frag(2, at(2026, 10, 25, 10, 1), 'C# 和 F# 都有人用'),
    frag(3, at(2026, 10, 25, 10, 2), '价格是 3 # 5', ['杂']),
  ];
  const text = buildMarkdown(tricky, []).content;
  const r = parseMarkdown(text, DAY);
  assert.strictEqual(r.items.length, 3);
  assert.strictEqual(r.items[0].content, '讨论 #include <stdio.h> 的用法');
  assert.deepStrictEqual(r.items[0].tags, []);
  assert.strictEqual(r.items[1].content, 'C# 和 F# 都有人用');
  assert.strictEqual(r.items[2].content, '价格是 3 # 5');
  assert.deepStrictEqual(r.items[2].tags, ['杂']);
});

console.log(`\n全部通过：${n} 项\n`);
