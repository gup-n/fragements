/**
 * 导出的 IO 部分：拼内容在 `util/mdBuild.ts`（纯函数，能和导入做往返测试），
 * 这里只负责把字符串变成文件、交给系统分享。
 */

import { Platform } from 'react-native';
import type { Fragment, Todo } from '../types';
import { buildMarkdown } from '../util/mdBuild';

export type { ExportFile } from '../util/mdBuild';

export async function exportMarkdown(
  fragments: Fragment[],
  todos: Todo[] = [],
): Promise<{ message: string }> {
  if (!fragments.length) throw new Error('还没有内容可以导出');
  const file = buildMarkdown(fragments, todos);

  if (Platform.OS === 'web') {
    const doc = (globalThis as any).document;
    const blob = new Blob([file.content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = file.name;
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return { message: `已下载 ${file.name}` };
  }

  let uri = '';
  try {
    const fs = require('expo-file-system');
    const target = new fs.File(fs.Paths.cache, file.name);
    if (target.exists) target.delete();
    target.create();
    target.write(file.content);
    uri = target.uri;
  } catch {
    const legacy = require('expo-file-system/legacy');
    uri = `${legacy.cacheDirectory}${file.name}`;
    await legacy.writeAsStringAsync(uri, file.content);
  }

  const Sharing = require('expo-sharing');
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: 'text/markdown',
      dialogTitle: '导出碎片',
      UTI: 'net.daringfireball.markdown',
    });
  }
  return { message: `已生成 ${file.name}` };
}
