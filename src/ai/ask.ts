/**
 * 知识库问答：拿卡片当事实来源回答用户的问题。
 *
 * 这里没有向量检索，用的是**关键词打分 + 预算装填**：
 * 卡片数量是几百张的量级，把提问里的词和卡片文本做字面匹配，
 * 命中标题/主题的加权更高，取分高的塞进上下文，剩下的预算按时间补齐。
 * 不够聪明，但零成本、结果可解释，也不会因为一次问答就多花几千 token。
 *
 * v0.5.0 起多了三样东西，都是**可选**的，开启时才改 prompt：
 * - `web`：联网搜到的资料。卡片优先，网络只用来补卡片没有的
 * - `turns`：这一次打开面板以来的更早问答。v0.6.5 之前是拼成一段文本塞进
 *   同一条 user 消息里，而且默认只带用户手动勾选的记录 —— 等于每问一句都是新的一轮，
 *   用户说「那它呢」「把这个改掉」时模型完全不知道指什么
 * - 操作提案（`:::action` 块）：模型只能建议，由界面勾选后执行
 *
 * ## 多轮是怎么拼的
 *
 * 卡片清单只出现一次，放在**第一条 user 消息**里（它就是这一轮的「资料」）；
 * 之后每一轮就是纯粹的 user/assistant 对话。这样既省 token，
 * 也让模型看到清晰的对话边界 —— 拼成一整段文本时它分不清哪句是它自己说的。
 */
import type { AiConfig, AskAction, KnowledgeCard, WebHit } from '../types';
import { parseAskActions } from '../util/askActions';
import { AiError, requestChat, type ChatMessage, type ChatProgress } from './chat';

/** 上下文预算（字符）。卡片原文很长，必须给上限 */
const CARD_BUDGET = 26_000;
/** 单张卡最多带多少字原文 */
const PER_CARD_CLIP = 1200;
/**
 * 多轮里更早那条回答最多保留多少字。
 *
 * 原来是 700 —— 一条稍微详细点的回答就被砍掉后半段，
 * 下一轮模型只看到半句话，追问自然接不上。问答记录本身就是上下文，
 * 这里给到 2500，正常长度的回答一个字都不会截。
 */
const HISTORY_CLIP = 2500;
/**
 * 最多回传几轮历史。
 *
 * 「一次打开算一轮」不等于「无限记」。问到第十几轮时，历史已经几万字，
 * 每一轮都要重发一遍：请求越来越慢、模型也更容易被前文带偏。
 * 留 10 轮（第 1 轮 + 最近 9 轮）—— 第 1 轮里装着卡片清单，不能丢；
 * 最近几轮决定「它指的是什么」。更早的仍然在界面上，只是不再回喂给模型。
 */
const MAX_HISTORY_TURNS = 10;
/** 一条网络资料最多进多少字。官方 summary 本身就是 600–800 字 */
const WEB_CLIP = 700;
/**
 * 回答上限。带 action 块时会更长一些。
 *
 * 这里曾经是 2800 —— 但思考模式下这个额度**要和思维链分**，
 * 引用好几张卡的长回答，思考链往往就吃掉大半，正文直接被截成空。
 * 现在按官方思考模式默认量级给，只当上限用、不会真的写满。
 */
const MAX_TOKENS = 12_000;

const BASE_RULES = [
  '你是一个私人知识库的检索助手。用户会提问，下面会给出他知识库里的若干卡片（每张有主题、标题、要点、原文）。',
  '',
  '硬规则：',
  '1. **只用卡片里的信息回答**。卡片里没写的内容一律不要用通用知识补，直接说「知识库里没有这方面的记录」，',
  '   可以顺带说一句「要不要把这条记下来」。',
  '2. 用中文，Markdown。能用两三句说清就不要分节；确实需要列点时才用 `- ` 列表。',
  '3. 引用某张卡的观点时，**把那张卡的标题原样写进句子里并用「」括起来**，让用户知道话是从哪来的。',
  '   不要自己编编号引用，不要输出参考文献列表。',
  '4. 卡片之间互相矛盾时，把矛盾点摆出来，不要替他裁决。',
  '5. 不要输出 JSON，不要解释你在做什么。',
];

const WEB_RULES = [
  '',
  '【这次带了网络资料】',
  '6. 下面有【网络资料】，它来自搜索引擎，**不属于他的知识库**。',
  '7. 卡片里有的，仍然只按卡片答。卡片明显没有时，才可以用网络资料补，',
  '   并且必须写明「网上资料显示…」，同时带上 [W1] 这样的编号。绝不要把网络资料说成他记过的东西。',
];

const HISTORY_RULES = [
  '',
  '【这是一次连续对话】',
  '8. 前面几轮是你刚回答过的内容，**直接接着聊**：他说的「这个」「那张卡」「再改一下」都指前文。',
  '   但事实来源仍然只有下面那份知识库清单：前文里你自己说过的话不能当证据，',
  '   两边冲突时以卡片为准，并把差异说出来。',
];

const ACTION_RULES = [
  '',
  '【改知识库：你有提案权，方式是在回答末尾追加 action 块】',
  '用户让你改东西时（合并主题、给主题改名、把卡片归到别的主题、改标题/要点/正文、归档旧卡），',
  '**你必须输出 action 块**。不要回「我没有修改权限」「请你自己去改」——',
  '你没有直接写的权限，但有提案权：下面的块会被界面解析成几条建议，他勾选后一键执行。',
  '只写「好的，我已经改好了」而不给 action 块，是他最讨厌的一种失败 —— 他看不到任何变化。',
  '',
  '格式（要多办几件事就写多段）：',
  '',
  ':::action',
  '{"kind":"rename_topic","from":"工具","to":"AI 与工具","reason":"两个主题下都是 AI 相关的结论"}',
  ':::',
  '',
  '支持的 kind：',
  '- merge_topics　{"from":[至少两个已存在的主题],"to":"合并后的名字"}',
  '- rename_topic　{"from":"已存在的主题","to":"新名字"}',
  '- archive_cards　{"ids":[已存在的卡片 id]}　只归档被新结论**完全取代**的旧卡',
  '- update_card　{"id":卡片 id,"topic":"新主题","subtopic":"新方向","title":"新标题","gist":"新要点","body":"新正文"}',
  '  只写要改的字段；"subtopic": null 表示取消小方向。',
  '  **用户说「改掉这条结论」「把正文里那段删了」「重新写一遍这张卡」时，必须用 body 给完整的新正文**，',
  '  不能只改标题或要点 —— 那两样是索引，正文才是他真正要改的东西。',
  '  正文里原样保留还有效的内容，只改他指出的部分；不要顺手删掉别的段落。',
  '',
  '什么情况**不要**输出 action：',
  '- 他只是在提问、在了解知识库里有什么；',
  '- 他说的是「以后要不要…」「是不是该…」这种还在商量的口气，而不是让你动手；',
  '- 你要改的主题名/卡片 id 无法从下面的清单里逐字确认 —— 这时候宁可先问一句「你是指 XX 这张卡吗」，',
  '  也不要编一个不存在的名字，那会被校验丢掉，他看到的是一条建议都没有。',
  '',
  '硬规则：',
  '9. 主题名、卡片 id 必须**逐字**来自下面的清单，不要自己编，也不要改一个字。',
  '10. action 块外面要用一两句话说明你打算怎么改，让人看懂之后再决定勾不勾。',
  '11. action 块里的 JSON 必须单行、合法，不要加注释，不要用 Markdown 代码围栏。',
  '12. 一次能改完的就给一条，不要把一个改动拆成好几条重复的。',
];

function buildPrompt(opts: { web: boolean; history: boolean }) {
  return [
    ...BASE_RULES,
    ...(opts.web ? WEB_RULES : []),
    ...(opts.history ? HISTORY_RULES : []),
    ...ACTION_RULES,
  ].join('\n');
}

/** 把提问拆成可匹配的词：英文/数字整词 + 中文二元组 */
function terms(question: string) {
  const out = new Set<string>();
  const lower = question.toLowerCase();

  for (const word of lower.match(/[a-z0-9_.+-]{2,}/g) ?? []) out.add(word);

  const cjk = lower.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const run of cjk) {
    // 单个字太容易误命中，两个字起步
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
    if (run.length === 1) out.add(run);
  }
  return [...out];
}

function count(haystack: string, needle: string) {
  if (!haystack) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * 按相关度排序。标题命中权重最高 —— 卡片标题就是结论本身，
 * 用户往往用接近标题的说法来提问。
 */
export function rankCards(question: string, cards: KnowledgeCard[]): KnowledgeCard[] {
  const words = terms(question);
  if (!words.length) return cards;

  const scored = cards.map((card) => {
    const title = card.title.toLowerCase();
    const topic = card.topic.toLowerCase();
    // 二级方向也算「主题级」的关键词：问「换盘」时，「NAS 维护 · 换盘」该排前面
    const subtopic = (card.subtopic ?? '').toLowerCase();
    const gist = card.gist.toLowerCase();
    const body = card.body.toLowerCase();

    let score = 0;
    for (const w of words) {
      score += count(title, w) * 8;
      score += count(topic, w) * 4;
      score += count(subtopic, w) * 4;
      score += count(gist, w) * 3;
      score += count(body, w) * 1;
    }
    return { card, score };
  });

  scored.sort((a, b) => b.score - a.score || b.card.createdAt - a.card.createdAt);
  return scored.map((x) => x.card);
}

function cardBlock(card: KnowledgeCard) {
  const body =
    card.body.length > PER_CARD_CLIP ? `${card.body.slice(0, PER_CARD_CLIP)}…` : card.body;
  return [
    `【${card.topic}${card.subtopic ? ` · ${card.subtopic}` : ''}｜${card.title}】`,
    card.gist ? `要点：${card.gist.replace(/\n/g, ' ')}` : '',
    `原文：${body.replace(/\n{2,}/g, ' ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 按预算装填卡片，返回实际带进上下文的那些 */
export function packCards(cards: KnowledgeCard[], budget = CARD_BUDGET) {
  const picked: KnowledgeCard[] = [];
  let used = 0;
  for (const card of cards) {
    const block = cardBlock(card);
    if (used + block.length > budget) break;
    picked.push(card);
    used += block.length + 2;
  }
  return picked;
}

/** 会话里的一轮问答。answer 必须已经剥掉 action 块 —— 那是内部标记，不该回喂给模型 */
export interface AskTurn {
  question: string;
  answer: string;
}

/** 兼容旧名字：从问答记录里挑出来的「带进本轮」也是这个结构 */
export type AskHistoryItem = AskTurn;

export interface AskOptions {
  question: string;
  /** 候选卡片。主题内提问就只传该主题的卡 */
  cards: KnowledgeCard[];
  config: AiConfig;
  /** 现有主题名与卡片 id，用来校验模型给出的操作提案 */
  topics?: string[];
  /** 本轮真正参与回答的卡片全集（用于提案校验）。不给就用 cards */
  contextCardIds?: number[];
  /** 联网搜到的资料。空数组和省略都等于「没联网」 */
  web?: WebHit[];
  /**
   * 这一次打开面板以来更早的几轮问答，按时间升序。
   *
   * v0.6.5 之前这里只有「用户手动勾选的问答记录」，默认为空，
   * 于是每问一句都是全新一轮 —— 追问「那它呢」模型完全接不上。
   */
  turns?: AskTurn[];
  onProgress?: (patch: ChatProgress) => void;
}

export interface AskOutcome {
  /** Markdown 回答，已经剥掉了 `:::action` 块 */
  answer: string;
  reasoning: string;
  /** 回答里真正提到的卡片，用于在界面上回链 */
  cited: KnowledgeCard[];
  /** 模型提议要改的东西。空数组表示这一轮只回答不动手 */
  actions: AskAction[];
  /**
   * 模型写了 action 块但校验没过的条数。
   * 界面上要如实提示 —— 静默丢掉会让用户以为「它没有权限」。
   */
  rejected: number;
  /** 这一轮实际用了哪些网络资料 */
  web: WebHit[];
  /**
   * 回答是不是被输出上限截断了。
   *
   * `requestChat` 只在正文**为空**时报截断；正文有内容但撞了上限时它照常返回，
   * 于是半截回答会被当成完整回答显示出来 —— 用户看到一句没说完的话，
   * 完全不知道是模型的问题，会以为「它就这水平」。必须如实标出来。
   */
  truncated: boolean;
  /** 实际读了几张卡 */
  scanned: number;
  /** 候选卡总数 */
  total: number;
}

function cleanAnswer(raw: string) {
  let text = raw.trim();
  const fenced = text.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i);
  if (fenced) text = fenced[1].trim();
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 历史轮数收敛：**保住第 1 轮**（卡片清单在它的 user 消息里），
 * 其余只留最近几轮。超出部分不是被删，只是这一轮不再发给模型。
 */
export function trimTurns(turns: AskTurn[]): AskTurn[] {
  if (turns.length <= MAX_HISTORY_TURNS) return turns;
  const keep = MAX_HISTORY_TURNS - 1;
  return [turns[0], ...turns.slice(turns.length - keep)];
}

/**
 * 拼多轮消息。
 *
 * 抽成独立导出函数是为了能直接跑断言 —— 「第 N 轮到底有没有把前几轮带上」
 * 这种问题靠肉眼读代码很容易看漏，而它正是 v0.6.5 之前每次提问都像新开一轮的根因。
 *
 * - system 只放规则
 * - 第一条 user = 卡片清单 + 第一个问题（资料只出现一次，不每轮重发）
 * - 之后每轮是干净的 user / assistant 对
 * - 网络资料只挂在当前这一轮（每次搜的东西不一样，不能混进历史）
 * - 超过 10 轮时由 `trimTurns` 收敛，第 1 轮永远保留
 */
export function buildAskMessages(input: {
  question: string;
  picked: KnowledgeCard[];
  web: WebHit[];
  turns: AskTurn[];
}): ChatMessage[] {
  const { question, picked, web } = input;
  const turns = trimTurns(input.turns);
  const cardText = ['【知识库卡片】', ...picked.map(cardBlock)].join('\n\n');

  const current: string[] = [];
  if (web.length) {
    current.push('【网络资料】');
    web.forEach((hit, i) => {
      const summary =
        hit.summary.length > WEB_CLIP ? `${hit.summary.slice(0, WEB_CLIP)}…` : hit.summary;
      current.push(`[W${i + 1}] ${hit.title} — ${hit.url}`, summary, '');
    });
  }
  current.push(`【问题】${question.trim()}`);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildPrompt({ web: web.length > 0, history: turns.length > 0 }),
    },
  ];

  const clipAnswer = (text: string) => {
    const t = text.trim();
    return t.length > HISTORY_CLIP ? `${t.slice(0, HISTORY_CLIP)}…` : t;
  };

  if (turns.length) {
    const [first, ...rest] = turns;
    messages.push({ role: 'user', content: `${cardText}\n\n【问题】${first.question.trim()}` });
    messages.push({ role: 'assistant', content: clipAnswer(first.answer) });
    for (const t of rest) {
      messages.push({ role: 'user', content: `【问题】${t.question.trim()}` });
      messages.push({ role: 'assistant', content: clipAnswer(t.answer) });
    }
    messages.push({ role: 'user', content: current.join('\n') });
  } else {
    messages.push({ role: 'user', content: `${cardText}\n\n${current.join('\n')}` });
  }

  return messages;
}

export async function askKnowledge(options: AskOptions): Promise<AskOutcome> {
  const { question, cards, config, topics = [], web = [], turns = [], onProgress } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  if (!question.trim()) throw new AiError('format', '先写个问题');
  if (!cards.length) throw new AiError('format', '这个范围里还没有卡片，先去整理点东西');

  const ranked = rankCards(question, cards);
  const picked = packCards(ranked);
  if (!picked.length) throw new AiError('format', '卡片原文太长，装不进上下文，先整理一下知识库');

  const messages = buildAskMessages({ question, picked, web, turns });

  // 回答是给人读的 Markdown，绝不能开 json_object
  const outcome = await requestChat(config, messages, onProgress, {
    json: false,
    maxTokens: MAX_TOKENS,
  });

  const parsed = parseAskActions(cleanAnswer(outcome.content), {
    topics,
    cardIds: options.contextCardIds ?? cards.map((c) => c.id),
  });
  const { text, actions, rejected } = parsed;

  if (!text && !actions.length) throw new AiError('format', '模型没有返回内容，再问一次');

  // 引用靠标题字面命中反查 —— 比让模型输出编号再解析稳得多
  const cited = picked.filter((c) => text.includes(c.title));

  return {
    answer:
      text ||
      (rejected
        ? '（这一轮的改动建议里，主题名或卡片 id 跟知识库对不上，已经丢掉。可以让它按清单里的原名重给一次。）'
        : '（这一轮只给了改法，没有正文。勾选下面的建议就可以执行。）'),
    reasoning: outcome.reasoning,
    cited,
    actions,
    rejected,
    truncated: outcome.finishReason === 'length',
    web,
    scanned: picked.length,
    total: cards.length,
  };
}
