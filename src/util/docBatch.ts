/**
 * 批量工作流的进度（纯函数）。
 *
 * 用户 2026-11-18 的要求是「批量处理，但一篇篇过」——
 * 不是一次勾 20 篇然后一口气改掉。所以这里有「当前这一篇」这个概念：
 * 一次只有一个 `running`，它被审批完才轮到下一篇。
 *
 * 为什么进度状态放在内存而不是库里：它是**这次操作**的状态，
 * 关掉 App 就没了。存进库反而会留下「上次批量做到一半」的幽灵进度，
 * 而那时的提案可能早已被单独处理掉了。
 */
import type { ProposalKind } from '../types';

export type BatchState = 'pending' | 'running' | 'review' | 'done' | 'skipped' | 'failed';

export interface BatchItem {
  documentId: number;
  name: string;
  state: BatchState;
  /** 失败原因 / 跳过原因，界面要原样显示，不能只说「失败」 */
  note?: string;
  /** 生成出来的提案 id。`review` 时点「存为新文档」要用它 */
  proposalId?: number;
}

export interface BatchPlan {
  kind: ProposalKind;
  items: BatchItem[];
}

export function planBatch(kind: ProposalKind, docs: { id: number; name: string }[]): BatchPlan {
  return { kind, items: docs.map((doc) => ({ documentId: doc.id, name: doc.name, state: 'pending' })) };
}

/** 下一个该动手的：先找已经排到的 `running`，没有就取第一条 `pending` */
export function nextBatchItem(plan: BatchPlan): BatchItem | null {
  return plan.items.find((item) => item.state === 'running')
    ?? plan.items.find((item) => item.state === 'pending')
    ?? null;
}

export function patchBatchItem(plan: BatchPlan, documentId: number, patch: Partial<BatchItem>): BatchPlan {
  return {
    ...plan,
    items: plan.items.map((item) => (item.documentId === documentId ? { ...item, ...patch } : item)),
  };
}

/** 还剩几篇没轮到。`review` 的也算没完 —— 用户还没决定 */
export function batchRemaining(plan: BatchPlan): number {
  return plan.items.filter((item) => item.state === 'pending' || item.state === 'running' || item.state === 'review').length;
}

export function batchProgress(plan: BatchPlan): { done: number; total: number; open: boolean } {
  const total = plan.items.length;
  const done = plan.items.filter((item) => item.state === 'done' || item.state === 'skipped' || item.state === 'failed').length;
  return { done, total, open: done < total };
}

/**
 * 收尾那句总结。
 *
 * 必须把「跳过几条、失败几条」说出来。只报「已完成」的话，
 * 用户会以为 20 篇都处理了，而实际上有 7 篇因为没正文被跳过。
 */
export function batchSummary(plan: BatchPlan): string {
  const count = (state: BatchState) => plan.items.filter((item) => item.state === state).length;
  const parts: string[] = [];
  if (count('done')) parts.push(`存了 ${count('done')} 篇`);
  if (count('skipped')) parts.push(`跳过 ${count('skipped')} 篇`);
  if (count('failed')) parts.push(`失败 ${count('failed')} 篇`);
  return parts.length ? parts.join('，') : '什么都没做';
}
