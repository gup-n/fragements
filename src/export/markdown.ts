import { Platform } from 'react-native';
import type { Fragment, Todo } from '../types';
import { dayKey, formatTime, weekdayCN } from '../util/date';

export interface ExportFile {
  name: string;
  content: string;
}

function daySections(fragments: Fragment[]) {
  const byDay = new Map<string, Fragment[]>();
  for (const f of fragments) {
    const key = dayKey(f.createdAt);
    const list = byDay.get(key);
    if (list) list.push(f);
    else byDay.set(key, [f]);
  }
  const keys = Array.from(byDay.keys()).sort().reverse();
  return keys.map((key) => {
    const items = byDay.get(key)!.slice().sort((a, b) => a.createdAt - b.createdAt);
    const lines = items.map((f) => {
      const text = f.content.replace(/\r?\n/g, ' ').trim();
      const tags = f.tags.map((t) => `#${t}`).join(' ');
      const merged = f.mergedInto !== null ? '（已合并）' : '';
      const base = `- ${formatTime(f.createdAt)} ${text}${merged}`;
      return tags ? `${base} ${tags}` : base;
    });
    return { key, date: new Date(items[0].createdAt), body: lines.join('\n'), count: items.length };
  });
}

/** 标签索引：标签名 → 条数，按条数降序 */
function tagIndex(fragments: Fragment[]) {
  const counts = new Map<string, number>();
  for (const f of fragments) {
    for (const t of f.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * 单文件、按天分节 + 待办清单 + 标签索引。
 * 刻意不写任何专有格式：换掉 App、丢进 Obsidian、直接 cat 都能读。
 *
 * v0.7 去掉了「知识库」附录（卡片已经不存在），换成标签索引 ——
 * 导出的文件要能回答「我在哪些标签下记过东西」，而不是给一堆没有归属的段落。
 */
/** 纯拼接，只被 exportMarkdown 调用，不对外暴露 */
function buildMarkdown(fragments: Fragment[], todos: Todo[] = []): ExportFile {
  const sections = daySections(fragments);
  const stamp = dayKey(Date.now());
  const tags = tagIndex(fragments);

  const head = [
    `# 碎片导出 · ${stamp}`,
    '',
    `共 ${fragments.length} 条碎片，覆盖 ${sections.length} 天` +
      (tags.length ? `，${tags.length} 个标签。` : '。'),
    '',
    '---',
    '',
    '## 时间轴',
    '',
  ].join('\n');

  const body = sections
    .map((s) => `### ${s.key} ${weekdayCN(s.date)}\n\n${s.body}\n`)
    .join('\n');

  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);
  const todoBlock =
    todos.length === 0
      ? ''
      : [
          '',
          '---',
          '',
          '## 待办',
          '',
          open.length
            ? `### 未完成（${open.length}）\n\n${open
                .map((t) => `- [ ] ${t.text}${t.dueAt ? ` · ${t.dueAt}` : ''}`)
                .join('\n')}\n`
            : '### 未完成\n\n（没有未完成的待办）\n',
          done.length
            ? `### 已完成（${done.length}）\n\n${done.map((t) => `- [x] ${t.text}`).join('\n')}\n`
            : '',
        ].join('\n');

  const tagBlock = tags.length
    ? ['', '---', '', '## 标签索引', '', ...tags.map(([name, n]) => `- #${name}（${n} 条）`)].join(
        '\n',
      )
    : '';

  return { name: `fragments-${stamp}.md`, content: `${head}${body}${todoBlock}${tagBlock}` };
}

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
