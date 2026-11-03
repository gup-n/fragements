/**
 * WebView 容器（Android / iOS）。
 *
 * 这个文件里有三处不是「随便写的」，都是有原因的：
 *
 * 1. `allowFileAccess` + `allowFileAccessFromFileURLs` + `allowUniversalAccessFromFileURLs`
 *    三个都要开。安卓 API 30 起 `file://` 默认关闭；只开第一个时页面能加载，
 *    但页面里 XHR 读不了 App 私有目录里的 PDF（那正是我们不做 base64 传文件的前提）。
 * 2. `originWhitelist={['*']}`：RN WebView 默认只放行 http(s)，`file://` 会被当成非法地址。
 * 3. `onShouldStartLoadWithRequest` 只放行本地协议。PDF 里的链接、`target=_blank`
 *    都不允许把用户带到网络上 —— 阅读不应该产生任何远程请求。
 */
import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { WebView, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview';
import {
  parseFromPage,
  type PdfWebViewHandle,
  type PdfWebViewProps,
} from './pdfProtocol';

/** 用来做平台判断，web 版是 false */
export const PDF_WEBVIEW_SUPPORTED = true;

/**
 * `react-native-webview@14` 的类型声明本身有缺陷：
 *
 * ```ts
 * declare class WebView<P = undefined> extends Component<WebViewProps & P>
 * ```
 *
 * 默认泛型是 `undefined`，于是 props 变成 `WebViewProps & undefined` —— 在 TS 里
 * 就是 `never`，写任何属性都报「Type ... is not assignable to type 'never'」。
 * 运行时的组件完全正常，纯粹是类型没写对。这里显式给它一份 props 类型，
 * 不要 `as any`：保留属性名检查，写错 `sorce` 这种拼写仍然会报错。
 */
type CompatibleWebViewProps = WebViewProps & { ref?: React.Ref<unknown> };
const WebViewCompat = WebView as unknown as React.ComponentType<CompatibleWebViewProps>;

const LOCAL_ONLY = /^(file|about|data|blob):/i;

export const PdfWebView = forwardRef<PdfWebViewHandle, PdfWebViewProps>(function PdfWebView(
  { uri, style, onMessage, onFail, onLoaded },
  ref,
) {
  const view = useRef<{ postMessage: (s: string) => void } | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      send(msg) {
        view.current?.postMessage(JSON.stringify(msg));
      },
    }),
    [],
  );

  return (
    <WebViewCompat
      ref={view}
      source={{ uri }}
      style={style}
      originWhitelist={['*']}
      allowFileAccess
      allowFileAccessFromFileURLs
      allowUniversalAccessFromFileURLs
      javaScriptEnabled
      domStorageEnabled={false}
      cacheEnabled={false}
      setSupportMultipleWindows={false}
      mixedContentMode="never"
      // 不允许页面把用户带出本地：外链、window.open 一律拦掉
      onShouldStartLoadWithRequest={(req) => LOCAL_ONLY.test(req.url)}
      onLoadEnd={() => onLoaded?.()}
      onError={(e) => onFail?.(e.nativeEvent.description || '内置阅读器启动失败')}
      onHttpError={(e) => onFail?.(`内置阅读器加载失败（HTTP ${e.nativeEvent.statusCode}）`)}
      onMessage={(e: WebViewMessageEvent) => {
        const msg = parseFromPage(e.nativeEvent.data);
        if (msg) onMessage(msg);
      }}
    />
  );
});
