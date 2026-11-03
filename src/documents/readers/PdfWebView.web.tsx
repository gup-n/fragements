/**
 * WebView 容器（Web 平台）。
 *
 * `npm run build:web` 会真的打包一遍，只要 `react-native-webview` 出现在 web 的
 * 依赖图里，它自己的原生组件引用就会把打包带崩。所以这里是**完全不含**
 * react-native-webview 的空实现：网页版没有应用内阅读器，界面上明确说明。
 *
 * 不是「先能编译、运行再说」——`PDF_WEBVIEW_SUPPORTED = false` 会让
 * 阅读器和提取器都走明确的降级分支，不会尝试挂一个假 WebView。
 */
import React, { forwardRef, useImperativeHandle } from 'react';
import type { PdfWebViewHandle, PdfWebViewProps } from './pdfProtocol';

export const PDF_WEBVIEW_SUPPORTED = false;

export const PdfWebView = forwardRef<PdfWebViewHandle, PdfWebViewProps>(function PdfWebView(
  _props,
  ref,
) {
  useImperativeHandle(ref, () => ({ send() {} }), []);
  return null;
});
