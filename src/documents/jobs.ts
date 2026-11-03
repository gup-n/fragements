/**
 * 文档任务服务。**应用级，不依附任何页面。**
 *
 * 为什么必须单独一层：v0.11.0 的解析任务活在发起它的那次页面实例里，
 * 于是出现了三个真实故障 —— 列表页和阅读器各起一个任务，同一个文件被传两遍；
 * 离开页面后进度回调指向已卸载的组件，列表永远停在「解析中」；
 * 进程被杀之后那条记录也停在「解析中」，谁都不知道它其实已经没了。
 *
 * 这一层的规矩：
 * 1. **单文档互斥**：同一篇文档同时只跑一个任务，重复点返回同一个 Promise。
 * 2. **runId + expectedRevision 双保险**：写回前先比 runId（是不是当前这次），
 *    再由 `replaceDocumentContent` 比版本。任何一个对不上就丢弃 —— 迟到的结果
 *    不能盖掉新内容，也不能把已删除的文档写回来。
 * 3. **取消走 AbortSignal**：一路传到 HTTP / 上传 / 下载。取消不是失败，
 *    要把状态还原成任务开始前的样子，不能留一条「上次准备失败」。
 * 4. **离页不中断**：任务只认自己的 Promise，页面只订阅。
 * 5. **本地任务绝不联网**：`prepareDocumentLocal` 只读本机原件。
 *    云解析是另一个显式入口，必须由用户在确认卡上点过才开始。
 */
import { useSyncExternalStore } from 'react';
import { repo } from '../db/repo';
import { getMineruToken, isCancelled, mineruMessage, stageText, type MineruStage } from '../ai/mineru';
import { parseDocFile } from '../util/docSupport';
import { extractLocalDocument, contentFromText } from './readers';
import type { Document, DocumentContentInput, DocState } from '../types';

export type DocumentJobPhase =
  | 'local'
  | 'cloud-upload'
  | 'cloud-queued'
  | 'cloud-parsing'
  | 'cloud-download'
  | 'done'
  | 'failed'
  | 'cancelled';

/** 界面拿到的任务快照。字段只读：改状态一律走任务服务，页面不要自己改 */
export interface DocumentJob {
  readonly documentId: number;
  /** 这一次运行的代次。写回前拿它判断「结果还是不是这一轮的」 */
  readonly runId: number;
  readonly phase: DocumentJobPhase;
  /** 一句话进度，界面直接显示 */
  readonly message?: string;
  /** 云端任务走的通道；本地任务没有 */
  readonly channel?: 'lite' | 'pro';
  readonly startedAt: number;
  readonly finishedAt?: number;
}

export interface CloudPrepareOptions {
  /**
   * 用户在选择卡上明确选的通道。
   * **不要在这里替用户决定** —— 默认值只用于确认卡的高亮建议，
   * 真正开始上传前必须已经展示过接收方与上限。
   */
  channel: 'lite' | 'pro';
}

/** 一次运行的全部内部状态。页面看不到它 */
interface Entry {
  job: DocumentJob;
  controller: AbortController;
  promise: Promise<void>;
  running: boolean;
  /** 任务开始前的状态，取消/失败时按它还原 */
  prevState: DocState;
  prevError: string | null;
  /** 开始时的正文版本。写回必须带它 */
  expectedRevision: number;
}

const entries = new Map<number, Entry>();
const listeners = new Set<() => void>();

/** 全局单调递增。每次运行都换号，旧任务据此发现自己过期了 */
let runSeq = 0;

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 一个订阅者抛错不能拖垮其它页面 */
    }
  }
}

/** 原地换一个快照对象：`useSyncExternalStore` 靠引用变化判断要不要重渲染 */
function patch(entry: Entry, next: Partial<DocumentJob>): void {
  entry.job = { ...entry.job, ...next };
  emit();
}

export function subscribeDocumentJobs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getDocumentJob(id: number): DocumentJob | undefined {
  return entries.get(id)?.job;
}

/**
 * 当前登记的代次。**只能从这里读** —— 直接写 `entries.get(id)?.runId` 是错的，
 * `runId` 在 `job` 里面，取错了永远拿到 undefined，所有写回都会被当成过期丢掉
 * （这个坑在自测里真的踩过一次，任务跑完了却什么都没写）。
 */
function currentRunId(id: number): number | undefined {
  return entries.get(id)?.job.runId;
}

/** 任务是不是还在跑。已结束的（done / failed / cancelled）不算 */
export function isJobRunning(job: DocumentJob | undefined | null): boolean {
  if (!job) return false;
  return job.phase !== 'done' && job.phase !== 'failed' && job.phase !== 'cancelled';
}

const PHASE_LABEL: Record<DocumentJobPhase, string> = {
  local: '正在本地提取',
  'cloud-upload': '正在上传到 mineru.net',
  'cloud-queued': '已上传，排队中',
  'cloud-parsing': '云端解析中',
  'cloud-download': '正在下载结果',
  done: '已就绪',
  failed: '这次没成功',
  cancelled: '已取消',
};

/** 任务状态的一句话。列表、阅读器都读它，别在页面里各写一套 */
export function jobPhaseText(job: DocumentJob | undefined | null): string {
  if (!job) return '';
  return job.message || PHASE_LABEL[job.phase];
}

/** 组件订阅同一篇文档的任务状态 */
export function useDocumentJob(id: number): DocumentJob | undefined {
  return useSyncExternalStore(subscribeDocumentJobs, () => getDocumentJob(id));
}

/* ------------------------------------------------------------------ *
 * 启动恢复
 * ------------------------------------------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 杀掉进程之后的收尾：`state === 'parsing'` 但内存里没有任务，就是上次没跑完。
 *
 * **不自动重发文件**。用户可能是在移动网络下、可能换了 Token、也可能就是想放一放；
 * 开机偷偷再传一遍是最不能接受的那种「贴心」。这里只把状态改诚实，让人自己决定。
 */
export function initDocumentJobs(): Promise<void> {
  if (!initPromise) initPromise = reconcileInterrupted();
  return initPromise;
}

async function reconcileInterrupted(): Promise<void> {
  let list;
  try {
    list = await repo.listDocuments();
  } catch {
    return;
  }
  let changed = false;
  for (const doc of list) {
    if (doc.state !== 'parsing') continue;
    if (entries.get(doc.id)?.running) continue;
    try {
      await repo.updateDocument(doc.id, {
        state: 'failed',
        error: '上次没跑完。原文件还在，可以重新准备。',
      });
      changed = true;
    } catch {
      /* 单条写不进去不影响其它文档 */
    }
  }
  if (changed) emit();
}

/* ------------------------------------------------------------------ *
 * 启动任务
 * ------------------------------------------------------------------ */

/**
 * 本地准备：只读本机原件，**绝不联网**。
 *
 * 返回的 Promise 在任务结束时 resolve（成功或失败都一样）—— 结果要看 `getDocumentJob`。
 * 这样调用方不用 try/catch，界面永远靠订阅拿状态。
 */
export function prepareDocumentLocal(id: number): Promise<void> {
  return startJob(id, 'local');
}

/**
 * 云端准备。**调用前必须已经弹过确认卡**（文件、接收方 mineru.net、通道与上限）。
 * 重试同样要重新确认 —— 上一次点了「开始」不代表这一次也同意上传。
 */
export function prepareDocumentCloud(id: number, opts: CloudPrepareOptions): Promise<void> {
  return startJob(id, 'cloud', opts.channel);
}

function startJob(id: number, kind: 'local' | 'cloud', channel?: 'lite' | 'pro'): Promise<void> {
  const existing = entries.get(id);
  // 单文档互斥：正在跑就返回同一个 Promise，重复点既不起新任务也不重复上传
  if (existing?.running) return existing.promise;

  const controller = new AbortController();
  const job: DocumentJob = {
    documentId: id,
    runId: ++runSeq,
    phase: kind === 'local' ? 'local' : 'cloud-upload',
    channel,
    startedAt: Date.now(),
    message: kind === 'local' ? '正在本地提取' : '正在连接解析服务',
  };
  const entry: Entry = {
    job,
    controller,
    // 先占位再赋值：下面的 execute 是同步开始执行的，但第一个 await 之前不会用到它
    promise: Promise.resolve(),
    running: true,
    prevState: 'stored',
    prevError: null,
    expectedRevision: 0,
  };
  // 必须在第一个 await 之前登记，否则同一帧里的第二次点击看不到它
  entries.set(id, entry);
  entry.promise = execute(entry, kind, channel).finally(() => {
    if (currentRunId(id) === job.runId) {
      entry.running = false;
      emit();
    }
  });
  emit();
  return entry.promise;
}

/**
 * 取消。
 *
 * 立刻放开互斥并改状态，**不等任务自己收尾**：上传卡在一条不返回的连接上时，
 * 那个 Promise 可能很久才回来，界面不能跟着一起僵住，用户点「取消」之后应该能马上重来。
 *
 * 状态还原交给任务自己的取消分支（`finishCancelled`），那里有 runId 校验：
 * 用户已经起了新任务时，旧任务不会再写状态，盖不掉新一轮。
 * **不要声称取消能撤回已经上传的字节。**
 */
export function cancelDocumentJob(id: number): void {
  const entry = entries.get(id);
  if (!entry || !entry.running) return;
  entry.running = false;
  entry.controller.abort();
  patch(entry, { phase: 'cancelled', message: '已取消，没有写入任何结果', finishedAt: Date.now() });
}

/** 清掉已经结束的任务快照。列表刷新后不需要再显示「已取消」 */
export function dismissDocumentJob(id: number): void {
  const entry = entries.get(id);
  if (!entry || entry.running) return;
  entries.delete(id);
  emit();
}

async function restoreBeforeJob(entry: Entry): Promise<void> {
  const { job } = entry;
  if (currentRunId(job.documentId) !== job.runId) return;
  try {
    await repo.updateDocument(job.documentId, { state: entry.prevState, error: entry.prevError });
  } catch {
    /* 还原失败也不能把取消变成错误提示：下一次启动恢复会兜住 */
  }
}

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */

async function execute(entry: Entry, kind: 'local' | 'cloud', channel?: 'lite' | 'pro'): Promise<void> {
  const { job, controller } = entry;
  const signal = controller.signal;
  const id = job.documentId;

  let doc: Document | null;
  try {
    doc = await repo.findDocument(id);
  } catch {
    await fail(entry, '读不到这篇文档，请稍后重试');
    return;
  }
  if (!doc) {
    await fail(entry, '这篇文档已经不在了');
    return;
  }

  entry.expectedRevision = doc.contentRevision;
  // 上次中断留下的 parsing 不能当成本次的起点：取消时还原成「上次没跑完」，
  // 否则一取消就永远停在「正在准备」上
  entry.prevState = doc.state === 'parsing' ? 'failed' : doc.state;
  entry.prevError = doc.state === 'parsing' ? doc.error ?? '上次没跑完' : doc.error;

  if (signal.aborted) {
    await finishCancelled(entry);
    return;
  }

  try {
    // parsing 期间 isDocumentReady 为 false：宁可暂时不能问，也不要用旧正文配新切片
    await repo.updateDocument(id, { state: 'parsing', error: null });
  } catch {
    /* 状态写不进去也继续：真正的把关在 replaceDocumentContent 的版本比较上 */
  }

  if (kind === 'local') {
    await runLocal(entry, doc);
  } else {
    await runCloud(entry, doc, channel ?? 'lite');
  }
}

async function runLocal(entry: Entry, doc: Document): Promise<void> {
  const { controller } = entry;
  try {
    const content = await extractLocalContent(doc, controller.signal);
    if (controller.signal.aborted || !(await writeIfCurrent(entry, content))) {
      if (controller.signal.aborted) await finishCancelled(entry);
      return;
    }
    patch(entry, {
      phase: 'done',
      message: content.chunks.length
        ? `已就绪 · ${content.bodyMd.length} 字`
        : '文件里没有可检索的文字',
      finishedAt: Date.now(),
    });
  } catch (e) {
    if (isCancelled(e) || controller.signal.aborted) {
      await finishCancelled(entry);
      return;
    }
    await fail(entry, e instanceof Error && e.message ? e.message : '本地准备失败，请重试');
  }
}

const MINERU_PHASE: Record<MineruStage, DocumentJobPhase> = {
  uploading: 'cloud-upload',
  queued: 'cloud-queued',
  parsing: 'cloud-parsing',
  downloading: 'cloud-download',
};

async function runCloud(entry: Entry, doc: Document, channel: 'lite' | 'pro'): Promise<void> {
  const { job, controller } = entry;
  const id = job.documentId;

  if (!doc.fileUri) {
    await fail(entry, '原文件已经不在手机上了，只能看已解析的正文');
    return;
  }

  let token = '';
  if (channel === 'pro') {
    token = await getMineruToken().catch(() => '');
    if (!token) {
      await fail(entry, '还没填 MinerU Token，填了才能用精准解析');
      return;
    }
  }

  try {
    const md = await parseDocFile(
      { name: doc.name, ext: doc.ext, size: doc.size, uri: doc.fileUri },
      token,
      (stage, detail) => {
        // 任务已经被换掉时，进度回调不许再改界面状态
        if (currentRunId(id) !== job.runId) return;
        patch(entry, {
          phase: MINERU_PHASE[stage],
          message: detail ? `${stageText(stage)} · ${detail}` : stageText(stage),
        });
      },
      { channel, signal: controller.signal },
    );
    if (controller.signal.aborted) {
      await finishCancelled(entry);
      return;
    }
    const content = contentFromText(md, 'mineru');
    if (!(await writeIfCurrent(entry, content))) return;
    patch(entry, {
      phase: 'done',
      message: content.chunks.length ? `云解析完成 · ${content.bodyMd.length} 字` : '解析结果是空的',
      finishedAt: Date.now(),
    });
  } catch (e) {
    if (isCancelled(e) || controller.signal.aborted) {
      await finishCancelled(entry);
      return;
    }
    await fail(entry, mineruMessage(e));
  }
}

/**
 * 唯一的写回口。
 *
 * 两道闸：runId（是不是当前这次）和 expectedRevision（正文有没有被别人改过）。
 * 任何一道不过就丢弃 —— **宁可这次白跑，也不能盖掉更新的内容**。
 */
async function writeIfCurrent(entry: Entry, content: DocumentContentInput): Promise<boolean> {
  const { job, controller, expectedRevision } = entry;
  const id = job.documentId;
  if (controller.signal.aborted || currentRunId(id) !== job.runId) return false;

  let saved = false;
  try {
    saved = await repo.replaceDocumentContent(id, content, expectedRevision);
  } catch {
    await fail(entry, '写入正文失败，请重试');
    return false;
  }
  if (!saved) {
    // 文档被删了，或者另一处已经把版本推过去了（版本对不上）
    patch(entry, {
      phase: 'failed',
      message: '正文已经变过，这次结果已作废',
      finishedAt: Date.now(),
    });
    return false;
  }
  return true;
}

async function fail(entry: Entry, message: string): Promise<void> {
  const { job } = entry;
  // 已经被新任务接管：旧任务的失败与新一轮无关，不要写库
  if (currentRunId(job.documentId) !== job.runId) return;
  patch(entry, { phase: 'failed', message, finishedAt: Date.now() });
  entry.running = false;
  /*
   * 失败**不销毁上一次可用的正文**：原来就有正文的，只记 error、保留状态，
   * 用户还能继续问上一版；从来没有正文的才落 failed（列表会显示「重试」）。
   */
  const hadContent = entry.prevState === 'done' || entry.prevState === 'local';
  try {
    await repo.updateDocument(job.documentId, {
      state: hadContent ? entry.prevState : 'failed',
      error: message,
    });
  } catch {
    /* 写不进去就只留在任务里，界面照样能看到失败原因 */
  }
}

async function finishCancelled(entry: Entry): Promise<void> {
  const { job } = entry;
  if (currentRunId(job.documentId) !== job.runId) return;
  patch(entry, { phase: 'cancelled', message: '已取消，没有写入任何结果', finishedAt: Date.now() });
  entry.running = false;
  await restoreBeforeJob(entry);
}

/* ------------------------------------------------------------------ *
 * 本地提取
 * ------------------------------------------------------------------ */

/**
 * 本地提取：只碰本机文件。
 *
 * 旧正文（v0.10 / v0.11 存进来、没有版本也没有切片）直接用缓存正文建切片：
 * 原件可能已经被系统清掉了，重新读一遍既慢又可能失败，而**绝不能因此自动上云**。
 *
 * 真正的读取交给 `documents/readers`：PDF / Excel / txt / md 的阅读器、编码检查与
 * 本地容量上限都在那边。这里只管两件事 —— 什么时候读、读到的结果怎么按版本写回。
 * 切片也必须走它的 `contentFromText`：另写一份实现，迟早和阅读器的定位对不上。
 */
async function extractLocalContent(doc: Document, signal: AbortSignal): Promise<DocumentContentInput> {
  if (signal.aborted) throw new Error('已取消这次准备');
  if (doc.contentRevision === 0 && doc.bodyMd.trim()) {
    return contentFromText(doc.bodyMd, 'legacy');
  }
  // 阅读器内部还会再查一次取消，signal 会一路传到 PDF 提取的 WebView 队列
  return extractLocalDocument(doc, { signal });
}
