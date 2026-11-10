/**
 * 整理成知识文档：把一批碎片（或一场对话）交给模型，产出一篇**可编辑的草稿**。
 *
 * 和旧的「整理」有什么不同：
 * - 旧整理按批打标签、抽待办、合并重复，产出是一份「对碎片做什么」的计划；
 *   它的结果直接作用于时间轴，用户看到的是一堆勾选框。
 * - 这里产出的是一篇**文档**：它有自己的标题和正文，能反复读、能被搜索，
 *   而且**在写库之前一个字都不落地**。
 *
 * 两个必须守住的边界：
 * 1. 只提炼材料里出现过的事实。模型很擅长"补全"一个看起来合理的结论，
 *    而这份文档是要被当成自己的知识反复读的 —— 编出来的部分会被当成真的。
 * 2. 改写草稿时只动用户点到的部分。整篇重写会让上一轮已经改好的措辞丢掉，
 *    用户会觉得"越改越差"。
 */
import type { AiConfig, Fragment, QaTurn } from '../types';
import { AiError, parseJsonLoose, requestChat, type ChatMessage, type ChatProgress } from './chat';
import { normalizeDraft, type DraftMode, type KnowledgeDraft } from '../util/knowledgeDoc';

const INPUT_LIMIT = 16_000;

const SYSTEM = `你在帮用户整理他自己的记录。用户会给你一批材料（他的碎片记录，或他与助手的对话），你要从中提炼出**值得长期留着**的知识，写成一篇 Markdown 文档。

只输出一个 JSON 对象，不要解释文字，不要 markdown 代码块。结构：

{
  "title": "文档标题",
  "body_md": "Markdown 正文",
  "todos": [{"text": "要做的事", "due": "2026-11-30 或 null"}],
  "note": "一句话说明这份文档覆盖了什么，不超过 30 字"
}

【只写材料里有的事】
- 材料里没有的事实、数字、型号、命令、路径，一律不许补。
- 可以归纳同类项、调换顺序、合并重复的说法；不许"顺着推"出一个结论。
- 两条记录互相矛盾时不要调和：并列写出来，注明「两种说法」。
- 原文里的具体数字、型号、命令、路径、报错信息**原样保留**，它们是这份文档的价值所在。

【正文怎么写】
- 先给结论或做法，再给依据；不要开场白、不要"本文将介绍"。
- 小节用 \`## \`，只在真的有两个以上层次时才用 \`### \`。
- 能对比的东西用 Markdown 表格（\`| 列 | 列 |\` 加一行 \`|---|---|\`）；步骤用有序列表。
- 长度由内容决定，不为凑字数扩写。一段话能说清就不要分三点。

【todos 怎么抽】
- 只抽**材料里明确写了下一步动作**的条目（"还要…""下次…""待…""记得…"）。
- 已经做完的事不是待办。愿望、猜测、"可能需要"都不是待办。
- due 只有材料里写明日期时才填，格式 YYYY-MM-DD；没写就 null，不要猜。
- 没有可抽的就给空数组。

【title】
- 不超过 24 字，是一个**主题**，不是一句话。
- 「群晖换盘」可以，「关于群晖换盘的一些记录和心得」不行。`;

const TODOS_SYSTEM = `你在帮用户从一堆记录里抽出**待办事项**。用户会给你材料，你只输出 JSON：

{
  "title": "",
  "body_md": "",
  "todos": [{"text": "要做的事", "due": "2026-11-30 或 null"}],
  "note": "一句话说明抽了几条、依据是什么，不超过 30 字"
}

规则：
- 只抽材料里**明确写了下一步动作**的条目；已经做完的不算，愿望和猜测也不算。
- 一条待办说清一件事，不超过 40 字；同一件事的多个步骤合成一条，别拆碎。
- due 只有材料里写明日期时才填（YYYY-MM-DD），没写就给 null，不要猜。
- 一条都抽不出来就给空数组，并在 note 里说明为什么。`;

export type KnowledgeSource = { kind: 'fragments'; fragments: Fragment[] } | { kind: 'session'; turns: QaTurn[] };

function stamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(
    2,
    '0',
  )}`;
}

/** 材料正文。带编号是为了让模型能引用具体某条，也让审阅时对得上 */
export function formatFragments(list: Fragment[]): string {
  return list
    .map((f, i) => `【${i + 1}】${stamp(f.createdAt)}${f.tags.length ? ` #${f.tags.join(' #')}` : ''}\n${f.content}`)
    .join('\n\n');
}

export function formatTurns(turns: QaTurn[]): string {
  return turns
    .map((t, i) => `【第 ${i + 1} 轮】\n问：${t.question}\n答：${t.answer}`)
    .join('\n\n');
}

/**
 * 材料超长时按「前 70% + 后 30%」截断。
 *
 * 只留前面会丢掉最近的结论，只留后面会丢掉起因 —— 两头都留才看得出一个月的走向。
 * 这一点和月小结的素材预算同一条口径（SPEC §6.3）。
 */
export function trimMaterial(text: string, limit = INPUT_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return {
    text: `${text.slice(0, head)}\n\n……（中间省略 ${text.length - limit} 字）……\n\n${text.slice(-tail)}`,
    truncated: true,
  };
}

function materialOf(source: KnowledgeSource): string {
  return source.kind === 'fragments' ? formatFragments(source.fragments) : formatTurns(source.turns);
}

export interface ExtractOptions {
  source: KnowledgeSource;
  mode: DraftMode;
  /** 用户在指令里额外说的要求（"只保留部署相关的"），可为空 */
  instruction?: string;
  config: AiConfig;
  onProgress?: (patch: ChatProgress) => void;
}

export interface ExtractOutcome {
  draft: KnowledgeDraft;
  reasoning: string;
  /** 材料被截断说明，界面要如实显示 —— 少看了内容就有可能是漏了关键结论 */
  truncated: boolean;
  used: number;
}

export async function extractKnowledge(options: ExtractOptions): Promise<ExtractOutcome> {
  const { source, mode, instruction, config, onProgress } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');

  const count = source.kind === 'fragments' ? source.fragments.length : source.turns.length;
  if (!count) throw new AiError('format', '没有可整理的内容');

  const { text, truncated } = trimMaterial(materialOf(source));
  const ask = (instruction ?? '').trim();

  const messages: ChatMessage[] = [
    { role: 'system', content: mode === 'todos' ? TODOS_SYSTEM : SYSTEM },
    {
      role: 'user',
      content: [
        `材料如下（共 ${count} 条${truncated ? '，中间有省略' : ''}）：`,
        '',
        text,
        '',
        ask ? `另外，用户对这次整理的要求：${ask}` : '',
        mode === 'todos' ? '请按系统提示抽出待办。' : '请按系统提示写出这篇文档。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];

  const outcome = await requestChat(config, messages, onProgress, {
    json: true,
    // 文档可能很长。思考链和正文共用这个额度，给少了会「想到一半停住」。
    maxTokens: mode === 'todos' ? 6_000 : 12_000,
    effort: mode === 'todos' ? 'low' : 'high',
  });

  if (outcome.finishReason === 'length') {
    throw new AiError(
      'truncated',
      '这篇的输出被截断了（思考过程和正文共用额度）。把范围缩小一点，或者在设置里调低思考强度再试。',
    );
  }

  const sourceIds = source.kind === 'fragments' ? source.fragments.map((f) => f.id) : [];
  const draft = normalizeDraft(parseJsonLoose(outcome.content), mode, sourceIds);

  if (mode === 'knowledge' && !draft.bodyMd) {
    throw new AiError('format', '模型没有写出正文。可以再试一次，或者先把范围缩小到几条。');
  }

  return { draft, reasoning: outcome.reasoning, truncated, used: count };
}

const REVISE_SYSTEM = `你在改一篇用户已经看过、正在修改的文档草稿。用户会给你当前草稿和一句修改要求。

只输出 JSON：{"title": "...", "body_md": "...", "todos": [...], "note": "一句话说明改了什么"}

规则：
- **只改用户点到的地方**。没提到的段落、小节、顺序、措辞一律原样保留 ——
  整篇重写会让用户上一轮改好的东西消失，那是最让人恼火的一种"帮忙"。
- 用户说"短一点"就删冗余，不要删事实；用户说"详细点"只展开材料里已有的内容，不许编。
- 表格仍然用 GFM 格式；改完要保证表格每行的竖线数量一致。
- todos 没被要求改就原样返回。`;

export interface ReviseOptions {
  draft: KnowledgeDraft;
  instruction: string;
  config: AiConfig;
  onProgress?: (patch: ChatProgress) => void;
}

export async function reviseDraft(options: ReviseOptions): Promise<KnowledgeDraft> {
  const { draft, instruction, config, onProgress } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  if (!instruction.trim()) throw new AiError('format', '还没说要改什么');

  const messages: ChatMessage[] = [
    { role: 'system', content: REVISE_SYSTEM },
    {
      role: 'user',
      content: [
        '当前草稿：',
        JSON.stringify(
          {
            title: draft.title,
            body_md: draft.bodyMd,
            todos: draft.todos.map((t) => ({ text: t.text, due: t.due })),
          },
          null,
          2,
        ),
        '',
        `用户要求：${instruction.trim()}`,
      ].join('\n'),
    },
  ];

  const outcome = await requestChat(config, messages, onProgress, {
    json: true,
    maxTokens: 12_000,
    effort: 'low',
  });

  if (outcome.finishReason === 'length') {
    throw new AiError('truncated', '这次修改被截断了。可以再发一次，或者只改一小段。');
  }

  const next = normalizeDraft(parseJsonLoose(outcome.content), draft.mode, draft.sourceIds);
  // 模型偶尔会返回空正文（只回了 note）。这种情况下保留原文，别让用户点一下修改就丢一篇
  if (!next.bodyMd) next.bodyMd = draft.bodyMd;
  if (!next.title) next.title = draft.title;
  if (!next.todos.length) next.todos = draft.todos;
  return next;
}
