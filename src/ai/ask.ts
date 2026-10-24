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
 * - `history`：用户手动带进来的更早问答。只当对话上下文，不当事实
 * - 操作提案（`:::action` 块）：模型只能建议，由界面勾选后执行
 */
import type { AiConfig, AskAction, KnowledgeCard, WebHit } from '../types';
import { parseAskActions } from '../util/askActions';
import { AiError, requestChat, type ChatProgress } from './chat';

/** 上下文预算（字符）。卡片原文很长，必须给上限 */
const CARD_BUDGET = 26_000;
/** 单张卡最多带多少字原文 */
const PER_CARD_CLIP = 1200;
/** 带进来的历史回答最多保留多少字 —— 只是用来理解指代，不需要全文 */
const HISTORY_CLIP = 700;
/** 一条网络资料最多进多少字。官方 summary 本身就是 600–800 字 */
const WEB_CLIP = 700;
/** 回答上限。带 action 块时会更长一些 */
const MAX_TOKENS = 2800;

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
  '【这次带了他更早的问答】',
  '8. 下面有【更早的问答】，那是他之前的提问记录，只用来理解指代和上下文（比如「那它呢」指什么）。',
  '   它不是事实来源：里面的结论都要重新用卡片核对，卡片里没有就照实说没有。',
];

const ACTION_RULES = [
  '',
  '【你可以提议改知识库，但不能直接改】',
  '只有当用户**明确要求**你动知识库（合并主题、给主题改名、归档旧卡、重写某张卡）时，',
  '才在回答的最末尾追加一段（要多办几件事就写多段）：',
  '',
  ':::action',
  '{"kind":"merge_topics","from":["工具","资讯"],"to":"AI 与工具","reason":"两张卡都在讲 AI"}',
  ':::',
  '',
  '支持的 kind：',
  '- merge_topics　{"from":[至少两个已存在的主题],"to":"合并后的名字"}',
  '- rename_topic　{"from":"已存在的主题","to":"新名字"}',
  '- archive_cards　{"ids":[已存在的卡片 id]}　只归档被新结论**完全取代**的旧卡',
  '- update_card　{"id":卡片 id,"topic":"新主题","subtopic":"新方向","title":"新标题","gist":"新要点"}',
  '  只写要改的字段；"subtopic": null 表示取消小方向',
  '',
  '硬规则：',
  '9. 用户只是在提问，就不要输出 action。宁可只回答。',
  '10. 主题名、卡片 id 必须**逐字**来自下面的清单，不要自己编，也不要改一个字。',
  '11. action 块外面照常用一两句话说明你打算怎么改，让人看懂之后再决定勾不勾。',
  '12. action 块里的 JSON 必须单行、合法，不要加注释，不要用 Markdown 代码围栏。',
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

/** 手动带进上下文的一条更早问答 */
export interface AskHistoryItem {
  question: string;
  answer: string;
}

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
  /** 用户手动勾选的更早问答，默认不带 */
  history?: AskHistoryItem[];
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
  /** 这一轮实际用了哪些网络资料 */
  web: WebHit[];
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

export async function askKnowledge(options: AskOptions): Promise<AskOutcome> {
  const { question, cards, config, topics = [], web = [], history = [], onProgress } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  if (!question.trim()) throw new AiError('format', '先写个问题');
  if (!cards.length) throw new AiError('format', '这个范围里还没有卡片，先去整理点东西');

  const ranked = rankCards(question, cards);
  const picked = packCards(ranked);
  if (!picked.length) throw new AiError('format', '卡片原文太长，装不进上下文，先整理一下知识库');

  const parts: string[] = [];

  if (history.length) {
    parts.push('【更早的问答】');
    for (const h of history) {
      parts.push(`Q：${h.question.trim()}`);
      const answer =
        h.answer.length > HISTORY_CLIP ? `${h.answer.slice(0, HISTORY_CLIP)}…` : h.answer;
      parts.push(`A：${answer.trim()}`);
      parts.push('');
    }
  }

  parts.push(`【问题】${question.trim()}`, '', '【知识库卡片】');
  for (const card of picked) parts.push(cardBlock(card));

  if (web.length) {
    parts.push('', '【网络资料】');
    web.forEach((hit, i) => {
      const summary = hit.summary.length > WEB_CLIP ? `${hit.summary.slice(0, WEB_CLIP)}…` : hit.summary;
      parts.push(`[W${i + 1}] ${hit.title} — ${hit.url}`, summary, '');
    });
  }

  const messages = [
    { role: 'system' as const, content: buildPrompt({ web: web.length > 0, history: history.length > 0 }) },
    { role: 'user' as const, content: parts.join('\n') },
  ];

  // 回答是给人读的 Markdown，绝不能开 json_object
  const outcome = await requestChat(config, messages, onProgress, {
    json: false,
    maxTokens: MAX_TOKENS,
  });

  const { text, actions } = parseAskActions(cleanAnswer(outcome.content), {
    topics,
    cardIds: options.contextCardIds ?? cards.map((c) => c.id),
  });

  if (!text && !actions.length) throw new AiError('format', '模型没有返回内容，再问一次');

  // 引用靠标题字面命中反查 —— 比让模型输出编号再解析稳得多
  const cited = picked.filter((c) => text.includes(c.title));

  return {
    answer: text || '（这一轮只给了改法，没有正文。勾选下面的建议就可以执行。）',
    reasoning: outcome.reasoning,
    cited,
    actions,
    web,
    scanned: picked.length,
    total: cards.length,
  };
}
