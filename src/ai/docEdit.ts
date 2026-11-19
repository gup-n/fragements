/**
 * 对**文档**做 AI 操作：改一版、打标签（v0.28）。
 *
 * 与整理/月总结的区别只有一句：**这里不写库**。
 * 模型产出直接回给调用方，调用方把它存成一条 `pending` 提案，
 * 用户点了才落库。「AI 只出建议」这条铁律在这一层是靠不 import repo 实现的。
 */
import type { AiConfig, DocProposalPayload, Document } from '../types';
import { AiError, requestChat, type ChatProgress } from './chat';

/** 一次能读进去的正文上限。再长就只取开头 —— 并如实把「只读了前面这些」写进 note */
const DOC_CHARS_BUDGET = 12_000;

/** 打标签时用到的候选标签名上限。列太多模型会开始乱挑 */
const TAG_CANDIDATES = 40;

export type DocEditMode = 'polish' | 'condense';

function systemFor(mode: DocEditMode, withTags: boolean): string {
  const common = [
    '你在帮用户整理他自己写的一篇文档。',
    withTags ? '做两件事：给出一版更好的正文，再给它挑一组标签。' : '只做一件事：给出一版更好的正文。',
    '',
    '硬规则：',
    '1. **不许编造**。原文没有的事实、数字、人名一律不许加；拿不准就保留原话。',
    '2. 保留原文的 Markdown 结构（标题层级、列表、图片占位符 `![](…)` 原样留在原位置）。',
    withTags
      ? '3. 只输出 JSON，形如 {"title": "标题", "bodyMd": "正文", "tags": ["标签1"], "note": "一句话说明改了什么"}。'
      : '3. 只输出 JSON，形如 {"title": "标题", "bodyMd": "正文", "note": "一句话说明改了什么"}。',
    '4. bodyMd 里不要出现 ``` 围栏，也不要写「以下是优化后的版本」这种话。',
    '5. title 不超过 24 字；原文标题已经够好就原样返回。',
    withTags ? '6. 标签最多 4 个，每个不超过 8 个字，是名词不是句子；从【已有标签】里能挑到就别造新的。' : '',
  ].filter(Boolean);
  const modeRule =
    mode === 'condense'
      ? '这次的任务是**精简**：删掉重复的、跑题的、说了等于没说的内容，让篇幅明显变短，但每一条有效信息都要留下。'
      : '这次的任务是**优化**：理顺顺序、补上过渡、把口语化的句子改清楚，篇幅可以略有增减。';
  return [...common, '', modeRule].join('\n');
}

function clipBody(bodyMd: string): { text: string; clipped: boolean } {
  const text = bodyMd.trim();
  if (text.length <= DOC_CHARS_BUDGET) return { text, clipped: false };
  return { text: text.slice(0, DOC_CHARS_BUDGET), clipped: true };
}

/**
 * 改一版。
 *
 * `finishReason === 'length'` 时**不返回半篇**：一篇被截断的正文如果存成新文档，
 * 用户看到的是一篇「写到一半」的东西，而它和原文的差别没人分得清。
 */
export async function suggestDocRewrite(options: {
  config: AiConfig;
  doc: Document;
  mode: DocEditMode;
  /** 重新整理：正文和标签一起给（一次请求，两份产出） */
  withTags?: boolean;
  /** 已有标签名，withTags 时作为候选 */
  knownTags?: string[];
  onProgress?: (patch: ChatProgress) => void;
}): Promise<DocProposalPayload> {
  const { config, doc, mode, withTags = false, knownTags = [], onProgress } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  const body = clipBody(doc.bodyMd ?? '');
  if (!body.text) throw new AiError('format', '这篇文档还没有正文，先准备好再让 AI 处理');

  const user = [
    withTags && knownTags.length ? `【已有标签】${knownTags.slice(0, TAG_CANDIDATES).join('、')}` : '',
    `【标题】${doc.name}`,
    body.clipped ? `【正文】只贴了前 ${DOC_CHARS_BUDGET.toLocaleString()} 字（全文 ${doc.bodyMd.length.toLocaleString()} 字）` : '【正文】',
    '',
    body.text,
  ].filter(Boolean).join('\n');

  const outcome = await requestChat(
    config,
    [
      { role: 'system', content: systemFor(mode, withTags) },
      { role: 'user', content: user },
    ],
    onProgress,
    { json: true },
  );

  if (outcome.finishReason === 'length') {
    throw new AiError(
      'truncated',
      '这一版写到一半撞到了输出上限，没有保存。把「思考强度」调低，或者先把文档拆短一点再试。',
      { stage: '改稿', finish: outcome.finishReason },
    );
  }

  const raw = outcome.content;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*([\s\S]*?)```$/i, '$1'));
  } catch {
    throw new AiError('format', '模型返回的不是 JSON，这一版没法用。再试一次。', { stage: '改稿', raw });
  }

  const bodyMd = typeof parsed.bodyMd === 'string' ? parsed.bodyMd.trim() : '';
  if (!bodyMd) throw new AiError('format', '模型没有给出正文，再试一次', { stage: '改稿', raw });

  const note = [typeof parsed.note === 'string' ? parsed.note.trim() : '', body.clipped ? '（只读了正文开头）' : '']
    .filter(Boolean)
    .join(' ');

  const payload: DocProposalPayload = {
    bodyMd,
    title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : undefined,
    note: note || undefined,
  };
  if (withTags) {
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === 'string')
      : typeof parsed.tags === 'string'
        ? parsed.tags.split(/[,，、\s]+/)
        : [];
    if (tags.length) payload.tags = tags;
  }
  return payload;
}

/**
 * 打标签。
 *
 * 只让模型从**已有标签里挑**，同时允许它提 1–2 个新名字。
 * 完全自由生成的后果是每篇都长出三个新标签，标签栏半年后变成一堆只挂过一篇的分类。
 */
export async function suggestDocTags(options: {
  config: AiConfig;
  doc: Document;
  knownTags: string[];
  onProgress?: (patch: ChatProgress) => void;
}): Promise<DocProposalPayload> {
  const { config, doc, knownTags, onProgress } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  const body = clipBody(doc.bodyMd ?? '');
  const known = knownTags.slice(0, TAG_CANDIDATES);

  const system = [
    '你在给用户的一篇文档打标签。',
    '',
    '规则：',
    '1. 先从【已有标签】里挑，能覆盖就不要造新的。',
    '2. 最多 4 个标签，每个不超过 8 个字，是名词而不是句子。',
    '3. 确实没有合适的，才提 1 个新名字；不要为了显得细致而多提。',
    '4. 只输出 JSON：{"tags": ["标签1", "标签2"], "note": "一句话理由"}。',
  ].join('\n');

  const user = [
    known.length ? `【已有标签】${known.join('、')}` : '【已有标签】（还没有任何标签）',
    `【标题】${doc.name}`,
    body.clipped ? `【正文】只贴了前 ${DOC_CHARS_BUDGET.toLocaleString()} 字` : '【正文】',
    '',
    body.text || doc.excerpt || '（这篇还没有正文，只能靠标题判断）',
  ].join('\n');

  const outcome = await requestChat(
    config,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    onProgress,
    { json: true },
  );

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(outcome.content.replace(/^```(?:json)?\s*([\s\S]*?)```$/i, '$1'));
  } catch {
    throw new AiError('format', '模型返回的不是 JSON，这次没有拿到标签。再试一次。', {
      stage: '打标签',
      raw: outcome.content,
    });
  }

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t): t is string => typeof t === 'string')
    : typeof parsed.tags === 'string'
      ? parsed.tags.split(/[,，、\s]+/)
      : [];
  if (!tags.length) throw new AiError('format', '模型没有给出标签，再试一次', { stage: '打标签' });

  return {
    tags,
    note: typeof parsed.note === 'string' && parsed.note.trim() ? parsed.note.trim() : undefined,
  };
}
