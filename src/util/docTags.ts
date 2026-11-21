/**
 * 文档标签的纯逻辑（v0.28）。
 *
 * 用户 2026-11-18 定的是**平铺**：没有父子、没有分类树。
 * 所以这里没有 parent、没有路径、没有「上级标签」的任何概念 ——
 * 真要做层级，那是另一张带 `parent_id` 的表，不该混进这个文件。
 */
import type { DocTag } from '../types';

/**
 * 新建文档默认挂的标签。
 *
 * 用户最初提的是「默认分类草稿」，后来定的是「自动入库」。
 * 两条合起来的读法：**文档立刻进库**，但它出生时带着「草稿」这个标签 ——
 * 分类是标签，不是另一块存放区。
 */
export const DEFAULT_DOC_TAG = '草稿';

/** 标签名最长这么多字。再长在芯片里就要换行，一屏放不下几个 */
export const TAG_MAX = 12;

/**
 * 输入框里那串字 → 标签名。
 *
 * 去首尾空白、去开头的 `#`（用户习惯在搜索框里打 #）、把连续空白压成一个空格。
 * 空串返回空串，调用方据此拒收 —— **不要在这里抛错**：
 * 用户打到一半的「工」是合法的中间态。
 */
export function normalizeTagName(raw: string): string {
  const text = String(raw ?? '')
    .replace(/^[#＃\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, TAG_MAX);
}

/**
 * 标签的**比较键**：全角半角、大小写、开头 `#` 与多余空白都不敏感。
 *
 * 只用于查重，**存库仍然是 `normalizeTagName` 的显示形式** ——
 * 把 NAS 存成 nas，界面上看着就像个错别字。
 *
 * 标点不折叠：文档标签是用户手写的短名字，「读/写」和「读写」
 * 可能是他有意分开的两件事，合并掉就等于改了他的组织方式。
 */
export function docTagKey(raw: string): string {
  return normalizeTagName(raw)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

/**
 * 一串原始输入 → 干净的标签名数组。
 *
 * 判重按**归一化键**（大小写不敏感、全角半角不敏感）：存两个只差大小写的标签，
 * 用户在列表里根本分不出点哪个。
 */
export function cleanTagNames(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const name = normalizeTagName(item);
    if (!name) continue;
    const key = docTagKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * 芯片的颜色档位。
 *
 * 不给每个标签存颜色：颜色该由名字稳定地算出来，同一个标签在任何地方都是同一个色，
 * 换个设备也不会变。三个档位已经是「能分辨」和「不吵」之间的上限。
 */
export const TAG_TONE_COUNT = 3;

export function tagTone(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 100000;
  return hash % TAG_TONE_COUNT;
}

/** 按标签筛文档。`tagId` 为 null = 不筛 */
export function filterDocsByTag<T extends { id: number; tags: DocTag[] }>(docs: T[], tagId: number | null): T[] {
  if (tagId === null) return docs;
  return docs.filter((doc) => doc.tags.some((tag) => tag.id === tagId));
}

/**
 * 列表里该显示哪些标签。
 *
 * 只显示 `approved`：`pending` 的标签是 AI 提的、用户还没点头，
 * 拿它当分类去筛会让「按标签看」出现一批用户从没创建过的分类。
 * 它们仍然显示在文档详情里（带「待确认」），只是不参与筛选。
 */
export function visibleTags(tags: DocTag[]): DocTag[] {
  return tags.filter((tag) => tag.state === 'approved');
}

/** 标签栏排序：挂得多的在前，同数量按名字。空标签（0 篇）排最后 */
export function sortTags(tags: DocTag[]): DocTag[] {
  return [...tags].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
}

/** 标签栏那一行字：「草稿 3」；0 篇时只显示名字 */
export function tagChipText(tag: DocTag): string {
  return tag.count > 0 ? `${tag.name} ${tag.count}` : tag.name;
}
