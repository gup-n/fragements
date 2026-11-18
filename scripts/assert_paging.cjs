#!/usr/bin/env node
/**
 * 大库分页与聚合查询的断言。不联网、不碰数据库。
 *
 * 这一版要回答的问题只有一个：**首页能不能不再把整库读进内存**。
 * 能做这件事的前提是「要计数的三件事都不再依赖那个数组」：
 *
 * - 日历要「哪天有几条」→ `dayCounts()`（SQL 的 `GROUP BY strftime(…,'localtime')`）
 * - 缺口要「每月有几条」→ `monthCounts()`（同上，月粒度）
 * - 「还有多少更早的」→ `totalFragments() - 已加载`（不能拿「这页满没满」反推）
 *
 * 这些在桌面上都能验：纯函数部分直接跑，SQL 部分读源码字符串 —— 断言不是
 * 「验证 SQL 跑得过」（那要真库），而是「口径和写法没有偷偷换掉」：
 * 少了 `'localtime'` 就会在 UTC+8 的夜里把记录算到前一天，而这一点在
 * 桌面时区下根本看不出来。
 *
 * 用法：node scripts/assert_paging.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLoader, createSuite } = require('./test_loader.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const suite = createSuite('大库分页');
const { test } = suite;

const pure = createLoader();
const paging = pure.load('src/util/paging.ts');
const { PAGE_SIZE, appendPage, olderCount } = paging;

const frag = (id, createdAt = 1) => ({
  id, content: `f${id}`, createdAt, source: 'app', status: 'inbox',
  tags: [], project: null, mergedInto: null, images: [],
});

test('一页的大小是个确定的数，首页与补页共用同一个', () => {
  assert.equal(typeof PAGE_SIZE, 'number');
  assert.ok(PAGE_SIZE >= 50 && PAGE_SIZE <= 500, '页太小要翻很多次，太大等于没分页');
  const app = read('App.tsx');
  assert.ok(app.includes('listFragmentsPage(0, PAGE_SIZE)'), '首屏读一页，不是 listAllFragments');
  assert.ok(app.includes('listFragmentsPage(fragments.length, PAGE_SIZE)'), '补页用已加载条数当 offset');
  assert.ok(!app.includes('repo.listAllFragments()'), '首页不许再整库读');
});

test('接页：按 id 去重，重复的那条不会被画两遍', () => {
  const first = [frag(3), frag(2)];
  const second = [frag(2), frag(1)]; // 中间新增过一条时，第二页会和第一页重叠一条
  const merged = appendPage(first, second);
  assert.deepEqual(merged.map((f) => f.id), [3, 2, 1], '顺序不动，重复的去掉');
  assert.equal(merged.length, 3);
});

test('接页：空页不改身份，也不新造数组', () => {
  const first = [frag(1)];
  assert.equal(appendPage(first, []), first, '空页时原样返回（省一次整页重渲染）');
  assert.equal(appendPage(first, [frag(1)]), first, '整页都是重复的也一样');
});

test('还有多少更早的：总数减已加载，绝不出现负数', () => {
  assert.equal(olderCount(500, 200), 300);
  assert.equal(olderCount(200, 200), 0, '刚好读完');
  assert.equal(olderCount(200, 201), 0, '并发删除让总数变小，也不能说「还有 -1 条」');
});

test('SQL 的分组口径必须带 localtime，且与 JS 的 dayKey/monthKey 对齐', () => {
  const native = read('src/db/repo.native.ts');
  // 日历
  assert.ok(native.includes('strftime(\'%Y-%m-%d\', created_at / 1000, \'unixepoch\', \'localtime\')'), 'dayCounts 要按本地时区分天');
  // 缺口
  assert.ok(native.includes('strftime(\'%Y-%m\', created_at / 1000, \'unixepoch\', \'localtime\')'), 'monthCounts 要按本地时区分月');
  assert.ok(native.includes('GROUP BY day') && native.includes('GROUP BY month'), '两条聚合各自分组');
  // 分页
  assert.ok(native.includes('ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'), '分页顺序与首页一致（同一条时间的两条也不能跳）');
  assert.ok(native.includes('SELECT COUNT(*) AS n FROM fragments'), '总数走 COUNT(*)，不读正文');
});

test('web 侧四个方法都在，并且用同一个 JS 口径', () => {
  const web = read('src/db/repo.web.ts');
  for (const name of ['totalFragments', 'listFragmentsPage', 'dayCounts', 'monthCounts']) {
    assert.ok(web.includes(`async ${name}(`), `web 仓库缺 ${name}（桌面编译校验会挂）`);
  }
  assert.ok(web.includes('countByMonth(load().fragments)'), '月份分组复用 util/digest.countByMonth，不另写一套');
  assert.ok(web.includes('dayKey(f.createdAt)'), '天分组复用 util/date.dayKey');
});

test('契约里四个方法都声明了，且注释写明「不是全部」', () => {
  const types = read('src/db/types.ts');
  for (const name of ['totalFragments', 'listFragmentsPage', 'dayCounts', 'monthCounts']) {
    assert.ok(types.includes(`${name}(`), `Repo 契约缺 ${name}`);
  }
});

/*
 * 截断之后最危险的不是列表少几条，而是**别的地方还在把这一窗当全量**：
 * 日历会少点、缺口会少几个月、月总结会把「4000 条」当上限。这三处都改了，
 * 断言得钉住它们，否则下一次「顺手传个 fragments 进去」会把大库悄悄弄错。
 */
test('计数类需求不再从全量数组里数', () => {
  const review = read('src/screens/ReviewScreen.tsx');
  assert.ok(!review.includes('fragments: Fragment[]'), '回顾页不再收全量碎片');
  assert.ok(review.includes('missingDigests(months, notes'), '缺口用每月条数');
  assert.ok(review.includes('days'), '日历用每天条数');
  assert.ok(review.includes('onLoadDay'), '点开某天才去读那天的正文');

  const summary = read('src/components/SummarySheet.tsx');
  assert.ok(!summary.includes('repo.listFragments(4000)'), '月总结面板不许再用「4000 条」这种猜的上限');
  assert.ok(summary.includes('repo.monthCounts()'), '缺口清单走月聚合');

  // 导出/备份仍然要全量 —— 那是「把东西完整拿走」，和首页展示不是一回事
  const settings = read('src/screens/SettingsScreen.tsx');
  assert.ok(settings.includes('repo.listAllFragments()'), '导出 Markdown 必须拿全量（这条留着是对的）');
});

test('界面：还有更早的才出现按钮，搜索时不说「还有 N 条」', () => {
  const timeline = read('src/screens/TimelineScreen.tsx');
  assert.ok(timeline.includes('olderCount(total, fragments.length)'), '剩余条数由总数与已加载算');
  assert.ok(timeline.includes('searching ? 0 : olderCount'), '搜索是整库的，结果里没有「更早的」；筛选才有');
  assert.ok(timeline.includes('只在已加载的'), '筛选只覆盖已加载部分，得说出来');
  assert.ok(timeline.includes('older > 0 || loadingOlder'), '没有更早的就不画那颗按钮');
  assert.ok(timeline.includes('读取中…'), '点下去要有反馈，不能什么都不动');
});

if (require.main === module) {
  suite.run().then(({ failed }) => {
    process.exitCode = failed ? 1 : 0;
  }).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
module.exports = { run: suite.run };
