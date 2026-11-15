/** Shared UI roles. Pure, color-free tokens: importing them never freezes a theme. */
import type { ThemeMetrics } from './appearance';

export const SPACE = {
  xxs: 4, xs: 8, sm: 12, md: 16, lg: 20, xl: 24, xxl: 32,
} as const;

/** Font roles intentionally retain native/system font scaling. */
export const TYPE = {
  display: { fontSize: 28, lineHeight: 40, fontWeight: '700' },
  heading: { fontSize: 22, lineHeight: 30, fontWeight: '700' },
  title: { fontSize: 18, lineHeight: 26, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 24, fontWeight: '400' },
  reading: { fontSize: 17, lineHeight: 30, fontWeight: '400' },
  label: { fontSize: 13, lineHeight: 20, fontWeight: '600' },
  meta: { fontSize: 12, lineHeight: 18, fontWeight: '400' },
  caption: { fontSize: 11, lineHeight: 16, fontWeight: '500' },
} as const;

/** Decoration stays quiet on ordinary screens, definite on monochrome controls. */
export function surfaceStroke(metrics: ThemeMetrics): number {
  return metrics.cardRadius <= 4 ? metrics.strokeWidth : 0.5;
}

/** A dedicated navigation row does not compete with the page title for width. */
export function navigationLayout(width: number, fontScale = 1) {
  const compact = width < 360 || fontScale > 1.3;
  return {
    compact,
    // Four equal slots; glyphs and text may wrap vertically instead of shrinking touch targets.
    gap: compact ? SPACE.xxs : SPACE.xs,
    horizontalPadding: compact ? SPACE.sm : SPACE.md,
    minimumSlot: 48,
  };
}
