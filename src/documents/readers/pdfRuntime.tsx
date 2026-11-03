/**
 * 后台 PDF 文本提取队列。
 *
 * 为什么要有一个常驻的「运行时」而不是在阅读器里顺手提：
 * 用户点「准备资料」之后经常会立刻离开文档页 —— 如果提取 WebView 挂在
 * 文档页上，页面一卸载提取就断，用户回来看到的是「准备失败」。
 * 所以队列挂在 App 根节点的 `<DocumentRuntime />` 上，只有文档页消失时才停止。
 *
 * 同一时刻只开一个离屏 WebView：PDF.js 一份文档就占几十 MB，并行跑两份
 * 在低端机上直接 OOM。任务排队，一个做完再下一个。
 */
import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { LOCAL_READER_LIMITS } from '../formats';
import { useTheme } from '../../theme';
import { PdfWebView, PDF_WEBVIEW_SUPPORTED } from './PdfWebView';
import { pdfHtmlUri } from './pdfAsset';
import { pdfThemeOf } from './pdfTheme';
import { abortError, ReaderError, type ReaderErrorCode } from './errors';
import type { PdfFromPage, PdfTheme, PdfWebViewHandle } from './pdfProtocol';
import type { LocalExtractOptions, PdfPages } from './contract';

interface Job {
  /** 每份文档换一次 key，强制 WebView 重新加载页面 —— 否则新文档会打在上一次的 S 状态上 */
  id: number;
  uri: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  resolve: (r: PdfPages) => void;
  reject: (e: unknown) => void;
}

let seq = 0;

/** 排队等运行时。只有 <DocumentRuntime /> 在挂载时才会被消费 */
const queue: Job[] = [];
/** 运行时挂上之后设这里，用来唤醒空转的队列 */
let wake: (() => void) | null = null;
/** 运行时初始化失败（资源没打进包）：后续请求直接失败，不要排队等到天荒地老 */
let fatal: ReaderError | null = null;

const EXTRACT_TIMEOUT = 240_000;

/** HTML 侧的 error code → 正式错误码。认不出来的一律算 WebView 层故障 */
function codeOf(code: string): ReaderErrorCode {
  switch (code) {
    case 'too-many-pages':
      return 'too-many-pages';
    case 'encrypted':
      return 'encrypted';
    case 'no-file':
      return 'no-file';
    case 'corrupt':
      return 'corrupt';
    default:
      return 'webview';
  }
}

/**
 * 提一份 PDF 的逐页文本。
 *
 * 调用方负责判断大小/页数上限；这里只保证「要么给完整结果，要么抛明确错误」，
 * 绝不返回半份。
 */
export function extractPdfPages(uri: string, options: LocalExtractOptions = {}): Promise<PdfPages> {
  if (!PDF_WEBVIEW_SUPPORTED) {
    return Promise.reject(
      new ReaderError('unsupported-web', '网页版没有应用内 PDF 阅读器，请在手机上打开。'),
    );
  }
  if (fatal) return Promise.reject(fatal);
  if (!wake) {
    return Promise.reject(
      new ReaderError(
        'runtime-unavailable',
        'PDF 提取服务没有启动：App 根节点需要常驻一个 <DocumentRuntime />。',
      ),
    );
  }
  if (options.signal?.aborted) return Promise.reject(abortError());

  return new Promise<PdfPages>((resolve, reject) => {
    queue.push({
      id: ++seq,
      uri,
      signal: options.signal,
      onProgress: options.onProgress,
      resolve,
      reject,
    });
    wake?.();
  });
}

interface EngineState {
  job: Job | null;
}

/**
 * 队列状态机。放在 React 之外（用 ref + 强制重渲染）的原因：
 * 任务的生命周期比任何一次渲染都长，而 `setJob` 的闭包很容易读到上一帧的
 * 回调，导致「已经取消的任务又被 resolve 一次」。
 */
function makeEngine(args: {
  bump: () => void;
  view: React.RefObject<PdfWebViewHandle | null>;
  theme: React.RefObject<PdfTheme>;
}) {
  const { bump, view, theme } = args;
  const state: EngineState = { job: null };
  const timers: { timeout: ReturnType<typeof setTimeout> | null; grace: ReturnType<typeof setTimeout> | null } = {
    timeout: null,
    grace: null,
  };
  let abortHandler: (() => void) | null = null;

  function clearTimers() {
    if (timers.timeout) clearTimeout(timers.timeout);
    if (timers.grace) clearTimeout(timers.grace);
    timers.timeout = null;
    timers.grace = null;
  }

  function settle(job: Job, err: unknown, result?: PdfPages) {
    // 迟到消息（上一份文档的 done / error）不许影响当前任务
    if (state.job !== job) return;
    clearTimers();
    if (abortHandler && job.signal) job.signal.removeEventListener('abort', abortHandler);
    abortHandler = null;
    state.job = null;
    bump();
    if (err) job.reject(err);
    else job.resolve(result as PdfPages);
    // 让当前 WebView 先卸载干净（它身上还挂着几十 MB 的文档）
    setTimeout(() => api.pump(), 0);
  }

  const api = {
    get current(): Job | null {
      return state.job;
    },

    pump() {
      if (state.job) return;
      while (queue.length) {
        const next = queue.shift() as Job;
        if (next.signal?.aborted) {
          next.reject(abortError());
          continue;
        }
        state.job = next;
        timers.timeout = setTimeout(() => {
          settle(
            next,
            new ReaderError('timeout', '这份 PDF 提取文字超时了。可以稍后重试，或用外部应用打开。'),
          );
        }, EXTRACT_TIMEOUT);
        if (next.signal) {
          abortHandler = () => {
            view.current?.send({ type: 'cancel' });
            // 页面卡在解析里时不会回消息，给 2.5 秒宽限再强制收尾
            timers.grace = setTimeout(() => settle(next, abortError()), 2500);
          };
          next.signal.addEventListener('abort', abortHandler);
        }
        bump();
        return;
      }
    },

    message(msg: PdfFromPage) {
      const job = state.job;
      if (!job) return;
      switch (msg.type) {
        case 'ready':
          view.current?.send({
            type: 'open',
            uri: job.uri,
            mode: 'extract',
            theme: theme.current as PdfTheme,
            title: '',
            maxPages: LOCAL_READER_LIMITS.pdfPages,
          });
          return;
        case 'progress':
          job.onProgress?.(msg.text);
          return;
        case 'done':
          settle(job, null, { pageTexts: msg.pageTexts, pageCount: msg.pageCount });
          return;
        case 'error':
          settle(
            job,
            msg.code === 'aborted' ? abortError() : new ReaderError(codeOf(msg.code), msg.message),
          );
          return;
        default:
          return;
      }
    },

    /** WebView 自身报错（页面加载失败、进程被杀） */
    webviewFailed(message: string) {
      const job = state.job;
      if (!job) return;
      settle(job, new ReaderError('webview', message));
    },

    /** 卸载 / 资源缺失：把当前任务和排队中的全部结掉，不留下永远 pending 的 Promise */
    dispose(reason: Error) {
      clearTimers();
      const job = state.job;
      if (job) {
        state.job = null;
        job.reject(reason);
      }
      while (queue.length) queue.shift()!.reject(reason);
      bump();
    },
  };

  return api;
}

/**
 * 常驻在 App 根节点的 PDF 运行时。
 *
 * 没有任务时返回 null（不挂 WebView，也就没有内存占用）；有任务时挂一个
 * 1×1 的离屏 WebView 跑提取。
 */
export function DocumentRuntime(): React.ReactElement | null {
  const { c } = useTheme();
  const theme = useMemo<PdfTheme>(() => pdfThemeOf(c), [c]);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const view = useRef<PdfWebViewHandle | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  const bumpRef = useRef(bump);
  bumpRef.current = bump;

  const engine = useMemo(
    () => makeEngine({ bump: () => bumpRef.current(), view, theme: themeRef }),
    [],
  );

  // 资源解析：失败就把所有请求立刻结掉，并让后续请求直接拿到原因
  useEffect(() => {
    if (!PDF_WEBVIEW_SUPPORTED) return;
    let alive = true;
    pdfHtmlUri()
      .then((u) => {
        if (alive) setUri(u);
      })
      .catch((e) => {
        fatal = e instanceof ReaderError ? e : new ReaderError('no-file', 'PDF 阅读器资源加载失败');
        engine.dispose(fatal);
      });
    return () => {
      alive = false;
    };
  }, [engine]);

  // 注册成全局队列的消费者；卸载时把队列清空，避免 Promise 悬着
  useEffect(() => {
    if (!PDF_WEBVIEW_SUPPORTED) return;
    wake = () => engine.pump();
    engine.pump();
    return () => {
      wake = null;
      engine.dispose(new ReaderError('runtime-unavailable', 'PDF 提取服务已停止'));
    };
  }, [engine]);

  // tick 只用来触发重渲染；读的是引擎里的实时状态
  void tick;
  const job = engine.current;

  if (!PDF_WEBVIEW_SUPPORTED || !job || !uri) return null;

  return (
    <View style={styles.host} pointerEvents="none">
      <PdfWebView
        key={job.id}
        ref={view}
        uri={uri}
        style={styles.web}
        onMessage={(m) => engine.message(m)}
        onFail={(m) => engine.webviewFailed(m)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  /** 1×1、移出屏幕、透明：看不见但真实存在，WebView 才会跑 JS */
  host: { position: 'absolute', width: 1, height: 1, left: -10, top: -10, opacity: 0 },
  web: { width: 1, height: 1 },
});
