/**
 * AI 提案的纯逻辑：读回来、说清楚、拼新标题。
 *
 * 提案是「AI 只出建议」这条铁律的落点：模型产出先落 `pending`，
 * 用户点了才算数。所以这个文件里**没有任何写库动作** ——
 * 写库在 `documents/proposals.ts`，那是唯一会改业务表的地方。
 */
import type { DocProposal, DocProposalPayload, ProposalKind } from '../types';
import { cleanTagNames } from './docTags';
import { clampTitle, clip } from './text';

export const PROPOSAL_LABEL: Record<ProposalKind, string> = {
  optimize: '优化',
  tag: '打标签',
  retag: '重新整理',
  batch: '批量',
};

/** 审批面板顶上的标题。不能只说「AI 建议」—— 用户要知道这是哪一种操作 */
export function proposalTitle(kind: ProposalKind): string {
  switch (kind) {
    case 'optimize':
      return '这是优化后的版本';
    case 'retag':
      return '重新整理后的版本';
    case 'tag':
      return '建议挂这些标签';
    default:
      return '批量处理';
  }
}

/**
 * 模型给的 JSON → 干净的 payload。
 *
 * 宽容读取的理由和 `util/jsonRepair` 一样：模型会多给字段（`diff`、`reason`），
 * 也会把数组写成字符串。这里只取自己认识的，**不因为多出来的字段就整条作废** ——
 * 作废等于让用户白等一次生成。
 */
export function parseProposalPayload(raw: unknown): DocProposalPayload {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object') return {};
  const src = value as Record<string, unknown>;
  const out: DocProposalPayload = {};

  const body = src.bodyMd ?? src.body ?? src.content;
  if (typeof body === 'string' && body.trim()) out.bodyMd = body.trim();

  if (typeof src.title === 'string' && src.title.trim()) out.title = clampTitle(src.title);

  const tags = src.tags ?? src.labels;
  if (Array.isArray(tags)) {
    const clean = cleanTagNames(tags.filter((t): t is string => typeof t === 'string'));
    if (clean.length) out.tags = clean;
  } else if (typeof tags === 'string') {
    const clean = cleanTagNames(tags.split(/[,，、\s]+/));
    if (clean.length) out.tags = clean;
  }

  if (typeof src.note === 'string' && src.note.trim()) out.note = clip(src.note.trim(), 200);
  return out;
}

export function serializeProposalPayload(payload: DocProposalPayload): string {
  return JSON.stringify(payload);
}

/** 这条提案有没有可落地的东西。空 payload 的提案不该出现在审批列表里 */
export function isActionable(proposal: Pick<DocProposal, 'kind' | 'payload'>): boolean {
  if (proposal.kind === 'tag') return !!proposal.payload.tags?.length;
  return !!proposal.payload.bodyMd;
}

/**
 * 派生文档的标题。
 *
 * 不用「原名 v2」：同一篇被优化两次就成了「…优化 优化」。
 * 也不覆盖原名 —— 原稿还在库里，两篇同名会让人分不清哪篇是新的。
 */
export function derivedName(original: string, kind: ProposalKind, suggested?: string): string {
  if (suggested && suggested.trim()) return suggested.trim();
  const base = original.replace(/\s*（(优化|整理|精简)）\s*$/, '');
  return `${base}（${kind === 'retag' ? '整理' : '优化'}）`;
}

/**
 * 审批时的那句对比：「原稿 1,204 字 → 建议 860 字（少 29%）」。
 *
 * 只说「已生成」等于没说：用户要判断的是「这一版值不值得存」，
 * 字数变化是他手上唯一能立刻核对的证据。
 */
export function diffSummary(before: string, after: string): string {
  const a = before.trim().length;
  const b = after.trim().length;
  if (!a) return `建议 ${b.toLocaleString()} 字`;
  const delta = Math.round(((b - a) / a) * 100);
  const trend = delta === 0 ? '字数不变' : delta > 0 ? `多 ${delta}%` : `少 ${-delta}%`;
  return `原稿 ${a.toLocaleString()} 字 → 建议 ${b.toLocaleString()} 字（${trend}）`;
}

/**
 * 批量工作流的一步该做什么。
 *
 * 三种情况一眼分得开：这条能不能自动做、要不要用户点、是不是该跳过。
 * 「跳过」不是失败：一篇还没正文的文档没法优化，它安静地待在那里就好。
 */
export function batchAction(kind: ProposalKind, hasBody: boolean): 'generate' | 'skip' {
  if (kind === 'tag') return 'generate';
  return hasBody ? 'generate' : 'skip';
}
