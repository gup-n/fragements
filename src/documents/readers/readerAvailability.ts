/** 只读分派，不触发提取/上传，也不拿可问索引当阅读门槛。 */
import type { Document } from '../../types';
import { LOCAL_READER_LIMITS, supportsLocalDocument } from '../formats';

export type DocumentReadMode = 'original' | 'snapshot' | 'unavailable';

/**
 * limitNote必须由现有localReaderLimitNote提供，避免再抄一份格式/容量表。
 * state/contentRevision/indexedRevision故意不参与：准备失败或旧索引不应遮住原件。
 */
export function documentReadMode(
  doc: Pick<Document, 'fileUri' | 'ext' | 'bodyMd'>,
  limitNote: string | null,
): DocumentReadMode {
  if (doc.fileUri && supportsLocalDocument(doc.ext) && !limitNote) return 'original';
  if (doc.bodyMd.trim() && doc.bodyMd.length <= LOCAL_READER_LIMITS.bodyChars) return 'snapshot';
  return 'unavailable';
}
