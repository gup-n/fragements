/**
 * 个人文档的写入口（v0.28）。
 *
 * 「新建一篇自己写的文档」= 插记录 + 写正文与切片 + 挂默认标签「草稿」。
 * 这三件事在 `repo.createDocumentWithContent` 里是**同一个事务**：分成三步调用时，
 * 第二步失败会留下一篇「有标题、没正文、问答永远说资料里没有」的文档 ——
 * 这种错在界面上看起来完全正常，只有真正去问的时候才发现。
 *
 * 切片仍然在这里做（`contentFromText`）：repo 只保证「三样要么都在、要么都没有」，
 * 不负责「怎么切」，否则切片规则会有两份实现。
 */
import type { DocTag, Document } from '../types';
import { repo } from '../db/repo';
import { contentFromText } from './readers/chunk';
import { excerptOf } from '../util/knowledgeDoc';
import { DEFAULT_DOC_TAG, docTagKey, normalizeTagName } from '../util/docTags';
import { clampTitle } from '../util/text';
import { LOCAL_READER_LIMITS } from './formats';

/**
 * 正文长度上限，**就取阅读器那一个数**。
 *
 * 原来这里是独立的 200,000：导入一篇 30 万字的 md 完全正常，打开编辑器
 * 原样保存却报「超过上限」—— 同一个对象，能进来不能存回去。
 */
export const AUTHORED_BODY_MAX = LOCAL_READER_LIMITS.bodyChars;

export function normalizeTitle(raw: string): string {
  return clampTitle(raw) || '未命名文档';
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
  return repo.createDocumentWithContent({
    name: normalizeTitle(input.title),
    ext: 'md',
    size: bodyMd.length,
    excerpt: excerptOf(bodyMd),
    origin: 'authored',
    content,
    tagNames: [DEFAULT_DOC_TAG, ...(input.tagNames ?? [])],
  });
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
 * 判重用 `docTagKey`（全半角、大小写折叠），与 `repo.createDocTag` 同一把尺子：
 * 两边不一致的话，这里认为「已挂过」而 repo 认为「是新标签」，
 * 就会出现「标签栏两条看起来一样的芯片」。
 */
export async function attachTagNames(documentId: number, names: string[]): Promise<DocTag[]> {
  const doc = await repo.findDocument(documentId);
  if (!doc) return [];
  const tags: DocTag[] = [...doc.tags];
  const seen = new Set(tags.map((tag) => docTagKey(tag.name)));
  for (const raw of names) {
    const name = normalizeTagName(raw);
    if (!name) continue;
    const key = docTagKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(await repo.createDocTag(name, 'approved'));
  }
  await repo.setDocumentTags(documentId, tags.map((tag) => tag.id));
  return tags;
}
