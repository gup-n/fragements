import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { R, tagColor } from '../theme';

export function TagPill({ label, small }: { label: string; small?: boolean }) {
  const { bg, fg } = tagColor(label);
  return (
    <View style={[styles.pill, { backgroundColor: bg }, small && styles.pillSmall]}>
      <Text style={[styles.text, { color: fg }, small && styles.textSmall]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: R.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
    maxWidth: 120,
  },
  pillSmall: {
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  text: {
    fontSize: 12,
    lineHeight: 16,
  },
  textSmall: {
    fontSize: 11,
    lineHeight: 15,
  },
});
