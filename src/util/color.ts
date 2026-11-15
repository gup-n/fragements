/**
 * 颜色工具的极小集合。**不依赖 react-native**，所以能直接拿 node 跑断言。
 *
 * 两处用：
 * - WebView 主题：PDF 画布是白底，高亮必须半透明，不透明色块会直接把字盖住；
 * - 毛玻璃：默认主题的玻璃后面垫一层 `page` 色的半透明纱，墨水主题不要这层。
 *
 * v0.22.1 之前这里有两份：`documents/readers/color.ts`（支持三位简写、夹紧 alpha）
 * 和 `GlassBackdrop.tsx` 里的一份（只认六位、不夹紧）。玻璃那份遇到 `#fff`
 * 会**原样返回不透明色**，纱就变成一块实心板 —— 现在只有这一份。
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
