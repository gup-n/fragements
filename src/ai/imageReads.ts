/**
 * 把一批碎片里**还没读过**的图交给模型看一眼，结果写回文字层。
 *
 * 触发时机只有两个（用户 2026-11-12 明确要求）：
 * - 整理之前：这批碎片即将交给模型，图里的字是材料的一部分；
 * - 提问之前：检索出来的这些碎片要进上下文，图里的字同理。
 *
 * 上传时**不再解析**。上一版是「落库就解析」，代价是：拍三张图立刻发三个请求，
 * 用户还在输入框里等着，模型却在读一张可能永远不会被用到的图；
 * 撞上限流还得逐张重试。
 *
 * 三条纪律：
 * - **读过的跳过**。`image_text` 非 null 就不再读（'' 也是读过的结论）。
 * - **失败不拦整件事**。一张图读不出来，整理照样跑，只是材料里少那一块；
 *   数量如实带回去，界面要能说「有 2 张没读出来」。
 * - **串行读**。并发打出去会撞限流，一失败就是整批重试，反而更慢。
 */
import type { AiConfig, Fragment } from '../types';
import { repo } from '../db/repo';
import { readImageBase64 } from '../db/fragmentImages';
import { pendingImagesOf } from '../util/pendingImages';
import { describeImage } from './vision';

export interface ImageReadResult {
  /** 真读出文字的条数 */
  read: number;
  /** 试了但失败的条数 */
  failed: number;
  /** 因为一轮上限被留在后面的张数（下次整理/提问还会再读） */
  rest: number;
  /** 第一条错误的原因，用来在界面上说清「为什么没读成」 */
  firstError: string | null;
}

export async function readPendingImages(input: {
  fragments: Fragment[];
  config: AiConfig;
  limit?: number;
  /** 每一步的人话，整理页拿它写步骤日志 */
  onStep?: (text: string) => void;
}): Promise<ImageReadResult> {
  const { fragments, config, limit, onStep } = input;
  const { list, rest } = pendingImagesOf(fragments, limit);
  if (!list.length) return { read: 0, failed: 0, rest, firstError: null };

  let read = 0;
  let failed = 0;
  let firstError: string | null = null;

  for (let i = 0; i < list.length; i += 1) {
    const p = list[i];
    onStep?.(
      list.length > 1 ? `正在看第 ${i + 1}/${list.length} 张图里的字…` : '正在看图里的字…',
    );
    try {
      const base64 = await readImageBase64(p.path);
      // hint 是那一条的正文：同一张图配「这是什么报错」和配「这块板子型号」，要抄的东西不同
      const text = await describeImage({ base64, config, hint: p.hint });
      await repo.setFragmentImageText(p.imageId, text);
      /*
       * 内存里那份也要改。材料是用调用方手里的这些对象现拼的 ——
       * 只写库不写回对象，这一次整理照样看不到图里的字，等于白读一次。
       */
      for (const f of fragments) {
        if (f.id !== p.fragmentId) continue;
        const img = f.images.find((x) => x.id === p.imageId);
        if (img) img.text = text;
      }
      read += 1;
    } catch (e) {
      failed += 1;
      if (!firstError) firstError = e instanceof Error ? e.message : '图片没读出来';
    }
  }

  return { read, failed, rest, firstError };
}
