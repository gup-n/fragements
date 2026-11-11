#!/usr/bin/env node
/**
 * 「问」页指令路由与整理草稿的纯逻辑断言。**不联网、不调用 AI、不碰数据库。**
 *
 * 覆盖三件在 node 里就能证明的事：
 *   1. 一句话会被路由到哪个任务（判错的代价不对称：整理被当成问答，
 *      用户会以为整理跑了，结果什么都没发生）；
 *   2. 模型返回的 JSON 收敛成草稿时，脏数据（空待办、2 月 31 日、超长标题）会被挡住；
 *   3. 列表摘要与写入前的校验。
 *
 * 另外**顺带断言月总结提示词的形状**：它是纯文本契约，改坏了没有任何类型检查
 * 会报错，但输出会从表格退化成一段段叙述 —— 而这正是这次要改掉的东西。
 *
 * 跑不到的部分（必须真机/真模型验证）：
 *   - 模型实际是否照表格写、表格列数是否一致；
 *   - 写入文档后能不能被「问」检索到；
 *   - SQLite v12 迁移、草稿卡在真机上的键盘位置。
 *
 * 用法：node scripts/assert_ask.cjs
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.tmp-assert-ask');

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

fs.rmSync(outDir, { recursive: true, force: true });

const tscArgs = [
  require.resolve('typescript/bin/tsc'),
  '--ignoreConfig',
  'src/util/askIntent.ts',
  'src/util/knowledgeDoc.ts',
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

const { routeAsk } = require(path.join(outDir, 'util', 'askIntent.js'));
const doc = require(path.join(outDir, 'util', 'knowledgeDoc.js'));

// ---------------------------------------------------------------------------
// 1. 指令路由
// ---------------------------------------------------------------------------
check('「整理这些碎片」进整理，不是问答', () => {
  eq(routeAsk('帮我把这些碎片整理一下').task, 'organize', '任务');
});

check('「整理待办」进待办，不是整理文档', () => {
  eq(routeAsk('整理一下待办').task, 'todos', '任务');
});

check('「整理这个月的碎片」优先判成月小结', () => {
  // 同时命中「整理」和「这个月」：用户要的显然是月总结
  eq(routeAsk('整理这个月的碎片').task, 'digest', '任务');
});

check('「写个月小结」进月小结', () => {
  eq(routeAsk('写个月小结吧').task, 'digest', '任务');
});

check('普通提问不会被吞成整理', () => {
  eq(routeAsk('上次换硬盘是哪天？').task, 'answer', '任务');
  eq(routeAsk('为什么阵列重建这么慢').task, 'answer', '任务');
});

check('「整理一下这段回答」不抢问答', () => {
  // 有动词、没有碎片类对象，且说了「回答」—— 这是要润色，不是整理碎片
  eq(routeAsk('帮我整理一下这段回答').task, 'answer', '任务');
});

check('光杆「整理一下」默认整理碎片', () => {
  eq(routeAsk('整理一下').task, 'organize', '任务');
});

check('空输入不会误判', () => {
  eq(routeAsk('   ').task, 'answer', '任务');
});

// ---------------------------------------------------------------------------
// 2. 模型 JSON → 草稿
// ---------------------------------------------------------------------------
check('空待办与空文字被丢掉', () => {
  const d = doc.normalizeDraft(
    {
      title: '群晖换盘',
      body_md: '## 结论\n换 4 块 8T。',
      todos: [
        { text: '  买硬盘  ', due: '2026-11-30' },
        { text: '   ', due: null },
        { due: '2026-12-01' },
      ],
    },
    'knowledge',
    [1, 2],
  );
  eq(d.todos.length, 1, '只剩一条有效待办');
  eq(d.todos[0].text, '买硬盘', '去掉首尾空白');
  eq(d.todos[0].keep, true, '默认勾选');
  eq(d.sourceIds.length, 2, '来源 id 要带上');
});

check('不存在的日期不会被写进去（2026-02-31）', () => {
  const d = doc.normalizeDraft({ todos: [{ text: '交报告', due: '2026-02-31' }] }, 'todos', []);
  eq(d.todos[0].due, null, '非法日期清空');
});

check('合法日期保留', () => {
  const d = doc.normalizeDraft({ todos: [{ text: '交报告', due: '2028-02-29' }] }, 'todos', []);
  eq(d.todos[0].due, '2028-02-29', '闰年 2 月 29 日有效');
});

check('标题超长会被截断，不是原样写库', () => {
  const long = '关于群晖换盘这件事从头到尾的完整记录以及后续的维护计划安排';
  const d = doc.normalizeDraft({ title: long, body_md: 'x' }, 'knowledge', []);
  assert(d.docs[0].title.length <= doc.TITLE_MAX, `标题长度 ${d.docs[0].title.length} 超过上限`);
  assert(d.docs[0].title.endsWith('…'), '截断要有省略号');
});

check('没有标题时用日期兜底', () => {
  const d = doc.normalizeDraft({ body_md: '正文' }, 'knowledge', []);
  const name = doc.docNameOf(d.docs[0], new Date(2026, 10, 10).getTime());
  eq(name, '整理 2026-11-10', '兜底标题');
});

check('正文写成 body 也能认（模型偶尔换字段名）', () => {
  const d = doc.normalizeDraft({ title: 'x', body: '用 body 字段' }, 'knowledge', []);
  eq(d.docs[0].bodyMd, '用 body 字段', '正文');
});

check('一次整理可以拆成多篇，各归各的', () => {
  const d = doc.normalizeDraft(
    {
      docs: [
        { title: 'RAID5 降级处理', summary: '先看存储池再拔盘', body_md: '## 顺序\n先确认降级位置。' },
        { title: '换盘前要跑的检查', body_md: 'SMART 长检。' },
      ],
    },
    'knowledge',
    [7],
  );
  eq(d.docs.length, 2, '两篇都要留下');
  eq(d.docs[0].title, 'RAID5 降级处理', '第一篇标题');
  eq(d.docs[0].summary, '先看存储池再拔盘', '摘要原样保留');
  // 没给摘要时用正文兜底，列表上不能是一行空白
  eq(d.docs[1].summary, 'SMART 长检。', '缺摘要时兜底');
  eq(d.sourceIds[0], 7, '来源 id 要带上');
});

check('篇数超过上限会被砍掉', () => {
  const docs = Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, body_md: `b${i}` }));
  eq(doc.normalizeDraft({ docs }, 'knowledge', []).docs.length, doc.MAX_DOCS, '上限');
});

check('空正文的篇直接丢掉，不留白文档', () => {
  const d = doc.normalizeDraft(
    { docs: [{ title: '空的', body_md: '   ' }, { title: '有内容', body_md: 'ok' }] },
    'knowledge',
    [],
  );
  eq(d.docs.length, 1, '只留能读的那篇');
  eq(d.docs[0].title, '有内容', '留下的是哪篇');
});

// ---------------------------------------------------------------------------
// 2.5 待办的两层结构
// ---------------------------------------------------------------------------
check('待办的子步骤会被解析，默认都勾着', () => {
  const d = doc.normalizeDraft(
    {
      todos: [
        {
          text: '把群晖那块盘换掉',
          due: '2026-11-20',
          children: [{ text: '先跑 SMART 长检' }, { text: '确认热备位置' }],
        },
      ],
    },
    'todos',
    [],
  );
  eq(d.todos.length, 1, '一件事');
  eq(d.todos[0].children.length, 2, '两个步骤');
  eq(d.todos[0].children[0].keep, true, '子项默认勾选');
  eq(doc.countTodos(d), 3, '含子项的总条数');
});

check('子步骤里的空文字与非法日期会被挡掉', () => {
  const d = doc.normalizeDraft(
    { todos: [{ text: 'a', children: [{ text: '  ' }, { text: 'b', due: '2026-13-40' }] }] },
    'todos',
    [],
  );
  eq(d.todos[0].children.length, 1, '只剩一条有效步骤');
  eq(d.todos[0].children[0].due, null, '非法日期清空');
});

check('勾掉子项后总条数跟着变', () => {
  const d = doc.normalizeDraft({ todos: [{ text: 'a', children: [{ text: 'b' }] }] }, 'todos', []);
  eq(doc.countTodos(d), 2, '两条');
  d.todos[0].children[0].keep = false;
  eq(doc.countTodos(d), 1, '勾掉后只剩父项');
  eq(doc.todoShape(d).sub, 0, '步骤数归零');
});

// ---------------------------------------------------------------------------
// 3. 摘要与写入校验
// ---------------------------------------------------------------------------
check('摘要里没有竖线，表头分隔行被丢掉', () => {
  const md = ['## 事件一览', '| 日期 | 事件 |', '|---|---|', '| 11-03 | 换盘 |'].join('\n');
  const ex = doc.excerptOf(md);
  assert(!ex.includes('|'), `摘要仍有竖线：${ex}`);
  assert(!ex.includes('---'), `摘要仍有分隔行：${ex}`);
  assert(ex.includes('11-03'), '内容要留下');
});

check('摘要按长度截断并加省略号', () => {
  const ex = doc.excerptOf('字'.repeat(400), 50);
  eq(ex.length, 51, '50 字 + 省略号');
});

check('什么都没有时不许写', () => {
  eq(doc.draftProblem(doc.emptyDraft('knowledge', [])), '没有可写入的文档，也没有勾选待办', '提示');
});

check('只抽待办时，一条都没勾不许写', () => {
  const d = doc.emptyDraft('todos', []);
  eq(doc.draftProblem(d), '还没有勾选任何待办', '提示');
});

check('勾掉的待办不算进写入', () => {
  const d = doc.normalizeDraft({ todos: [{ text: 'a' }, { text: 'b' }] }, 'todos', []);
  d.todos[0].keep = false;
  eq(doc.keptTodos(d).length, 1, '只写勾着的那条');
});

check('文档有正文就能写，长度不设下限', () => {
  const d = doc.normalizeDraft({ docs: [{ title: 't', body_md: '一句话。' }] }, 'knowledge', []);
  eq(doc.draftProblem(d), null, '应当允许');
});

check('单篇缺标题时那张卡不许写', () => {
  const d = doc.normalizeDraft({ docs: [{ title: '', body_md: 'x' }] }, 'knowledge', []);
  eq(doc.docProblem(d.docs[0]), '还没起标题', '提示');
});

check('勾掉的篇不参与写入', () => {
  const d = doc.normalizeDraft(
    { docs: [{ title: 'a', body_md: '1' }, { title: 'b', body_md: '2' }] },
    'knowledge',
    [],
  );
  d.docs[1].keep = false;
  eq(doc.keptDocs(d).length, 1, '只写勾着的那篇');
});

// ---------------------------------------------------------------------------
// 3.5 提示词契约：只收知识、拆多篇、待办带去重
// ---------------------------------------------------------------------------
check('整理提示词有「什么算知识」的判据与不收清单', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'ai', 'knowledge.ts'), 'utf8');
  assert(src.includes('三个月后重读'), '缺少可执行的判据');
  assert(src.includes('情绪、感想'), '缺少「不收感想」');
  assert(src.includes('生活琐事'), '缺少「不收生活琐事」');
});

check('整理提示词要求多篇输出与两层的待办', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'ai', 'knowledge.ts'), 'utf8');
  assert(src.includes('"docs"'), '缺少 docs 数组');
  assert(src.includes('"children"'), '缺少待办子步骤');
  assert(src.includes('已有待办'), '缺少去重上下文');
  assert(src.includes('MAX_DOCS') || src.includes('最多 ${'), '缺少篇数上限的约束');
});

// ---------------------------------------------------------------------------
// 4. 月总结提示词仍然是「表格 + 重要事件」
// ---------------------------------------------------------------------------
check('月总结提示词要求表格与重要事件两段', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'ai', 'summarize.ts'), 'utf8');
  assert(src.includes('| 日期 | 事件 |'), '缺少表头约定');
  assert(src.includes('## 事件一览'), '缺少第一段标题');
  assert(src.includes('## 重要事件与进展'), '缺少第二段标题');
  assert(src.includes('一天一行'), '缺少「同一天合并成一行」的约束');
  assert(src.includes('省略实现细节'), '缺少「省略实现细节」的约束');
  assert(src.includes('3–6 件事'), '缺少重要事件条数上限');
});

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n✗ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 问页与草稿断言全部通过（${passed} 项）`);
