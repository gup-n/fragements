/**
 * 把一次问答压成一条可以进时间轴的「问答纪要」碎片。
 *
 * 为什么要压：原样存回答，一轮就是几百字，四轮下来是一条三四千字的长碎片，
 * 下次整理时要单独吃掉一整批的预算，而且里面大半是客套和重复。
 *
 * 压到什么程度：每答 1-3 句、最多 300 字，最多保留最近 6 轮。
 * 引用编号保留 —— 它指向的碎片 id 是稳定的，将来重新找回原文靠它。
 */
import type { QaTurn } from '../types';
import { dayKey, formatTime } from './date';

/** 一轮最多保留几轮 */
const MAX_TURNS = 6;
/** 单个回答最多多少字 */
const MAX_ANSWER = 300;
/** 单个问题最多多少字 */
const MAX_QUESTION = 120;

/** 去掉 Markdown 外壳，只留能读的文字 */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^[-*+]\s+/gm, '· ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 取前几句。按中文句号/问号/感叹号断句，
 * 最多 3 句且不超过 300 字 —— 「第一句结论 + 一句依据」通常就够了。
 */
function compress(text: string, max = MAX_ANSWER): string {
  const body = plain(text).replace(/\n/g, ' ');
  // 自己按标点断句，不用 lookbehind：Hermes 对零宽断言的兼容性不值得赌
  const parts: string[] = [];
  let cur = '';
  for (const ch of body) {
    cur += ch;
    if ('。！？!?'.includes(ch)) {
      parts.push(cur);
      cur = '';
    }
  }
  if (cur.trim()) parts.push(cur);
  const out: string[] = [];
  let len = 0;
  for (const p of parts.slice(0, 3)) {
    if (len + p.length > max) break;
    out.push(p);
    len += p.length;
  }
  const joined = out.join('').trim() || body.slice(0, max);
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined;
}

/**
 * 生成纪要正文。时间戳用**会话开始时间**，
 * 这样这条碎片在时间轴上落在「你真正提问的那一刻」，而不是退出时。
 */
export function buildQaNote(turns: QaTurn[], startedAt: number): string {
  const kept = turns.filter((t) => t.question.trim() && t.answer.trim()).slice(-MAX_TURNS);
  const head = `【问答纪要】${dayKey(startedAt)} ${formatTime(startedAt)} · ${kept.length} 轮`;
  const body = kept
    .map((t, i) => {
      const q = t.question.replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION);
      return `问${i + 1}：${q}\n答${i + 1}：${compress(t.answer)}`;
    })
    .join('\n\n');
  return `${head}\n\n${body}`;
}
