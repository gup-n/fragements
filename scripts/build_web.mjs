/**
 * 导出 Web 产物到固定的 `web-preview/` 目录。
 *
 * 为什么不能直接 `expo export --output-dir web-preview` 覆盖：
 * 目录已存在时会被安全策略拦截，所以每次必须先删干净再导出。
 * 目录名固定，`preview_server.mjs` 才能一直指着同一个地方 —— 服务不用重启，
 * 改完代码重新跑本脚本，浏览器刷新就能看到新的。
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'web-preview');

rmSync(out, { recursive: true, force: true });

console.log('导出 Web 产物 → web-preview/ ...');
execFileSync('npx', ['expo', 'export', '-p', 'web', '--output-dir', 'web-preview'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});
console.log('完成。若预览服务已在运行，直接刷新浏览器即可。');
