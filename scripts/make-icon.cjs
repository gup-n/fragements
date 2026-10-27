/**
 * 生成应用图标。跑完即删，产物留在 assets/。
 *
 * 不引第三方图形库（这机器装不上 Pillow，也没有 sharp），所以自己写：
 *   1. 形状用 SDF（有向距离场）描述，圆角矩形之间做并/交/差；
 *   2. 抗锯齿靠 `clamp(0.5 - d, 0, 1)` —— d 以像素计，边缘正好一个像素过渡；
 *   3. PNG 用 Node 自带的 zlib 压 IDAT，手写 chunk 与 CRC32。
 *
 * 图形：一块圆角方板，右下角缺了一块（用圆角方块做布尔差，缺口边缘自然带圆角），
 * 缺下来的那一小块落在右下方，跟主体分开。
 *
 * 试过另一种：把板子从中间劈开、右半截往下错开。做出来两块宽度接近，
 * 在小尺寸下会被读成播放器的「暂停」图标 —— 而且那块只有 220 宽、圆角却是 104，
 * 上下两个圆角一相接（208 > 220），整个形状退化成胶囊，底部收成一个尖。作废。
 *
 * 排版不靠手算：先在设计画布上画，再按实际不透明区域的包围盒裁剪、居中、缩放。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const NAVY = [0x18, 0x5f, 0xa5];
const PAPER = [0xfb, 0xfb, 0xf9];

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 形状 ----------
/** 圆角矩形的有向距离：负 = 在内部 */
function sdRoundBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// ---- 设计坐标：1400 见方，中心 (700, 700) ----
const D = 1400;

// 主板：600 见方
const MAIN = { cx: 600, cy: 600, half: 300, r: 96 };
// 缺口的「咬痕」：拿一个圆角方块做布尔差，缺口边缘因此也是圆的
const BITE = { cx: 900, cy: 900, half: 190, r: 18 };
// 落下来的那一小块
const SHARD = { cx: 862, cy: 1058, half: 95, r: 22 };

function cover(x, y) {
  const board = sdRoundBox(x - MAIN.cx, y - MAIN.cy, MAIN.half, MAIN.half, MAIN.r);
  const bite = sdRoundBox(x - BITE.cx, y - BITE.cy, BITE.half, BITE.half, BITE.r);
  // 布尔差：减掉一块 = max(A, -B)
  const body = Math.max(board, -bite);
  const shard = sdRoundBox(x - SHARD.cx, y - SHARD.cy, SHARD.half, SHARD.half, SHARD.r);
  return Math.min(Math.max(0.5 - Math.min(body, shard), 0), 1);
}

/** 在 1400 设计画布上算不透明区域的包围盒，用来做居中 */
function measure() {
  let x0 = D,
    y0 = D,
    x1 = 0,
    y1 = 0;
  for (let y = 0; y < D; y += 2) {
    for (let x = 0; x < D; x += 2) {
      if (cover(x, y) > 0.5) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, x1, y1 };
}

const BOX = measure();
const BOX_W = BOX.x1 - BOX.x0;
const BOX_H = BOX.y1 - BOX.y0;
const BOX_CX = (BOX.x0 + BOX.x1) / 2;
const BOX_CY = (BOX.y0 + BOX.y1) / 2;

/**
 * @param size   输出边长
 * @param bg     背景色，null = 透明
 * @param fg     图形颜色
 * @param fill   图形长边占画布的比例
 * @param round  背景圆角占边长的比例（0 = 直角，安卓自适应图标会自己裁）
 */
function render(size, bg, fg, fill, round = 0) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = (size * fill) / Math.max(BOX_W, BOX_H);
  const half = size / 2;
  const bgR = round * size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = (x + 0.5 - half) / scale + BOX_CX;
      const sy = (y + 0.5 - half) / scale + BOX_CY;
      const a = cover(sx, sy);

      let bgA = 1;
      if (bg && bgR > 0) {
        const d = sdRoundBox(x + 0.5 - half, y + 0.5 - half, half, half, bgR);
        bgA = Math.min(Math.max(0.5 - d, 0), 1);
      }

      const i = (y * size + x) * 4;
      if (bg) {
        rgba[i] = Math.round(bg[0] * (1 - a) + fg[0] * a);
        rgba[i + 1] = Math.round(bg[1] * (1 - a) + fg[1] * a);
        rgba[i + 2] = Math.round(bg[2] * (1 - a) + fg[2] * a);
        rgba[i + 3] = Math.round(bgA * 255);
      } else {
        rgba[i] = fg[0];
        rgba[i + 1] = fg[1];
        rgba[i + 2] = fg[2];
        rgba[i + 3] = Math.round(a * 255);
      }
    }
  }
  return encodePNG(size, size, rgba);
}

const out = path.join(__dirname, '..', 'assets');
const write = (name, buf) => {
  fs.writeFileSync(path.join(out, name), buf);
  console.log(name, (buf.length / 1024).toFixed(1) + ' KiB');
};

console.log('bbox', BOX, 'w', BOX_W, 'h', BOX_H);

// 主图标：满幅深蓝底（iOS 和旧版 Android 会自己加圆角，所以这里是直角）
write('icon.png', render(1024, NAVY, PAPER, 0.72));
// 自适应图标前景：透明底，图形收进中心安全区（系统只保证中心 66% 可见）
write('android-icon-foreground.png', render(1024, null, PAPER, 0.62));
// 自适应图标背景：纯色，系统按自己的形状裁
write('android-icon-background.png', render(1024, NAVY, NAVY, 0.72));
// 主题图标（Android 13+）：系统只取 alpha，自己上色
write('android-icon-monochrome.png', render(1024, null, [255, 255, 255], 0.62));
// 网页标签页
write('favicon.png', render(128, NAVY, PAPER, 0.82, 0.22));
