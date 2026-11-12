/**
 * 「这一批碎片里还有哪几张图没被模型看过」。
 *
 * 为什么需要这个筛选（v0.20.2）：用户否掉了「上传即解析」——
 * 拍三张图发出去，三个请求、几十秒、还可能撞限流，而那张图当时并不需要
 * 变成文字。现在改成**用到的时候才读**：整理/提问要把这批碎片交给模型了，
 * 顺手把里面没读过的图看一眼，读完存进文字层，下次不再重复读。
 *
 * 纯函数，不碰库也不碰网络 —— 能不能读、读几张在这里判，怎么读在
 * `ai/imageReads.ts` 里做。这样「哪些图算没读过」只有一份实现：
 * 它同时决定字数预算、界面状态和请求次数，各写一份必然对不上。
 */
import type { Fragment } from '../types';
import { stripImageTokens } from './inlineImages';

/** 一轮最多看几张。一张图几秒钟，四十条碎片里的图全读一遍会让整理卡好几分钟 */
export const IMAGE_READ_LIMIT = 6;
/** 问答一次最多看几张。问答是「等一下就要答案」，比整理更不能拖 */
export const ASK_IMAGE_READ_LIMIT = 3;

/** 一张待读的图，连带「谁写的、写了什么」——提示词要靠它判断该抄什么 */
export interface PendingImage {
  imageId: number;
  /** 相对文件名，交给 `readImageBase64` */
  path: string;
  fragmentId: number;
  /** 那条碎片的正文（已去掉定位标记）。模型看同一张图，正文不同，要抄的东西不同 */
  hint: string;
}

/**
 * 挑出这批碎片里没读过的图，按碎片顺序（也就是时间顺序）排队。
 *
 * `text === null` 才算没读过：空字符串是「读过了，图里确实没字」，
 * 再读一遍也只是再花一次钱、再等几秒，不会读出别的结果。
 */
export function pendingImagesOf(
  fragments: Pick<Fragment, 'id' | 'content' | 'images'>[],
  limit = IMAGE_READ_LIMIT,
): { list: PendingImage[]; rest: number } {
  const all: PendingImage[] = [];
  for (const f of fragments) {
    const hint = stripImageTokens(f.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    for (const img of f.images ?? []) {
      // 只要真的没读过（null / 缺字段）。'' 是读过的结论，跳过
      if (typeof img.text === 'string') continue;
      all.push({ imageId: img.id, path: img.path, fragmentId: f.id, hint });
    }
  }
  const room = Math.max(0, Math.floor(limit));
  return { list: all.slice(0, room), rest: Math.max(0, all.length - room) };
}
