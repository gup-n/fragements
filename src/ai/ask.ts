/**
 * 知识库问答：拿卡片当唯一事实来源回答用户的问题。
 *
 * 这里没有向量检索，用的是**关键词打分 + 预算装填**：
 * 卡片数量是几百张的量级，把提问里的词和卡片文本做字面匹配，
 * 命中标题/主题的加权更高，取分高的塞进上下文，剩下的预算按时间补齐。
 * 不够聪明，但零成本、结果可解释，也不会因为一次问答就多花几千 token。
 */
import type { AiConfig, KnowledgeCard } from '../types';
import { AiError, requestChat, type ChatProgress } from './chat';

/** 上下文预算（字符）。卡片原文很长，必须给上限 */
const CARD_BUDGET = 26_000;
/** 单张卡最多带多少字原文 */
const PER_CARD_CLIP = 1200;
const MAX_TOKENS = 2000;

const SYSTEM_PROMPT = [
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
].join('\n');

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
    const gist = card.gist.toLowerCase();
    const body = card.body.toLowerCase();

    let score = 0;
    for (const w of words) {
      score += count(title, w) * 8;
      score += count(topic, w) * 4;
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
    `【${card.topic}｜${card.title}】`,
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

export interface AskOptions {
  question: string;
  /** 候选卡片。主题内提问就只传该主题的卡 */
  cards: KnowledgeCard[];
  config: AiConfig;
  onProgress?: (patch: ChatProgress) => void;
}

export interface AskOutcome {
  /** Markdown 回答 */
  answer: string;
  reasoning: string;
  /** 回答里真正提到的卡片，用于在界面上回链 */
  cited: KnowledgeCard[];
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
  const { question, cards, config, onProgress } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  if (!question.trim()) throw new AiError('format', '先写个问题');
  if (!cards.length) throw new AiError('format', '这个范围里还没有卡片，先去整理点东西');

  const ranked = rankCards(question, cards);
  const picked = packCards(ranked);
  if (!picked.length) throw new AiError('format', '卡片原文太长，装不进上下文，先整理一下知识库');

  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    {
      role: 'user' as const,
      content: [`【问题】${question.trim()}`, '', '【知识库卡片】', ...picked.map(cardBlock)].join(
        '\n',
      ),
    },
  ];

  // 回答是给人读的 Markdown，绝不能开 json_object
  const outcome = await requestChat(config, messages, onProgress, {
    json: false,
    maxTokens: MAX_TOKENS,
  });

  const answer = cleanAnswer(outcome.content);
  if (!answer) throw new AiError('format', '模型没有返回内容，再问一次');

  // 引用靠标题字面命中反查 —— 比让模型输出编号再解析稳得多
  const cited = picked.filter((c) => answer.includes(c.title));

  return {
    answer,
    reasoning: outcome.reasoning,
    cited,
    scanned: picked.length,
    total: cards.length,
  };
}
