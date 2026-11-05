/**
 * RN ↔ WebView 的消息契约。
 *
 * 单独一个文件是为了让两边对得上：HTML 里那段 JS 是字符串，`tsc` 检查不到它，
 * 消息字段写错只会在真机上表现为「点了没反应」。所以类型写在这里，
 * HTML 侧按同样的 `type` 字符串收发，改一处时这里必须同步。
 *
 * 顺序上的坑：RN 的 `postMessage` 在页面脚本跑起来之前发出去会丢。
 * 因此页面启动完成后先发 `ready`，RN 收到 `ready` 才发 `open`。
 */
import type { StyleProp, ViewStyle } from 'react-native';

/** 传给 WebView 的主题色。只给 WebView 用得上的一小撮，不整份 Palette */
export interface PdfTheme {
  page: string;
  text: string;
  text2: string;
  text3: string;
  hair: string;
  accent: string;
  accentText: string;
  hitBg: string;
  hitCurrent: string;
  danger: string;
}

export type PdfToPage =
  | {
      type: 'open';
      uri: string;
      mode: 'view' | 'extract';
      theme: PdfTheme;
      title: string;
      /** 页数上限由 RN 传，避免同一个常量在 HTML 里再抄一份 */
      maxPages: number;
    }
  | { type: 'find'; query: string }
  | { type: 'find-move'; delta: number }
  | { type: 'cancel' }
  | { type: 'theme'; theme: PdfTheme };

export type PdfFromPage =
  | { type: 'ready' }
  /**
   * 文档打开了（首屏可以画了）。
   *
   * `hasText` 为 `null` 表示**文字还没索引**：阅读模式不再等全篇 `getTextContent`
   * 才报 `loaded`，否则 100 页的 PDF 要等它跑完才画出第一页。有结果之后再补一条
   * `text-ready`。提取模式（`done`）不受影响，它本来就要求整篇跑完。
   */
  | { type: 'loaded'; pageCount: number; hasText: boolean | null }
  /** 后台文字索引完成。`hasText=false` 是扫描件：能翻不能搜 */
  | { type: 'text-ready'; hasText: boolean }
  /** 提取进度。`text` 是**已提取部分的累计文本**，任务层只拿它显示进度 */
  | { type: 'progress'; pagesDone: number; text: string }
  /** 提取完成。空字符串页保留位置，切片时按 page 号定位 */
  | { type: 'done'; pageTexts: string[]; pageCount: number }
  /** 查找结果。`current` 从 1 起，0 表示没有命中；`total` 是全量命中数 */
  | { type: 'find'; total: number; current: number }
  | { type: 'error'; code: string; message: string };

export function parseFromPage(raw: string): PdfFromPage | null {
  try {
    const v = JSON.parse(raw) as PdfFromPage;
    if (!v || typeof v !== 'object' || typeof (v as { type?: unknown }).type !== 'string') return null;
    return v;
  } catch {
    return null;
  }
}

/** 命令式句柄：页面就绪后由外部下发命令（查找、取消、换主题） */
export interface PdfWebViewHandle {
  send(msg: PdfToPage): void;
}

export interface PdfWebViewProps {
  /** `file://` 下的 reader.html */
  uri: string;
  style?: StyleProp<ViewStyle>;
  onMessage: (msg: PdfFromPage) => void;
  onFail?: (message: string) => void;
  /** 页面第一次加载完成（不代表 PDF 打开成功） */
  onLoaded?: () => void;
}
