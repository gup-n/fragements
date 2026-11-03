/**
 * 颜色工具的极小集合。**不依赖 react-native**，所以能直接拿 node 跑断言。
 *
 * 只在 WebView 主题里用：PDF 画布是白底，高亮必须是半透明的，
 * 不透明色块会直接把字盖住。入参仍然是调色板里的色值，不是写死的色号。
 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  let raw = m[1];
  if (raw.length === 3) raw = raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2];
  const n = parseInt(raw, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${r},${g},${b},${a})`;
}
