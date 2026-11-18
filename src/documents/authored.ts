/**
 * 个人文档的写入口（v0.28）。
 *
 * 「新建一篇自己写的文档」涉及**三步**，它们必须按这个顺序、在同一处发生：
 *
 * 1. `insertDocument` 插一条 `origin='authored'` 的空记录；
 * 2. `replaceDocumentContent` 写正文 + 切片（版本号从 0 推到 1）；
 * 3. `setDocumentTags` 挂上默认标签「草稿」。
 *
 * 为什么不让 repo 包一个 `createAuthoredDoc`：包了之后这三步就有两份实现，
 * 而漏掉第 2 步会留下一篇「有标题、没正文、问答永远说资料里没有」的文档 ——
 * 这种错在界面上看起来完全正常，只有真正去问的时候才发现。
 */
import type { DocTag, Document } from '../types';
import { repo } from '../db/repo';
import { contentFromText } from './readers/chunk';
import { excerptOf } from '../util/knowledgeDoc';
import { DEFAULT_DOC_TAG, normalizeTagName } from '../util/docTags';

/** 标题上限。比整理产出的 24 宽一点 —— 自己写的东西，标题常常是一句话 */
export const AUTHORED_TITLE_MAX = 60;

/** 正文长度上限，和阅读器读文本时同一个口径（超了明确报错，不静默截断） */
export const AUTHORED_BODY_MAX = 200_000;

export function normalizeTitle(raw: string): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '未命名文档';
  return text.length > AUTHORED_TITLE_MAX ? `${text.slice(0, AUTHORED_TITLE_MAX)}…` : text;
}

/**
 * 新建一篇。
 *
 * 用户 2026-11-18 定的是**自动入库**：不经过「草稿区」，写完就在文档库里，
 * 「草稿」是它出生时挂的标签 —— 所以这里没有 `stage='draft'` 这一步。
 */
export async function createAuthoredDoc(input: {
  title: string;
  bodyMd: string;
  /** 额外的标签名（默认已经带上「草稿」）。用户在编辑器里选过的那些 */
  tagNames?: string[];
}): Promise<number> {
  const bodyMd = input.bodyMd ?? '';
  if (!bodyMd.trim()) throw new Error('正文还是空的，写点什么再保存');
  if (bodyMd.length > AUTHORED_BODY_MAX) {
    throw new Error(`正文 ${bodyMd.length.toLocaleString()} 字，超过 ${AUTHORED_BODY_MAX.toLocaleString()} 字上限`);
  }

  // 切片在这里做：走和导入文档同一条 `contentFromText`，问答的引用定位才有行号
  const content = contentFromText(bodyMd, 'markdown');
  const id = await repo.insertDocument({
    name: normalizeTitle(input.title),
    ext: 'md',
    size: bodyMd.length,
    fileUri: null,
    state: 'parsing',
    origin: 'authored',
    stage: 'library',
    excerpt: excerptOf(bodyMd),
  });

  const wrote = await repo.replaceDocumentContent(id, content, 0);
  if (!wrote) {
    // 刚插进去的记录版本号必然是 0，走不到这里；真走到了说明有人并发改了它
    throw new Error('这篇文档刚被改过，正文没有写进去。请重新打开再试。');
  }

  const tags = await attachTagNames(id, [DEFAULT_DOC_TAG, ...(input.tagNames ?? [])]);
  void tags;
  return id;
}

/**
 * 改正文。标题另走 `renameDoc`。
 *
 * 版本号从读到的当前值推进：`replaceDocumentContent` 对不上就返回 false，
 * 那时**不能假装成功** —— 另一个页面可能刚保存过一版，覆盖掉就是丢内容。
 */
export async function saveDocBody(id: number, bodyMd: string): Promise<void> {
  const doc: Document | null = await repo.findDocument(id);
  if (!doc) throw new Error('这篇文档已经不在了');
  if (bodyMd.length > AUTHORED_BODY_MAX) {
    throw new Error(`正文 ${bodyMd.length.toLocaleString()} 字，超过 ${AUTHORED_BODY_MAX.toLocaleString()} 字上限`);
  }
  const content = contentFromText(bodyMd, doc.contentSource === 'text' ? 'text' : 'markdown');
  const ok = await repo.replaceDocumentContent(id, content, doc.contentRevision);
  if (!ok) throw new Error('这篇文档刚被别处改过，这次没有覆盖。重新打开看一眼再改。');
  await repo.updateDocument(id, { excerpt: excerptOf(bodyMd) });
}

export async function renameDoc(id: number, title: string): Promise<void> {
  await repo.updateDocument(id, { name: normalizeTitle(title) });
}

/**
 * 把一串标签名挂到文档上（**追加**，不覆盖已有的）。
 *
 * 名字重复的（大小写不同）由 `normalizeTagName` 与 repo 的 UNIQUE 一起收掉：
 * 界面上不可能出现两个只差大小写的标签。
 */
export async function attachTagNames(documentId: number, names: string[]): Promise<DocTag[]> {
  const doc = await repo.findDocument(documentId);
  if (!doc) return [];
  const tags: DocTag[] = [...doc.tags];
  for (const raw of names) {
    const name = normalizeTagName(raw);
    if (!name) continue;
    if (tags.some((tag) => tag.name.toLowerCase() === name.toLowerCase())) continue;
    tags.push(await repo.createDocTag(name, 'approved'));
  }
  await repo.setDocumentTags(documentId, tags.map((tag) => tag.id));
  return tags;
}
