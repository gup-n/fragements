/**
 * 小结正文的轻量渲染。
 *
 * 存进库里的 `body_md` 是 Markdown（导出要保真），但 RN 的 Text 不认 Markdown。
 * 这里只处理四种结构：`## 小标题`、`- 列表`、`**加粗**`、普通段落 ——
 * 刚好是总结 prompt 限定输出的范围。不做完整 Markdown 解析，也不需要第三方库。
 *
 * v0.7 起小结的每条都是 `- **换盘**：一句话`，加粗不能像以前那样直接抹掉：
 * 抹掉之后整段成了一片灰字，「一眼看出要点」就没了。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { C } from '../theme';

type Seg = { text: string; bold: boolean };
type Block = { kind: 'h' | 'b' | 'p'; segs: Seg[] };

/** 拆出行内加粗。反引号和引用符号只去壳，不留样式 */
function inlineParts(raw: string): Seg[] {
  const cleaned = raw.replace(/`([^`]*)`/g, '$1').replace(/^>\s?/, '');
  const segs: Seg[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    if (m.index > last) segs.push({ text: cleaned.slice(last, m.index), bold: false });
    segs.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < cleaned.length) segs.push({ text: cleaned.slice(last), bold: false });
  return segs.length ? segs : [{ text: '', bold: false }];
}

function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'h', segs: inlineParts(heading[1]) });
      continue;
    }

    const bullet = line.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      const segs = inlineParts(bullet[1]);
      blocks.push({ kind: 'b', segs: [{ text: '· ', bold: false }, ...segs] });
      continue;
    }

    const num = line.match(/^(\d+)[.)]\s+(.*)$/);
    if (num) {
      blocks.push({ kind: 'b', segs: [{ text: `${num[1]}. `, bold: false }, ...inlineParts(num[2])] });
      continue;
    }

    blocks.push({ kind: 'p', segs: inlineParts(line) });
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
          <Text style={b.kind === 'h' ? s.h : b.kind === 'b' ? s.b : s.p}>
            {b.segs.map((seg, j) => (
              <Text key={j} style={seg.bold ? s.bold : undefined}>
                {seg.text}
              </Text>
            ))}
          </Text>
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
  /** 加粗的关键词用正文色 + 稍重字重：强调要点，但不至于整段花花绿绿 */
  bold: { fontWeight: '600', color: C.text },
});
