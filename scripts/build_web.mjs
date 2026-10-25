/**
 * Web 平台编译校验：打一遍包，确认 Metro 能过，然后立刻删掉产物。
 *
 * 为什么不是「导出预览」：
 *   用户 2026-10-25 明确要求不做界面预览（原话「不要再开预览了」），
 *   UI 只能靠装 APK 的真机反馈验证。这里保留的只是 tsc 抓不到的那部分检查 ——
 *   模块解析、平台分流（`repo.web.ts` 会不会漏方法）、Metro 打包能否完成。
 *
 * 为什么产物必须跑完即删：
 *   以前固定输出到 `web-preview/`，目录留着就总会有人顺手起个服务给用户看，
 *   这正是那条铁律被破掉的方式。不落地就没有可预览的东西。
 *
 * 用法：`npm run build:web`。成功打印体积后退出 0，失败退出 1。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, '.tmp-bundle');

function dirSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

// 上次异常退出可能留下半个目录，先清干净
rmSync(out, { recursive: true, force: true });

let failed = false;
let size = 0;

console.log('Web 编译校验中（产物不落地，跑完即删）...');

try {
  execFileSync('npx', ['expo', 'export', '-p', 'web', '--output-dir', '.tmp-bundle'], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
} catch {
  failed = true;
  console.error('\n✗ Web 编译失败：Metro 没能完成打包，看上面的报错。');
} finally {
  try {
    size = dirSize(out);
  } catch {
    size = 0;
  }
  rmSync(out, { recursive: true, force: true });
}

if (!failed) {
  const mb = (size / 1024 / 1024).toFixed(2);
  console.log(`\n✓ Web 编译通过，产物 ${mb} MiB（已删除，不提供预览）`);
}

process.exit(failed ? 1 : 0);
