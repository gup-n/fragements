/**
 * 「问」的一次问答：本地检索 → 装填预算 → 调模型 → 解析引用。
 *
 * 为什么不做 RAG/向量检索：手机端跑 embedding 要么联网、要么背一个几十 MB 的模型，
 * 都不划算；个人笔记这个量级（几千条）用 FTS5 + 时间/标签意图足够。
 * 详细取舍见 SPEC 0.4 / 0.7。
 *
 * 三条纪律：
 * - **只给模型筛过的资料**。不是「把全库丢进去」—— 上一版就栽在这，
 *   问题一具体，上下文里全是无关卡片，模型反而更容易答偏。
 * - **网络资料和本地记录必须分开标**。混在一起，模型会把网页内容说成
 *   「你记过」的事，这比答错更难发现。
 * - **检索失败不阻断回答**：本地没检索到就直说没有；联网失败只提示失败，不影响本地部分。
 */
import type {
  AiConfig,
  Fragment,
  Note,
  QaCitation,
  QaOutcome,
  QaTurn,
  Todo,
  WebHit,
} from '../types';
import { dayKey, formatTime, monthStart, weekStart } from '../util/date';
import { tokenizeText } from '../util/tokenize';
import { repo } from '../db/repo';
import { AiError, requestChat, type ChatMessage, type ChatProgress } from './chat';
import { searchWeb } from './search';

/** 装填上限。碎片条数少了答不全，多了稀释重点 */
const MAX_FRAGMENTS = 18;
/** 单条碎片进上下文最多多少字。超长的在末尾标明截断 */
const PER_FRAGMENT_CHARS = 1_200;
/** 碎片总预算。18 条 × 1200 是上限，实际按相关度先到先得 */
const FRAGMENT_BUDGET = 36_000;
/** 小结最多几篇；小结本身很短，不需要占太多 */
const MAX_NOTES = 6;
const OPEN_TODO_LIMIT = 40;
const DONE_TODO_LIMIT = 20;
const MAX_TURNS = 8;

function isMerged(f: Fragment) {
  return f.mergedInto !== null;
}

/**
 * 从问题里认出时间意图。认不出返回 null。
 *
 * 只做「今天/昨天/上周」这类明确说法，不做自然语言理解 ——
 * 猜错了会把一段无关的时间段塞进上下文，比不识别更糟。
 */
function timeRange(question: string, now = Date.now()): { from: number; to: number } | null {
  const DAY = 86_400_000;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();

  const ago = question.match(/(?:最近|近|过去)\s*(\d{1,3})\s*天/);
  if (ago) {
    const n = Math.min(365, Math.max(1, Number(ago[1])));
    return { from: now - n * DAY, to: now + 1 };
  }
  if (/今天|今日/.test(question)) return { from: t0, to: now + 1 };
  if (/昨天|昨日/.test(question)) return { from: t0 - DAY, to: t0 };
  if (/前天/.test(question)) return { from: t0 - 2 * DAY, to: t0 - DAY };
  if (/本周|这周|这个星期|这星期/.test(question)) return { from: weekStart(now), to: now + 1 };
  if (/上周|上个星期|上星期/.test(question)) {
    const start = weekStart(now) - 7 * DAY;
    return { from: start, to: start + 7 * DAY };
  }
  if (/本月|这个月/.test(question)) return { from: monthStart(now), to: now + 1 };
  if (/上月|上个月/.test(question)) {
    const start = monthStart(monthStart(now) - DAY);
    return { from: start, to: monthStart(now) };
  }
  return null;
}

export interface Retrieval {
  fragments: Fragment[];
  notes: Note[];
  todos: Todo[];
  /** 命中过多少条（去重前），用来如实报「查了几条」 */
  scanned: number;
  /** 认出了哪个时间范围，界面上可以提一句 */
  range: { from: number; to: number } | null;
}

/**
 * 本地检索：全文 + 时间意图 + 标签意图 + 上一轮引用，四路并起来再按预算装填。
 *
 * 顺序就是优先级：FTS 命中的排前面，其余按时间倒序补进去。
 */
export async function retrieveLocal(
  question: string,
  turns: QaTurn[] = [],
  contextIds: number[] = [],
): Promise<Retrieval> {
  const picked: Fragment[] = [];
  const seen = new Set<number>();
  const push = (list: Fragment[]) => {
    for (const f of list) {
      if (seen.has(f.id) || isMerged(f)) continue;
      seen.add(f.id);
      picked.push(f);
    }
  };

  // 从某条碎片左滑进来时，它是这一场的起点：先放它，再让检索补其余资料。
  // 不放进「上一轮引用」里，是因为它可能和问题毫无字面重叠，FTS 根本搜不到。
  if (contextIds.length) {
    try {
      // 这里不走 push：用户是**明确指着这一条**进来的，
      // 即使它被合并过（merged_into 非空）也该让模型看到，否则「就这条」会答成没有。
      for (const f of await repo.listFragmentsByIds(contextIds)) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        picked.push(f);
      }
    } catch {
      /* 取不到就当没有上下文 */
    }
  }

  let scanned = 0;
  try {
    const hits = await repo.searchFragments(question, 40);
    scanned = hits.length;
    push(hits);
  } catch {
    /* 检索失败当作没命中，后面还有时间/标签两条路 */
  }

  const range = timeRange(question);
  if (range) {
    try {
      push(await repo.listFragmentsBetween(range.from, range.to));
    } catch {
      /* 同上 */
    }
  }

  // 标签意图：问题里出现了某个已有标签名，就把那个标签下的记录并进来。
  // 只在标签名足够长（≥2 字）时才算，避免「工作」这种词在无关问题里误命中
  try {
    const tags = await repo.listTags();
    const mentioned = tags
      .filter((t) => t.name.length >= 2 && question.includes(t.name))
      .slice(0, 2);
    for (const t of mentioned) push(await repo.listFragmentsByTag(t.name, 20));
  } catch {
    /* 同上 */
  }

  // 上一轮引用过的碎片带进来，否则「那第二条呢」接不上
  const prevIds = turns.flatMap((t) => t.sourceIds).slice(-12);
  if (prevIds.length) {
    try {
      push(await repo.listFragmentsByIds(prevIds));
    } catch {
      /* 同上 */
    }
  }

  // 时间意图命中的那条池子是按时间正序来的，这里整体按时间倒序兜一遍，
  // 让「最近的事」更容易进预算（FTS 命中的已经在前面，不受影响）
  const fragments: Fragment[] = [];
  let chars = 0;
  for (const f of picked) {
    if (fragments.length >= MAX_FRAGMENTS) break;
    const cost = Math.min(f.content.length, PER_FRAGMENT_CHARS);
    if (fragments.length && chars + cost > FRAGMENT_BUDGET) break;
    fragments.push(f);
    chars += cost;
  }

  // 小结：按问题 token 命中数打分，取前几篇。没有命中就不给 ——
  // 小结是二手总结，没有命中还硬塞，只会让模型用总结替掉原文细节
  const notes: Note[] = [];
  try {
    const words = new Set(tokenizeText(question));
    const all = await repo.listNotes(60);
    const scored = all
      .map((n) => {
        const text = `${n.title ?? ''}${n.bodyMd}`;
        let score = 0;
        for (const w of tokenizeText(text)) if (words.has(w)) score++;
        return { n, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.n.createdAt - a.n.createdAt);
    for (const x of scored.slice(0, MAX_NOTES)) notes.push(x.n);
  } catch {
    /* 小结读不到不影响回答 */
  }

  let todos: Todo[] = [];
  try {
    const all = await repo.listTodos();
    const open = all.filter((t) => !t.done);
    const done = all
      .filter((t) => t.done)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, DONE_TODO_LIMIT);
    todos = [...open.slice(0, OPEN_TODO_LIMIT), ...done];
  } catch {
    /* 同上 */
  }

  return { fragments, notes, todos, scanned, range };
}

function clip(text: string, max: number) {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 把装填好的资料拼成一段可读的上下文 */
export function buildMaterials(r: Retrieval, web: WebHit[]): string {
  const out: string[] = [];

  out.push('【你的记录 · 碎片原文】');
  if (r.fragments.length) {
    out.push('（引用某条时写 [F编号]，编号就是方括号里的数字）');
    for (const f of r.fragments) {
      const tags = f.tags.length ? ` #${f.tags.join(' #')}` : '';
      const project = f.project ? ` · ${f.project}` : '';
      out.push(`[F${f.id}] ${dayKey(f.createdAt)} ${formatTime(f.createdAt)}${tags}${project}`);
      out.push(clip(f.content, PER_FRAGMENT_CHARS));
      out.push('');
    }
  } else {
    out.push('（这次没有检索到相关碎片）');
  }

  if (r.notes.length) {
    out.push('【你的记录 · 周期小结】');
    out.push('（引用写 [N编号]。小结是你自己过去写过的总结，细节以碎片原文为准）');
    for (const n of r.notes) {
      out.push(`[N${n.id}] ${dayKey(n.createdAt)} ${n.type === 'daily' ? '日' : n.type === 'weekly' ? '周' : '月'}小结`);
      out.push(clip(n.bodyMd, 1_500));
      out.push('');
    }
  }

  if (r.todos.length) {
    out.push('【你的记录 · 待办】');
    out.push('（引用写 [T编号]。）');
    for (const t of r.todos) {
      const due = t.dueAt ? ` 截止 ${t.dueAt}` : '';
      out.push(`[T${t.id}] ${t.done ? '✓ ' : ''}${t.text}${due}`);
    }
    out.push('');
  }

  if (web.length) {
    out.push('【网络资料】');
    out.push('（**这些不是你记过的东西**，来自网页，引用时必须写 [W编号]。');
    out.push('  和你的记录冲突时，先说明「你的记录里是…，网上有说法是…」，不要把两者混成一句。）');
    for (let i = 0; i < web.length; i++) {
      const h = web[i];
      out.push(`[W${i + 1}] ${h.title}`);
      out.push(`链接：${h.url}`);
      out.push(clip(h.summary, 800));
      out.push('');
    }
  } else {
    out.push('【网络资料】（这一轮没有联网资料）');
  }

  return out.join('\n').trim();
}

/** 引用正文要保留换行，不能像 clip 那样压成一行 */
function citeBody(text: string, max: number): string {
  const s = text.trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 把回答里真正出现的引用做成可持久化的快照。
 *
 * 为什么连正文一起存：历史会话重开时，当时的检索结果早就没了；
 * 只存 id 的话，点开引用还得再查库，而待办被删、小结被替换之后就查不到了。
 * 存快照的代价是会话 JSON 大一点，换的是「历史就是当时看到的样子」。
 */
function buildCitations(answer: string, r: Retrieval, web: WebHit[]): QaCitation[] {
  const out: QaCitation[] = [];

  for (const f of r.fragments) {
    if (!answer.includes(`[F${f.id}]`)) continue;
    const tags = f.tags.length ? ` · ${f.tags.slice(0, 3).join(' / ')}` : '';
    out.push({
      kind: 'F',
      id: f.id,
      label: `${dayKey(f.createdAt)} ${formatTime(f.createdAt)} · 碎片${tags}`,
      body: citeBody(f.content, 2_000),
    });
  }

  for (const n of r.notes) {
    if (!answer.includes(`[N${n.id}]`)) continue;
    const kind = n.type === 'daily' ? '日小结' : n.type === 'weekly' ? '周总结' : '月总结';
    out.push({
      kind: 'N',
      id: n.id,
      label: `${n.period ? `${n.period} · ` : ''}${kind}`,
      body: citeBody(n.bodyMd, 2_500),
    });
  }

  for (const t of r.todos) {
    if (!answer.includes(`[T${t.id}]`)) continue;
    out.push({
      kind: 'T',
      id: t.id,
      label: t.done ? '待办 · 已完成' : '待办',
      body: `${t.text}${t.dueAt ? `\n截止：${t.dueAt}` : ''}`,
    });
  }

  web.forEach((h, i) => {
    if (!answer.includes(`[W${i + 1}]`)) return;
    out.push({
      kind: 'W',
      id: i + 1,
      label: h.title || h.url,
      body: citeBody(h.summary, 1_200),
      url: h.url,
    });
  });

  return out;
}

const SYSTEM_PROMPT = `你是一个私人记录问答助手。用户把平时的想法、待办、事件随手记成一条条「碎片」存在手机本地。你这次回答的**唯一事实来源**是下面给出的资料。

【怎么答】
1. **先给结论，再给依据**。第一句就要回答「是/不是/怎么做」，不要先铺垫背景。
2. 能引用就引用：用了某条碎片写 \`[F编号]\`，用了小结写 \`[N编号]\`，用了待办写 \`[T编号]\`，用了网页写 \`[W编号]\`。
   编号只能用资料里出现过的，不许自己编。一句话里最多带一个引用，别堆一串。
3. **资料里没有的，就说没有**。用「你的记录里没有这件事」这种直白说法，然后可以说「如果要做，一般是这样」，但必须明确标出那是常识而不是你的记录。
4. **绝不能把网页内容说成用户记过的事**。网页资料只能挂在 [W] 引用下，并且要和本地记录分开描述。
5. 不要凭印象补细节：时间、型号、金额、人名，资料里没写就不写。
6. 用中文，简洁。能三句说清就不要写五句，不要用小标题包装一句结论。
7. 不需要罗列「我查了哪些资料」，也不要复述资料原文。`;

export interface QaOptions {
  question: string;
  /** 之前的问答轮次，用来接「那第二条呢」 */
  turns: QaTurn[];
  config: AiConfig;
  /** 深度思考开关 */
  thinking: boolean;
  /** 联网搜索开关 */
  useWeb: boolean;
  /** 从某条碎片左滑进来时的上下文碎片 id，优先装进资料 */
  contextIds?: number[];
  onProgress?: (patch: ChatProgress) => void;
}

export interface QaRun extends QaOutcome {
  /** 本轮检索到的资料，界面上可以显示「查了 N 条」 */
  retrieval: Retrieval;
}

/**
 * 问一次。
 *
 * 联网和本地检索**并行**：联网慢的时候不用等它才开始读本地，
 * 反过来本地很快时也不该被搜索卡住。
 */
export async function askQuestion(options: QaOptions): Promise<QaRun> {
  const { question, turns, config, thinking, useWeb, contextIds, onProgress } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  const q = question.trim();
  if (!q) throw new AiError('format', '问点什么吧');

  const retrieval = await retrieveLocal(q, turns, contextIds);

  let web: WebHit[] = [];
  let webError: string | null = null;
  if (useWeb) {
    try {
      web = await searchWeb(config, q);
    } catch (e) {
      // 搜索失败不影响本地回答：本地已经检索完了，照常给
      webError = e instanceof Error ? e.message : '联网搜索失败';
    }
  }

  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  // 多轮只带「问题 + 回答」，不带上一轮的资料：
  // 资料每轮重新检索，重复塞进去只会把上下文撑爆，而且会让模型拿旧资料答新问题
  for (const t of turns.slice(-MAX_TURNS)) {
    messages.push({ role: 'user', content: t.question });
    messages.push({ role: 'assistant', content: t.answer });
  }
  messages.push({
    role: 'user',
    content: `${buildMaterials(retrieval, web)}\n\n【问题】${q}`,
  });

  const outcome = await requestChat(
    config,
    messages,
    onProgress,
    // json 必须关：开了以后整篇回答会被塞进一个 JSON 字符串，换行全变 \n
    { json: false, effort: thinking ? 'high' : undefined },
  );

  const answer = outcome.content.trim();
  if (!answer) throw new AiError('format', '模型没有返回内容，再试一次');

  // 只有本轮真的给了资料的编号才算引用，避免模型编一个 [F999] 出来
  const cited = retrieval.fragments.filter((f) => answer.includes(`[F${f.id}]`));
  const citations = buildCitations(answer, retrieval, web);

  return {
    answer,
    reasoning: outcome.reasoning,
    fragments: retrieval.fragments,
    cited,
    citations,
    notes: retrieval.notes,
    todos: retrieval.todos,
    web,
    truncated: outcome.finishReason === 'length',
    webError,
    scanned: retrieval.scanned,
    retrieval,
  };
}
