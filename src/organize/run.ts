/** 可注入的真实整理执行器。页面/重试/恢复共用，不含 React、Repo 或凭据。 */
import type { Fragment } from '../types';
import type { ExtractOptions, ExtractOutcome, TodoSnapshot } from '../ai/knowledge';
import type { ImageReadResult } from '../ai/imageReads';
import type { ChatProgress } from '../ai/chat';
import { MAX_BATCHES, packFragments } from '../util/batch';
import { IMAGE_READ_LIMIT } from '../util/pendingImages';
import {
  appendDraftBatch,
  hasUnfinishedWork,
  remainingIds,
  type DraftWorkspace,
  type WorkStep,
} from './workspace';

export interface OrganizeRunDeps {
  loadFragments(ids: number[]): Promise<Fragment[]>;
  extractKnowledge(options: Omit<ExtractOptions, 'config'>): Promise<ExtractOutcome>;
  loadTodos(): Promise<TodoSnapshot[]>;
  readImages?(fragments: Fragment[], limit: number): Promise<ImageReadResult>;
  persist(work: DraftWorkspace): Promise<void>;
  onChange?(work: DraftWorkspace): void;
  onProgress?(progress: ChatProgress): void;
  /** 关闭/切会话后旧请求只结束，不更新任何新状态或持久化旧快照。 */
  isCurrent?(): boolean;
  maxBatches?: number;
}
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * 返回最新工作区。失败会先发布/尝试保存带原 pending 材料的状态，再抛原异常。
 * “继续/重试”传这个工作区而不是重新 createWorkspace；恢复不调用此函数。
 */
export async function executeOrganize(initial: DraftWorkspace, deps: OrganizeRunDeps): Promise<DraftWorkspace> {
  let work = copy(initial);
  const current = () => deps.isCurrent?.() !== false;
  const steps = (text: string, state: WorkStep['state']): WorkStep[] => [...work.steps, { text, state }];
  async function checkpoint(next: DraftWorkspace): Promise<boolean> {
    if (!current()) return false;
    work = { ...next, updatedAt: Date.now() };
    deps.onChange?.(work);
    await deps.persist(work);
    return current();
  }
  try {
    if (!current()) return work;
    const source = work.request.source;
    // 限定文档会话的提炼不能偷偷携带用户的全库待办。
    const existing = work.request.owner.scope.kind === 'documents' ? [] : await deps.loadTodos();
    if (!current()) return work;
    const maxBatches = deps.maxBatches ?? (source.kind === 'fragments' && !source.all ? 1 : MAX_BATCHES);
    let imageBudget = IMAGE_READ_LIMIT;
    let read = 0;
    let failed = 0;
    let readRest = 0;
    let rounds = 0;
    while (hasUnfinishedWork(work) && rounds < maxBatches) {
      if (!current()) return work;
      if (!work.pending) {
        if (source.kind === 'session') {
          work = { ...work, pending: { kind: 'session', turns: copy(source.turns) } };
        } else {
          const wanted = remainingIds(work).slice(0, 40);
          const found = await deps.loadFragments(wanted);
          if (!current()) return work;
          const byId = new Map(found.map((f) => [f.id, f]));
          const missing = wanted.filter((id) => !byId.has(id));
          const candidates = wanted.map((id) => byId.get(id)).filter((f): f is Fragment => !!f).map(copy);
          if (missing.length) {
            work = {
              ...work, missingIds: [...new Set([...work.missingIds, ...missing])],
              steps: steps(`${missing.length} 条来源已不存在，未把它们当成已整理`, 'fail'),
            };
          }
          if (!candidates.length) {
            if (!(await checkpoint(work))) return work;
            continue;
          }
          if (imageBudget > 0 && deps.readImages) {
            const result = await deps.readImages(candidates, imageBudget);
            if (!current()) return work;
            read += result.read;
            failed += result.failed;
            readRest = result.rest;
            imageBudget = Math.max(0, imageBudget - result.read - result.failed);
          }
          const batch = packFragments(candidates, 40, 16_000);
          work = { ...work, pending: { kind: 'fragments', fragments: copy(batch) } };
        }
      }
      const pending = work.pending;
      if (!pending) break;
      const count = pending.kind === 'fragments' ? pending.fragments.length : pending.turns.length;
      if (!count) throw new Error('这次没有可整理的材料，未发送模型请求');
      const label = pending.kind === 'session'
        ? `会话《${source.kind === 'session' ? source.title : work.request.owner.title}》的 ${count} 轮问答`
        : `${count} 条快照中的碎片`;
      // 先留下这一次准确输入，再发送。保存失败时不得花钱发一个无法恢复的请求。
      if (!(await checkpoint({ ...work, phase: 'running', error: null, steps: steps(`正在提炼${label}`, 'running') }))) return work;
      const planned: TodoSnapshot[] = work.draft.todos.map((t) => ({
        text: t.text, done: false, due: t.due, children: t.children.map((c) => c.text),
      }));
      const outcome = await deps.extractKnowledge({
        source: pending.kind === 'session'
          ? { kind: 'session', turns: copy(pending.turns), title: source.kind === 'session' ? source.title : work.request.owner.title }
          : { kind: 'fragments', fragments: copy(pending.fragments) },
        mode: work.request.mode,
        instruction: work.request.instruction,
        existingTodos: [...existing, ...planned],
        onProgress: (patch) => { if (current()) deps.onProgress?.(patch); },
      });
      if (!current()) return work;
      const completed = pending.kind === 'fragments' ? pending.fragments.map((f) => f.id) : [];
      const draft = appendDraftBatch(work.draft, { ...outcome.draft, sourceIds: completed });
      const doneStep: WorkStep = {
        text: `已提炼${label}：${outcome.draft.docs.length} 篇文档、${outcome.draft.todos.length} 件事`, state: 'done',
      };
      const nextSteps = [...work.steps.slice(0, -1), doneStep];
      work = {
        ...work, draft,
        processedIds: [...new Set([...work.processedIds, ...completed])],
        sessionProcessed: pending.kind === 'session' || work.sessionProcessed,
        pending: null, steps: nextSteps,
        note: outcome.truncated ? '本批材料过长，中间有省略；原始材料和全部产出仍保留。' : work.note,
      };
      // 草稿与处理进度一次写同一个 settings 值；不能只提交游标再遗失结果。
      if (!(await checkpoint(work))) return work;
      rounds++;
    }
    const bits = [work.note];
    if (read) bits.push(`顺手读了 ${read} 张图`);
    if (failed) bits.push(`${failed} 张图没读出来，可回记录手动重试`);
    if (readRest) bits.push(`还有 ${readRest} 张图未读，本次没有把它们当成已读`);
    const remaining = remainingIds(work).length;
    if (remaining) bits.push(`快照中还有 ${remaining} 条未处理，点“继续”才会发送下一批`);
    const next = {
      ...work,
      phase: hasUnfinishedWork(work) ? 'paused' as const : 'complete' as const,
      error: null,
      note: [...new Set(bits.filter(Boolean))].join('；'),
    };
    await checkpoint(next);
    return work;
  } catch (error) {
    if (!current()) return work;
    const message = error instanceof Error ? error.message : '整理中断，材料与进度已保留';
    work = {
      ...work, phase: 'failed', error: message,
      steps: work.steps.map((s, i) => i === work.steps.length - 1 && s.state === 'running' ? { ...s, state: 'fail' } : s),
      updatedAt: Date.now(),
    };
    deps.onChange?.(work);
    // 保存失败绝不抹掉内存中已经生成的结果；页面会阻止关闭并允许重试保存。
    try { await deps.persist(work); } catch { /* 调用方的存储层记录具体失败，不掩盖原异常。 */ }
    throw error;
  }
}
