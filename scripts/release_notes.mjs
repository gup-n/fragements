#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里抠出某个版本的正文，给 GitHub Release 当说明。
 *
 * 为什么单独写成脚本：发版说明本来就该和 CHANGELOG 同源。
 * 手写一遍等于给自己留一个「改了 CHANGELOG 忘了改 Release」的坑，
 * 而 Release 说明会直接显示在手机的更新弹窗里 —— 用户读到的可能就是过期的。
 *
 * 用法：node scripts/release_notes.mjs v0.8.4 > notes.md
 */
import fs from 'node:fs';

const tag = (process.argv[2] ?? '').trim();
if (!tag) {
  console.error('用法：node scripts/release_notes.mjs v0.8.4');
  process.exit(1);
}

const version = tag.replace(/^v/i, '');
const file = 'CHANGELOG.md';

if (!fs.existsSync(file)) {
  console.error(`找不到 ${file}`);
  process.exit(1);
}

const lines = fs.readFileSync(file, 'utf8').split('\n');
// 标题形如 `## v0.8.4 — 小结能筛选…`
const start = lines.findIndex((l) => l.startsWith(`## v${version}`));

if (start < 0) {
  // 没写就退化成一句话，不要让 CI 挂掉 —— Release 说明缺失不影响发版
  console.log(`v${version}\n\n这一版的变更记录还没写进 CHANGELOG。`);
  process.exit(0);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith('## v')) {
    end = i;
    break;
  }
}

const body = lines
  .slice(start + 1, end)
  .join('\n')
  .replace(/\n---\s*$/, '')
  .trim();

console.log(body || `v${version}`);
