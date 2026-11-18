/**
 * TXT / Markdown / 云解析快照共用分块虚拟化。
 * TXT 原文显示；Markdown 保留作者的 [F12] 等字面引用。
 * 查找与高亮只用 findHits，位置来自真实块/原文偏移，不编PDF页码。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import type { Document } from '../../types';
import { SPACE, TYPE, surfaceStroke, useTheme, useThemedStyles, type Palette, type ThemeMetrics } from '../../theme';
import { BusyIndicator as ActivityIndicator } from '../../components/BusyIndicator';
import { NoteBody } from '../../components/NoteBody';
import { fragmentImageUri } from '../../db/fragmentImages';
import { findHits } from '../../util/highlight';
import { SearchBar } from './SearchBar';
import { readDocText } from './readerFiles';
import { readerMessage } from './errors';
import { blockAt, buildBlocks, type Block } from './textBlocks';
import { markdownHitBlocks } from './markdownSearch';

const MAX_HITS = 999;

interface Props {
  document: Document;
  mode: 'text' | 'markdown';
  /** 已有正文快照，不再读原文件。 */
  text?: string;
  /** 跟正文滚走，不常驻挤占阅读区。 */
  notice?: string;
}

function storedBodyOf(doc: Document, mode: 'text' | 'markdown'): string | null {
  if (doc.contentRevision <= 0 || doc.contentSource !== mode) return null;
  return doc.bodyMd?.length ? doc.bodyMd : null;
}

export function TextReader({ document: doc, mode, text: providedText, notice }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const { reduceMotion } = useTheme();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hitIndex, setHitIndex] = useState(0);
  const listRef = useRef<FlatList<Block>>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (retryTimer.current) clearTimeout(retryTimer.current); }, []);

  useEffect(() => {
    setText(null);
    setError(null);
    setHitIndex(0);
    setQuery('');
    if (retryTimer.current) clearTimeout(retryTimer.current);
    let cancelled = false;
    if (providedText !== undefined) {
      setText(providedText);
      return;
    }
    const stored = storedBodyOf(doc, mode);
    if (stored !== null) {
      setText(stored);
      return;
    }
    (async () => {
      try {
        const body = doc.fileUri ? await readDocText(doc.fileUri) : doc.bodyMd ?? '';
        if (!cancelled) setText(body);
      } catch (e) {
        if (!cancelled) setError(readerMessage(e, '读不了这个文件'));
      }
    })();
    return () => { cancelled = true; };
    // 不依赖主题、整个doc对象或仅元数据updatedAt，避免刷新时丢查询和阅读位置。
  }, [doc.fileUri, doc.id, doc.bodyMd, doc.contentSource, doc.contentRevision, mode, providedText]);

  const blocks = useMemo(() => text === null ? [] : buildBlocks(text), [text]);
  const q = query.trim();
  const textHits = useMemo(
    () => mode === 'text' && text !== null && q ? findHits(text, q, MAX_HITS) : [],
    [mode, q, text],
  );
  const hitBlocks = useMemo(() => {
    if (!q || text === null) return [] as number[];
    if (mode === 'text') return textHits.map((h) => blockAt(blocks, h.start));
    const out: number[] = [];
    for (let index = 0; index < blocks.length && out.length < MAX_HITS; index++) {
      for (const _ of markdownHitBlocks(blocks[index].text, q, true, MAX_HITS - out.length)) out.push(index);
    }
    return out;
  }, [blocks, mode, q, text, textHits]);
  const total = hitBlocks.length;
  const shown = total ? Math.min(hitIndex, total - 1) : 0;
  const currentBlock = total ? hitBlocks[shown] : -1;
  const currentInBlock = total ? shown - hitBlocks.indexOf(currentBlock) : -1;

  const jump = useCallback((next: number) => {
    if (!total) return;
    const at = Math.min(Math.max(next, 0), total - 1);
    setHitIndex(at);
    try {
      listRef.current?.scrollToIndex({ index: hitBlocks[at], animated: !reduceMotion, viewPosition: 0.15 });
    } catch { /* 未测量块由onScrollToIndexFailed继续定位 */ }
  }, [hitBlocks, total, reduceMotion]);
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  useEffect(() => {
    setHitIndex(0);
    if (hitBlocks.length) jumpRef.current(0);
  }, [hitBlocks]);

  const lineNote = useMemo(() => {
    const hit = textHits[shown];
    if (mode !== 'text' || !hit || !text) return undefined;
    return `第 ${text.slice(0, hit.start).split('\n').length} 行`;
  }, [mode, shown, text, textHits]);

  // TXT直接按全文真实偏移切高亮，跨虚拟块的命中也不会丢掉可见部分。
  const plain = (block: Block): React.ReactNode => {
    if (!q) return block.text;
    const parts: React.ReactNode[] = [];
    let last = 0;
    const end = block.start + block.text.length;
    textHits.forEach((hit, index) => {
      if (hit.end <= block.start || hit.start >= end) return;
      const from = Math.max(0, hit.start - block.start);
      const to = Math.min(block.text.length, hit.end - block.start);
      if (from > last) parts.push(block.text.slice(last, from));
      parts.push(
        <Text key={index} style={[styles.hit, index === shown && styles.hitCurrent]}>
          {block.text.slice(from, to)}
        </Text>,
      );
      last = to;
    });
    if (last < block.text.length) parts.push(block.text.slice(last));
    return parts;
  };

  if (error) {
    return <View style={styles.state}><Text style={styles.stateTitle}>打不开这个文件</Text><Text style={styles.stateHint}>{error}</Text></View>;
  }
  if (text === null) {
    return <View style={styles.state}><ActivityIndicator color={c.accent} /><Text style={styles.stateHint}>正在读取原文件…</Text></View>;
  }

  return (
    <View style={styles.root}>
      <SearchBar
        value={query} onChange={setQuery} total={q ? total : -1} current={total ? shown + 1 : 0}
        note={lineNote} onPrev={() => jump(shown - 1)} onNext={() => jump(shown + 1)}
      />
      {text.length === 0 ? (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>这是一个空文件</Text>
          <Text style={styles.stateHint}>没有内容可以阅读，也没有可以查找的文字。</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef} data={blocks} keyExtractor={(_, i) => String(i)}
          ListHeaderComponent={notice ? <Text style={styles.notice}>{notice}</Text> : undefined}
          style={styles.list} contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
          initialNumToRender={10} maxToRenderPerBatch={10} windowSize={9} removeClippedSubviews
          onScrollToIndexFailed={(info) => {
            listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            if (retryTimer.current) clearTimeout(retryTimer.current);
            retryTimer.current = setTimeout(() => {
              try {
                listRef.current?.scrollToIndex({ index: info.index, animated: !reduceMotion, viewPosition: 0.15 });
              } catch { /* 下次布局后仍可使用前后命中按钮重新定位 */ }
            }, 60);
          }}
          renderItem={({ item, index }) => (
            <View style={[styles.block, index === currentBlock && styles.currentBlock]}>
              {mode === 'markdown' ? (
                <NoteBody
                  text={item.text} variant="reading" selectable literalCitations highlight={q || undefined}
                  activeHit={index === currentBlock ? currentInBlock : undefined}
                  /* 文档内嵌图：文件与碎片配图同目录，直接用同一个 uri 函数 */
                  fileUri={fragmentImageUri}
                />
              ) : <Text style={styles.body} selectable>{plain(item)}</Text>}
            </View>
          )}
        />
      )}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  root: { flex: 1 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.xl, paddingBottom: SPACE.xxl },
  block: { marginBottom: SPACE.sm, paddingLeft: SPACE.xs, borderLeftWidth: 2, borderLeftColor: 'transparent' },
  currentBlock: { borderLeftColor: c.focus },
  notice: { ...TYPE.body, color: c.text2, marginBottom: SPACE.xl, paddingBottom: SPACE.md, borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair },
  body: { ...TYPE.reading, color: c.text },
  hit: { backgroundColor: c.amberBg },
  hitCurrent: { textDecorationLine: 'underline', fontWeight: '700' },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl, gap: SPACE.sm },
  stateTitle: { ...TYPE.heading, color: c.text, textAlign: 'center' },
  stateHint: { ...TYPE.body, color: c.text2, textAlign: 'center', maxWidth: 360 },
});
