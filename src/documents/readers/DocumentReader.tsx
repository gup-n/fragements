/**
 * 应用内阅读器的统一入口。
 *
 * 只做分派：格式判定用 `documents/formats.ts` 的唯一一份实现，四种格式各自
 * 有自己的阅读器。首版没有阅读器的格式（Word、PPT 等）**不当成错误处理**——
 * 原件还在，明确告诉用户「用外部应用打开」比给个打不开的空白页好。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Document } from '../../types';
import { ScreenHeader } from '../../components/ScreenHeader';
import { useThemedStyles, type Palette } from '../../theme';
import { documentFormat, type DocumentFormat } from '../formats';
import { formatSize } from './errors';
import { TextReader } from './TextReader';
import { SheetReader } from './SheetReader';
import { PdfReader } from './PdfReader';

function subtitleOf(doc: Document, fmt: DocumentFormat): string {
  const size = formatSize(doc.size);
  switch (fmt) {
    case 'pdf':
      return doc.pages && doc.pages > 0 ? `PDF · ${doc.pages} 页 · ${size}` : `PDF · ${size}`;
    case 'excel':
      return `表格 · ${doc.ext.toUpperCase()} · ${size}`;
    case 'markdown':
      return `Markdown · ${size}`;
    case 'text':
      return `纯文本 · ${size}`;
    default:
      return `${doc.ext ? doc.ext.toUpperCase() : '未知格式'} · ${size}`;
  }
}

export function DocumentReader({
  document: doc,
  embedded = false,
}: {
  document: Document;
  /**
   * 嵌进别人页面（`DocViewer` 的覆盖层）时为 true：不画自己的页头，
   * 根节点撑满父容器。
   *
   * 为什么要有这个开关而不是让调用方自己裁：阅读器内部是 FlatList/WebView，
   * 外面再包一层 ScrollView 会同时毁掉虚拟化、把「点一下滚动」变成两层手势
   * 打架。所以嵌入方只能把整块区域让给它，页头得由嵌入方提供。
   */
  embedded?: boolean;
}) {
  const { styles } = useThemedStyles(makeStyles);
  const fmt = documentFormat(doc.ext);

  return (
    <View style={styles.root}>
      {embedded ? null : (
        <ScreenHeader title={doc.name} subtitle={subtitleOf(doc, fmt)} bordered />
      )}
      {fmt === 'pdf' ? (
        <PdfReader key={`pdf-${doc.id}`} document={doc} />
      ) : fmt === 'excel' ? (
        <SheetReader key={`sheet-${doc.id}`} document={doc} />
      ) : fmt === 'markdown' ? (
        <TextReader key={`md-${doc.id}`} document={doc} mode="markdown" />
      ) : fmt === 'text' ? (
        <TextReader key={`txt-${doc.id}`} document={doc} mode="text" />
      ) : doc.bodyMd.trim() ? (
        /*
         * Word / PPT / 图片没有本机阅读器，但**云解析出来过正文**。
         * 这一段不能省：v0.11.0 里它们就是靠这段文本可读的，
         * 换成「这种格式读不了」等于把已有内容弄丢了。
         *
         * 以前这里是一个 ScrollView + 整篇 NoteBody：几百个块一次性布局，
         * 文档越长打开越慢、滑动越顿，而且没有查找。现在交给 TextReader，
         * 分块虚拟化和查找栏都是现成的，代价只是把正文从库里读出来。
         */
        <TextReader
          key={`snapshot-${doc.id}`}
          document={doc}
          mode="markdown"
          text={doc.bodyMd}
          notice="这是云解析得到的文本，版式可能失真。要看原样请用「打开原文件」。"
        />
      ) : (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>这种格式还没有应用内阅读器</Text>
          <Text style={styles.stateHint}>
            「{doc.ext || '未知'}」格式只能先在应用外打开，或者确认后上传到 mineru.net 取正文。原件仍在本机。
          </Text>
        </View>
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.page },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  stateTitle: { fontSize: 15, color: c.text, fontWeight: '600' },
  stateHint: { fontSize: 12.5, lineHeight: 19, color: c.text3, textAlign: 'center', maxWidth: 300 },
});
