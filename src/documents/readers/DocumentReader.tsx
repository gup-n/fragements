/** 只读入口：格式/容量沿用唯一判据；读原件和正文快照均不自动准备或上传。 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Document } from '../../types';
import { ScreenHeader } from '../../components/ScreenHeader';
import { SPACE, TYPE, useThemedStyles, type Palette } from '../../theme';
import { localReaderLimitNote } from '../../util/docSupport';
import { documentFormat, LOCAL_READER_LIMITS, type DocumentFormat } from '../formats';
import { formatSize } from './errors';
import { TextReader } from './TextReader';
import { SheetReader } from './SheetReader';
import { PdfReader } from './PdfReader';
import { documentReadMode } from './readerAvailability';

function subtitleOf(doc: Document, fmt: DocumentFormat): string {
  const size = formatSize(doc.size);
  switch (fmt) {
    case 'pdf': return doc.pages && doc.pages > 0 ? `PDF · ${doc.pages} 页 · ${size}` : `PDF · ${size}`;
    case 'excel': return `表格 · ${doc.ext.toUpperCase()} · ${size}`;
    case 'markdown': return `Markdown · ${size}`;
    case 'text': return `纯文本 · ${size}`;
    default: return `${doc.ext ? doc.ext.toUpperCase() : '未知格式'} · ${size}`;
  }
}

export function DocumentReader({ document: doc, embedded = false }: {
  document: Document;
  /** 嵌入方只让出高度，不能再套ScrollView，否则会破坏内部虚拟化。 */
  embedded?: boolean;
}) {
  const { styles } = useThemedStyles(makeStyles);
  const fmt = documentFormat(doc.ext);
  const limitNote = localReaderLimitNote(doc);
  const mode = documentReadMode(doc, limitNote);
  const snapshotNotice = doc.origin === 'knowledge' ? undefined : !doc.fileUri
    ? '原文件已不在手机上。这里是已保留的正文快照，不代表原版式。'
    : '这里是已提取的正文快照，版式可能失真。查看原样请用「打开原件」。';

  return (
    <View style={styles.root}>
      {!embedded ? <ScreenHeader title={doc.name} subtitle={subtitleOf(doc, fmt)} bordered /> : null}
      {mode === 'snapshot' ? (
        <TextReader
          key={`snapshot-${doc.id}`} document={doc} mode={fmt === 'text' ? 'text' : 'markdown'}
          text={doc.bodyMd} notice={snapshotNotice}
        />
      ) : mode === 'original' && fmt === 'pdf' ? <PdfReader key={`pdf-${doc.id}`} document={doc} />
        : mode === 'original' && fmt === 'excel' ? <SheetReader key={`sheet-${doc.id}`} document={doc} />
        : mode === 'original' && (fmt === 'markdown' || fmt === 'text') ? (
          <TextReader key={`${fmt}-${doc.id}`} document={doc} mode={fmt} />
        ) : (
          <View style={styles.state}>
            <Text style={styles.stateTitle}>请用外部应用打开原件</Text>
            <Text style={styles.stateHint}>
              {doc.bodyMd.length > LOCAL_READER_LIMITS.bodyChars
                ? '正文超过应用内阅读上限200万字，不会静默截断。原件仍可交给其它应用打开。'
                : limitNote || (doc.fileUri
                  ? `「${doc.ext || '未知'}」格式还没有本机阅读器。需要正文时，可自行确认是否上传到 mineru.net 解析。`
                  : '本机没有可读原件或正文快照，请重新导入原文件。')}
            </Text>
          </View>
        )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.page },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl, gap: SPACE.sm },
  stateTitle: { ...TYPE.heading, color: c.text, textAlign: 'center' },
  stateHint: { ...TYPE.body, color: c.text2, textAlign: 'center', maxWidth: 360 },
});
