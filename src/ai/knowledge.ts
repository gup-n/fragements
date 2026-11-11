/**
 * 整理成知识文档：把一批碎片（或一场对话）交给模型，产出一批**可编辑的草稿**。
 *
 * v0.17 按用户的两条反馈重写：
 *
 * 1. **只收知识**。上一版会把「买了把螺丝刀」「空调漏水报修」也整理进文档，
 *    文档区于是变成第二个时间轴 —— 而用户要的是「浓缩就是精华」。
 * 现在 prompt 里有一张「收 / 不收」清单和一句可执行的判据。
 * 2. **拆成多篇**。一篇里塞进换盘步骤、报错含义、型号取舍，找具体做法得从头读。
 *    现在按「将来会在什么场景下翻它」拆，每篇一个主题。
 *
 * 两个必须守住的边界：
 * - 只提炼材料里出现过的事实。模型很擅长"补全"一个看起来合理的结论，
 *   而这份文档是要被当成自己的知识反复读的 —— 编出来的部分会被当成真的。
 * - 改写草稿时只动用户点到的部分。整篇重写会让上一轮已经改好的措辞丢掉。
 */
import type { AiConfig, Fragment, QaTurn } from '../types';
import { fragmentText } from '../util/fragmentText';
import {
  AiError,
  clipRaw,
  parseJsonLoose,
  requestChat,
  type ChatMessage,
  type ChatProgress,
} from './chat';
import { MAX_DOCS, normalizeDraft, type DraftMode, type KnowledgeDraft } from '../util/knowledgeDoc';

const INPUT_LIMIT = 16_000;

const SHAPE = `{
  "docs": [
    {"title": "文档标题", "summary": "一句话说这篇讲什么", "body_md": "Markdown 正文"}
  ],
  "todos": [
    {"text": "要做的事", "due": "2026-11-30 或 null",
     "children": [{"text": "这件事的一步", "due": null}]}
  ],
  "note": "一句话说明这次整理覆盖了什么，不超过 30 字"
}`;

const SYSTEM = `你在帮用户整理他自己的记录。用户会给你一批材料（他的碎片记录，或他与助手的对话）。你要从中提炼**可以复用的知识**，写成 Markdown 文档。

只输出一个 JSON 对象，不要解释文字，不要 markdown 代码块。结构：

${SHAPE}

【第一步：判断什么算知识】
收：
- 做法与顺序：一件事怎么做成，关键的先后和前提
- 结论与判断：为什么这样、什么情况下不行、踩过的坑和它的成因
- 事实与参数：型号、版本、命令、路径、配置项、报错原文及含义
- 对比与取舍：几种方案的区别和适用条件
不收（这一条最重要，宁缺勿滥）：
- 生活琐事与一次性事件：「买了螺丝刀」「空调漏水报修」「明天带 U 盘」
- 情绪、感想、吐槽、自我鼓励、对自己的评价
- 计划、愿望、"回头试试"这类没有验证过的念头
- 没有结论的疑问
- 用户显然早已知晓、且材料里没有任何新信息的常识
判据只有一句：**三个月后重读，还能照着做、或者用来做判断的，才是知识。**
一条都不够格时，docs 给空数组，并在 note 里说明材料里没有可沉淀的知识。

【第二步：怎么拆】
- 一篇只讲一个主题；主题不同的拆开，最多 ${MAX_DOCS} 篇。
- 按「将来会在什么场景下翻它」分，不按时间、不按来源条数分。
- 只有一两句话能说的不单独成篇，并进最相关的那篇。

【第三步：怎么写才浓缩】
- 直接给结论和做法，删掉铺垫、过渡、客套，不要开场白。
- 能对比、能列步骤的用 Markdown 表格（\`| 列 | 列 |\` 加一行 \`|---|---|\`）或有序列表。
- 每篇 200~800 字。材料里就那么点东西时写短一点，**不要为凑篇幅扩写**。
- 原文里的数字、型号、命令、路径、报错信息**原样保留**，它们是这份文档的价值。
- 材料自相矛盾时不要调和：并列写出来，注明「两种说法」。

【todos 怎么抽】
- 只抽**材料里明确写了下一步动作**的条目（"还要…""下次…""待…""记得…"）。
- 已经做完的事不是待办。愿望、猜测、"可能需要"都不是待办。
- **一件事分几步时用 children 表达**，不要把一件事拆成三条并列待办。
  父项写「这件事本身」，children 写各步骤；没有步骤就用空数组。
- 一条不超过 40 字，说清一件事。
- due 只有材料里写明日期时才填（YYYY-MM-DD），没写就 null，不要猜。
- **已经存在的待办不要重复给出**（见用户消息里的「已有待办」）。材料里只是提到了
  一件已经在清单里的事，不算新待办。
- 没有可抽的就给空数组。

【title】
- 不超过 24 字，是一个**主题**，不是一句话。
- 「RAID5 降级处理」可以，「关于群晖换盘的一些记录和心得」不行。`;

const TODOS_SYSTEM = `你在帮用户从一堆记录里抽出**待办事项**。用户会给你材料和他的已有待办。只输出 JSON：

${SHAPE}

规则：
- 只抽材料里**明确写了下一步动作**的条目；已经做完的不算，愿望和猜测也不算。
- **一件事分几步时用 children 表达**（父项是这件事，children 是步骤），
  不要把一件事拆成几条并列待办 —— 那正是清单变得杂乱的原因。
- 一条不超过 40 字，说清一件事；children 里的步骤不超过 30 字。
- due 只有材料里写明日期时才填（YYYY-MM-DD），没写就给 null，不要猜。
- **已有待办里出现过的不要再给**：同一件事哪怕措辞不同也不许重复。
  用户已经在做、或者已经做完的事，材料里再提一次也不是新待办。
- docs 一律给空数组（这一轮不要写文档）。
- 一条都抽不出来就给空数组，并在 note 里说明为什么。`;

export type KnowledgeSource = { kind: 'fragments'; fragments: Fragment[] } | { kind: 'session'; turns: QaTurn[] };

/** 已有待办的一句话快照。整理时交给模型去重 —— 不给它看见，它只会把旧事再抽一遍 */
export interface TodoSnapshot {
  text: string;
  done: boolean;
  due: string | null;
  children: string[];
}

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
    .map(
      (f, i) =>
        `【${i + 1}】${stamp(f.createdAt)}${f.tags.length ? ` #${f.tags.join(' #')}` : ''}\n${fragmentText(f)}`,
    )
    .join('\n\n');
}

export function formatTurns(turns: QaTurn[]): string {
  return turns
    .map((t, i) => `【第 ${i + 1} 轮】\n问：${t.question}\n答：${t.answer}`)
    .join('\n\n');
}

/**
 * 已有待办清单。已完成的和未完成的分开列 ——
 * 模型需要知道「哪些已经做过」，否则一个月后它会反复整理出同一批旧事。
 */
export function formatExistingTodos(list: TodoSnapshot[]): string {
  if (!list.length) return '（还没有任何待办）';
  const line = (t: TodoSnapshot) =>
    `- ${t.done ? '［已完成］' : ''}${t.text}${t.due ? `（${t.due}）` : ''}${
      t.children.length ? `：${t.children.join('；')}` : ''
    }`;
  const open = list.filter((t) => !t.done);
  const done = list.filter((t) => t.done);
  const parts: string[] = [];
  if (open.length) parts.push(`未完成：\n${open.map(line).join('\n')}`);
  if (done.length) parts.push(`最近已完成（不要再整理出来）：\n${done.map(line).join('\n')}`);
  return parts.join('\n\n');
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
  /** 已有待办。只给 todos 模式看，整理文档时也用得上（判断哪些是计划哪些是知识） */
  existingTodos?: TodoSnapshot[];
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
  const { source, mode, instruction, existingTodos, config, onProgress } = options;
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
        `已有待办（用于去重，不要重复输出）：\n${formatExistingTodos(existingTodos ?? [])}`,
        '',
        ask ? `另外，用户对这次整理的要求：${ask}` : '',
        mode === 'todos' ? '请按系统提示抽出待办。' : '请按系统提示写出文档。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];

  const outcome = await requestChat(config, messages, onProgress, {
    json: true,
    // 文档可能很长。思考链和正文共用这个额度，给少了会「想到一半停住」。
    maxTokens: mode === 'todos' ? 8_000 : 16_000,
    effort: mode === 'todos' ? 'low' : 'high',
  });

  if (outcome.finishReason === 'length') {
    throw new AiError(
      'truncated',
      '这篇的输出被截断了（思考过程和正文共用额度）。把范围缩小一点，或者在设置里调低思考强度再试。',
      { stage: '整理', raw: outcome.content },
    );
  }

  const sourceIds = source.kind === 'fragments' ? source.fragments.map((f) => f.id) : [];
  /*
   * 解析失败时把**模型的原文**一起带出去。
   * 「返回的不是合法 JSON」这句话本身没法排查 —— 到底是截断了、被拒答了，
   * 还是把 JSON 包在解释文字里，只有原文能看出来。
   */
  let parsed: unknown;
  try {
    parsed = parseJsonLoose(outcome.content);
  } catch (e) {
    /*
     * 把具体原因（哪一字、什么毛病）留在人话里。
     * 「不是合法 JSON」等于什么都没说 —— 用户既不知道要不要重试，
     * 也不知道下次该怎么改（截断要缩小范围，语法问题重试通常就好）。
     */
    // 截断在上面已经拦过了，走到这里的都是「内容完整但语法有问题」
    const why = e instanceof AiError ? e.message : '模型返回的不是合法 JSON';
    throw new AiError('format', `${why}。展开详情能看到原文和出错位置。`, {
      stage: '解析',
      raw: clipRaw(outcome.content),
      finish: outcome.finishReason,
    });
  }
  const draft = normalizeDraft(parsed, mode, sourceIds);

  if (mode === 'knowledge' && !draft.docs.length && !draft.todos.length) {
    // 模型可能确实判断「这些材料里没有知识」。这不算错误，要说清楚而不是让人反复重试
    throw new AiError(
      'format',
      '这次没有整理出可沉淀的知识。可能是这批碎片都是待办或琐事 —— 换个范围，或者直接说「整理待办」。',
      { stage: '整理', raw: outcome.content },
    );
  }

  return { draft, reasoning: outcome.reasoning, truncated, used: count };
}

const REVISE_SYSTEM = `你在改一批用户已经看过、正在修改的文档草稿和待办。用户会给你当前草稿和一句修改要求。

只输出 JSON：${SHAPE}

规则：
- **只改用户点到的地方**。没提到的篇、段落、顺序、措辞一律原样保留 ——
  整篇重写会让用户上一轮改好的东西消失，那是最让人恼火的一种"帮忙"。
- 用户说"第一篇并进第二篇"就真的合并，其余篇不许动。
- 用户说"短一点"就删冗余，不要删事实；说"详细点"只展开材料里已有的内容，不许编。
- 表格仍然用 GFM 格式；改完要保证表格每行的竖线数量一致。
- todos 没被要求改就原样返回（含 children）。`;

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
            docs: draft.docs.map((d) => ({
              title: d.title,
              summary: d.summary,
              body_md: d.bodyMd,
            })),
            todos: draft.todos.map((t) => ({
              text: t.text,
              due: t.due,
              children: t.children.map((c) => ({ text: c.text, due: c.due })),
            })),
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
    maxTokens: 16_000,
    effort: 'low',
  });

  if (outcome.finishReason === 'length') {
    throw new AiError('truncated', '这次修改被截断了。可以再发一次，或者只改一小段。', {
      stage: '改稿',
      raw: outcome.content,
    });
  }

  let parsed: unknown;
  try {
    parsed = parseJsonLoose(outcome.content);
  } catch (e) {
    const why = e instanceof AiError ? e.message : '改稿返回的不是合法 JSON';
    throw new AiError('format', `${why}。展开详情能看到原文和出错位置。`, {
      stage: '改稿解析',
      raw: clipRaw(outcome.content),
      finish: outcome.finishReason,
    });
  }
  const next = normalizeDraft(parsed, draft.mode, draft.sourceIds);
  /*
   * 模型偶尔只回一句 note（尤其当它认为"没什么要改"时）。
   * 这种情况下保留原文，别让用户点一下修改就丢一篇 —— 但也不会把空数组当成"删光了"。
   */
  if (!next.docs.length) next.docs = draft.docs;
  if (!next.todos.length) next.todos = draft.todos;
  return next;
}
