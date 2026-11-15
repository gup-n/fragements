/**
 * 把一个**已经在手机上**的文件存进文档库。
 *
 * 两条入口共用这一份顺序：文档页的「导入」（系统选择器）和系统分享
 * （微信/文件管理器「分享到碎片」）。两处各写一遍的话，早晚有一处
 * 忘记「记录没写成要删掉刚复制的原文件」，私有目录里就开始攒孤儿。
 *
 * **顺序不能换：先落原文件、核验字节数，再写记录。** 反过来的话，
 * 写库成功但复制失败，列表里就多一条永远「打开原文件失败」的记录，
 * 用户只能删掉重来。
 */
import { repo } from '../db/repo';
import { deleteOriginal, extOf, saveOriginal } from '../db/docFiles';
import { supportsLocalDocument } from './formats';

export interface LocalImportResult {
  /** 文档库里的记录 id */
  id: number;
  name: string;
  ext: string;
  /** 复制到私有目录之后的真实字节数（不是选择器报的大小） */
  size: number;
  /** 这台设备上能不能本地读。false 时界面要说「只能打开原文件」而不是假装能读 */
  readable: boolean;
}

export interface LocalFileInput {
  uri: string;
  /** 带扩展名的文件名。分享进来的文件名由原生侧从 `ContentResolver` 里取 */
  name: string;
}

export async function importLocalFile(input: LocalFileInput): Promise<LocalImportResult> {
  const name = input.name.trim();
  if (!name) throw new Error('文件没有名字，无法入库');
  const ext = extOf(name);

  const saved = await saveOriginal(input.uri, name);
  let id: number;
  try {
    id = await repo.insertDocument({
      name,
      ext,
      size: saved.size,
      fileUri: saved.uri,
      state: 'stored',
    });
  } catch (e) {
    // 记录没写成，刚复制的那份就是孤儿，顺手清掉
    await deleteOriginal(saved.uri);
    throw e;
  }

  return { id, name, ext, size: saved.size, readable: supportsLocalDocument(ext) };
}
