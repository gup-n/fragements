/**
 * 一条碎片「给模型看 / 给搜索看」的全文。
 *
 * 为什么单独一个函数：碎片有两块内容是分开存的 —— 用户写的正文（`content`）
 * 和模型的图片文字层（`imageText`）。整理、问答、搜索、装箱预算这四处
 * 都要把它们当成同一份材料，各拼各的迟早有一处漏掉图，表现为
 * 「明明记了那张图，整理出来的文档里却没有它」。
 */
import type { Fragment } from '../types';

/**
 * 图片文字层的分段标记。
 *
 * 用方括号而不是 Markdown 标题：整理时的材料是纯文本块，
 * 一个 `[图片内容]` 前缀比 `### 图片` 更不容易让模型把它当成文档结构写出来。
 */
export const IMAGE_MARK = '[图片内容]';

/** 正文 + 图片文字。两者都没有时返回空串 */
export function fragmentText(f: Pick<Fragment, 'content' | 'imageText'>): string {
  const body = (f.content ?? '').trim();
  const pic = (f.imageText ?? '').trim();
  if (!pic) return body;
  return body ? `${body}\n${IMAGE_MARK} ${pic}` : `${IMAGE_MARK} ${pic}`;
}

/**
 * 这条碎片现在有没有可读内容。
 *
 * 纯图片且还没解析出文字时为 false —— 这种碎片进入整理材料只会占字数预算，
 * 却提供零信息（模型看到的是一个空块）。
 */
export function hasReadableText(f: Pick<Fragment, 'content' | 'imageText'>): boolean {
  return fragmentText(f).length > 0;
}
