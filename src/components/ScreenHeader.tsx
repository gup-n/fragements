/** Page header: open title hierarchy and fixed touch targets, never a compressed icon strip. */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SPACE, TYPE, surfaceStroke, useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
import { IconButton, type IoniconName } from './IconButton';
import { useHeadingFocus } from './useHeadingFocus';

interface Props {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  backIcon?: IoniconName;
  backLabel?: string;
  right?: React.ReactNode;
  bordered?: boolean;
}

export function ScreenHeader({
  title, subtitle, onBack, backIcon = 'chevron-back', backLabel = '返回', right, bordered = true,
}: Props) {
  const { styles } = useThemedStyles(makeStyles);
  const headingRef = useHeadingFocus(title);
  return (
    <View style={[styles.wrap, bordered && styles.bordered]}>
      {onBack ? (
        <View style={styles.back}>
          <IconButton name={backIcon} onPress={onBack} size={22} tone="none" accessibilityLabel={backLabel} />
        </View>
      ) : null}
      <View style={styles.center}>
        <Text ref={headingRef} accessible style={styles.title} numberOfLines={2} accessibilityRole="header">{title}</Text>
        {subtitle ? <Text style={styles.sub} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {right ? <View style={styles.actions}>{right}</View> : null}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', minHeight: 72,
    paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs, backgroundColor: c.page,
  },
  bordered: { borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair },
  back: { alignItems: 'flex-start', justifyContent: 'center', marginRight: SPACE.xs },
  actions: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs, flexShrink: 0, marginLeft: SPACE.xs },
  center: { flex: 1, minWidth: 0, justifyContent: 'center' },
  title: { ...TYPE.title, color: c.text },
  sub: { ...TYPE.meta, color: c.text2, marginTop: SPACE.xxs },
});
