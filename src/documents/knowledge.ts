/**
 * 知识文档的写入：整理产出的 Markdown → `documents` 里的一篇可读、可搜的文档。
 *
 * 为什么不直接 `updateDocument({bodyMd})`：
 * 那样只会写正文，**切片和索引不会跟着走**。结果是文档能读、能按标题搜到，
 * 但「在文档里问」查不到它的任何一段 —— 而用户刚整理完最想干的就是这件事。
 * 所以一律走 `replaceDocumentContent`：正文、版本、切片、FTS 在同一个事务里。
 *
 * 也不复用 `documents/jobs`：那套是「原件 → 解析 → 正文」的异步队列，
 * 有进度、可取消、按文件去重。整理产出的正文**已经在手上**，
 * 塞进队列只会多一个永远不会出现的失败分支。
 */
import { repo } from '../db/repo';
import { contentFromText } from './readers/chunk';

export interface KnowledgeInput {
  title: string;
  bodyMd: string;
  excerpt: string;
}

/**
 * 新建一篇知识文档，返回它的 id。
 *
 * 先插一行 `parsing` 再写正文，而不是反过来：正文写入要靠 document id，
 * 而 `replaceDocumentContent` 会顺带把 state 改成 `done`。
 * 中间这个 `parsing` 不会被用户看到（同一个 tick 内就结束了），
 * 但如果进程在这里被杀，列表上留下的是一条「解析中」而不是一条「有标题没内容」——
 * 后者更让人困惑。
 */
export async function writeKnowledgeDocument(input: KnowledgeInput): Promise<number> {
  const bodyMd = input.bodyMd.trim();
  if (!bodyMd) throw new Error('正文是空的');

  // 超长（>LOCAL_READER_LIMITS.bodyChars）会在这里抛，并且带明确文案：
  // 与其写进去一篇打不开的文档，不如让用户当场看到「太长了，分两篇」
  const content = contentFromText(bodyMd, 'markdown');

  const id = await repo.insertDocument({
    name: input.title,
    ext: 'md',
    size: bodyMd.length,
    fileUri: null,
    state: 'parsing',
    origin: 'knowledge',
    excerpt: input.excerpt,
  });

  try {
    const ok = await repo.replaceDocumentContent(id, content, 0);
    if (!ok) throw new Error('这篇文档在写入时被改动过，请重试');
  } catch (e) {
    // 正文没写成就把空壳删掉：留一条 `parsing` 的空文档，用户点开是空白，
    // 而且没有任何入口能把它清掉（它会一直挂在列表顶部）
    try {
      await repo.deleteDocument(id);
    } catch {
      /* 删不掉也只能这样了，原始错误更重要 */
    }
    throw e;
  }

  return id;
}

/**
 * 覆盖一篇已有知识文档的正文（「重新整理」写回同一篇时用）。
 *
 * 版本号从库里现读，而不是由调用方传：这个函数只在这一个地方被调用，
 * 让调用方去记「上次写的是第几版」纯粹是多一个出错的机会。
 */
export async function rewriteKnowledgeDocument(
  id: number,
  input: KnowledgeInput,
): Promise<boolean> {
  const bodyMd = input.bodyMd.trim();
  if (!bodyMd) return false;
  const doc = await repo.findDocument(id);
  if (!doc) return false;

  const content = contentFromText(bodyMd, 'markdown');
  const ok = await repo.replaceDocumentContent(id, content, doc.contentRevision);
  if (!ok) return false;
  await repo.updateDocument(id, { excerpt: input.excerpt });
  return true;
}
