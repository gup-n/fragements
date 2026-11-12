/**
 * 一条碎片「给模型看 / 给搜索看」的全文。
 *
 * 为什么单独一个函数：碎片有两块内容是分开存的 —— 用户写的正文（`content`）
 * 和模型的图片文字层（`images[].text`）。整理、问答、搜索、装箱预算这四处
 * 都要把它们当成同一份材料，各拼各的迟早有一处漏掉图，表现为
 * 「明明记了那张图，整理出来的文档里却没有它」。
 *
 * v0.20 起一条碎片可以带多张图，所以「哪张图的文字在哪」要说得清：
 * 只有一张时用 `[图片内容]`，多张时编号 —— 否则模型会把两张图的字
 * 连成一段，整理出来的文档里两件事就被合并了。
 */
import type { Fragment, FragmentImage } from '../types';

/**
 * 图片文字层的分段标记。
 *
 * 用方括号而不是 Markdown 标题：整理时的材料是纯文本块，
 * 一个 `[图片内容]` 前缀比 `### 图片` 更不容易让模型把它当成文档结构写出来。
 */
export const IMAGE_MARK = '[图片内容]';

/** 这一条里读出了字的图（按加入顺序） */
export function imageTextsOf(f: Pick<Fragment, 'images'>): string[] {
  return (f.images ?? []).map((i) => (i.text ?? '').trim()).filter((t) => t.length > 0);
}

/** 正文 + 每张图的文字。什么都没有时返回空串 */
export function fragmentText(f: Pick<Fragment, 'content' | 'images'>): string {
  const body = (f.content ?? '').trim();
  const pics = imageTextsOf(f);
  if (!pics.length) return body;
  const multi = (f.images ?? []).length > 1;
  const block = pics
    .map((t, i) => `${multi ? `${IMAGE_MARK} 第 ${i + 1} 张` : IMAGE_MARK} ${t}`)
    .join('\n');
  return body ? `${body}\n${block}` : block;
}

/**
 * 这条碎片现在有没有可读内容。
 *
 * 纯图片且还没解析出文字时为 false —— 这种碎片进入整理材料只会占字数预算，
 * 却提供零信息（模型看到的是一个空块）。
 */
export function hasReadableText(f: Pick<Fragment, 'content' | 'images'>): boolean {
  return fragmentText(f).length > 0;
}

/**
 * 一张图当前处在什么状态。界面和「重试」按钮都读它，不各写一份判断。
 *
 * - `busy`   正在读
 * - `fail`   上次读失败了（可以重试）
 * - `read`   读出了内容
 * - `empty`  读过了，图里确实没字（重试没用）
 * - `idle`   还没读过
 */
export type ImageState = 'busy' | 'fail' | 'read' | 'empty' | 'idle';

export function imageStateOf(
  image: FragmentImage,
  busy: Set<number>,
  fail: Record<string, string>,
): ImageState {
  if (busy.has(image.id)) return 'busy';
  if (fail[String(image.id)]) return 'fail';
  if (image.text === null || image.text === undefined) return 'idle';
  return image.text.trim() ? 'read' : 'empty';
}
