/**
 * 阅读器/提取器读原文件的那一层。
 *
 * 只做「拿到字节/文本，失败时给一句人话」，不判断格式、不切片。
 * 复用 `db/docFiles.readPlainText`：它已经处理了「新 API 抛错就退回 legacy」这条
 * 安卓上的老坑（`content://` 在新 File API 里读不到），再写一份必定漏掉分支。
 */
import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import { readPlainText } from '../../db/docFiles';
import { ReaderError } from './errors';
import { stripBom } from './textDecode';

/** 没有原文件就别往下走了。`fileUri` 为空说明记录来自旧版本或已经被清理 */
export function requireFileUri(fileUri: string | null): string {
  if (!fileUri) {
    throw new ReaderError('no-file', '原文件已不在手机上（可能被系统清理），只能看已解析的正文。');
  }
  return fileUri;
}

export function assertNative(): void {
  if (Platform.OS === 'web') {
    throw new ReaderError('unsupported-web', '网页版没有应用内阅读器，请在手机上打开。');
  }
}

/** 读纯文本。BOM 由这里统一剥掉，调用方拿到的就是干净正文 */
export async function readDocText(uri: string): Promise<string> {
  assertNative();
  try {
    return stripBom(await readPlainText(uri));
  } catch (e) {
    if (e instanceof ReaderError) throw e;
    throw new ReaderError(
      'no-file',
      `读不了原文件：${e instanceof Error ? e.message : '未知原因'}。原文件可能已经被系统清理。`,
    );
  }
}

/** 读二进制（xlsx / xls）。走 `File.arrayBuffer`，不经 base64 */
export async function readDocBytes(uri: string): Promise<ArrayBuffer> {
  assertNative();
  try {
    return await new File(uri).arrayBuffer();
  } catch (e) {
    throw new ReaderError(
      'no-file',
      `读不了原文件：${e instanceof Error ? e.message : '未知原因'}。原文件可能已经被系统清理。`,
    );
  }
}
