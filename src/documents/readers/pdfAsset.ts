/**
 * PDF.js 资源定位。
 *
 * 这份 HTML 是**构建期生成的自包含文件**（见 `scripts/prepare_pdf.mjs`）：
 * PDF.js 主库、worker、中文 CMap 全部内联在里面。运行期只做一件事 ——
 * 把 asset 落到本机缓存，拿到 `file://` URI 交给 WebView。
 *
 * 为什么不 `source={{ html: 字符串 }}`：那要把 2 MB 多的 HTML 每次过一遍 RN bridge；
 * 也不方便 WebView 把它当成同源页面去读原文件。走 URI 更省内存，也能用
 * `allowUniversalAccessFromFileURLs` 让页面 XHR 读 App 私有目录里的 PDF。
 */
import { Asset } from 'expo-asset';
import htmlAsset from '../../../assets/pdfjs/reader.html';
import { ReaderError } from './errors';

let pending: Promise<string> | null = null;

export function pdfHtmlUri(): Promise<string> {
  if (pending) return pending;
  pending = (async () => {
    const asset = Asset.fromModule(htmlAsset);
    if (!asset.localUri) await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;
    if (!uri || !/^(file|content|asset):/.test(uri)) {
      throw new ReaderError(
        'no-file',
        'PDF 阅读器资源没有打进安装包（缺 assets/pdfjs/reader.html）。请重新构建 App。',
      );
    }
    return uri;
  })().catch((e) => {
    // 失败不缓存，否则一次临时失败会让整个进程再也打不开 PDF
    pending = null;
    throw e;
  });
  return pending;
}
