/** 新页面/覆盖层挂载后只为屏幕阅读器聚焦标题，不抢普通输入焦点。 */
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import type React from 'react';

export function useHeadingFocus(key: string) {
  const headingRef = useRef<React.ComponentRef<typeof Text>>(null);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
        if (active && enabled && headingRef.current) {
          AccessibilityInfo.sendAccessibilityEvent(headingRef.current, 'focus');
        }
      }).catch(() => { /* 辅助服务不可用不能阻断页面。 */ });
    }, 100);
    return () => { active = false; clearTimeout(timer); };
  }, [key]);
  return headingRef;
}
