#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里抠出某个版本的条目，给 GitHub Release 当说明。
 *
 * 为什么单独写成脚本：发版说明本来就该和 CHANGELOG 同源。
 * 手写一遍等于给自己留一个「改了 CHANGELOG 忘了改 Release」的坑。
 *
 * 只输出能扫一眼的东西：第一行版本号，之后最多 6 条 `- ` 条目。
 * 段落叙述、小标题、`> 引用`、空行一律丢掉 —— Release 说明会直接显示在
 * 手机上，而 App 里只留一行摘要 + 一个跳 GitHub 的按钮，长文没人读。
 *
 * 用法：node scripts/release_notes.mjs v0.8.4 > notes.md
 * 退出码：0 = 有输出（含「CHANGELOG 里没有这一版」的兜底），1 = 用错了参数或文件缺失
 */
import fs from 'node:fs';

/** 最多几条。再多就不是「一眼看完」，而是把 CHANGELOG 换个地方放 */
const MAX_ITEMS = 6;

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

const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
// 标题形如 `## v0.8.4 — 小结能筛选…`
const heading = new RegExp(`^##\\s*v${version.replace(/\./g, '\\.')}(?![\\d.])`);
const start = lines.findIndex((l) => heading.test(l));

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

/*
 * 只认顶格的 `- `：缩进的行是上一条的续行 —— CHANGELOG 里为了读通顺折过行，
 * 直接照搬会在 Release 上变成「…以前要从」「才调用 `buildQaNote`」这种半句话。
 * 续行接回去，一条就是完整的一句。
 *
 * **按 `###` 小节分组收集**，不按出现顺序一把梭。v0.11.0 一次改了下载和文档两块，
 * 前 6 条全是下载的，文档那半整个被截掉 —— Release 说明变成「这版只修了下载」。
 * 「版本」小节不收：里面的 bullet 是 versionCode 之类的元信息，不是改动。
 */
const buckets = [[]];
let skipping = false;
for (const line of lines.slice(start + 1, end)) {
  if (/^###\s+/.test(line)) {
    skipping = /版本/.test(line);
    // 跳过的小节仍然要有个桶，否则下一条 bullet 会掉进上一节的桶里
    buckets.push([]);
    continue;
  }
  const bucket = buckets[buckets.length - 1];
  const bullet = line.match(/^-\s+(.+)$/);
  if (bullet) {
    if (skipping) continue;
    bucket.push(bullet[1].trim());
    continue;
  }
  // 顶格的段落、小标题、`> 引用` 不是任何一条的一部分
  if (!skipping && bucket.length && /^\s+\S/.test(line)) {
    const prev = bucket[bucket.length - 1];
    const next = line.trim();
    // 中文折行不需要空格，英文单词之间需要
    const glue = /[A-Za-z0-9`]$/.test(prev) && /^[A-Za-z0-9`]/.test(next) ? ' ' : '';
    bucket[bucket.length - 1] = prev + glue + next;
  }
}

// 加粗标记在纯文本里只是两颗星
const groups = buckets
  .map((g) => g.map((t) => t.replace(/\*\*/g, '').trim()).filter(Boolean))
  .filter((g) => g.length);

/*
 * 各小节平分名额。只有一个小节时（绝大多数版本）就是「取前 6 条」，和以前一样。
 * 分不匀的名额按小节顺序补回去，免得第二节只剩一条时浪费额度。
 */
const quota = Math.max(1, Math.floor(MAX_ITEMS / Math.max(1, groups.length)));
const clean = [];
for (const g of groups) clean.push(...g.slice(0, quota));
for (const g of groups) {
  if (clean.length >= MAX_ITEMS) break;
  clean.push(...g.slice(quota, quota + (MAX_ITEMS - clean.length)));
}
clean.length = Math.min(clean.length, MAX_ITEMS);

if (clean.length) {
  // 版本号和列表之间要留一个空行，否则 Markdown 会把 `- ` 当成上一段的普通文字
  console.log(`v${version}\n\n${clean.map((t) => `- ${t}`).join('\n')}`);
} else {
  /*
   * 这一版一条 `- ` 都没有（v0.9.0 是整段叙述 + 有序列表）。
   * 那就退回标题里的主题短句 —— 仍然出自 CHANGELOG，不自己编，也不会交一个空 body。
   */
  const theme = lines[start]
    .replace(/^##\s*v[\d.]+\s*/, '')
    .replace(/^[—–-]\s*/, '')
    .trim();
  console.log(theme ? `v${version}\n\n${theme}` : `v${version}`);
}
