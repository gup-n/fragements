/**
 * 本地静态服务，专门用来让 WorkBuddy 的内置浏览器预览面板打开 App。
 *
 * 用法：node scripts/preview_server.mjs [端口]
 * 然后用 present_files 传 http://127.0.0.1:<端口>
 *
 * 只绑 127.0.0.1，不对局域网暴露。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'web-preview');
const port = Number(process.argv[2] || 8731);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

if (!fs.existsSync(root)) {
  console.error(`找不到 ${root}，先跑 npm run build:web`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  // 去掉 query / hash，防止把 ?platform=web 当成文件名的一部分
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
  let filePath = path.join(root, urlPath);

  // 目录穿越防护：解析后必须仍在 root 内
  if (!path.resolve(filePath).startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  // 目录或不存在 → 回 index.html（Expo 产物是单页，路由由前端 state 接管）
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const indexed = path.join(filePath, 'index.html');
    filePath = fs.existsSync(indexed) ? indexed : path.join(root, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // 开发预览，别让浏览器缓存住旧的 bundle
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`预览服务已启动：http://127.0.0.1:${port}`);
});
