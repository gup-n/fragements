import { Platform } from 'react-native';
import type { Fragment, KnowledgeCard } from '../types';
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
      const base = `- ${formatTime(f.createdAt)} ${text}`;
      return tags ? `${base} ${tags}` : base;
    });
    return { key, date: new Date(items[0].createdAt), body: lines.join('\n'), count: items.length };
  });
}

/**
 * 单文件、按天分节 + 知识库附录。
 * 刻意不写任何专有格式：换掉 App、丢进 Obsidian、直接 cat 都能读。
 */
export function buildMarkdown(fragments: Fragment[], cards: KnowledgeCard[] = []): ExportFile {
  const sections = daySections(fragments);
  const stamp = dayKey(Date.now());
  const knowledgeCount = cards.length;

  const head = [
    `# 碎片导出 · ${stamp}`,
    '',
    `共 ${fragments.length} 条碎片，覆盖 ${sections.length} 天` +
      (knowledgeCount ? `；另有 ${knowledgeCount} 张知识卡。` : '。'),
    '',
    '---',
    '',
    '## 时间轴',
    '',
  ].join('\n');

  const body = sections
    .map((s) => `### ${s.key} ${weekdayCN(s.date)}\n\n${s.body}\n`)
    .join('\n');

  const byTopic = new Map<string, KnowledgeCard[]>();
  for (const c of cards) {
    const list = byTopic.get(c.topic);
    if (list) list.push(c);
    else byTopic.set(c.topic, [c]);
  }

  const knowledge = knowledgeCount
    ? [
        '',
        '---',
        '',
        '## 知识库',
        '',
        Array.from(byTopic.entries())
          .map(([topic, list]) => {
            const items = list
              .map((c) => {
                const gist = c.gist
                  .split('\n')
                  .filter(Boolean)
                  .map((line) => (line.trim().startsWith('-') ? line.trim() : `- ${line.trim()}`))
                  .join('\n');
                const quote = c.body
                  .split(/\n{2,}/)
                  .map((para) => `> ${para.replace(/\r?\n/g, ' ').trim()}`)
                  .join('\n>\n');
                return `#### ${c.title}\n\n${gist}\n\n原文：\n\n${quote}\n`;
              })
              .join('\n');
            return `### ${topic}\n\n${items}`;
          })
          .join('\n'),
      ].join('\n')
    : '';

  return { name: `fragments-${stamp}.md`, content: `${head}${body}${knowledge}` };
}

export async function exportMarkdown(
  fragments: Fragment[],
  cards: KnowledgeCard[] = [],
): Promise<{ message: string }> {
  if (!fragments.length && !cards.length) throw new Error('还没有内容可以导出');
  const file = buildMarkdown(fragments, cards);

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
