/**
 * 回收站的文件清理（v0.28）。
 *
 * 数据库那边 `purgeTrash` / `purgeExpiredTrash` 只还回**文件名**，
 * 删文件这一步必须由文件层做 —— repo 不碰文件系统，删文件失败也不该让事务回滚。
 *
 * 这一份实现有两个调用点：App 启动时清到期的，以及回收站页面里手动点「彻底删除」。
 * 两处各写一遍的话，30 天自动清掉的那批迟早会漏删配图。
 */
import { repo } from './repo';
import { removeFragmentImage } from './fragmentImages';
import { deleteOriginal } from './docFiles';
import { dropViewCache } from '../documents/readers/viewCache';
import { purgeCutoff } from '../util/trash';

/**
 * 删掉一个回收站文件，返回有没有删干净。
 *
 * 碎片配图存的是**文件名**（相对 `fragment-images/`），文档原件存的是整个 URI。
 * 两者都从 `purgeTrash` 的返回值里来，只能靠形状分辨：带斜杠/协议的当 URI，
 * 光秃秃一个名字的当配图。判错的后果是把一个不存在的路径交给另一条删除路径，
 * 那一边会安静地什么也不做 —— 所以这里只需要判对一次。
 */
export async function deleteTrashFile(file: string): Promise<boolean> {
  if (!file) return true;
  if (/^[^/:]+$/.test(file)) {
    await removeFragmentImage(file);
    return true;
  }
  // 解析缓存跟着原件一起走：原件没了，几 MB 的 JSON 也没有意义了
  await dropViewCache(file);
  return deleteOriginal(file);
}

/**
 * 清掉到期（删除超过 30 天）的条目，返回删掉的文件数。
 *
 * 幂等：没有到期的就什么都不做。启动时调一次就行，
 * 多调几次也只是几条 SELECT。
 */
export async function runTrashCleanup(now: number = Date.now()): Promise<{ files: number; failed: number }> {
  let files: string[] = [];
  try {
    files = await repo.purgeExpiredTrash(purgeCutoff(now));
  } catch {
    // 清理失败不该影响启动：下次打开还会再试
    return { files: 0, failed: 0 };
  }
  let failed = 0;
  for (const file of files) {
    const ok = await deleteTrashFile(file);
    if (!ok) failed += 1;
  }
  return { files: files.length, failed };
}
