/**
 * 版本号比较。
 *
 * 三个不能用的写法，都踩过或想过：
 *
 * 1. **不能比字符串。** `'0.10.0' < '0.9.0'` 在字典序里是 true，但语义上 0.10 更新。
 *    这个错误很难在测试里发现 —— 大多数版本号前两段一样，一比就"对"了。
 * 2. **不能用 parseFloat。** `'0.10'` → `0.1`，和 `'0.1'` 撞成同一个数。
 * 3. **不能忽略段数。** `'1.0'` 和 `'1.0.0'` 必须相等，否则两个都表示 1.0 的写法
 *    会被判成"有新版本"。
 *
 * 所以按 `.` 拆段、逐段转数字、短的一侧补 0。
 */

/** 只保留主版本段的数字。`v0.8.4-beta.1` → [0, 8, 4] */
export function parseVersion(raw: string): number[] | null {
  if (!raw) return null;
  // 去掉 tag 常见的前缀与预发布后缀。预发布不参与比较：
  // 本项目只发正式版，把 -beta 当同版本处理（宁可不错报有更新）
  const core = raw.trim().replace(/^[vV]/, '').split(/[-+]/)[0];
  if (!core) return null;

  const nums: number[] = [];
  for (const p of core.split('.')) {
    // 每段必须是纯数字。`0.8.x` 这种直接判非法，不要猜
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  return nums.length ? nums : null;
}

/**
 * 比较两个版本。返回 1 表示 a 更新，-1 表示 b 更新，0 表示相同。
 *
 * **解析不了的一律返回 0（当作相同）**，调用方就不会提示更新。
 * 反过来（当作不同）会导致：版本号格式一怪，每次启动都弹出"有新版本"。
 */
export function compareVersion(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;

  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const x = va[i] ?? 0;
    const y = vb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** `latest` 是否比 `current` 新 */
export function isNewer(latest: string, current: string): boolean {
  return compareVersion(latest, current) > 0;
}

/** 展示用：统一成 `v` 前缀 */
export function versionLabel(raw: string): string {
  const v = raw.trim().replace(/^[vV]/, '');
  return v ? `v${v}` : raw;
}
