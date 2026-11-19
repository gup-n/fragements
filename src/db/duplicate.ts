/**
 * 复制一条碎片（含配图），v0.30.1。
 *
 * 「复制」在剪贴板里只能带走文字 —— 用户 2026-11-19 反馈「复制的碎片不会自带里面的图」，
 * 要的是「再存一条一样的」。所以这里做的是**在库里复制一条**：
 * 正文照抄，配图**连同文件再复制一份**，然后把这批新图接在正文后面。
 *
 * 为什么必须复制文件而不是共用文件名：
 * 配图文件是**按条归属**的，删掉任意一条碎片会连文件一起删（回收站真正清空时）。
 * 两条碎片共用一个文件，删一条就把另一条的图也弄没了。
 *
 * 为什么不用 `insertFragment` 的待发键（`key`）：那套映射的输入是「还没落盘的临时图」，
 * 这里已经有真实文件名了，直接用一条 SQL 之外的顺序写更清楚 ——
 * 先建记录、再插图、最后把标记改写成新 id，全在一个事务里由 repo 保证原子性。
 */
import type { Fragment } from '../types';
import { repo } from './repo';
import { fragmentImageUri, removeFragmentImage, saveFragmentImage } from './fragmentImages';
import { imageToken } from '../util/inlineImages';

/** 一条碎片最多带几张图（与 repo 的校验同口径） */
const MAX_IMAGES = 9;

export async function duplicateFragment(source: Fragment): Promise<number> {
  const pictures = source.images.slice(0, MAX_IMAGES);
  let content = source.content;

  /*
   * 先落文件，再写库。反过来的话，写库成功而复制文件失败，
   * 会留下一条「图片行指着不存在的文件」的碎片 —— 界面上是几张空白格子。
   */
  const copies: { path: string; key: string }[] = [];
  const written: string[] = [];
  try {
    for (const [index, image] of pictures.entries()) {
      const uri = fragmentImageUri(image.path);
      if (!uri) continue;
      const name = await saveFragmentImage(uri);
      written.push(name);
      const key = `dup${index + 1}`;
      // 把对旧 id 的引用换成这次复制出来的待发键，交给 insertFragment 换成新 id
      content = content.split(imageToken(image.id)).join(imageToken(key));
      copies.push({ path: name, key });
    }

    return await repo.insertFragment(content, source.source, undefined, copies);
  } catch (error) {
    // 库没写成，刚落盘的图就是孤儿 —— 这里不删，手机上会一直多着几 MB
    for (const name of written) await removeFragmentImage(name);
    throw error;
  }
}
