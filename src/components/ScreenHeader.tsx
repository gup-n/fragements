/** 子页面统一页头：48dp动作槽，左右动作等宽，长标题和大字体允许增高。 */
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useThemedStyles, type Palette, type ThemeMetrics } from '../theme';
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
  title,
  subtitle,
  onBack,
  backIcon = 'chevron-back',
  backLabel = '返回',
  right,
  bordered = true,
}: Props) {
  const { styles, metrics } = useThemedStyles(makeStyles);
  const headingRef = useHeadingFocus(title);
  const [rightWidth, setRightWidth] = useState(0);
  const sideWidth = Math.max(metrics.controlHeight, rightWidth);
  return (
    <View style={[styles.wrap, bordered && styles.bordered]}>
      <View style={[styles.side, { width: sideWidth }]}>
        {onBack ? (
          <IconButton name={backIcon} onPress={onBack} size={22} tone="soft" accessibilityLabel={backLabel} />
        ) : null}
      </View>
      <View style={styles.center}>
        <Text ref={headingRef} accessible style={styles.title} numberOfLines={2} accessibilityRole="header">{title}</Text>
        {subtitle ? <Text style={styles.sub} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      <View style={[styles.side, { width: sideWidth }, styles.sideRight]}>
        <View
          style={styles.actions}
          onLayout={(e) => {
            const measured = Math.ceil(e.nativeEvent.layout.width);
            setRightWidth((previous) => previous === measured ? previous : measured);
          }}
        >
          {right}
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', minHeight: 60,
    paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.page,
  },
  bordered: { borderBottomWidth: metrics.strokeWidth, borderBottomColor: c.hair },
  side: { alignItems: 'flex-start', justifyContent: 'center' },
  sideRight: { alignItems: 'flex-end' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
  center: { flex: 1, minWidth: 0, alignItems: 'center', paddingHorizontal: 6 },
  title: { fontSize: 17, lineHeight: 24, color: c.text, fontWeight: '600', textAlign: 'center' },
  sub: { fontSize: 12, lineHeight: 18, color: c.text2, marginTop: 2, textAlign: 'center' },
});
