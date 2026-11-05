/**
 * 工作簿解析结果的单槽缓存。
 *
 * 为什么需要：`XLSX.read` 是同步的，一张 10 万格的表在这台电脑上要 400 ms，
 * 手机上 1.5–3 秒，整段时间 JS 线程交不出来。而「打开 → 退出 → 再打开」
 * 是最常见的动作，第二次没有任何理由再解析一遍。同一份视图也给「本地准备」
 * 复用（`extract.ts`），所以一张表从导入到阅读只解析一次。
 *
 * **只留一份**，不是懒，是内存：一份 10 万格的视图是几 MB 到几十 MB 的
 * 字符串 Map，留两份在低端机上就开始挤压别的页面了。换文件即替换。
 *
 * 键用 `fileUri + size`：导入时原文件会以新文件名拷进私有目录，所以同一个
 * 文件再导入一次也是新 URI，不会命中旧缓存。`size` 是额外的一层保险 ——
 * 万一将来出现原地覆盖（现在没有），大小变了也不会拿旧视图顶上。
 */
import type { WorkbookView } from './excelWorkbook';

let slot: { key: string; view: WorkbookView } | null = null;

/** 没有原文件（记录来自旧版本）就没有可缓存的键 */
export function workbookKey(fileUri: string | null, size: number): string | null {
  if (!fileUri) return null;
  return `${fileUri}|${size}`;
}

export function recallWorkbook(key: string | null): WorkbookView | null {
  if (!key || !slot) return null;
  return slot.key === key ? slot.view : null;
}

export function rememberWorkbook(key: string | null, view: WorkbookView): void {
  if (!key) return;
  slot = { key, view };
}

/** 断言与「删除文档」用得上：删掉之后不该再命中 */
export function forgetWorkbook(): void {
  slot = null;
}
