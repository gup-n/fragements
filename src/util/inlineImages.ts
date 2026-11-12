/**
 * 正文里的「图片位置」标记。
 *
 * 为什么需要它（用户 2026-11-12）：「图片都是发到最上面，没有和文本嵌合，
 * 我如果中间文本需要加一张图片就无法做到」。配图原本只是碎片的一个附属列表，
 * 读的时候统一铺在正文上方 —— 一段话中间想插一张截图，没有任何办法表达。
 *
 * 做法是最朴素的：正文里留一行 `![](img:12)`，渲染时把这一行换成那张图。
 * 不用自定义语法是刻意的 —— 这份正文会原样导出成 Markdown，
 * 标准写法至少不会在一个陌生编辑器里变成一堆乱码（导出时会整行去掉，见 `mdBuild`）。
 *
 * 两个 key 空间：
 * - `12`  已入库的配图 id（`fragment_images.id`）
 * - `p3`  还没发出去的待发图（选择器给的临时 uri），发出去之后换成真 id
 */
import type { Fragment } from '../types';

/** 整行只有一个图片标记。行内混排不支持 —— 图片是块级的东西，挤在句子里反而更乱 */
const BLOCK_RE = /^!\[[^\]]*\]\(img:(\d+)\)$/;

/** 任意位置的标记（含待发的 `p` 形式），用于剥离与计数 */
const ANY_RE = /!\[[^\]]*\]\(img:(?:p?\d+)\)/g;

/** 生成标记。`key` 是配图 id 或 `p1` 这种待发键 */
export function imageToken(key: number | string): string {
  return `![](img:${key})`;
}

/** 这一行是图片标记时返回配图 id，否则 null */
export function imageIdOfLine(line: string): number | null {
  const m = line.trim().match(BLOCK_RE);
  return m ? Number(m[1]) : null;
}

/** 正文里按出现顺序引用了哪些配图（去重前的顺序保留，渲染按顺序找图） */
export function referencedImageIds(text: string): number[] {
  const out: number[] = [];
  for (const line of text.split('\n')) {
    const id = imageIdOfLine(line);
    if (id !== null) out.push(id);
  }
  return out;
}

/**
 * 去掉所有图片标记，换成空行。
 *
 * 三处必须用：喂给模型的材料（`![](img:12)` 对它是噪音）、FTS 索引、
 * Markdown 导出。少一处就会出现「模型把标记当正文写进文档」或者
 * 「导出文件里一堆坏图片链接」。
 */
export function stripImageTokens(text: string): string {
  return text.replace(ANY_RE, '').replace(/\n{3,}/g, '\n\n');
}

/** 把待发键换成真实配图 id。返回新正文（没变化时原样返回同一个字符串） */
export function resolvePendingTokens(
  text: string,
  mapping: { key: string; imageId: number }[],
): string {
  let out = text;
  for (const { key, imageId } of mapping) {
    if (!imageId) continue;
    out = out.split(imageToken(key)).join(imageToken(imageId));
  }
  return out;
}

/** 某张图被删掉时，正文里指向它的那一行也要跟着去掉 */
export function removeImageToken(text: string, imageId: number): string {
  return removeToken(text, imageId);
}

/**
 * 去掉某一枚标记（整行优先）。
 *
 * 先整行删、再删剩下的行内残留：用户手动把标记和句子写在了同一行，
 * 只删整行会一个都删不掉。
 */
export function removeToken(text: string, key: number | string): string {
  const tok = imageToken(key);
  return text
    .split('\n')
    .filter((line) => line.trim() !== tok)
    .join('\n')
    .split(tok)
    .join('');
}

/**
 * 一条碎片里「没有在正文中定位」的配图。
 *
 * 详情页只把这一批铺在正文上方；已定位的图跟着文字走，
 * 否则同一张图会出现两次。
 */
export function looseImages(f: Pick<Fragment, 'content' | 'images'>): Fragment['images'] {
  const placed = new Set(referencedImageIds(f.content));
  return f.images.filter((img) => !placed.has(img.id));
}
