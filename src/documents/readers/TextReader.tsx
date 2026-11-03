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

/** 单次查找最多认多少处。超过就不再往上加，界面显示 99+ */
const MAX_HITS = 999;

interface Block {
  text: string;
  /** 在整篇文本里的起始偏移（TXT 用来把命中映射回块） */
  start: number;
  lineStart: number;
  lineEnd: number;
}

/**
 * 切成可虚拟化的块。
 *
 * 为什么不按行：4 MB 文本可能有十几万行，一行一个 FlatList item，光 key 就够卡。
 * 也不能切得太碎：块多到几千个时滚动同步会抖。目标 ~1 KB 一块。
 *
 * 两条不能切的位置：
 * - **代码围栏内部**：切开会留下半个 ```，后面全被当成代码；
 * - **表格行之间**：GFM 表格要求连续，切开就成了两段竖线。
 */
function buildBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let buf: string[] = [];
  let size = 0;
  let startLine = 0;
  let endLine = 0;
  let startOffset = 0;
  let offset = 0;
  let inFence = false;

  const MAX = 1200;
  const SOFT = 320;

  const push = () => {
    if (!buf.length) return;
    blocks.push({ text: buf.join('\n'), start: startOffset, lineStart: startLine, lineEnd: endLine });
    buf = [];
    size = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineOffset = offset;
    offset += raw.length + 1;

    if (/^\s*```/.test(raw)) inFence = !inFence;

    if (!buf.length) {
      if (!raw.trim()) continue;
      startLine = i + 1;
      startOffset = lineOffset;
    }

    buf.push(raw);
    size += raw.length + 1;
    endLine = i + 1;

    if (inFence || size < SOFT) continue;
    const next = lines[i + 1] ?? '';
    if (raw.includes('|') && next.includes('|')) continue;
    if (size >= MAX || !next.trim()) push();
  }

  push();
  return blocks;
}

/** 命中偏移落在哪一块。块按 start 升序，二分即可 */
function blockAt(blocks: Block[], offset: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].start <= offset) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

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
}

export function TextReader({ document: doc, mode }: Props) {
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
  }, [doc.fileUri, doc.id, doc.updatedAt, doc.bodyMd]);

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
        } else if (blk.kind !== 'hr') {
          for (const seg of blk.segs) n += countHits(segText(seg), q);
        }
      }
      for (let k = 0; k < n && at.length < MAX_HITS; k++) at.push(bi);
    });
    return at;
  }, [blocks, mode, q, text, textHits]);

  const total = hitBlocks.length;
  const shown = total > 0 ? Math.min(hitIndex, total - 1) : 0;

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
  body: { fontSize: 16, lineHeight: 27, color: c.text, letterSpacing: 0.2 },
  hit: { backgroundColor: c.amberBg, borderRadius: 3 },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  stateTitle: { fontSize: 15, color: c.text, fontWeight: '600' },
  stateHint: { fontSize: 12.5, lineHeight: 19, color: c.text3, textAlign: 'center', maxWidth: 300 },
});
