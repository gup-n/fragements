/**
 * 小结正文的轻量渲染。
 *
 * 存进库里的 `body_md` 是 Markdown（导出要保真），但 RN 的 Text 不认 Markdown。
 * 这里只处理三种结构：`## 小标题`、`- 列表`、普通段落 —— 刚好是总结 prompt 限定输出的范围。
 * 不做完整 Markdown 解析，也不需要第三方库。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { C } from '../theme';

/** 去掉行内标记，只留文字 */
function inline(raw: string) {
  return raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^>\s?/, '');
}

type Block = { kind: 'h' | 'b' | 'p'; text: string };

function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'h', text: inline(heading[1]) });
      continue;
    }

    const bullet = line.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push({ kind: 'b', text: `· ${inline(bullet[1])}` });
      continue;
    }

    const num = line.match(/^(\d+)[.)]\s+(.*)$/);
    if (num) {
      blocks.push({ kind: 'b', text: `${num[1]}. ${inline(num[2])}` });
      continue;
    }

    blocks.push({ kind: 'p', text: inline(line) });
  }
  return blocks;
}

interface Props {
  text: string;
  /** 折叠行数；不给表示全展开 */
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
}

export function NoteBody({ text, numberOfLines, style }: Props) {
  const blocks = useMemo(() => toBlocks(text), [text]);

  return (
    <Text style={[s.root, style]} numberOfLines={numberOfLines}>
      {blocks.map((b, i) => (
        <React.Fragment key={i}>
          {/* 小标题前面空一行，读起来才有分节感 */}
          {i === 0 ? '' : b.kind === 'h' ? '\n\n' : '\n'}
          <Text style={b.kind === 'h' ? s.h : b.kind === 'b' ? s.b : s.p}>{b.text}</Text>
        </React.Fragment>
      ))}
    </Text>
  );
}

const s = StyleSheet.create({
  root: { fontSize: 14, lineHeight: 23, color: C.text },
  h: { fontSize: 12, lineHeight: 20, color: C.accentText, fontWeight: '600' },
  b: { color: C.text },
  p: { color: C.text },
});
