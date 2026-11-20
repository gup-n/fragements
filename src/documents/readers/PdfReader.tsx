/**
 * PDF 阅读器：PDF.js 跑在本地 WebView 里。
 *
 * 选 WebView 而不是原生 PDF 组件的**唯一理由**在文本层：原生渲染组件只给
 * 位图，没有文字，搜不了也提不出内容。PDF.js 的 TextLayer 让「显示 / 查找 /
 * 提取」共用同一份文本，三处结果自然一致。
 *
 * 这里只负责「把命令下给它、把结果画出来」：
 * - 页面在 `assets/pdfjs/reader.html` 里（构建期生成，自包含、离线）；
 * - 查找与计数在页面内完成（跨页、字面匹配），RN 只显示「第 i / N 处」；
 * - 加密、损坏、没有文字层都由页面报错误码，这里翻译成用户能读的一句话。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BusyIndicator as ActivityIndicator } from '../../components/BusyIndicator';
import type { Document } from '../../types';
import { LOCAL_READER_LIMITS } from '../formats';
import { SPACE, TYPE, surfaceStroke, useTheme, useThemedStyles, type Palette, type ThemeMetrics } from '../../theme';
import { SearchBar } from './SearchBar';
import { PdfWebView, PDF_WEBVIEW_SUPPORTED } from './PdfWebView';
import { pdfHtmlUri } from './pdfAsset';
import { pdfThemeOf } from './pdfTheme';
import type { PdfFromPage, PdfTheme, PdfWebViewHandle } from './pdfProtocol';
import { formatSize, readerMessage } from './errors';

interface Props {
  document: Document;
}

export function PdfReader({ document: doc }: Props) {
  const { c, styles, metrics } = useThemedStyles(makeStyles);
  const { reduceMotion } = useTheme();
  const theme = useMemo<PdfTheme>(() => pdfThemeOf(c, metrics, reduceMotion), [c, metrics, reduceMotion]);

  const [uri, setUri] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  /**
   * 文字索引的状态。**不能用一个 boolean**：`indexing` 是「还不知道」，
   * 和 `none`（扫过了，确实没有文字层）在界面上必须分开 —— 混成一个 false
   * 会让每份正常 PDF 打开时先闪一下「没有文字层」。
   */
  const [textState, setTextState] = useState<'indexing' | 'ready' | 'none'>('indexing');
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  /** total = -1 表示还没算出来 */
  const [find, setFind] = useState<{ total: number; current: number }>({ total: -1, current: 0 });
  const view = useRef<PdfWebViewHandle | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** 打开前先按元数据挡一次：几十 MB 的 PDF 直接塞进 WebView 会 OOM */
  const precheck = useMemo(() => {
    if (!PDF_WEBVIEW_SUPPORTED) return '网页版没有应用内 PDF 阅读器，请在手机上打开。';
    if (!doc.fileUri) return '原文件已不在手机上（可能被系统清理），只能看已解析的正文。';
    if (doc.size > LOCAL_READER_LIMITS.pdfBytes) {
      return `这份 PDF 有 ${formatSize(doc.size)}，超过应用内阅读上限 ${formatSize(LOCAL_READER_LIMITS.pdfBytes)}。原件仍在本机，可以用其它应用打开。`;
    }
    return null;
  }, [doc.fileUri, doc.size]);

  useEffect(() => {
    if (precheck) return;
    let cancelled = false;
    pdfHtmlUri()
      .then((u) => {
        if (!cancelled && alive.current) setUri(u);
      })
      .catch((e) => {
        if (!cancelled && alive.current) setError(readerMessage(e, '打不开内置阅读器'));
      });
    return () => {
      cancelled = true;
    };
  }, [precheck]);

  // 换文档：清掉上一份的计数，否则会显示上一份的「3 / 18」
  useEffect(() => {
    setOpened(false);
    setFind({ total: -1, current: 0 });
    setQuery('');
    setError(null);
    setPageCount(null);
    setTextState('indexing');
  }, [doc.id]);

  const open = useCallback(() => {
    if (!doc.fileUri) return;
    view.current?.send({
      type: 'open',
      uri: doc.fileUri,
      mode: 'view',
      theme,
      title: doc.name,
      maxPages: LOCAL_READER_LIMITS.pdfPages,
    });
  }, [doc.fileUri, doc.name, theme]);

  const onMessage = useCallback(
    (msg: PdfFromPage) => {
      switch (msg.type) {
        case 'ready':
          open();
          return;
        case 'loaded':
          setOpened(true);
          if (msg.hasText === null) setTextState('indexing');
          else setTextState(msg.hasText ? 'ready' : 'none');
          setPageCount(msg.pageCount);
          return;
        case 'text-ready':
          setTextState(msg.hasText ? 'ready' : 'none');
          return;
        case 'find':
          setFind({ total: msg.total, current: msg.current });
          return;
        case 'error':
          setError(msg.message);
          return;
        default:
          return;
      }
    },
    [open],
  );

  // 主题切换时让页面跟着变（深色下 PDF 画布仍是白的，但外框和高亮要跟上）
  useEffect(() => {
    if (opened) view.current?.send({ type: 'theme', theme });
  }, [opened, theme]);

  // 查询词变化：下发给页面，计数清零等回包。
  // `textState` 进依赖是有意的：文字索引建好之后要把当前查询词补发一次，
  // 否则「打开就搜」会永远停在「正在索引」等不到结果。
  useEffect(() => {
    if (!opened || textState !== 'ready') return;
    const q = query.trim();
    setFind({ total: -1, current: 0 });
    // 空串也是命令：必须清掉文本层里上一轮的标记，而不只是隐藏RN计数。
    view.current?.send({ type: 'find', query: q });
  }, [opened, query, textState]);

  const step = useCallback((delta: number) => {
    view.current?.send({ type: 'find-move', delta });
  }, []);

  const message = error ?? precheck;

  return (
    <View style={styles.root}>
      {message ? (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>这一份打不开</Text>
          <Text style={styles.stateHint}>{message}</Text>
        </View>
      ) : (
        <>
          {opened && pageCount ? <Text style={styles.pageMeta}>PDF 原版式 · 共 {pageCount} 页</Text> : null}
          <SearchBar
            value={query}
            onChange={setQuery}
            total={query.trim() ? find.total : -1}
            current={find.current}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
            disabled={!opened || textState === 'none'}
            busy={opened && textState === 'indexing'}
          />

          {opened && textState === 'none' ? (
            <Text style={styles.notice}>
              这份 PDF 没有文字层（扫描件）：可以翻页，但不能查找，也不能用来提问。
              需要正文请用 MinerU 云解析（会上传原件，需要你确认）。
            </Text>
          ) : null}

          {uri ? (
            <View style={styles.webWrap}>
              <PdfWebView
                key={`${doc.id}-${uri}`}
                ref={view}
                uri={uri}
                style={styles.web}
                onMessage={onMessage}
                onFail={(m) => setError(m)}
              />
              {!opened ? (
                <View style={styles.loading} pointerEvents="none">
                  <ActivityIndicator color={c.accent} />
                  <Text style={styles.loadingText}>
                    {pageCount ? `共 ${pageCount} 页` : '正在打开 PDF…'}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : (
            <View style={styles.state}>
              <ActivityIndicator color={c.accent} />
              <Text style={styles.stateHint}>正在准备内置阅读器…</Text>
            </View>
          )}
        </>
      )}
    </View>
  );
}

const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  root: { flex: 1 },
  webWrap: { flex: 1 },
  web: { flex: 1, backgroundColor: c.page },
  pageMeta: { ...TYPE.meta, color: c.text2, paddingHorizontal: metrics.pagePadding, paddingTop: SPACE.xs },
  /** 首屏提示不改变PDF画布、页码控件或消息协议。 */
  loading: { position: 'absolute', top: 0, left: 0, right: 0, paddingTop: SPACE.xxl, alignItems: 'center', gap: SPACE.sm },
  loadingText: { ...TYPE.body, color: c.text2 },
  notice: {
    ...TYPE.body, color: c.amberText, backgroundColor: c.amberBg,
    paddingHorizontal: metrics.pagePadding, paddingVertical: SPACE.sm,
    borderBottomWidth: surfaceStroke(metrics), borderBottomColor: c.hair,
  },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl, gap: SPACE.sm },
  stateTitle: { ...TYPE.heading, color: c.text, textAlign: 'center' },
  stateHint: { ...TYPE.body, color: c.text2, textAlign: 'center', maxWidth: 360 },
});
