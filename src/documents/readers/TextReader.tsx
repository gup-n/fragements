/**
 * TXT / Markdown 阅读器。
 *
 * 两个格式共用一个文件，但**渲染路径不同**，这不是偷懒：
 *
 * - Markdown 交给 `NoteBody`（必须传 `literalCitations`）。文档正文里的 `[F12]`
 *   是作者写的字面量，不传这个开关就会被当成我们这轮的引用标记整个吞掉 ——
 *   等于把用户文档改了字。
 * - TXT 不能被 Markdown 解析：`# 第 3 章` 会变成标题，`*` 会变成圆点。
 *   TXT 就按纯文本画，除了换行什么都不解释。
 *
 * 查找计数跟着各自的渲染走，所以两条路径的口径也分开：
 * Markdown 按「渲染出来的片段」数（和 `FragmentDetail` 完全同一套），
 * TXT 按原文偏移数（它显示的就是原文）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import type { Document } from '../../types';
import { useThemedStyles, type Palette } from '../../theme';
import { NoteBody } from '../../components/NoteBody';
import { countHits, findHits } from '../../util/highlight';
import { parseBlocks, type Seg } from '../../util/mdBlocks';
import { SearchBar } from './SearchBar';
import { readDocText } from './readerFiles';
import { readerMessage } from './errors';
import { blockAt, buildBlocks, type Block } from './textBlocks';

/** 单次查找最多认多少处。超过就不再往上加，界面显示 99+ */
const MAX_HITS = 999;

/**
 * 一个 seg 在「字面量模式」下显示成什么。
 *
 * NoteBody 传了 `literalCitations` 之后 `[F12]` 会原样显示，
 * 这里必须还原成同样的字符串，计数才和屏幕上看到的一致。
 */
function segText(seg: Seg): string {
  return seg.cite ? `[${seg.cite.kind}${seg.cite.id}]` : seg.text;
}

interface Props {
  document: Document;
  mode: 'text' | 'markdown';
  /**
   * 直接给正文，不读原文件。
   *
   * 云解析出来的 Word / PPT 只有一段 Markdown 快照（库里 `bodyMd`），没有可读的
   * 原版式。以前这条分支在 `DocumentReader` 里自己包一个 ScrollView 把整篇塞
   * 给 `NoteBody`：几百个块一次布局，越长的文档越顿，而且**没有查找**。
   * 走这里就自动拿到分块虚拟化和查找栏。
   */
  text?: string;
  /** 正文上方的说明（例如「这是转出来的，不是原版式」）。跟内容一起滚走 */
  notice?: string;
}

/**
 * 库里这份正文是不是**就是这个文件本身**？
 *
 * txt/md 的本地提取产物就是原文件（`contentSource` 与格式一一对应），
 * 所以能拿它顶替「再读一次磁盘 + 再解一次 UTF-8」——4 MB 的文本这一下
 * 通常是几百毫秒。云解析（mineru）的正文**绝不能**用在这里：那是 OCR 结果，
 * 和原文件不是一个东西，拿来显示等于偷偷改了用户的文档。
 */
function storedBodyOf(doc: Document, mode: 'text' | 'markdown'): string | null {
  if (doc.contentRevision <= 0) return null;
  if (doc.contentSource !== mode) return null;
  const body = doc.bodyMd ?? '';
  return body.length > 0 ? body : null;
}

export function TextReader({ document: doc, mode, text: providedText, notice }: Props) {
  const { c, styles } = useThemedStyles(makeStyles);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hitIndex, setHitIndex] = useState(0);
  const listRef = useRef<FlatList<Block>>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    setText(null);
    setError(null);
    setHitIndex(0);
    setQuery('');
    let cancelled = false;

    // 已经拿在手上的正文（云解析快照）：不必再碰磁盘，也就没有读取失败这一步
    if (providedText !== undefined) {
      setText(providedText);
      return;
    }

    // 本机提取过、且提取的就是这个文件本身：库里的正文和文件逐字相同，直接用它
    const stored = storedBodyOf(doc, mode);
    if (stored !== null) {
      setText(stored);
      return;
    }

    (async () => {
      try {
        // 原件已经不在了（用户清理过存储）但正文快照还在：这时候读库里的 bodyMd。
        // 快照可以「旧」，但「打不开」是不可接受的 —— 用户问过的内容不能凭空消失。
        const body = doc.fileUri
          ? await readDocText(doc.fileUri)
          : doc.bodyMd ?? '';
        if (!cancelled && alive.current) setText(body);
      } catch (e) {
        if (!cancelled && alive.current) setError(readerMessage(e, '读不了这个文件'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    // 逐个字段而不是整个 `doc`：父层刷新时会给出新的对象，引用一变就会把用户的
    // 查找词和滚动位置清掉。这几项变了才真的代表「正文换了一份」。
    doc.fileUri,
    doc.id,
    doc.updatedAt,
    doc.bodyMd,
    doc.contentSource,
    doc.contentRevision,
    mode,
    providedText,
  ]);

  const blocks = useMemo(() => (text === null ? [] : buildBlocks(text)), [text]);
  const q = query.trim();

  /** TXT 的命中在原文上算一次，块映射和行号都用它，避免每次渲染重扫 4 MB */
  const textHits = useMemo(
    () => (mode === 'text' && text !== null && q ? findHits(text, q, MAX_HITS) : []),
    [mode, q, text],
  );

  /**
   * 命中 → 块下标。数组长度就是命中总数，所以计数不用另算一遍。
   *
   * Markdown 走「渲染片段」计数：`# 标题` 里的 `#` 用户根本看不到，
   * 按原文数会数出一堆点不中的命中。
   */
  const hitBlocks = useMemo(() => {
    if (!q || text === null) return [] as number[];
    if (mode === 'text') return textHits.map((h) => blockAt(blocks, h.start));

    const at: number[] = [];
    blocks.forEach((b, bi) => {
      let n = 0;
      for (const blk of parseBlocks(b.text)) {
        if (blk.kind === 'table') {
          for (const seg of blk.head.flat()) n += countHits(segText(seg), q);
          for (const row of blk.rows) for (const seg of row.flat()) n += countHits(segText(seg), q);
        } else if (blk.kind === 'code') {
          n += countHits(blk.text, q);
        } else if (blk.kind !== 'hr' && blk.kind !== 'image') {
          for (const seg of blk.segs) n += countHits(segText(seg), q);
        }
      }
      for (let k = 0; k < n && at.length < MAX_HITS; k++) at.push(bi);
    });
    return at;
  }, [blocks, mode, q, text, textHits]);

  const total = hitBlocks.length;
  const shown = total > 0 ? Math.min(hitIndex, total - 1) : 0;

  /** 说明文字跟内容一起滚走，不占着屏幕顶部 */
  const header = useMemo(
    () => (notice ? <Text style={styles.notice}>{notice}</Text> : undefined),
    [notice, styles.notice],
  );

  useEffect(() => {
    setHitIndex(0);
  }, [query]);

  /** 当前命中在第几行。TXT 有精确偏移，Markdown 只知道块从哪行开始 */
  const lineNote = useMemo(() => {
    if (!total || !text) return undefined;
    if (mode !== 'text') return undefined;
    const h = textHits[shown];
    if (!h) return undefined;
    return `第 ${text.slice(0, h.start).split('\n').length} 行`;
  }, [mode, shown, text, textHits, total]);

  const jump = useCallback(
    (next: number) => {
      if (!total) return;
      const clamped = Math.min(Math.max(next, 0), total - 1);
      setHitIndex(clamped);
      const bi = hitBlocks[clamped];
      if (bi === undefined) return;
      try {
        listRef.current?.scrollToIndex({ index: bi, animated: true, viewPosition: 0.15 });
      } catch {
        /* 未测到位置时会抛，onScrollToIndexFailed 兜住 */
      }
    },
    [hitBlocks, total],
  );

  /** TXT 高亮：只描底色，不改字色（深色主题下改字色会读不出来） */
  const plain = useCallback(
    (body: string, style: TextStyle): React.ReactNode => {
      if (!q) return body;
      const hits = findHits(body, q, MAX_HITS);
      if (!hits.length) return body;
      const out: React.ReactNode[] = [];
      let last = 0;
      hits.forEach((h, i) => {
        if (h.start > last) out.push(body.slice(last, h.start));
        out.push(
          <Text key={i} style={style}>
            {body.slice(h.start, h.end)}
          </Text>,
        );
        last = h.end;
      });
      if (last < body.length) out.push(body.slice(last));
      return out;
    },
    [q],
  );

  if (error) {
    return (
      <View style={styles.state}>
        <Text style={styles.stateTitle}>打不开这个文件</Text>
        <Text style={styles.stateHint}>{error}</Text>
      </View>
    );
  }

  if (text === null) {
    return (
      <View style={styles.state}>
        <ActivityIndicator color={c.accent} />
        <Text style={styles.stateHint}>正在读取原文件…</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <SearchBar
        value={query}
        onChange={setQuery}
        total={q ? total : -1}
        current={shown + 1}
        note={lineNote}
        onPrev={() => jump(shown - 1)}
        onNext={() => jump(shown + 1)}
      />

      {text.length === 0 ? (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>这是一个空文件</Text>
          <Text style={styles.stateHint}>没有内容可以阅读，也没有可以查找的文字。</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={blocks}
          keyExtractor={(_, i) => String(i)}
          ListHeaderComponent={header}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={9}
          removeClippedSubviews
          // 未测到某块位置时先按平均高度估一个偏移再滚一次，避免「跳转没反应」
          onScrollToIndexFailed={(info) => {
            listRef.current?.scrollToOffset({
              offset: info.averageItemLength * info.index,
              animated: false,
            });
            setTimeout(() => {
              listRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.15 });
            }, 60);
          }}
          renderItem={({ item }) =>
            mode === 'markdown' ? (
              <View style={styles.block}>
                <NoteBody
                  text={item.text}
                  variant="reading"
                  selectable
                  highlight={q || undefined}
                  literalCitations
                />
              </View>
            ) : (
              <View style={styles.block}>
                <Text style={styles.body} selectable>
                  {plain(item.text, styles.hit)}
                </Text>
              </View>
            )
          }
        />
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 60 },
  block: { marginBottom: 6 },
  notice: { fontSize: 12, lineHeight: 18, color: c.text3, marginBottom: 12 },
  body: { fontSize: 16, lineHeight: 27, color: c.text, letterSpacing: 0.2 },
  hit: { backgroundColor: c.amberBg, borderRadius: 3 },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  stateTitle: { fontSize: 15, color: c.text, fontWeight: '600' },
  stateHint: { fontSize: 12.5, lineHeight: 19, color: c.text3, textAlign: 'center', maxWidth: 300 },
});
