/**
 * 文档阅读器与本地提取的公开入口。
 *
 * 对外只有这四样东西（契约见 docs/plans/2026-11-03-documents-contracts.md）：
 *
 * ```ts
 * DocumentReader({ document })        // 应用内阅读，自带查找
 * DocumentRuntime()                   // 常驻 App 根节点，跑 PDF 提取队列
 * extractLocalDocument(document)      // 本地提取成正文 + 切片
 * contentFromText(text, source?)      // 纯文本 → 正文 + 切片
 * ```
 *
 * 其余模块都是实现细节，不要从 `readers/pdfRuntime` 之类的地方直接 import ——
 * 那样以后换实现（比如改用原生 PDF 组件）要改一圈调用点。
 */
export { DocumentReader } from './DocumentReader';
export { DocumentRuntime } from './pdfRuntime';
export { extractLocalDocument, type LocalExtractOptions } from './extract';
export { contentFromText } from './chunk';
export { ReaderError, type ReaderErrorCode } from './errors';
