#!/usr/bin/env node
/**
 * 待办父子关系与「只剩月总结」的纯逻辑断言。**不联网、不调用 AI、不碰数据库。**
 *
 * 覆盖的是「在 node 里就能证明」的那部分：
 *   - 勾一条待办到底会牵动谁（`planToggle` 的四条规则）；
 *   - 子项跟随父项、孤儿不丢、导出时缩进对；
 *   - 缺口清单只算月，且旧日小结填不掉月的缺口。
 *
 * **跑不到的那部分必须显式标注未验证**：SQLite 迁移（v11）、真机上的勾选手感、
 * 键盘弹起时编辑层的位置。这些只有装 APK 才知道。
 *
 * 用法：node scripts/assert_todos.cjs
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.tmp-assert-todos');

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

// ---------------------------------------------------------------------------
// 编译纯函数模块（和 test:md / assert_readers 同样的做法）
// ---------------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true });

const tscArgs = [
  require.resolve('typescript/bin/tsc'),
  '--ignoreConfig',
  'src/util/todoTree.ts',
  'src/util/digest.ts',
  'src/util/mdBuild.ts',
  'src/util/calendar.ts',
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

const todoTree = require(path.join(outDir, 'util', 'todoTree.js'));
const digest = require(path.join(outDir, 'util', 'digest.js'));
const mdBuild = require(path.join(outDir, 'util', 'mdBuild.js'));
const calendar = require(path.join(outDir, 'util', 'calendar.js'));

// ---------------------------------------------------------------------------
// 构造数据
// ---------------------------------------------------------------------------
function todo(id, text, extra = {}) {
  return {
    id,
    text,
    dueAt: null,
    done: false,
    doneAt: null,
    sourceFragmentId: null,
    createdAt: 1000 + id,
    mergedInto: null,
    parentId: null,
    ...extra,
  };
}

/** planToggle 返回的是 [{id, done}]，比较时摊成 Map */
function planMap(steps) {
  const m = new Map();
  for (const s of steps) m.set(s.id, s.done);
  return m;
}

// ---------------------------------------------------------------------------
// 1. 勾选的四条级联规则
// ---------------------------------------------------------------------------
check('勾父项：父项与全部子项一起完成', () => {
  const list = [
    todo(1, '发布新版本'),
    todo(2, '写更新说明', { parentId: 1 }),
    todo(3, '发通知', { parentId: 1 }),
  ];
  const p = planMap(todoTree.planToggle(list, 1, true));
  eq(p.get(1), true, '父项');
  eq(p.get(2), true, '子项一');
  eq(p.get(3), true, '子项二');
  eq(p.size, 3, '只应牵动这三条');
});

check('取消父项：子项一起退回未完成', () => {
  const list = [
    todo(1, '发布新版本', { done: true, doneAt: 1 }),
    todo(2, '写更新说明', { parentId: 1, done: true, doneAt: 1 }),
    todo(3, '发通知', { parentId: 1, done: true, doneAt: 1 }),
  ];
  const p = planMap(todoTree.planToggle(list, 1, false));
  eq(p.get(1), false, '父项');
  eq(p.get(2), false, '子项一');
  eq(p.get(3), false, '子项二');
});

check('子项全勾完：父项自动完成', () => {
  const list = [
    todo(1, '发布新版本'),
    todo(2, '写更新说明', { parentId: 1, done: true }),
    todo(3, '发通知', { parentId: 1 }),
  ];
  const p = planMap(todoTree.planToggle(list, 3, true));
  eq(p.get(3), true, '最后一条子项');
  eq(p.get(1), true, '父项跟着完成');
});

check('子项没全勾完：父项不下沉成完成', () => {
  const list = [
    todo(1, '发布新版本'),
    todo(2, '写更新说明', { parentId: 1 }),
    todo(3, '发通知', { parentId: 1 }),
  ];
  const p = planMap(todoTree.planToggle(list, 3, true));
  eq(p.get(1), false, '还有一条没勾，父项不能完成');
});

check('取消任一子项：父项退回未完成', () => {
  const list = [
    todo(1, '发布新版本', { done: true, doneAt: 1 }),
    todo(2, '写更新说明', { parentId: 1, done: true, doneAt: 1 }),
    todo(3, '发通知', { parentId: 1, done: true, doneAt: 1 }),
  ];
  const p = planMap(todoTree.planToggle(list, 2, false));
  eq(p.get(2), false, '被取消的子项');
  eq(p.get(1), false, '父项必须退回');
});

check('没有子项也不是子项：只改自己', () => {
  const list = [todo(1, '买牛奶'), todo(2, '交电费')];
  const steps = todoTree.planToggle(list, 2, true);
  eq(steps.length, 1, '只应有一条');
  eq(steps[0].id, 2, '目标 id');
  eq(steps[0].done, true, '目标状态');
});

check('找不到的 id 当作无操作，不抛错', () => {
  const steps = todoTree.planToggle([todo(1, 'a')], 999, true);
  eq(steps.length, 0, '空数组');
});

check('父项已被合并（不在列表里）时，子项仍能勾', () => {
  // 列表里只有子项，父项不参与（被合并掉了）—— 不该因为找不到父项就报错
  const list = [todo(2, '写更新说明', { parentId: 1 })];
  const p = planMap(todoTree.planToggle(list, 2, true));
  eq(p.get(2), true, '子项自己变了');
  eq(p.size, 1, '没有别的条目被牵动');
});

// ---------------------------------------------------------------------------
// 2. 树的构建与孤儿
// ---------------------------------------------------------------------------
check('子项跟随父项，按创建时间升序', () => {
  const list = [
    todo(3, '第三步', { parentId: 1, createdAt: 3000 }),
    todo(1, '父项'),
    todo(2, '第一步', { parentId: 1, createdAt: 2000 }),
    todo(4, '另一件事'),
  ];
  const tree = todoTree.buildTodoTree(list);
  eq(tree.length, 2, '两条顶层');
  eq(tree[0].todo.id, 1, '顶层保持传入顺序');
  eq(tree[0].children.length, 2, '父项挂着两条');
  eq(tree[0].children[0].id, 2, '先创建的子项在前');
  eq(tree[1].todo.id, 4, '第二条顶层');
  eq(tree[1].children.length, 0, '没有子项');
});

check('父项不存在的子项不进树，但不会被丢掉', () => {
  const list = [todo(1, '孤儿', { parentId: 99 })];
  const tree = todoTree.buildTodoTree(list);
  eq(tree.length, 0, '没有顶层');
  const orphans = todoTree.orphanTodos(list);
  eq(orphans.length, 1, '孤儿要能拿到');
  eq(orphans[0].id, 1, '就是它');
});

check('拍平后父项后面紧跟子项，孤儿排在末尾', () => {
  const list = [
    todo(1, '父项'),
    todo(2, '子项', { parentId: 1 }),
    todo(3, '孤儿', { parentId: 99 }),
    todo(4, '另一件事'),
  ];
  const flat = todoTree.flattenTodos(list).map(({ todo: t, depth }) => `${t.id}@${depth}`);
  eq(flat.join(','), '1@0,2@1,4@0,3@0', '顺序与层级');
});

check('openChildCount 只数未完成的子项', () => {
  const list = [
    todo(1, '父项'),
    todo(2, 'a', { parentId: 1, done: true }),
    todo(3, 'b', { parentId: 1 }),
  ];
  const node = todoTree.buildTodoTree(list)[0];
  const c = todoTree.openChildCount(node);
  eq(c.open, 1, '未完成 1 条');
  eq(c.total, 2, '共 2 条');
});

// ---------------------------------------------------------------------------
// 3. 导出：子项必须有缩进
// ---------------------------------------------------------------------------
check('导出 Markdown 时子项缩进两格', () => {
  const out = mdBuild.buildMarkdown(
    [],
    [todo(1, '发布新版本'), todo(2, '写更新说明', { parentId: 1 })],
  );
  assert(out.content.includes('- [ ] 发布新版本'), '父项应是一级列表');
  assert(out.content.includes('  - [ ] 写更新说明'), '子项应是缩进的二级列表');
});

check('导出时已完成与未完成分开计数，子项跟着父项走', () => {
  const out = mdBuild.buildMarkdown(
    [],
    [
      todo(1, '父项'),
      todo(2, '子项', { parentId: 1, done: true }),
    ],
  );
  // 父项未完成、子项已完成：子项留在父项下面，但打的是勾
  assert(out.content.includes('- [ ] 父项'), '父项未完成');
  assert(out.content.includes('  - [x] 子项'), '子项已完成且缩进');
});

// ---------------------------------------------------------------------------
// 4. 缺口清单只剩月
// ---------------------------------------------------------------------------
function frag(id, createdAt) {
  return {
    id,
    content: 'x',
    createdAt,
    source: 'app',
    status: 'inbox',
    tags: [],
    project: null,
    mergedInto: null,
    nature: null,
  };
}

function note(id, type, period, createdAt = 1) {
  return { id, type, title: null, bodyMd: 'x', period, createdAt };
}

const NOW = new Date(2026, 10, 10, 12).getTime(); // 2026-11-10 12:00 本地时间
const OCT = new Date(2026, 9, 15, 9).getTime();
const SEP = new Date(2026, 8, 15, 9).getTime();

check('缺口清单按月给出，跳过还没结束的当月', () => {
  const fragments = [frag(1, OCT), frag(2, OCT), frag(3, NOW)];
  const { items, total } = digest.missingDigests(fragments, [], 10, NOW);
  eq(total, 1, '只有 10 月这一个缺口');
  eq(items[0].period, '2026-10', '周期键');
  eq(items[0].count, 2, '当月两条碎片');
});

check('已经有月总结的月份不出现', () => {
  const fragments = [frag(1, SEP), frag(2, OCT)];
  const notes = [note(1, 'monthly', '2026-09')];
  const { items } = digest.missingDigests(fragments, notes, 10, NOW);
  eq(items.length, 1, '只剩 10 月');
  eq(items[0].period, '2026-10', '9 月已被总结覆盖');
});

check('旧的日小结填不掉月的缺口', () => {
  // 这条是这次改动的关键：迁移前库里可能还留着 daily 的行，
  // 如果按 period 字符串匹配（不看 type），2026-10-15 的日小结
  // 会被误认为「10 月已经写过」—— 用户会看到缺口凭空少一个
  const fragments = [frag(1, OCT)];
  const notes = [note(1, 'daily', '2026-10-15')];
  const { items, total } = digest.missingDigests(fragments, notes, 10, NOW);
  eq(total, 1, '10 月仍然是缺口');
  eq(items[0].period, '2026-10', '周期键');
});

check('按时间倒序，最多给 limit 条', () => {
  const fragments = [
    frag(1, new Date(2026, 6, 1).getTime()),
    frag(2, new Date(2026, 7, 1).getTime()),
    frag(3, SEP),
  ];
  const { items, total } = digest.missingDigests(fragments, [], 2, NOW);
  eq(total, 3, '一共三个缺口');
  eq(items.length, 2, '只给两条');
  eq(items[0].period, '2026-09', '最近的在最前');
  eq(items[1].period, '2026-08', '然后是 8 月');
});

// ---------------------------------------------------------------------------
// 5. 日历网格（回顾页 v0.22 新增）
// ---------------------------------------------------------------------------
check('日历固定 42 格，第一格是周一，本月天数不多不少', () => {
  for (const [y, m, days] of [[2026, 11, 30], [2026, 2, 28], [2028, 2, 29], [2026, 8, 31]]) {
    const cells = calendar.monthCells(y, m);
    eq(cells.length, 42, `${y}-${m} 的格子数`);
    eq(cells.filter((c) => c.inMonth).length, days, `${y}-${m} 的本月天数`);
    // 第 1、8、15… 格必须是周一，否则表头那排「一二三四五六日」是错的
    for (let i = 0; i < 42; i += 7) {
      const d = new Date(calendar.keyToTs(cells[i].key));
      eq(d.getDay(), 1, `${y}-${m} 第 ${i / 7 + 1} 行第一格应是周一`);
    }
  }
});

check('日历把上下月补齐的日子也带上，且 key 连续递增', () => {
  const cells = calendar.monthCells(2026, 11);
  eq(cells[0].key < '2026-11-01', true, '第一格应属于上个月');
  eq(cells[41].key > '2026-11-30', true, '最后一格应属于下个月');
  for (let i = 1; i < cells.length; i++) {
    const prev = calendar.keyToTs(cells[i - 1].key);
    const now = calendar.keyToTs(cells[i].key);
    eq(now - prev, 86400000, `第 ${i} 格与前一格应正好差一天`);
  }
  // 补的那几天不能算进本月，否则「本月记了几天」会多算
  eq(cells.filter((c) => c.inMonth).every((c) => c.month === 11), true, 'inMonth 必须都是 11 月');
});

check('翻月跨年交给 Date 算，不手写 12→1', () => {
  eq(JSON.stringify(calendar.shiftMonth({ year: 2026, month: 12 }, 1)), JSON.stringify({ year: 2027, month: 1 }));
  eq(JSON.stringify(calendar.shiftMonth({ year: 2026, month: 1 }, -1)), JSON.stringify({ year: 2025, month: 12 }));
  eq(JSON.stringify(calendar.shiftMonth({ year: 2026, month: 3 }, -3)), JSON.stringify({ year: 2025, month: 12 }));
});

check('keyToTs 按本地时区解析，不经过 UTC', () => {
  // 用 new Date('2026-11-15') 会按 UTC 解析，东八区会退到 14 日 08:00 之前
  eq(calendar.keyToTs('2026-11-15'), new Date(2026, 10, 15).getTime(), '本地零点');
  eq(calendar.WEEKDAY_HEADS.length, 7, '表头七天');
  eq(calendar.WEEKDAY_HEADS[0], '一', '一周从周一开始');
});

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n✗ ${failures.length} 项失败（通过 ${passed} 项）`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ 待办与小结断言全部通过（${passed} 项）`);
