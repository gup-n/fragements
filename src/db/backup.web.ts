/**
 * 网页端的备份占位。
 *
 * 网页版没有私有目录、没有 SQLite 文件、也没有系统分享，做出来的
 * 「备份」只会是半份数据 —— 那比没有更危险（用户会以为备份过了）。
 * 所以这里直接抛一句人话，界面照原样显示原因。
 */
import type { BackupResult, RestoreResult, SafetyCopy } from './types';

const NO = '网页版没有完整备份（没有私有目录和本地数据库文件），请在手机上操作';

export async function createBackup(): Promise<BackupResult> {
  throw new Error(NO);
}

export async function restoreBackup(): Promise<RestoreResult> {
  throw new Error(NO);
}

export async function listSafetyCopies(): Promise<SafetyCopy[]> {
  return [];
}
