#!/usr/bin/env node
/**
 * 更新下载的**断点续传**断言。不联网、不碰文件系统。
 *
 * 用户 2026-11-19：「临时切了 10 秒应用，回来要重新下载」。
 * 根因不是网速 —— `expo-file-system` 的进度回调切到后台就不触发，
 * 而下载代码里「15 秒没有新字节就换源」的巡检还在计时。于是：
 * 判卡死 → 掐源 → 换下一个 → 残包被删 → 从头下。
 *
 * 这组断言钉三件事：
 * 1. 残包什么时候能接着用（判据在 `src/update/resume.ts`，纯函数）；
 * 2. 切到后台期间不许判卡死；
 * 3. 源码里那两处的接线没有退回旧写法（`File.createDownloadTask`、卸载即删残包）。
 *
 * 用法：node scripts/assert_update.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLoader, createSuite } = require('./test_loader.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const suite = createSuite('更新下载续传');
const { test } = suite;

const pure = createLoader();
const resume = pure.load('src/update/resume.ts');
const { resumeOffset, stallApplies, percentOf } = resume;

const want = { version: 'v0.31.1', url: 'https://example.com/a.apk', size: 26_000_000 };

test('同一个版本、同一个源、残包没超过目标 → 从残包大小接着下', () => {
  assert.equal(resumeOffset({ ...want }, want, 8_000_000), 8_000_000);
  // 小数（文件系统偶尔给浮点）向下取整，Range 头不认小数
  assert.equal(resumeOffset({ ...want }, want, 8_000_000.7), 8_000_000);
});

test('换了版本 / 换了源 / 目标大小变了 → 一律从头下', () => {
  assert.equal(resumeOffset({ ...want, version: 'v0.30.0' }, want, 8_000_000), 0, '版本不同不能续');
  assert.equal(resumeOffset({ ...want, url: 'https://mirror.example/b.apk' }, want, 8_000_000), 0, '源不同不能续');
  assert.equal(resumeOffset({ ...want, size: 25_000_000 }, want, 8_000_000), 0, '目标大小不同不能续');
});

test('没有残包 / 残包已满 / 残包比目标还大 → 不算残包', () => {
  assert.equal(resumeOffset(null, want, 8_000_000), 0, '没有 sidecar 就不知道这半包是谁的');
  assert.equal(resumeOffset(want, want, 0), 0);
  assert.equal(resumeOffset(want, want, -1), 0);
  assert.equal(resumeOffset(want, want, want.size), 0, '已经下全了，不该再续');
  assert.equal(resumeOffset(want, want, want.size + 4096), 0, '超过目标说明拼坏了');
  assert.equal(resumeOffset(want, want, Number.NaN), 0);
});

test('切到后台期间不判卡死，回到前台才恢复', () => {
  assert.equal(stallApplies('active'), true);
  assert.equal(stallApplies('background'), false);
  assert.equal(stallApplies('inactive'), false);
  // AppState.currentState 在极早期可能是 null
  assert.equal(stallApplies(null), false);
  assert.equal(stallApplies(undefined), false);
});

test('百分比只算一份：总量未知给 null，不会除出 NaN', () => {
  assert.equal(percentOf(0, 100), 0);
  assert.equal(percentOf(50, 100), 50);
  assert.equal(percentOf(100, 100), 100);
  assert.equal(percentOf(120, 100), 100, '回调偶尔会多报一点，封顶 100');
  assert.equal(percentOf(5, 0), null);
  assert.equal(percentOf(5, -1), null, 'Content-Length 缺失时是 -1');
});

test('下载走的是可续传任务，慢/卡判据和残包删除都接在这条路上', () => {
  const src = read('src/update/download.ts');

  assert.ok(src.includes('createDownloadResumable'), '要用能续传的那个任务');
  assert.ok(!src.includes('File.createDownloadTask('), '旧的一次性任务不支持 Range，别退回去');
  // resumeData 就是残包的字节数
  assert.ok(src.includes('offset > 0 ? String(offset) : undefined'), 'resumeData 要传残包大小');
  // 只有「不能续」时才清文件：无条件删就是把已下的字节扔掉
  assert.ok(
    src.includes('if (offset === 0 && dest.exists)'),
    '残包只在不能续的时候才删',
  );
  assert.ok(
    !/if \(dest\.exists\) \{\s*try \{\s*dest\.delete\(\)/.test(src),
    '不许再无条件删残包（v0.31 及之前就是这么把进度丢掉的）',
  );
  // 先记 sidecar 再下：中途被杀也能认出这半包是谁的
  assert.ok(
    src.indexOf('await writeSidecar(') < src.indexOf('createDownloadResumable('),
    'sidecar 必须在请求发出前就写好',
  );
  // 后台不判卡死
  assert.ok(src.includes('stallApplies(AppState.currentState)'), '巡检要先问「现在是不是在前台」');
  // 慢的判据也不能把后台时间算进分母：否则切走五分钟回来就成了几 KB/s
  assert.ok(
    src.includes('const avg = (written - offset) / (activeMs / 1000)'),
    '平均速度只算前台时间',
  );
});

test('面板不再一卸载就删残包，还能认出缓存里的半包', () => {
  const sheet = read('src/components/UpdateSheet.tsx');
  assert.ok(sheet.includes('pendingDownload(release)'), '打开面板要先问缓存');
  assert.ok(sheet.includes('继续下载'), '有残包时按钮要说「继续下载」');
  // v0.31 的卸载清理会把残包删掉 —— 那正是「切走就要重下」的另一半原因。
  // 用正则而不是按 `\n` 切：仓库工作树是 CRLF，写死换行符的断言迟早会假红。
  const cleanup = sheet.match(/useEffect\(\(\) => \{\s*return \(\) => \{([\s\S]*?)\}, \[\]\);/);
  assert.ok(cleanup, '找不到卸载清理');
  assert.ok(!cleanup[1].includes('clearDownload'), '卸载时不许删残包');
  // 装完才收拾
  assert.ok(sheet.includes('clearDownload();'), '装完要清掉，不然 26 MB 一直躺着');
});

if (require.main === module) {
  suite.run().then(({ failed }) => { process.exitCode = failed ? 1 : 0; }).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
module.exports = { run: suite.run };
