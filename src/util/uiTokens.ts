/** Shared UI roles. Pure, color-free tokens: importing them never freezes a theme. */
import type { ThemeMetrics } from './appearance';

export const SPACE = {
  xxs: 4, xs: 8, sm: 12, md: 16, lg: 20, xl: 24, xxl: 32,
} as const;

/**
 * Font roles intentionally retain native/system font scaling.
 *
 * 八个角色原来不够用，于是到处出现 `fontSize: 17`、`lineHeight: 23` 这种
 * 就地写的值 —— 单看每一处都「只差一两个像素」，合起来就是同一屏里
 * 页头 17、正文 16、文档标题 16/23、待办 15/22、摘要 14/20，谁也说不清差在哪。
 *
 * 补两个角色把常用档位收干净：
 * - `subtitle` 17/24：页头标题。它要压在 16 的正文之上、18 的卡片标题之下。
 * - `compact` 14/21：列表行、摘要、图片状态这类「次要正文」。
 *   比 body 紧一档，但不像 meta 那样读到 12 号。
 */
export const TYPE = {
  display: { fontSize: 28, lineHeight: 40, fontWeight: '700' },
  heading: { fontSize: 22, lineHeight: 30, fontWeight: '700' },
  /** 卡片标题 */
  title: { fontSize: 18, lineHeight: 26, fontWeight: '600' },
  /** 页头标题：比卡片标题小一号，比正文大一号 */
  subtitle: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
  // 正文 16/26：DeepSeek 的正文比常见的 14/15 大一号，长句读起来不挤
  body: { fontSize: 16, lineHeight: 26, fontWeight: '400' },
  reading: { fontSize: 17, lineHeight: 30, fontWeight: '400' },
  /** 次要正文：列表行、摘要、图片状态 */
  compact: { fontSize: 14, lineHeight: 21, fontWeight: '400' },
  label: { fontSize: 13, lineHeight: 20, fontWeight: '600' },
  meta: { fontSize: 12, lineHeight: 18, fontWeight: '400' },
  caption: { fontSize: 11, lineHeight: 16, fontWeight: '500' },
} as const;

/**
 * Decoration stays quiet on ordinary screens, definite on monochrome controls.
 *
 * 判据是 `outline` 这个显式开关，不再从圆角大小反推。反推过的代价：
 * 一旦把墨水的圆角调圆（用户 2026-11-15 说方角扎眼），`cardRadius <= 4`
 * 就悄悄失效，所有边线掉回 0.5 —— 墨水的「靠线表达边界」当场没了，
 * 而且 tsc 和断言都不会响。
 *
 * 所有「分隔线 / 卡片描边」都应该走它，而不是直接写 `metrics.strokeWidth`：
 * 后者在默认主题下是 1，是 surfaceStroke 的两倍粗，同一页里会出现两种线宽。
 */
export function surfaceStroke(metrics: ThemeMetrics): number {
  return metrics.outline > 0 ? metrics.strokeWidth : 0.5;
}
