/**
 * Markdown 导出：纯拼接，不碰文件系统。
 *
 * 单独拆出来只有一个目的——能和 `mdParse.ts` 做**往返测试**：
 * 碎片 → md → 碎片，时间、正文、标签必须原样回来。
 * 导出格式一改，那条测试立刻变红，而不是等用户真去恢复数据时才发现对不上。
 *
 * 刻意不写任何专有格式：换掉 App、丢进 Obsidian、直接 cat 都能读。
 * 代价是 `status` / `project` / 合并关系不落进文件，导入时只能靠推断
 * （有标签=已整理），这一点在 mdParse 的文件头也写了一遍。
 */

import type { Fragment, Todo } from '../types';
import { dayKey, formatTime, weekdayCN } from './date';

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
      // 正文压成一行：md 列表项里塞换行会把解析和阅读都搞乱
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

/** 单文件、按天分节 + 待办清单 + 标签索引 */
export function buildMarkdown(fragments: Fragment[], todos: Todo[] = []): ExportFile {
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
