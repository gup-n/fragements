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
  'src/util/batch.ts',
  'src/util/jsonRepair.ts',
  'src/util/fragmentText.ts',
  'src/util/inlineImages.ts',
  'src/util/mdBlocks.ts',
  'src/util/pendingImages.ts',
  'src/util/urls.ts',
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

const { planDraftInput, routeAsk, showsDraftAsk, wantsAll } = require(path.join(outDir, 'util', 'askIntent.js'));
const doc = require(path.join(outDir, 'util', 'knowledgeDoc.js'));
const batch = require(path.join(outDir, 'util', 'batch.js'));
const json = require(path.join(outDir, 'util', 'jsonRepair.js'));
const text = require(path.join(outDir, 'util', 'fragmentText.js'));
const urls = require(path.join(outDir, 'util', 'urls.js'));
const inline = require(path.join(outDir, 'util', 'inlineImages.js'));
const mdBlocks = require(path.join(outDir, 'util', 'mdBlocks.js'));
const pending = require(path.join(outDir, 'util', 'pendingImages.js'));

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
// 1.9 草稿开着时，新的一句话算改稿还是新的一轮（v0.20.3）
// ---------------------------------------------------------------------------
check('草稿开着说「再整理一下待办」：新开一轮待办，不是拿去改稿', () => {
  const plan = planDraftInput('再整理一下待办', 0);
  eq(plan.kind, 'new', '应当开新一轮');
  eq(plan.mode, 'todos', '模式是待办');
});

check('「整理所有碎片」在草稿没有待写入时也开新一轮，模式是知识', () => {
  const plan = planDraftInput('整理所有碎片', 0);
  eq(plan.kind, 'new', '新开一轮');
  eq(plan.mode, 'knowledge', '知识文档');
});

check('草稿里还有没写入的东西：新整理被挡住，不能悄悄覆盖', () => {
  eq(planDraftInput('整理所有碎片', 2).kind, 'blocked', '有没写入的就挡');
  eq(planDraftInput('整理待办', 1).kind, 'blocked', '待办也一样');
});

check('「把第二段并进第一段」是改稿，不是新任务', () => {
  eq(planDraftInput('把第二段并进第一段', 3).kind, 'revise', '改稿');
  eq(planDraftInput('短一点', 0).kind, 'revise', '没提到整理就还是改稿');
});

// ---------------------------------------------------------------------------
// 1.10 草稿上方的用户气泡要不要画（v0.20.4）
// ---------------------------------------------------------------------------
check('草稿刚开、历史里还没有这一轮：气泡要画', () => {
  eq(showsDraftAsk([], '整理一下碎片'), true, '空历史要画');
  eq(showsDraftAsk([{ question: '你好', kind: undefined }], '整理一下碎片'), true, '上面是问答也要画');
});

check('历史最后一条已经是同一句整理：气泡让位，不能出现两次', () => {
  const turns = [{ question: '整理一下碎片', kind: 'organize' }];
  eq(showsDraftAsk(turns, '整理一下碎片'), false, '同一句不画');
  eq(showsDraftAsk(turns, '  整理一下碎片  '), false, '前后空格不算不同');
});

check('改过稿之后气泡回来（历史里那句已经旧了）', () => {
  const turns = [{ question: '整理一下碎片', kind: 'organize' }];
  eq(showsDraftAsk(turns, '短一点'), true, '新句要显示');
  eq(showsDraftAsk(turns, ''), false, '没有话就不画');
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
// 3.6 v0.18：整理全部、跨批合并、写进历史的那句话
// ---------------------------------------------------------------------------
check('说「所有」才算全部：光说「整理一下」只取最近一批', () => {
  eq(wantsAll('把所有这些碎片整理一下'), true, '所有这些碎片');
  eq(wantsAll('整理全部记录'), true, '全部记录');
  eq(wantsAll('把整个库过一遍'), true, '整个库');
  eq(wantsAll('整理一下'), false, '光说整理');
  eq(wantsAll(undefined), false, '没有指令');
});

check('「整理所有碎片」真的会切多批，不是只看 40 条', () => {
  const pool = Array.from({ length: 130 }, (_, i) => ({
    id: i + 1,
    content: 'x'.repeat(20),
    createdAt: i,
    source: 'manual',
    status: 'inbox',
    tags: [],
    project: null,
    mergedInto: null,
    nature: null,
  }));
  const batches = batch.sliceBatches(pool);
  eq(batches.length, 4, '130 条 / 每批 40 条 = 4 批');
  eq(batches.reduce((n, b) => n + b.length, 0), 130, '一条都不能漏');
  eq(batches[0].length, 40, '每批 40 条');
});

check('批数有上限，超出的留给下一次（不静默吞掉）', () => {
  const pool = Array.from({ length: 600 }, (_, i) => ({
    id: i + 1,
    content: 'x',
    createdAt: i,
    source: 'manual',
    status: 'inbox',
    tags: [],
    project: null,
    mergedInto: null,
    nature: null,
  }));
  const batches = batch.sliceBatches(pool, 3);
  eq(batches.length, 3, '最多 3 批');
  assert(pool.length - batches.reduce((n, b) => n + b.length, 0) > 0, '应当有剩余条数交给游标');
});

check('跨批合并：同名文档不重复，超上限的计入 dropped', () => {
  const a = doc.normalizeDraft({ docs: [{ title: '换盘顺序', body_md: 'A' }] }, 'knowledge', [1]);
  const b = doc.normalizeDraft(
    { docs: [{ title: '换盘顺序', body_md: 'B' }, { title: '报错含义', body_md: 'C' }] },
    'knowledge',
    [2],
  );
  const { draft, dropped } = doc.mergeDrafts(a, b);
  eq(draft.docs.length, 2, '同名只留一篇，另一篇照收');
  eq(dropped, 1, '被挡掉一篇要能报出来');
  eq(draft.sourceIds.length, 2, '来源 id 要并起来');
});

check('跨批合并：同一件事不会因为分两批就出现两条', () => {
  const a = doc.normalizeDraft(
    { todos: [{ text: '换盘', children: [{ text: '跑 SMART 长检' }] }] },
    'todos',
    [],
  );
  const b = doc.normalizeDraft(
    { todos: [{ text: '换盘 ', children: [{ text: '跑 SMART 长检' }, { text: '确认热备' }] }] },
    'todos',
    [],
  );
  const { draft } = doc.mergeDrafts(a, b);
  eq(draft.todos.length, 1, '还是同一件事');
  eq(draft.todos[0].children.length, 2, '缺的那一步要补齐');
});

check('写进历史的那句话只说结果', () => {
  const d = doc.normalizeDraft(
    {
      docs: [{ title: '换盘顺序', body_md: 'x' }],
      todos: [{ text: '换盘', children: [{ text: '长检' }] }],
    },
    'knowledge',
    [],
  );
  const line = doc.describeForHistory(d);
  assert(line.includes('1 篇文档'), `缺少篇数：${line}`);
  assert(line.includes('《换盘顺序》'), `缺少标题：${line}`);
  assert(line.includes('2 条待办'), `待办要含子项：${line}`);
  assert(!line.includes('失败'), '不该出现失败字样');
});

check('什么都没有时不假装整理成功', () => {
  const line = doc.describeForHistory(doc.emptyDraft('knowledge', []), 0);
  assert(line.includes('没有可沉淀的知识'), `应当如实说没有：${line}`);
});

check('被截断时如实报还剩多少条', () => {
  const d = doc.normalizeDraft({ docs: [{ title: 'x', body_md: 'y' }] }, 'knowledge', []);
  assert(doc.describeForHistory(d, 320).includes('320 条'), '剩余条数要出现');
});

// ---------------------------------------------------------------------------
// 3.7 模型 JSON 的宽容解析（v0.18.1）
// ---------------------------------------------------------------------------
check('合法的 JSON 原样解析，不算「修过」', () => {
  const r = json.parseJsonLenient('{"docs":[{"title":"a"}]}');
  eq(r.ok, true, '应当成功');
  eq(r.repaired, false, '没坏就别修');
  eq(r.value.docs[0].title, 'a', '内容');
});

check('Windows 路径少转义一个反斜杠也能读出来', () => {
  // 模型写的 `\\server\queue` 少转义了一次 → \s \q 都是非法转义，JSON.parse 必挂
  const r = json.parseJsonLenient('{"path":"\\wsus-nbwyt\\NFCC新刷卡打印机"}');
  eq(r.ok, true, `应当被修复：${JSON.stringify(r)}`);
  eq(r.repaired, true, '要标出「修过」');
  eq(r.value.path, '\\wsus-nbwyt\\NFCC新刷卡打印机', '反斜杠按字面保留');
});

check('字符串里的裸换行会被补成 \\n', () => {
  const r = json.parseJsonLenient('{"a":"第一行\n第二行"}');
  eq(r.ok, true, '应当被修复');
  eq(r.value.a, '第一行\n第二行', '内容不变');
});

check('尾逗号这种笔误会被删掉', () => {
  const r = json.parseJsonLenient('{"docs":[{"title":"a"},],"note":"x",}');
  eq(r.ok, true, `应当被修复：${JSON.stringify(r)}`);
  eq(r.value.docs.length, 1, '内容不变');
  eq(r.value.note, 'x', '保留后面的字段');
});

check('包在代码围栏和解释文字里也能取出 JSON', () => {
  const raw = '好的，整理如下：\n```json\n{"docs":[]}\n```\n还需要我补充吗？';
  const r = json.parseJsonLenient(raw);
  eq(r.ok, true, '应当成功');
  eq(Array.isArray(r.value.docs), true, '取到的是对象本体');
});

check('正文里带花括号不影响切片', () => {
  const r = json.parseJsonLenient('说明如下 {"a":"含 } 的字符串"} 后面还有字');
  eq(r.ok, true, '应当成功');
  eq(r.value.a, '含 } 的字符串', '内容完整');
});

check('截断的 JSON 不硬修，要说清是末尾断掉', () => {
  const r = json.parseJsonLenient('{"docs":[{"title":"a","body_md":"写到一半');
  eq(r.ok, false, '不能假装成功');
  assert(/断掉|截断/.test(r.problem.reason), `原因要说准：${r.problem.reason}`);
  assert(r.problem.near.length > 0, '要给出附近原文');
});

check('语法错时给出位置，不是只说「不合法的 JSON」', () => {
  const r = json.parseJsonLenient('{"docs":[{"title":"a" "body_md":"b"}]}');
  eq(r.ok, false, '确实解析不了');
  assert(typeof r.problem.at === 'number', '要有下标');
  assert(r.problem.near.includes('title'), `附近原文要能定位：${r.problem.near}`);
});

// ---------------------------------------------------------------------------
// 3.8 配图的文字层（v0.19 一张图 / v0.20 多张图）
// ---------------------------------------------------------------------------
/** 造一张配图。`text: null` = 还没读过，'' = 读过但没读出内容 —— 两者必须能分开 */
const pic = (id, t) => ({ id, path: `p${id}.jpg`, text: t, createdAt: id });

check('纯文字碎片原样返回，不会被加上任何标记', () => {
  eq(text.fragmentText({ content: '换盘先跑 SMART', images: [] }), '换盘先跑 SMART', '正文');
});

check('有图文字时拼在正文后面，中间用分隔标记', () => {
  const out = text.fragmentText({ content: '这块主板', images: [pic(1, 'B760M 迫击炮')] });
  assert(out.includes('这块主板'), '正文要在');
  assert(out.includes('B760M 迫击炮'), '图文字要在');
  assert(out.includes(text.IMAGE_MARK), '要有标记区分两块内容');
});

check('只有图文字没有正文时也能读', () => {
  const out = text.fragmentText({ content: '   ', images: [pic(1, '蓝屏 0x0000007B')] });
  eq(out, `${text.IMAGE_MARK} 蓝屏 0x0000007B`, '只有图文字');
});

check('两张图各标各的编号，不会被连成一段', () => {
  const out = text.fragmentText({ content: '', images: [pic(1, 'AAA'), pic(2, 'BBB')] });
  assert(out.includes('第 1 张') && out.includes('第 2 张'), '多图要编号');
  assert(out.indexOf('AAA') < out.indexOf('BBB'), '顺序按加入顺序');
  assert(!out.includes(`${text.IMAGE_MARK} AAA`), '多图时不能退化成同一套标记');
});

check('空串（解析过但没读出东西）不算内容', () => {
  eq(text.fragmentText({ content: '', images: [pic(1, '')] }), '', '空');
  eq(text.hasReadableText({ content: '', images: [pic(1, '')] }), false, '不能进整理材料');
});

check('纯图还没解析：既没有正文也没有图文字', () => {
  eq(text.fragmentText({ content: '', images: [pic(1, null)] }), '', '空');
  eq(text.hasReadableText({ content: '', images: [pic(1, null)] }), false, '不能进材料');
});

check('图的状态：没读 / 正在读 / 失败 / 读空 / 有字，各说各的', () => {
  const base = pic(7, null);
  eq(text.imageStateOf(base, new Set(), {}), 'idle', '还没读');
  eq(text.imageStateOf(base, new Set([7]), {}), 'busy', '正在读');
  eq(text.imageStateOf(base, new Set(), { '7': '超时' }), 'fail', '失败了要能重试');
  eq(text.imageStateOf({ ...base, text: '' }, new Set(), {}), 'empty', '读过了但没字');
  eq(text.imageStateOf({ ...base, text: '有字' }, new Set(), {}), 'read', '读出来了');
});

check('装箱预算把图文字算进去，不是只算正文', () => {
  const frag = (id, content, t) => ({
    id,
    content,
    images: t === null ? [] : [pic(id, t)],
    createdAt: id,
    source: 'manual',
    status: 'inbox',
    tags: [],
    project: null,
    mergedInto: null,
    nature: null,
    organizedAt: null,
  });
  // 三条各 100 字正文 + 100 字图文字 = 每条实际 200+ 字
  const pool = [
    frag(1, 'a'.repeat(100), 'b'.repeat(100)),
    frag(2, 'a'.repeat(100), 'b'.repeat(100)),
    frag(3, 'a'.repeat(100), 'b'.repeat(100)),
  ];
  // 预算 500：只算正文会收满 3 条（300），算上图文字就是 2 条（约 440）
  eq(batch.packFragments(pool, 40, 500).length, 2, '图文字要占预算');
});

// ---------------------------------------------------------------------------
// 3.8b 正文里的图片定位（v0.20.1）
// ---------------------------------------------------------------------------
check('正文里的图片标记能认出来，并按出现顺序返回 id', () => {
  const body = '第一段\n![](img:12)\n第二段\n![](img:7)';
  eq(inline.referencedImageIds(body).join(','), '12,7', '按出现顺序');
  eq(inline.imageIdOfLine('  ![](img:3) '), 3, '容忍缩进与空格');
  eq(inline.imageIdOfLine('![](img:p1)'), null, '待发键不是真图');
  eq(inline.imageIdOfLine('看这张 ![](img:3)'), null, '行内混排不算定位');
});

check('剥离标记：正文、索引、导出用的是同一个函数', () => {
  eq(inline.stripImageTokens('a\n![](img:12)\nb'), 'a\n\nb', '整行去掉');
  eq(inline.stripImageTokens('前文 ![](img:12) 后文'), '前文  后文', '行内残留也去掉');
});

check('待发标记落库时换成真 id', () => {
  const out = inline.resolvePendingTokens('a\n![](img:p1)\nb', [{ key: 'p1', imageId: 42 }]);
  eq(out, 'a\n![](img:42)\nb', '换成真 id');
  eq(inline.resolvePendingTokens('纯文字', [{ key: 'p1', imageId: 42 }]), '纯文字', '没标记就原样');
});

check('删图时正文里指向它的那一行也去掉', () => {
  eq(inline.removeImageToken('a\n![](img:12)\nb', 12), 'a\nb', '整行去掉');
  eq(inline.removeImageToken('a\n![](img:13)\nb', 12), 'a\n![](img:13)\nb', '别的图不动');
});

check('只有没定位的图才铺在正文上方', () => {
  const imgs = [pic(1, 'x'), pic(2, 'y')];
  const loose = inline.looseImages({ content: '![](img:1)', images: imgs });
  eq(loose.length, 1, '已定位的不再重复铺一遍');
  eq(loose[0].id, 2, '剩下的是没定位的那张');
});

check('分块把图片标记认成图片块，不当正文', () => {
  const blocks = mdBlocks.parseBlocks('第一段\n![](img:5)\n第二段');
  eq(blocks.length, 3, '三块');
  eq(blocks[1].kind, 'image', '中间是图片块');
  eq(blocks[1].id, 5, '带 id');
});

check('卡片预览里图片降级成占位文字，不吐出标记', () => {
  const flat = mdBlocks.flattenForPreview(mdBlocks.parseBlocks('![](img:5)'));
  assert(!JSON.stringify(flat).includes('img:5'), '预览不该出现标记原文');
});

check('图文字拼接前先剥标记，模型看不到 `![](img:12)`', () => {
  const out = text.fragmentText({
    content: '换盘前\n![](img:9)\n先跑 SMART',
    images: [pic(9, 'SMART 截图')],
  });
  assert(!out.includes('img:9'), '材料里不该有标记');
  assert(out.includes('换盘前') && out.includes('SMART 截图'), '正文与图文字都还在');
});

// ---------------------------------------------------------------------------
// 3.8c 读图的时机：只挑没读过的，一轮有上限（v0.20.2）
// ---------------------------------------------------------------------------
check('只挑没读过的图：读过（含空结论）的不再读', () => {
  const frag = {
    id: 1,
    content: '这块盘有异响',
    images: [pic(11, 'SMART 截图'), pic(12, ''), pic(13, null)],
  };
  const { list, rest } = pending.pendingImagesOf([frag]);
  eq(list.length, 1, '只有 null 的那张');
  eq(list[0].imageId, 13, '挑出的是没读过的那张');
  eq(rest, 0, '没有落下的');
});

check('纯文字碎片没有待读的图', () => {
  eq(pending.pendingImagesOf([{ id: 2, content: '只有字', images: [] }]).list.length, 0, '空');
});

check('一轮有上限，剩下的要报出来（不能假装全读完了）', () => {
  const frag = {
    id: 3,
    content: '一堆截图',
    images: [1, 2, 3, 4, 5].map((i) => pic(i, null)),
  };
  const { list, rest } = pending.pendingImagesOf([frag], 2);
  eq(list.length, 2, '只给两张');
  eq(rest, 3, '剩下三张如实报');
  eq(pending.pendingImagesOf([frag], 0).list.length, 0, '上限为 0 时一张都不读');
});

check('待读的图带上那条碎片的正文（同一张图，正文不同要抄的东西不同）', () => {
  const body = '这个报错啥意思 然后一张图 ![](img:9) 结束';
  const { list } = pending.pendingImagesOf([{ id: 4, content: body, images: [pic(9, null)] }]);
  eq(list[0].fragmentId, 4, '记着是哪一条的');
  eq(list[0].hint, '这个报错啥意思 然后一张图 结束', '正文里的定位标记要剥掉');
  eq(list[0].path, 'p9.jpg', '文件相对名照带');
});

check('按碎片顺序排队：先记的先读', () => {
  const { list } = pending.pendingImagesOf([
    { id: 5, content: 'a', images: [pic(51, null)] },
    { id: 6, content: 'b', images: [pic(61, null)] },
  ]);
  eq(list.map((x) => x.imageId).join(','), '51,61', '顺序');
});

// ---------------------------------------------------------------------------
// 3.9 联网：链接要认出来，不能当关键词去搜（v0.19.1）
// ---------------------------------------------------------------------------
check('一句话里的链接能被认出来', () => {
  const got = urls.extractUrls('帮我看看这个 https://example.com/a?b=1 说的对不对');
  eq(got.length, 1, '一条链接');
  eq(got[0], 'https://example.com/a?b=1', '原样取出');
});

check('微信分享那种尾巴不会粘进链接', () => {
  const got = urls.extractUrls('https://mp.weixin.qq.com/s/abc123 复制打开抖音，看看【某某】');
  eq(got[0], 'https://mp.weixin.qq.com/s/abc123', '不带后面的中文');
});

check('链接末尾的句号括号会被剪掉', () => {
  eq(urls.extractUrls('看这个（https://example.com/x）。').at(0), 'https://example.com/x', '剪标点');
  eq(urls.extractUrls('见 <https://example.com/y>').at(0), 'https://example.com/y', '去尖括号');
});

check('裸域名不算链接，那条是「搜这个词」不是「读这个站」', () => {
  eq(urls.extractUrls('example.com 这个站怎么进').length, 0, '不猜裸域名');
});

check('同一个链接不重复算', () => {
  eq(urls.extractUrls('https://a.com/x 和 https://a.com/x').length, 1, '去重');
});

check('剥掉链接后剩下用户真正想问的话', () => {
  eq(urls.stripUrls('https://example.com/a 这个报错是什么意思'), '这个报错是什么意思', '剩正文');
});

check('搜索 query 不带链接，超长时在标点处断', () => {
  const q = urls.searchQueryOf('https://example.com/a ' + '很长的描述，'.repeat(30));
  assert(!q.includes('http'), `query 里不该有链接：${q.slice(0, 40)}`);
  assert(q.length <= 128, `不能超过 128 字符，实际 ${q.length}`);
  // 截断只能取原句的前缀：不能把中间的字重新拼起来，也不能带上省略号去搜
  const clean = urls.stripUrls('https://example.com/a ' + '很长的描述，'.repeat(30));
  assert(clean.startsWith(q), '截断结果应当是原句前缀');
  assert(!q.includes('…'), '不该带省略号');
});

check('query 全是链接时返回空串，由调用方决定不去搜', () => {
  eq(urls.searchQueryOf('https://example.com/a'), '', '空');
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
