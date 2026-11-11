/**
 * 碎片配图的文件层。**只碰文件，不碰数据库、不碰界面。**
 *
 * 为什么单独一层：
 * - 图片和文档不一样，它是「碎片的一部分」而不是独立资产：库里只存一个相对文件名，
 *   真文件躺在 App 私有目录。这样备份 / 迁移 / 换机时不会因为一个绝对路径失效
 *   就把所有配图变成空白；
 * - 复制这个动作在安卓上有两个坑（`content://` 在新 File API 里读不到、失败会留半截
 *   文件），散在页面里必定漏掉分支。
 */
import { Directory, File, Paths } from 'expo-file-system';
import { copyAsync, deleteAsync, readAsStringAsync } from 'expo-file-system/legacy';

const IMG_DIR = 'fragment-images';

/** 配图目录。不存在就建，`getOrCreate` 保证连点两次不会一个抛异常 */
function imagesDir(): Directory {
  const dir = new Directory(Paths.document, IMG_DIR);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** 库里存的相对名 → 能给 <Image> 用的绝对 uri */
export function fragmentImageUri(name: string | null | undefined): string | null {
  if (!name) return null;
  try {
    return new File(imagesDir(), name).uri;
  } catch {
    return null;
  }
}

/**
 * 把选择器给的临时图复制进私有目录，返回**相对文件名**。
 *
 * 为什么要复制：`ImagePicker` / 分享进来的 uri 是临时授权，重启后经常读不到；
 * 而且原图可能落在别的应用的缓存里，被系统清掉就没了。
 *
 * 扩展名一律 `.jpg`：`ImagePicker` 的 `quality` 只在重新编码成 JPEG 时才生效，
 * 保留 png 就等于没压缩。文件名用时间戳 + 随机串，绝不用原文件名 ——
 * 中文文件名在部分 ROM 的 File API 上会打不开。
 */
export async function saveFragmentImage(srcUri: string): Promise<string> {
  const dir = imagesDir();
  const name = `f${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const dest = new File(dir, name);

  try {
    await new File(srcUri).copy(dest);
  } catch {
    // 旧 API 兜底：部分 ROM 上 `content://` 在新 File API 里读不到
    try {
      await copyAsync({ from: srcUri, to: dest.uri });
    } catch (e) {
      await deleteAsync(dest.uri, { idempotent: true }).catch(() => undefined);
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`保存图片失败：${msg}。可能是存储空间不足`);
    }
  }

  if (!dest.exists) throw new Error('图片复制后读不到了，可能是存储空间不足');
  return name;
}

/**
 * 读出 base64，交给模型。
 *
 * 走 legacy 的 `readAsStringAsync`：新 `File` API 只有 `bytes()`，
 * 自己转 base64 要手写一遍编码，而这里读的是自己目录下的 `file://`，
 * 不存在 `content://` 那条老坑。
 */
export async function readImageBase64(name: string): Promise<string> {
  const uri = fragmentImageUri(name);
  if (!uri) throw new Error('图片路径不对');
  return readAsStringAsync(uri, { encoding: 'base64' });
}

/**
 * 删除配图文件。**失败不抛** —— 调用方是删碎片，数据库那行已经删了，
 * 这里再抛只会让用户看到「删除失败」但记录其实没了，更困惑。
 * 残留文件由「设置页的清理」负责，不是这条路径。
 */
export async function removeFragmentImage(name: string | null | undefined): Promise<void> {
  if (!name) return;
  try {
    await deleteAsync(new File(imagesDir(), name).uri, { idempotent: true });
  } catch {
    /* 见上 */
  }
}
