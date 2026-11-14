/**
 * Markdown 文字导出：纯拼接，不碰文件系统。
 *
 * 与 `mdParse.ts` 做往返测试：保留分钟时间、压成一行的正文和旧标签，
 * 图片只迁出已有文字或缺失说明，待办清单只供阅读，不当成完整备份。
 *
 * 保持普通 Markdown 列表，换掉 App 后也能阅读；`status` / `project` /
 * 合并关系不还原，导入时只按旧标签推断兼容状态。
 */

import type { Fragment, Todo } from '../types';
import { dayKey, formatTime, weekdayCN } from './date';
import { exportFragmentText, MARKDOWN_EXPORT_SCOPE } from './mdExport';
import { flattenTodos } from './todoTree';

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
      // 正文与图片文字一起压成一行，保留旧列表格式；图片定位标记由投影剥掉。
      const text = exportFragmentText(f).replace(/\r\n?|\n/g, ' ').trim();
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
    MARKDOWN_EXPORT_SCOPE,
    '',
    '---',
    '',
    '## 时间轴',
    '',
  ].join('\n');

  const body = sections
    .map((s) => `### ${s.key} ${weekdayCN(s.date)}\n\n${s.body}\n`)
    .join('\n');

  /*
   * 待办按父子拍平后输出：子项缩进两格，成为 Markdown 的嵌套列表。
   * 用 `flattenTodos` 而不是直接 filter —— 直接 filter 会让子项混在顶层里，
   * 导出一份「分不出哪几步属于同一件事」的清单。
   */
  const flat = flattenTodos(todos);
  const open = flat.filter(({ todo }) => !todo.done);
  const done = flat.filter(({ todo }) => todo.done);
  const item = ({ todo, depth }: { todo: Todo; depth: number }) =>
    `${'  '.repeat(depth)}- [${todo.done ? 'x' : ' '}] ${todo.text}` +
    (todo.dueAt ? ` · ${todo.dueAt}` : '');

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
            ? `### 未完成（${open.length}）\n\n${open.map(item).join('\n')}\n`
            : '### 未完成\n\n（没有未完成的待办）\n',
          done.length
            ? `### 已完成（${done.length}）\n\n${done.map(item).join('\n')}\n`
            : '',
        ].join('\n');

  const tagBlock = tags.length
    ? ['', '---', '', '## 标签索引', '', ...tags.map(([name, n]) => `- #${name}（${n} 条）`)].join(
        '\n',
      )
    : '';

  return { name: `fragments-${stamp}.md`, content: `${head}${body}${todoBlock}${tagBlock}` };
}
