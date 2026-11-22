#!/usr/bin/env node
/**
 * CI 步骤完整性（v0.36）。
 *
 * `package.json` 的 `test` 链是本地唯一口径，而 workflow 是另一份手写清单。
 * v0.28 加了 `test:recycle` 之后 CI 一直没跑它，38 项软删断言只在本地生效 ——
 * 这类漏项不会报错，只会让「CI 绿」少证明一件事。这里逐条比对，缺一个就红。
 *
 * 只比 `npm run <script>`：`check:ci` 自己不在预期集合里（否则它得在 workflow 里
 * 跑自己才能通过）；workflow 里多出来的步骤不算错。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const chain = String(pkg.scripts?.test ?? '');
const expected = new Set(
  [...chain.matchAll(/npm run ([\w:]+)/g)]
    .map((m) => m[1])
    .filter((name) => name !== 'check:ci'),
);
if (!expected.size) {
  console.error('package.json 的 test 链里一条 npm run 都没解析到');
  process.exit(1);
}

const workflow = fs.readFileSync(path.join(root, '.github/workflows/android.yml'), 'utf8');
const actual = new Set([...workflow.matchAll(/run:\s*npm run ([\w:]+)/g)].map((m) => m[1]));

const missing = [...expected].filter((name) => !actual.has(name));
if (missing.length) {
  console.error(`Android CI 缺少 ${missing.length} 个断言步骤：`);
  for (const name of missing) console.error(`  - npm run ${name}`);
  console.error('package.json 的 test 链与 workflow 必须一致；别只改一边。');
  process.exit(1);
}

console.log(`CI 步骤完整：test 链 ${expected.size} 条，workflow 全部覆盖`);
