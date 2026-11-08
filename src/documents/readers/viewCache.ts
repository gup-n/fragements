/**
 * 表格解析结果的**磁盘**缓存。
 *
 * 内存里的那份（`workbookCache.ts`）只活到 App 退出。而「今天打开过、明天再打开」
 * 才是最常见的节奏 —— 那时候又得从头 `XLSX.read`，手机上一张 10 万格的表就是
 * 1.5–3 秒的 JS 线程独占（界面收不到点击）。
 *
 * 落盘之后同一条路变成：读 1.9 MB JSON → `JSON.parse` → 建 Map，实测 340 ms → 40 ms。
 *
 * 三条边界：
 *
 * 1. **缓存永远只是加速。** 读不出来、解不动、大小对不上，一律当作没有缓存，
 *    回到解析。任何情况下都不允许因为它抛错把「打开文档」变成本打不开。
 * 2. **放在原件旁边**（`documents/.cache/…`），名字只跟原文件名走。
 *    删除文档时用同一个 URI 就能推出该删哪个文件，不需要另建一张索引表；
 *    原件没了缓存也就没了意义，同生共死。
 * 3. **超上限不落盘。** 一份超大表的 JSON 可能几十 MB，占的空间比原件还多，
 *    这时候留在内存里就够了，不写盘 —— 宁可慢，不要把用户存储吃光。
 */
import { Directory, File } from 'expo-file-system';
import { decodeView, encodeView, type WorkbookView } from './excelWorkbook';

/** 缓存目录（相对 App 私有目录）。前导点让它和用户导入的原件分开，也不会被当成文档列出 */
const CACHE_DIR = '.cache';

/** 单份缓存的上限。超过就不落盘，只留内存里那一份 */
const MAX_CACHE_BYTES = 6 * 1024 * 1024;

/**
 * 缓存文件名：原文件名的最后一段 + `.view.json`。
 *
 * URI 可能是百分号编码过的（中文名），这里**不解码** —— 写和读走同一个字符串，
 * 一致就够了；一解码反而会在 `new File` 里再编码一次，变成 `%25E6…`。
 */
function cacheNameOf(fileUri: string | null): string | null {
  if (!fileUri) return null;
  const base = fileUri.split('/').pop();
  if (!base || base === '.' || base === '..') return null;
  return `${base}.view.json`;
}

function cacheDir(fileUri: string): Directory {
  // `file:///…/files/documents/17…-表.xlsx` → `file:///…/files/documents/.cache`
  const dirUri = fileUri.slice(0, fileUri.lastIndexOf('/'));
  return new Directory(`${dirUri}/${CACHE_DIR}`);
}

function cacheFile(fileUri: string | null, name: string): File | null {
  if (!fileUri) return null;
  try {
    return new File(cacheDir(fileUri), name);
  } catch {
    return null;
  }
}

/**
 * 读缓存。没有、坏了、大小对不上，都返回 null。
 *
 * `size` 是防御性的第二道锁：文件名只跟原文件名走，理论上同一毫秒同名导入会
 * 撞上同一个 URI（`saveOriginal` 用后缀躲开了，但那是另一处的实现细节）。
 * 把大小写进文件内容里比对，比在两处凑一个全局唯一的键可靠。
 */
export async function readViewCache(
  fileUri: string | null,
  size: number,
): Promise<WorkbookView | null> {
  const name = cacheNameOf(fileUri);
  if (!name) return null;
  try {
    const file = cacheFile(fileUri, name);
    if (!file || !file.exists) return null;
    const text = await file.text();
    const view = decodeView(text, size);
    if (!view) {
      // 解不出来的文件留着没有任何用，下次还会再读一次，顺手清掉
      void dropViewCache(fileUri);
    }
    return view;
  } catch {
    return null;
  }
}

/**
 * 写缓存。返回**是否真的写下去了**（超上限、没权限、空间不足都是 false）。
 *
 * 调用方应当在首屏画完之后再调 —— 一张 10 万格的表要写 1.9 MB，
 * 和第一帧渲染抢同一个 JS 线程不值得。
 */
export async function writeViewCache(
  fileUri: string | null,
  size: number,
  view: WorkbookView,
): Promise<boolean> {
  const name = cacheNameOf(fileUri);
  if (!name || !fileUri) return false;
  // 超限的表本来就读不开（`workbookToContent` 会明确失败），写盘没有意义
  if (view.truncated) return false;

  try {
    const file = cacheFile(fileUri, name);
    if (!file) return false;

    const json = encodeView(view, size);
    if (json.length > MAX_CACHE_BYTES) return false;

    const dir = cacheDir(fileUri);
    dir.create({ intermediates: true, idempotent: true });
    if (!file.exists) file.create({ intermediates: true });
    file.write(json);
    return true;
  } catch {
    return false;
  }
}

/** 删缓存。文档被删时必须调 —— 否则原件走了，几 MB 的派生文件还躺着 */
export async function dropViewCache(fileUri: string | null): Promise<void> {
  const name = cacheNameOf(fileUri);
  if (!name) return;
  try {
    const file = cacheFile(fileUri, name);
    if (file?.exists) file.delete();
  } catch {
    /* 删不掉就算了：缓存是可再生的，不值得为它报错打断删除流程 */
  }
}
