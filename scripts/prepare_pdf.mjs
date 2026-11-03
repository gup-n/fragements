#!/usr/bin/env node
/**
 * 把 PDF.js 的运行时资源从 node_modules 拷进 assets/pdfjs/，并生成自包含的 reader.html。
 *
 * 为什么必须有个准备脚本：
 *   - `assets/` 里的东西要能跟着仓库走，不能指望运行期还能读到 node_modules；
 *   - PDF.js 4.x 只发 ESM，而 WebView 的页面是 `file://` 起源，Chrome 对
 *     `file://` 下的 ES module 一律按不透明源处理，`import "./pdf.min.mjs"`
 *     会被 CORS 拦掉。本地起 HTTP 服务又等于引入服务端。所以只能**内联**：
 *     把 ESM 改写成经典脚本塞进 HTML，运行期不再加载任何脚本。
 *   - 中文 PDF 缺 CMap 就是一片乱码，而 CMap 也要按名字取 —— 内联成一张
 *     base64 表，运行期由自定义 CMapReaderFactory 直接查表，不发请求。
 *
 * 幂等：内容一致就不重写（连 mtime 都不动），重复跑没有副作用。
 *
 * 用法：
 *   node scripts/prepare_pdf.mjs            # 生成/更新
 *   node scripts/prepare_pdf.mjs --check    # 只检查是否最新（CI 用），过期退出 1
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const OUT = path.join(root, 'assets', 'pdfjs');
const PDFJS = path.join(root, 'node_modules', 'pdfjs-dist');
const TEMPLATE = path.join(root, 'src', 'documents', 'readers', 'pdfjs', 'reader.template.html');

const check = process.argv.includes('--check');

/**
 * 选哪些 CMap。
 *
 * 取舍：**只留中日韩**。整个 cmaps 目录 1.4 MB，其中大半是 UTF-8/UTF-32 变体和
 * 冷门编码；手机上的中文 PDF 绝大多数落在下面这几类里：
 *   - Adobe-GB1/CNS1/Japan1/Korea1-UCS2：CID 字体的基础映射，缺了整页都是乱码；
 *   - UniGB/CNS/JIS/KS-UCS2 与 UTF16：现代排版软件导出的就是这些；
 *   - GB / GBK / B5 / ETen / HKscs / KSC / 90ms-RKSJ：老式本地编码（国产办公软件常见）。
 * 真遇到表里没有的名字，页面会报「缺少 CMap」而不是静默显示乱码。
 */
const CMAP_NAMES = [
  'Adobe-GB1-UCS2',
  'Adobe-CNS1-UCS2',
  'Adobe-Japan1-UCS2',
  'Adobe-Korea1-UCS2',
  ...[0, 1, 2, 3, 4, 5, 6].flatMap((n) => [
    `Adobe-GB1-${n}`,
    `Adobe-CNS1-${n}`,
    `Adobe-Japan1-${n}`,
    `Adobe-Korea1-${n}`,
  ]),
  // 简体
  'UniGB-UCS2-H',
  'UniGB-UCS2-V',
  'UniGB-UTF16-H',
  'UniGB-UTF16-V',
  'GB-EUC-H',
  'GB-EUC-V',
  'GB-H',
  'GB-V',
  'GBK-EUC-H',
  'GBK-EUC-V',
  'GBKp-EUC-H',
  'GBKp-EUC-V',
  'GBK2K-H',
  'GBK2K-V',
  // 繁体
  'UniCNS-UCS2-H',
  'UniCNS-UCS2-V',
  'UniCNS-UTF16-H',
  'UniCNS-UTF16-V',
  'B5-H',
  'B5-V',
  'B5pc-H',
  'B5pc-V',
  'ETen-B5-H',
  'ETen-B5-V',
  'ETenms-B5-H',
  'ETenms-B5-V',
  'HKscs-B5-H',
  'HKscs-B5-V',
  // 日文
  'UniJIS-UCS2-H',
  'UniJIS-UCS2-V',
  'UniJIS-UCS2-HW-H',
  'UniJIS-UCS2-HW-V',
  'UniJIS-UTF16-H',
  'UniJIS-UTF16-V',
  '90ms-RKSJ-H',
  '90ms-RKSJ-V',
  '90msp-RKSJ-H',
  '90msp-RKSJ-V',
  // 韩文
  'UniKS-UCS2-H',
  'UniKS-UCS2-V',
  'UniKS-UTF16-H',
  'UniKS-UTF16-V',
  'KSC-EUC-H',
  'KSC-EUC-V',
  'KSC-H',
  'KSC-V',
  'KSCms-UHC-H',
  'KSCms-UHC-V',
  'KSCpc-EUC-H',
  'KSCpc-EUC-V',
];

const written = [];
const skipped = [];
let stale = 0;

function writeIfChanged(file, content, note) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  let same = false;
  try {
    same = readFileSync(file).equals(buf);
  } catch {
    same = false;
  }
  if (same) {
    skipped.push(`${path.relative(root, file)}（内容一致，跳过）`);
    return;
  }
  if (check) {
    stale++;
    console.error(`✗ 过期：${path.relative(root, file)}`);
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buf);
  written.push(`${path.relative(root, file)}  ${(buf.length / 1024).toFixed(1)} KB${note ? `  ${note}` : ''}`);
}

function need(file) {
  if (!existsSync(file)) {
    console.error(`✗ 缺少文件：${path.relative(root, file)}\n  先跑 npm install（依赖 pdfjs-dist）。`);
    process.exit(1);
  }
  return readFileSync(file, 'utf8');
}

/**
 * ESM → 经典脚本。
 *
 * 两处改动，都是「不这么改就跑不起来」：
 * 1. 把结尾的 `export{a as X,b as Y}` 换成 `window.pdfjsLib={X:a,Y:b}` —— 经典脚本
 *    没有 export，而调用方需要 `getDocument` / `TextLayer` / `GlobalWorkerOptions`。
 * 2. `import.meta.url` 换成字符串常量。它在源码里只出现在 Node 才走的分支
 *    （createRequire 加载 @napi-rs/canvas），WebView 里永远不执行；
 *    但**经典脚本不允许出现 import.meta 这个语法**，解析期就会整份报错。
 */
function toClassic(src, label) {
  const exportRe = /export\s*\{([^{}]*)\}\s*;?\s*$/;
  const m = exportRe.exec(src);
  if (!m) throw new Error(`${label}：找不到结尾的 export {}，PDF.js 版本可能变了`);

  const pairs = m[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const seg = part.split(/\s+as\s+/);
      if (seg.length === 2) return `${seg[1]}:${seg[0]}`;
      return `${part}:${part}`;
    });

  let out = src.slice(0, m.index) + `\n;window.pdfjsLib={${pairs.join(',')}};\n`;
  out = out.replace(/import\.meta\.url/g, '"file:///reader.html"');

  if (/import\.meta/.test(out)) throw new Error(`${label}：还有 import.meta，经典脚本跑不了`);
  if (/^\s*(import|export)\s/m.test(out)) throw new Error(`${label}：还有残留的 import/export`);
  if (out.includes('</script')) throw new Error(`${label}：源码里有 </script，内联进 HTML 会截断`);
  return out;
}

function stripExport(src, label) {
  const exportRe = /export\s*\{[^{}]*\}\s*;?\s*$/;
  if (!exportRe.test(src)) throw new Error(`${label}：找不到结尾的 export {}`);
  const out = src.replace(exportRe, '\n');
  if (/import\.meta/.test(out)) throw new Error(`${label}：worker 里出现 import.meta`);
  if (/^\s*(import|export)\s/m.test(out)) throw new Error(`${label}：worker 里还有 import/export`);
  if (out.includes('</script')) throw new Error(`${label}：worker 源码里有 </script`);
  return out;
}

function main() {
  const libPath = path.join(PDFJS, 'legacy', 'build', 'pdf.min.mjs');
  const workerPath = path.join(PDFJS, 'legacy', 'build', 'pdf.worker.min.mjs');
  const lib = need(libPath);
  const worker = need(workerPath);
  const template = need(TEMPLATE);

  // 原始 ESM 也留一份：出问题时可以直接对照版本，不用回 node_modules 翻
  writeIfChanged(path.join(OUT, 'pdf.min.mjs'), lib, '（原样）');
  writeIfChanged(path.join(OUT, 'pdf.worker.min.mjs'), worker, '（原样）');

  const classicLib = toClassic(lib, 'pdf.min.mjs');
  const classicWorker = stripExport(worker, 'pdf.worker.min.mjs');

  // CMap：拷原文件（便于审计），同时内联进 HTML（运行期真用的是这份）
  const cmapBase64 = {};
  let cmapBytes = 0;
  for (const name of CMAP_NAMES) {
    const file = path.join(PDFJS, 'cmaps', `${name}.bcmap`);
    if (!existsSync(file)) {
      // Adobe-Korea1 只导到 -2，各家子集数量并不一致：这些编号表是补充，
      // 缺了不影响主映射，跳过即可；核心映射（带 UCS2/UTF16 的）缺了才必须报错。
      if (/-\d+$/.test(name)) continue;
      console.error(`✗ 缺少 CMap：${name}.bcmap（pdfjs-dist 版本变了？）`);
      process.exit(1);
    }
    const buf = readFileSync(file);
    cmapBytes += buf.length;
    cmapBase64[name] = buf.toString('base64');
    writeIfChanged(path.join(OUT, 'cmaps', `${name}.bcmap`), buf);
  }

  const cmapJson = JSON.stringify(cmapBase64);
  if (cmapJson.includes('</script')) throw new Error('CMap base64 里出现了 </script，不该发生');

  let html = template;
  /*
   * 必须用**函数式**替换。
   *
   * `String.replace(marker, string)` 会把替换串里的 `$&`、`` $` ``、`$'` 当成特殊指令，
   * 而压缩过的 PDF.js 里这类序列满地都是 —— 用它拼接会把 1.4 MB 的 worker 直接啃掉
   * 十二万字，生成一个语法都不成立的 HTML。这种错在浏览器里只表现为「一片空白」。
   */
  html = html.replace(
    '<!--@PDFJS_LIB@-->',
    () => `<script>\n${classicLib}\n</script>`,
  );
  html = html.replace(
    '<!--@PDFJS_WORKER@-->',
    () => `<script type="text/plain" id="pdfjs-worker">${classicWorker}</script>`,
  );
  html = html.replace(
    '<!--@PDFJS_CMAPS@-->',
    () => `<script type="application/json" id="pdfjs-cmaps">${cmapJson}</script>`,
  );
  if (html === template) throw new Error('模板里没找到占位注释（@PDFJS_LIB@ 等）');
  // 替换是否完整：任何一处 `$` 语义吃掉了内容都会在这里露出来
  if (!html.includes(classicLib) || !html.includes(classicWorker) || !html.includes(cmapJson)) {
    throw new Error('内联内容不完整：替换占位符时内容被改写了');
  }

  writeIfChanged(path.join(OUT, 'reader.html'), html);

  const manifest = {
    generatedBy: 'scripts/prepare_pdf.mjs',
    note: '由脚本生成，不要手改。reader.html 是运行期真正被加载的那一个文件。',
    sources: {
      lib: 'node_modules/pdfjs-dist/legacy/build/pdf.min.mjs',
      worker: 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs',
      template: 'src/documents/readers/pdfjs/reader.template.html',
      cmaps: 'node_modules/pdfjs-dist/cmaps/*.bcmap',
    },
    cmaps: CMAP_NAMES,
    bytes: {
      lib: Buffer.byteLength(lib),
      worker: Buffer.byteLength(worker),
      cmaps: cmapBytes,
      html: Buffer.byteLength(html),
    },
  };
  writeIfChanged(path.join(OUT, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const htmlSize = Buffer.byteLength(html);
  if (check) {
    if (stale) {
      console.error(`\n✗ assets/pdfjs 有 ${stale} 个文件不是最新的，跑一次 node scripts/prepare_pdf.mjs`);
      process.exit(1);
    }
    console.log(`✓ assets/pdfjs 是最新的（reader.html ${(htmlSize / 1024).toFixed(0)} KB）`);
    return;
  }

  console.log(`assets/pdfjs/ 已就绪`);
  console.log(`  reader.html      ${(htmlSize / 1024).toFixed(0)} KB（内联：主库 ${(Buffer.byteLength(lib) / 1024).toFixed(0)} KB + worker ${(Buffer.byteLength(worker) / 1024).toFixed(0)} KB + ${CMAP_NAMES.length} 个 CMap ${(cmapBytes / 1024).toFixed(0)} KB）`);
  console.log(`  写入 ${written.length} 个文件，跳过 ${skipped.length} 个（内容一致）`);
  for (const line of written) console.log(`  + ${line}`);
}

main();
