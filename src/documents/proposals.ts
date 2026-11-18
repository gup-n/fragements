/**
 * 提案 → 落库。**这是 AI 产出唯一能进业务表的地方。**
 *
 * 分工：
 * - `proposeXxx` 只读文档、调模型、写一条 `pending` 提案；
 * - `approveProposal` 才真写 `documents` / `doc_tag_links`，然后把提案标成 approved；
 * - `rejectProposal` 什么都不写，只把提案标成 rejected（留审计）。
 *
 * 「不改原稿」贯穿到底：优化与重新整理都只**新写一篇**，
 * 原稿一个字不动。用户真想改原稿，自己编辑 —— 他的权限最高，不用借 AI 的手。
 */
import type { AiConfig, DocProposal, DocProposalPayload, DocTag, Document } from '../types';
import { repo } from '../db/repo';
import { loadAiConfig } from '../ai/config';
import type { ChatProgress } from '../ai/chat';
import { suggestDocRewrite, suggestDocTags, type DocEditMode } from '../ai/docEdit';
import { contentFromText } from './readers/chunk';
import { excerptOf } from '../util/knowledgeDoc';
import { derivedName } from '../util/proposal';
import { attachTagNames } from './authored';

async function requireDoc(documentId: number): Promise<Document> {
  const doc = await repo.findDocument(documentId);
  if (!doc) throw new Error('这篇文档已经不在了');
  return doc;
}

/** 生成一条「改一版」的提案。不写任何业务表 */
export async function proposeRewrite(
  documentId: number,
  mode: DocEditMode,
  onProgress?: (patch: ChatProgress) => void,
): Promise<DocProposal> {
  const config: AiConfig = await loadAiConfig();
  const doc = await requireDoc(documentId);
  const payload = await suggestDocRewrite({ config, doc, mode, onProgress });
  // 优化与精简产出的形状完全一样，在提案这一层不需要分开记：
  // 真正的差别（篇幅变多变少）已经在正文里了，多一个 kind 只会多一条分支
  const id = await repo.insertProposal({ kind: 'optimize', documentId, payload });
  const created = await repo.findProposal(id);
  if (!created) throw new Error('提案没有存下来，请再试一次');
  return created;
}

/** 生成一条「建议挂这些标签」的提案 */
export async function proposeTags(
  documentId: number,
  onProgress?: (patch: ChatProgress) => void,
): Promise<DocProposal> {
  const config: AiConfig = await loadAiConfig();
  const doc = await requireDoc(documentId);
  const known = (await repo.listDocTags()).map((tag) => tag.name);
  const payload = await suggestDocTags({ config, doc, knownTags: known, onProgress });
  const id = await repo.insertProposal({ kind: 'tag', documentId, payload });
  const created = await repo.findProposal(id);
  if (!created) throw new Error('提案没有存下来，请再试一次');
  return created;
}

export type ApproveChoice = 'newDoc' | 'tagsOnly';

export interface ApproveResult {
  /** 新写的那篇文档 id；`tagsOnly` 时为 null */
  docId: number | null;
  /** 最终挂上的标签名（界面用它说「已挂上：工作、报销」） */
  tags: string[];
}

/**
 * 审批通过。
 *
 * 三件事的先后顺序不能换：先建文档、再写正文、最后挂标签。
 * 反过来（先挂标签）在写正文失败时会留下一篇「有标签、没正文」的文档，
 * 而那篇文档在列表里看起来完全正常。
 */
export async function approveProposal(
  proposal: DocProposal,
  choice: ApproveChoice,
): Promise<ApproveResult> {
  const payload = proposal.payload;
  const names = payload.tags ?? [];

  // 只有标签的提案（kind='tag'），或者用户自己选了「只存标签」
  if (choice === 'tagsOnly' || proposal.kind === 'tag' || !payload.bodyMd) {
    if (!proposal.documentId) throw new Error('这条提案没有关联文档');
    const tags = await attachTagNames(proposal.documentId, names);
    await repo.decideProposal(proposal.id, 'approved');
    return { docId: null, tags: tags.map((tag) => tag.name) };
  }

  const original = await requireDoc(proposal.documentId ?? 0);
  const bodyMd = payload.bodyMd;
  const name = derivedName(original.name, proposal.kind, payload.title);

  const docId = await repo.insertDocument({
    name,
    ext: 'md',
    size: bodyMd.length,
    fileUri: null,
    state: 'parsing',
    origin: 'knowledge',
    originId: original.id,
    stage: 'library',
    excerpt: excerptOf(bodyMd),
  });

  const wrote = await repo.replaceDocumentContent(docId, contentFromText(bodyMd, 'markdown'), 0);
  if (!wrote) throw new Error('新文档的正文没有写进去，原稿没有受影响');

  const tags = await attachTagNames(docId, names);
  // 重新整理：旧的那篇归档，可查可恢复。原稿本身一个字没动
  if (proposal.kind === 'retag') await repo.setDocumentStage(original.id, 'archived');
  await repo.decideProposal(proposal.id, 'approved');
  return { docId, tags: tags.map((tag) => tag.name) };
}

/** 放弃：不写任何业务表，只留一条审计。界面照这个说法讲给用户 */
export async function rejectProposal(id: number): Promise<void> {
  await repo.decideProposal(id, 'rejected');
}

/** 还没批的提案。文档列表上的「待确认」角标用它 */
export async function pendingProposals(): Promise<DocProposal[]> {
  return repo.listProposals('pending');
}

/** 把一批标签名预先建出来（AI 提到的新名字）。返回的标签都已 approved */
export async function ensureTags(names: string[]): Promise<DocTag[]> {
  const out: DocTag[] = [];
  for (const name of names) {
    out.push(await repo.createDocTag(name, 'approved'));
  }
  return out;
}

export function payloadPreview(payload: DocProposalPayload): string {
  if (payload.bodyMd) return payload.bodyMd;
  return (payload.tags ?? []).join('、');
}
