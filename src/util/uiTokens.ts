/** Shared UI roles. Pure, color-free tokens: importing them never freezes a theme. */
import type { TextStyle } from 'react-native';
import type { ThemeMetrics } from './appearance';

/** 字号档位。用户可选的四种，倍数在 `TYPE_SCALE_FACTOR` */
export type TypeScale = 'small' | 'normal' | 'large' | 'xlarge';

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
/** 字号档位的倍数。1 = 标准；小/大/特大只动字号与行高，不动间距 */
export const TYPE_SCALE_FACTOR: Record<TypeScale, number> = {
  small: 0.9,
  normal: 1,
  large: 1.1,
  xlarge: 1.22,
};

export const TYPE_SCALE_LABEL: Record<TypeScale, string> = {
  small: '小', normal: '标准', large: '大', xlarge: '特大',
};

export function normalizeTypeScale(raw: unknown): TypeScale {
  return raw === 'small' || raw === 'large' || raw === 'xlarge' ? raw : 'normal';
}

const BASE_TYPE = {
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

export type TypeRole = {
  fontSize: number;
  lineHeight: number;
  fontWeight: TextStyle['fontWeight'];
};
export type TypeKey = keyof typeof BASE_TYPE;

/**
 * 按倍数缩放一套字号。
 *
 * **行高跟着字号一起放大**：只放大字号会让中文行与行挤成一块，
 * 而「看得清但读不动」比「小一点」更糟。取整是为了让同一屏里的
 * 字高差保持在整数像素上（半像素在 Android 上会被拉成 1 或 0）。
 */
function buildType(factor: number): Record<TypeKey, TypeRole> {
  const out = {} as Record<TypeKey, TypeRole>;
  for (const key of Object.keys(BASE_TYPE) as TypeKey[]) {
    const base = BASE_TYPE[key];
    out[key] = {
      fontSize: Math.round(base.fontSize * factor),
      lineHeight: Math.round(base.lineHeight * factor),
      fontWeight: base.fontWeight,
    };
  }
  return out;
}

/**
 * 字号角色。**这是一个会变的导出**（v0.26）。
 *
 * 为什么不是「传给每个样式工厂的参数」：40 多个 `makeStyles(c, metrics)` 全都
 * 在函数体里 `...TYPE.body`，加一个参数就要改 40 多个签名、还要逐个记得用。
 * 改成「模块级当前档位 + 让 `metrics` 带上档位值」——
 * `useThemedStyles` 的 memo 以 metrics 为依赖，档位一变整页样式全部重建，
 * 而每个工厂照旧写 `...TYPE.body`。
 *
 * 代价是它不纯：读 TYPE 的地方必须在**重新渲染之后**才拿到新值。
 * 所以改档位一定要走 `applyTypeScale`（先改这里、再 setState），
 * 别在渲染过程中调 `setTypeScale`。
 */
export let TYPE = buildType(1);

/** 改当前档位。只在设置页/启动读设置时调，且必须先于包含它的那次渲染 */
export function setTypeScale(scale: TypeScale): void {
  TYPE = buildType(TYPE_SCALE_FACTOR[scale]);
}

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
