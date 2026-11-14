/** 进度图形只改变呈现：墨水/系统减少动效时不连续旋转，业务状态仍由调用者保留。 */
import React from 'react';
import { ActivityIndicator, View, type ActivityIndicatorProps } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../theme';

export function BusyIndicator(props: ActivityIndicatorProps) {
  const { c, reduceMotion } = useTheme();
  if (!reduceMotion) return <ActivityIndicator {...props} />;
  if (props.animating === false && props.hidesWhenStopped !== false) return null;
  const size = typeof props.size === 'number' ? props.size : props.size === 'large' ? 36 : 20;
  return (
    <View
      style={props.style}
      accessibilityRole="progressbar"
      accessibilityLabel={props.accessibilityLabel ?? '处理中'}
      accessibilityState={{ busy: props.animating !== false }}
      testID={props.testID}
    >
      <Ionicons name="ellipsis-horizontal-circle-outline" size={size} color={typeof props.color === 'number' ? c.text3 : props.color ?? c.text2} accessible={false} />
    </View>
  );
}
