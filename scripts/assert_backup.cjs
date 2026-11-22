#!/usr/bin/env node
/**
 * 完整备份的**纯逻辑**断言。不联网、不碰文件系统、不碰数据库。
 *
 * 备份这件事真正的风险不在打包，而在**恢复**：
 * 拿错包、包来自更新的版本、包里带路径穿越。这些都能在 node 里证明，
 * 所以放在这里；真正的 zip 读写与 SQLite 文件替换只有装 APK 才知道。
 *
 * 用法：node scripts/assert_backup.cjs
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.tmp-assert-backup');

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
  'src/util/backupPlan.ts',
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

const plan = require(path.join(outDir, 'util', 'backupPlan.js'));

const AT = new Date(2026, 10, 14, 23, 40).getTime();

function goodManifest(extra = {}) {
  return plan.makeManifest({
    now: AT,
    appVersion: '0.20.5',
    schemaVersion: 16,
    counts: { fragments: 123, images: 4, documents: 2 },
    imageNames: ['a.jpg', 'b.jpg'],
    documentNames: ['手册.pdf'],
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// 1. 命名与清单
// ---------------------------------------------------------------------------
check('备份文件名带版本和到分钟的时间，且不含中文（分享器对它更友好）', () => {
  const name = plan.backupFileName(AT, '0.20.5');
  eq(name, 'fragments-backup-v0.20.5-20261114-2340.zip', '文件名');
  assert(!/[\u4e00-\u9fa5]/.test(name), '不该有中文');
});

check('清单列出的文件 = 数据库 + 每张图 + 每份文档', () => {
  const m = goodManifest();
  eq(m.app, 'com.local.fragments', '包名');
  eq(m.files[0], plan.ENTRY.database, '第一项是数据库');
  assert(m.files.includes('images/a.jpg'), '图片要在清单里');
  assert(m.files.includes('documents/手册.pdf'), '文档要在清单里');
  eq(m.files.length, 4, '1 库 + 2 图 + 1 文档');
});

check('清单里只有数据库时也成立（纯文字库）', () => {
  const m = plan.makeManifest({
    now: AT,
    appVersion: '0.20.5',
    schemaVersion: 16,
    counts: { fragments: 3, images: 0, documents: 0 },
    imageNames: [],
    documentNames: [],
  });
  eq(m.files.length, 1, '只有 database');
});

// ---------------------------------------------------------------------------
// 2. 恢复前的校验（四种拒绝 + 一种通过）
// ---------------------------------------------------------------------------
check('不是对象就拒绝', () => {
  eq(plan.checkManifest(null, 16).ok, false, 'null');
  eq(plan.checkManifest('x', 16).ok, false, '字符串');
});

check('别的 App 的备份拒绝', () => {
  const r = plan.checkManifest({ ...goodManifest(), app: 'com.other.app' }, 16);
  eq(r.ok, false, '要拒绝');
  assert(r.reason.includes('碎片'), '理由要点名');
});

check('清单格式比本机新 → 拒绝并让人升级', () => {
  const r = plan.checkManifest({ ...goodManifest(), manifestVersion: plan.MANIFEST_VERSION + 1 }, 16);
  eq(r.ok, false, '要拒绝');
  assert(r.reason.includes('升级'), '理由要给出路');
});

check('库版本比本机新 → 拒绝（迁移只能往前）', () => {
  const r = plan.checkManifest({ ...goodManifest(), schemaVersion: 17 }, 16);
  eq(r.ok, false, '要拒绝');
  assert(r.reason.includes('v17') && r.reason.includes('v16'), '要把两个版本都写出来');
});

check('同版本或更旧的库 → 允许（旧包会被迁移补上）', () => {
  eq(plan.checkManifest(goodManifest(), 16).ok, true, '同版本');
  eq(plan.checkManifest({ ...goodManifest(), schemaVersion: 12 }, 16).ok, true, '旧版本');
});

check('清单里没有数据库 → 拒绝', () => {
  const r = plan.checkManifest({ ...goodManifest(), files: ['images/a.jpg'] }, 16);
  eq(r.ok, false, '要拒绝');
});

check('计数缺失或非法时归零，不能把 NaN 显示给用户', () => {
  const r = plan.checkManifest(
    { ...goodManifest(), counts: { fragments: 'x', images: -3, documents: undefined } },
    16,
  );
  eq(r.ok, true, '仍然可以恢复');
  eq(r.manifest.counts.fragments, 0, 'fragments');
  eq(r.manifest.counts.images, 0, 'images');
  eq(r.manifest.counts.documents, 0, 'documents');
});

// ---------------------------------------------------------------------------
// 3. 只写清单列过、且路径合法的文件
// ---------------------------------------------------------------------------
check('清单里列了、包里也有 → 分到正确的桶', () => {
  const m = goodManifest();
  const r = plan.planRestoreEntries(m, ['database/fragments.db', 'images/a.jpg', 'images/b.jpg', 'documents/手册.pdf', 'extra.txt']);
  eq(r.database, 'database/fragments.db', '数据库');
  eq(r.images.length, 2, '两张图');
  eq(r.documents.length, 1, '一份文档');
  eq(r.missing.length, 0, '没有缺');
});

check('清单里列了但包里没有 → 记进 missing（恢复不完整要说出来）', () => {
  const r = plan.planRestoreEntries(goodManifest(), ['database/fragments.db']);
  eq(r.database, 'database/fragments.db', '数据库在');
  eq(r.missing.length, 3, '2 图 + 1 文档都缺');
});

check('包里有但清单没列 → 一律不写出去', () => {
  const r = plan.planRestoreEntries(goodManifest(), [
    'database/fragments.db',
    'images/a.jpg',
    'images/b.jpg',
    'documents/手册.pdf',
    'images/evil.sh',
  ]);
  assert(![...r.images, ...r.documents].includes('evil.sh'), '多出来的条目不能落地');
});

check('路径穿越与绝对路径被拒绝', () => {
  const m = goodManifest();
  m.files = ['database/fragments.db', 'images/../../etc/passwd', 'images//etc/x.jpg', 'C:/windows/x.jpg'];
  const r = plan.planRestoreEntries(m, [
    'database/fragments.db',
    'images/../../etc/passwd',
    'images//etc/x.jpg',
    'C:/windows/x.jpg',
  ]);
  eq(r.images.length, 0, '一张都不该收');
  eq(r.missing.length, 3, '三个都被拒');
});

// ---------------------------------------------------------------------------
// 4. 文件头与体积
// ---------------------------------------------------------------------------
check('SQLite 文件头认得出来', () => {
  const head = new Uint8Array([...Buffer.from('SQLite format 3\u0000'), 0, 0]);
  eq(plan.looksLikeSqlite(head), true, 'SQLite');
});

check('PNG 头不会被当成数据库', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  eq(plan.looksLikeSqlite(png), false, 'PNG 要拒绝');
});

check('太短的字节不算 SQLite', () => {
  eq(plan.looksLikeSqlite(new Uint8Array([0x53, 0x51])), false, '短');
});

check('体积文案换单位，不给一串裸数字', () => {
  eq(plan.humanBytes(0), '0 B', '0');
  eq(plan.humanBytes(512), '512 B', 'B');
  eq(plan.humanBytes(2048), '2 KB', 'KB');
  eq(plan.humanBytes(5 * 1024 * 1024), '5.0 MB', 'MB');
  eq(plan.humanBytes(2 * 1024 * 1024 * 1024), '2.00 GB', 'GB');
});

check('超过单次上限要拒绝，而不是让系统把 App 杀掉', () => {
  eq(plan.overSizeLimit(plan.BACKUP_SIZE_LIMIT), false, '刚好不超');
  eq(plan.overSizeLimit(plan.BACKUP_SIZE_LIMIT + 1), true, '超一点就拒');
});

/* ------------------------------------------------------------------ */
/* 源码契约：恢复必须是两阶段换名，启动要能收拾中间态                    */
/* ------------------------------------------------------------------ */

check('恢复先写 .new 再换名，不许先删主库', () => {
  const src = fs.readFileSync(path.join(root, 'src/db/backup.ts'), 'utf8');
  assert(src.includes("const DB_NEW = `${DB_NAME}.new`"), '要有 .new 暂存名');
  assert(src.includes('swapStagedDatabase'), '要有一个统一的换名函数');
  assert(src.includes('recoverInterruptedRestore'), '要有启动兜底');
  assert(src.includes('restoreSafetyCopy'), '恢复点要能恢复');
  const fn = src.slice(
    src.indexOf('export async function restoreBackup('),
    src.indexOf('export async function restoreSafetyCopy('),
  );
  assert(fn.length > 0, '找不到 restoreBackup');
  assert(!/target\.delete\(\)/.test(fn), '恢复备份里还有「先删主库」的旧写法');
});

check('启动先收拾恢复中间件，迁移失败能退回 .old', () => {
  const repo = fs.readFileSync(path.join(root, 'src/db/repo.native.ts'), 'utf8');
  const init = repo.slice(repo.indexOf('async init()'), repo.indexOf('async commitDraft'));
  assert(init.includes('recoverInterruptedRestore()'), 'init 要先处理半截恢复');
  assert(init.includes('restoreOldDatabase()'), '迁移失败要能换回旧库');
  assert(init.includes('cleanupRestoreLeftovers()'), '成功之后要清掉 .old/.new');
});

check('设置页能列出恢复点并二次确认', () => {
  const src = fs.readFileSync(path.join(root, 'src/screens/SettingsScreen.tsx'), 'utf8');
  assert(src.includes('repo.listSafetyCopies()'), '要读恢复点列表');
  assert(src.includes('repo.restoreSafetyCopy('), '要能恢复选中的那一份');
  assert(src.includes('恢复点（覆盖前的旧库）'), '列表要有标题');
  assert(src.includes('handleConfirmSafetyRestore'), '要二次确认，不能点一下就覆盖');
});

// ---------------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true });

if (failures.length) {
  console.error('\n✗ 完整备份断言有失败：');
  for (const f of failures) console.error('  -', f);
  process.exit(1);
}
console.log(`\n✓ 完整备份断言全部通过（${passed} 项）`);
