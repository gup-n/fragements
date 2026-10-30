#!/usr/bin/env node
/**
 * 文档一致性检查。
 *
 * 为什么要有这个脚本：这一版之前的每次发版，文档都靠人工扫一遍，
 * 结果是反反复复同一类问题 —— 改了代码只更新一处描述，另一处留着旧版：
 *
 * - HANDOFF 的文件行数表漂了 14 处（加功能的时候没人回去数）
 * - TEXTS.md 的 `文件:行号` 漂了 7 处（改界面文案必然带着行号一起变）
 * - SPEC 里小结格式写了两遍，改了一处漏了另一处
 * - 三份文档各自写着「N 条清单」，而 ROADMAP 早就不止 N 条
 *
 * 人眼扫这些是不可靠的：不是看不出来，是**看不出来的时候不知道**。
 * 所以能机器比的都交给机器。不能机器比的（表述准不准、有没有过时结论）
 * 仍然得人读，但至少不会再有「数字对不上」这种一眼可查的错误。
 *
 * 用法：npm run check:docs
 * 退出码 1 表示有问题，CI 里直接挡住。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOCS = ['README.md', 'SPEC.md', 'HANDOFF.md', 'ROADMAP.md', 'AGENTS.md', 'TEXTS.md', 'CHANGELOG.md'];

/** 统一成 LF。仓库在 Windows 上是 CRLF，代码围栏 ` ```text\n ` 会匹配不上 */
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const readLines = (p) => read(p).split('\n');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const lineCount = (p) => readLines(p).length - 1;

const problems = [];
const fail = (check, detail) => problems.push({ check, detail });

/* ------------------------------------------------------------------ */
/* 1. 版本号三处必须一致                                                */
/* ------------------------------------------------------------------ */
{
  const versionTs = read('src/version.ts').match(/APP_VERSION\s*=\s*'([\d.]+)'/)?.[1];
  const pkg = JSON.parse(read('package.json')).version;
  const app = JSON.parse(read('app.json')).expo;

  if (!versionTs) fail('版本号', 'src/version.ts 里没找到 APP_VERSION');
  if (versionTs !== pkg) fail('版本号', `src/version.ts = ${versionTs}，package.json = ${pkg}`);
  if (versionTs !== app.version) fail('版本号', `src/version.ts = ${versionTs}，app.json = ${app.version}`);

  // 文档里凡是声明「当前版本」的地方，都要等于实际版本
  const claims = [
    ['README.md', /\|\s*当前版本\s*\|\s*v([\d.]+)（versionCode (\d+)）/],
    ['ROADMAP.md', /当前版本 \*\*v([\d.]+)\*\*（versionCode (\d+)）/],
    ['HANDOFF.md', /\|\s*版本\s*\|\s*v([\d.]+) \/ versionCode (\d+)/],
    ['TEXTS.md', /对应版本 v([\d.]+)/],
  ];
  for (const [doc, re] of claims) {
    const m = read(doc).match(re);
    if (!m) {
      fail('版本号', `${doc} 里没找到当前版本声明`);
      continue;
    }
    if (m[1] !== versionTs) fail('版本号', `${doc} 写的是 v${m[1]}，实际 v${versionTs}`);
    if (m[2] && Number(m[2]) !== app.android.versionCode) {
      fail('版本号', `${doc} 写的是 versionCode ${m[2]}，实际 ${app.android.versionCode}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. HANDOFF 的文件行数表                                             */
/* ------------------------------------------------------------------ */
{
  const src = read('HANDOFF.md');
  const rows = src.matchAll(/\|\s*`([\w./-]+\.tsx?)`[^|]*\|\s*(\d+)\s*\|/g);
  let checked = 0;
  for (const m of rows) {
    const [, p, n] = m;
    if (!exists(p)) {
      fail('行数表', `HANDOFF 写了 ${p}，文件不存在`);
      continue;
    }
    checked++;
    const actual = lineCount(p);
    if (Number(n) !== actual) fail('行数表', `${p}：文档 ${n} 行，实际 ${actual} 行`);
  }
  if (checked === 0) fail('行数表', 'HANDOFF 里一行都没匹配上，正则可能失效了');
}

/* ------------------------------------------------------------------ */
/* 3. 文档内相对链接不能有死链                                          */
/* ------------------------------------------------------------------ */
for (const doc of DOCS) {
  for (const m of read(doc).matchAll(/\]\(\.\/([^)#]+)\)/g)) {
    if (!exists(decodeURI(m[1]))) fail('死链', `${doc} → ./${m[1]}`);
  }
}

/* ------------------------------------------------------------------ */
/* 4. 反引号里提到的 src/scripts 路径要真实存在                          */
/* ------------------------------------------------------------------ */
{
  /*
   * 两个白名单，各有理由：
   * - `src/app/`：「项目没有 src/app/」是刻意写的否定句
   * - dedupe.ts：CHANGELOG 记录的是当时存在的文件，后来并进别的模块了。
   *   历史记录不该为了通过检查而改写 —— 那会让人以为它现在还在。
   */
  const allow = new Set(['src/app/', 'src/util/dedupe.ts']);
  for (const doc of DOCS) {
    for (const m of read(doc).matchAll(/`((?:src|scripts|plugins|assets)\/[\w./-]+)`/g)) {
      const p = m[1];
      if (allow.has(p)) continue;
      // `src/...` 这种带省略号的写法是示意，不是真路径
      if (p.includes('...')) continue;
      if (!exists(p)) fail('路径', `${doc} 引用了不存在的 ${p}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 5. `文件:行号` 要落在有内容的行上                                    */
/* ------------------------------------------------------------------ */
{
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

  const index = new Map();
  for (const p of [...walk('src'), 'App.tsx']) {
    if (!/\.tsx?$/.test(p)) continue;
    index.set(path.basename(p), p);
  }

  for (const doc of DOCS) {
    for (const m of read(doc).matchAll(/`([\w/]+\.(?:tsx?)):(\d+)`/g)) {
      const [, name, lineNo] = m;
      const file = index.get(path.basename(name));
      if (!file) {
        fail('行号', `${doc} 引用了不存在的文件 ${name}`);
        continue;
      }
      const lines = readLines(file);
      const n = Number(lineNo);
      if (n < 1 || n > lines.length) {
        fail('行号', `${doc}：${name}:${n} 越界（该文件 ${lines.length} 行）`);
        continue;
      }
      const text = lines[n - 1].trim();
      // 空行、纯括号这类位置一定是漂了；有标识符或中文就算命中
      if (!text || /^[)}\]};,]+$/.test(text)) {
        fail('行号', `${doc}：${name}:${n} 是空行或括号（「${text}」），行号漂了`);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 6. TEXTS.md 抄录的提示词必须和源码逐行一致                            */
/* ------------------------------------------------------------------ */
{
  const texts = read('TEXTS.md');
  const section = (heading) => {
    const start = texts.indexOf(heading);
    if (start < 0) return null;
    const next = texts.indexOf('\n### ', start + heading.length);
    const body = texts.slice(start, next < 0 ? undefined : next);
    const code = body.match(/```text\n([\s\S]*?)```/);
    return code ? code[1] : null;
  };
  const norm = (t) => t.trim().split('\n').map((l) => l.trim().replace(/\\`/g, '`'));

  const pairs = [
    ['### 1.1 整理', 'src/ai/prompt.ts', /export const SYSTEM_PROMPT = `([\s\S]*?)`;/],
    ['### 1.5 「问」', 'src/ai/qa.ts', /const SYSTEM_PROMPT = `([\s\S]*?)`;/],
  ];
  for (const [heading, file, re] of pairs) {
    const doc = section(heading);
    const src = read(file).match(re)?.[1];
    if (!doc) {
      fail('提示词', `TEXTS.md 找不到「${heading}」的代码块`);
      continue;
    }
    if (!src) {
      fail('提示词', `${file} 里没找到 SYSTEM_PROMPT`);
      continue;
    }
    const a = norm(src);
    const b = norm(doc);
    const longer = Math.max(a.length, b.length);
    for (let i = 0; i < longer; i++) {
      if ((a[i] ?? '') !== (b[i] ?? '')) {
        fail('提示词', `TEXTS.md「${heading}」第 ${i + 1} 行与 ${file} 不一致\n      源码：${(a[i] ?? '<缺>').slice(0, 70)}\n      文档：${(b[i] ?? '<缺>').slice(0, 70)}`);
        break;
      }
    }
  }

  // 1.3 是渲染后的样子，不能逐字比；只抽查几条最关键的规则还在不在
  const d13 = section('### 1.3 周期小结');
  for (const key of ['精简优先于叙述完整', '不使用第一人称', '没有符合条件的内容就省略整个小节', '字数是上限，不是目标']) {
    if (d13 && !d13.includes(key)) fail('提示词', `TEXTS.md 1.3 里缺少规则「${key}」`);
  }
}

/* ------------------------------------------------------------------ */
/* 7. 「N 条清单」必须等于 ROADMAP 的实际条数                            */
/* ------------------------------------------------------------------ */
{
  const roadmap = read('ROADMAP.md');
  const items = [...roadmap.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
  const max = items.length ? Math.max(...items) : 0;
  if (!max) fail('条数', 'ROADMAP 里一条验证项都没匹配到');
  for (const doc of ['HANDOFF.md', 'README.md']) {
    for (const m of read(doc).matchAll(/(\d+)\s*条(?:清单|没验完)/g)) {
      if (Number(m[1]) !== max) fail('条数', `${doc} 写的是 ${m[1]} 条，ROADMAP 实际 ${max} 条`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 8. 文件体积：单份文档不该再无限长                                     */
/* ------------------------------------------------------------------ */
{
  for (const doc of DOCS) {
    const kb = Buffer.byteLength(read(doc), 'utf8') / 1024;
    if (kb > 200) fail('体积', `${doc} 已经 ${kb.toFixed(0)} KB，考虑把历史版本压成摘要`);
  }
}

/* ------------------------------------------------------------------ */
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

if (!problems.length) {
  console.log(`${GREEN}文档一致性检查通过${RESET} ${DIM}（版本号 / 行数表 / 死链 / 路径 / 行号 / 提示词 / 条数）${RESET}`);
  process.exit(0);
}

console.log(`${RED}文档不一致 ${problems.length} 处：${RESET}\n`);
const byCheck = new Map();
for (const p of problems) {
  if (!byCheck.has(p.check)) byCheck.set(p.check, []);
  byCheck.get(p.check).push(p.detail);
}
for (const [check, list] of byCheck) {
  console.log(`  ${check}`);
  for (const d of list) console.log(`    - ${d}`);
  console.log('');
}
console.log(`${DIM}这些都能机器查出来，就不该靠人眼扫。修完再发版。${RESET}`);
process.exit(1);
