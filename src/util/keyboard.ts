import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * 当前键盘高度（已扣掉导航栏），键盘收起时为 0。
 *
 * 为什么不用 `KeyboardAvoidingView`：
 * 本项目开启了 edge-to-edge（`WindowCompat.setDecorFitsSystemWindows(false)`），
 * 窗口不再随输入法缩放。而 RN 0.88 的 KeyboardAvoidingView 用
 * `frame.y + frame.height - keyboardY` 推算需要抬升的距离，其中 `keyboardY`
 * 取的是「可视区域底边」—— edge-to-edge 下它就等于屏幕底边，于是
 * `frame.height` 永远够不到它，结果被 `Math.max(..., 0)` 夹成 0，
 * 在 Android 上等于完全没生效。这就是输入栏被键盘整个盖住的原因。
 *
 * 直接读 `endCoordinates.height` 更可靠：RN 的 Android 实现是
 * `imeInsets.bottom - barInsets.bottom`，即「扣掉系统栏的纯键盘高度」。
 * 因为 SafeAreaView 已经把底部安全区预留掉了，所以这个值正好等于
 * 还需要额外抬升的距离，不用再减 inset。
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS === 'web') return;

    // Android 没有 keyboardWillShow，只有 Did；收起同理
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      setHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => setHeight(0));

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return height;
}
