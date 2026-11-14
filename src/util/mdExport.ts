/**
 * Markdown 的文字迁出投影。与导入判重共用，不读取原图、不触发读图。
 * 配图文字导回后只是普通正文；这个格式不恢复附件或数据库的其它实体。
 */
import type { Fragment } from '../types';
import { fragmentText } from './fragmentText';

export const MARKDOWN_EXPORT_SCOPE =
  'Markdown 仅迁出碎片文字（含已有图片文字、时间和旧标签），不含原图、文档、月总结或会话，不是完整备份。' +
  '待办清单仅供阅读，不会导入；图片文字导入后仅作为文本保留。';

/** 保持原配图顺序/编号，未读与已读无字分别占位，永远不生成空白时间条目。 */
export function exportFragmentText(f: Pick<Fragment, 'content' | 'images'>): string {
  const images = (f.images ?? []).map((image) => ({
    ...image,
    // 只替换迁出投影，不改变库里的 null / 空串状态，也不把占位文字当成 OCR 写回。
    text: (image.text ?? '').trim()
      ? image.text
      : image.text == null
        ? '（尚未读取图片文字；原图未导出）'
        : '（未读出可导出文字；原图未导出）',
  }));
  const text = fragmentText({ content: f.content, images });
  if (!images.length) return text || '（此条无可导出文字）';
  return `${text}\n（原图未导出；图片文字导入后仅作为文本保留）`;
}
