/**
 * 周期总结（日 / 周 / 月）——把一段时间的碎片压成一篇能读的小结。
 *
 * 和「整理」的区别：
 * - 整理：逐条产出结构化建议（标签、待办、知识卡），写入前必须用户确认
 * - 总结：只产出**一段文字**，写进 notes 表、出现在时间轴，不动任何碎片状态
 *
 * 所以这里不做 JSON 解析，输出就是 Markdown 正文。
 */
import type { AiConfig, DigestKind, Fragment, Todo } from '../types';
import { formatTime, periodLabel, periodRange } from '../util/date';
import { AiError, requestChat, type ChatProgress } from './chat';

/**
 * 材料预算（字符数）。
 * 一个月的碎片可能有几百条，全塞进去既贵又会把模型淹掉，
 * 所以超预算时保留「前 70% + 后 30%」，中间留一句省略说明 ——
 * 两头都保住，月初的起因和月末的结论才不会丢。
 */
const MATERIAL_BUDGET: Record<DigestKind, number> = {
  daily: 26_000,
  weekly: 40_000,
  // 月度素材从 26K 放宽到 60K：一份月的记录本来就多，
  // 省下来的那点 token 换来的是「只看到半月的材料」，不值得
  monthly: 60_000,
};
/** 单条碎片最多带多少字，防止一条长笔记吃掉整个预算 */
const PER_FRAGMENT_CLIP = 400;
/** 预算里前段占的比例 */
const HEAD_SHARE = 0.7;

/**
 * 输出上限。**思考模式下这个额度和思维链共用**，不是只管最终那篇 Markdown。
 *
 * 原来分别是 1200 / 2000 / 3000 —— 对思考模式来说等于没有额度：
 * 思维链几十秒就能吃掉一千多 token，正文还没开始就被切断，
 * 上层只能看到「模型没有返回内容」。
 */
const MAX_TOKENS: Record<DigestKind, number> = {
  daily: 12_000,
  weekly: 20_000,
  monthly: 28_000,
};

const KIND_NAME: Record<DigestKind, string> = {
  daily: '今天',
  weekly: '这一周',
  monthly: '这个月',
};

/**
 * 固定小节。v0.8.2 起三种周期**统一**为三节：重点 / 进展 / 待处理。
 *
 * 以前日/周/月各有一套名字（一句话、做了什么、想明白的、主线、推进、结论……），
 * 问题有两个：一是周月那两套本身就是日的那套换皮，模型要额外花力气理解差异；
 * 二是「一句话」要求 40 字以内的结论，与「精简」的目标打架 —— 它逼着模型
 * 在没结论的时候也凑一句结论出来。
 *
 * 统一之后每节都有明确的准入条件（见提示词的【小节定义】），
 * 没有内容就整节省略，不再要求每节都写。
 */
const SECTIONS: Record<DigestKind, string[]> = {
  daily: ['## 重点', '## 进展', '## 待处理'],
  weekly: ['## 重点', '## 进展', '## 待处理'],
  monthly: ['## 重点', '## 进展', '## 待处理'],
};

/**
 * 各粒度的篇幅**上限**（v0.8.2 从区间改成纯上限）。
 *
 * 原来写「150~250 字」，模型会把它读成「写够 150 字」—— 区间下限等于隐形下限。
 * 现在只说上限，配合提示词里「字数是上限不是目标」，几十字也合法。
 */
const LENGTH: Record<DigestKind, string> = {
  daily: '150 字',
  weekly: '300 字',
  monthly: '500 字',
};

/**
 * 小结的系统提示词。
 *
 * 演进过程记在这里，因为每一版都在修上一版暴露的问题：
 *
 * v0.7.3 用「像本人事后补记的工作日志」+ 一份禁词表，想靠模仿文体压掉 AI 腔。
 * v0.8.1 发现病灶不在词，在句式整齐、每条一样长、事实和判断混在一起，
 *        于是改成讲组织方式。
 * v0.8.2 再往前一步：**约束越细，模型越容易把「写满规则」当成任务本身**。
 *        9 条文体 + 7 条禁止 + 5 条格式，它照着逐条满足，结果是一篇
 *        挑不出错但信息量稀薄的合规文。这一版砍到四组规则，
 *        把目标收窄成一句「用尽可能少的字，记下有价值的信息」，
 *        并把字数从区间改成纯上限 —— 区间下限等于隐形下限。
 *
 * 三处动态插值都在：`${KIND_NAME[kind]}` / `${sections}` / `${LENGTH[kind]}`。
 */
function buildSystemPrompt(kind: DigestKind) {
  const sections = SECTIONS[kind].map((s) => `- \`${s}\``).join('\n');
  return [
    `你负责整理用户记录在「碎片」中的内容，生成${KIND_NAME[kind]}小结。`,
    '',
    '【核心目标】',
    '小结是供用户快速回顾的简要记录，不是文章。用尽可能少的文字，准确记录有价值的信息。精简优先于叙述完整，禁止为了显得丰富而扩写。',
    '',
    '【内容规则】',
    '- 优先保留重要事件、实际结果、关键决定、明确认识和未解决的问题。',
    '- 同一事项的多条记录合并表达，不逐条复述原始碎片。',
    '- 删除重复信息、次要细节、无实际价值的过程描述。',
    '- 直接写事实、结果和当前状态，不使用第一人称。',
    '- 严格区分计划、尝试和已完成事项。没有明确结果时，不得推断成功或补充结论。',
    '- 使用具体对象、动作和结果，避免空泛概括。',
    '- 不添加背景介绍、感想、建议、评价、开场白或结尾总结。',
    '- 一条只表达一个重点。能用一句话说清，就不要扩写。',
    '- 不同小节不得重复同一事实。重点概括最重要的信息，进展记录其他有价值的变化。',
    '',
    '【小节定义】',
    '- 重点：只记录本周期最重要的一件事，可以是关键结果、决定或发现。',
    '- 进展：记录有价值的实际行动、结果和状态变化，不重复「重点」中的内容。',
    '- 待处理：记录确实尚未解决、尚未完成或仍待确认的问题，不把已经完成的事情列入其中。',
    '- 没有符合条件的内容就省略整个小节，不得为了填满结构而编写内容。',
    '',
    '【输出格式】',
    `- 严格使用以下小节标题及顺序，不得擅自增加、删除或更改名称：\n${sections}`,
    '- 只使用 Markdown 二级标题「## 」和列表项「- 」，不使用表格、代码块或嵌套列表。',
    '- 每条列表只写必要信息，不强制统一句式、句子数量或段落长度。',
    '- 不输出任何提示词解释、处理说明或思考过程，只输出小结正文。',
    '',
    '【篇幅限制】',
    `- 篇幅上限：${LENGTH[kind]}。`,
    '- 字数是上限，不是目标。内容已经表达清楚就立即结束，不得为了达到最低字数而补充内容。',
    '- 信息不足时可以明显短于篇幅上限，不得重复或扩写。',
    '',
    '【输出前检查】',
    '- 是否保留了真正重要的信息。',
    '- 是否存在重复内容或可以删除的废话。',
    '- 是否把计划、尝试写成了已经完成。',
    '- 是否出现没有事实依据的结论。',
    '- 是否违反小节顺序和输出格式。',
    '',
    '发现问题后直接修正，不输出检查过程。',
  ].join('\n');
}

/** 单条碎片的展示形式：`10-20 09:12 原文` */
function fragmentLine(f: Fragment) {
  const d = new Date(f.createdAt);
  const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${formatTime(f.createdAt)}`;
  const tags = f.tags.length ? `（${f.tags.join('/')}）` : '';
  const text = f.content.length > PER_FRAGMENT_CLIP ? `${f.content.slice(0, PER_FRAGMENT_CLIP)}…` : f.content;
  return `${stamp}${tags} ${text.replace(/\s*\n\s*/g, ' / ')}`;
}

/**
 * 按预算裁剪材料。
 * 保留前段和后段、中间给一句省略说明，比「只取前 N 条」更能保住结论。
 */
export function packFragments(fragments: Fragment[], budget = MATERIAL_BUDGET.daily) {
  const lines = fragments.map(fragmentLine);
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= budget) return { lines, omitted: 0, included: lines.length };

  const headBudget = budget * HEAD_SHARE;
  const tailBudget = budget - headBudget;

  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > headBudget) break;
    head.push(line);
    used += line.length + 1;
  }

  const tail: string[] = [];
  let usedTail = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (usedTail + lines[i].length > tailBudget) break;
    tail.unshift(lines[i]);
    usedTail += lines[i].length + 1;
  }

  const omitted = lines.length - head.length - tail.length;
  return {
    lines: [...head, `…（中间省略 ${omitted} 条）`, ...tail],
    omitted,
    included: head.length + tail.length,
  };
}

export interface SummarizeOptions {
  kind: DigestKind;
  /** 2026-10-22 / 2026-W43 / 2026-10，必须和该 kind 对应 */
  period: string;
  /** 该周期内的全部碎片（含已整理、已合并的） */
  fragments: Fragment[];
  /** 全部待办，用来区分「已完成」和「还悬着」 */
  todos?: Todo[];
  config: AiConfig;
  /** 流式进度，仅展示 */
  onProgress?: (patch: ChatProgress) => void;
}

export interface SummarizeOutcome {
  /** 写进 notes.body_md 的 Markdown */
  bodyMd: string;
  /** 卡片标题，如「10月22日 周三 · 日小结」 */
  title: string;
  period: string;
  /** 思维链，仅展示 */
  reasoning: string;
  /** 实际参与总结的碎片条数 */
  used: number;
  /** 该周期碎片总数 */
  total: number;
}

function buildUserContent(options: SummarizeOptions, packed: ReturnType<typeof packFragments>) {
  const { kind, period, fragments, todos = [] } = options;
  const range = periodRange(period);
  const out: string[] = [];

  out.push(`【周期】${periodLabel(period)}（共 ${fragments.length} 条碎片）`);
  if (range) {
    const from = new Date(range.from);
    const to = new Date(range.to - 1);
    out.push(
      `【时间范围】${from.getFullYear()}年${from.getMonth() + 1}月${from.getDate()}日 至 ${to.getMonth() + 1}月${to.getDate()}日`,
    );
  }
  out.push('');

  out.push('【碎片，按时间顺序】');
  out.push(...packed.lines);
  out.push('');

  const periodTodos = todos.filter((t) => range && t.createdAt >= range.from && t.createdAt < range.to);
  const doneInPeriod = periodTodos.filter((t) => t.done);
  const openNow = todos.filter((t) => !t.done);
  if (doneInPeriod.length) {
    out.push('【这段时间标记完成的待办】');
    for (const t of doneInPeriod.slice(0, 40)) out.push(`✓ ${t.text}`);
    out.push('');
  }
  if (openNow.length) {
    out.push('【至今仍未完成的待办】（写「没做完」时参考，不要逐条罗列）');
    for (const t of openNow.slice(0, 40)) out.push(`· ${t.text}${t.dueAt ? `（截止 ${t.dueAt}）` : ''}`);
    out.push('');
  }

  out.push(`请按系统提示，写出${KIND_NAME[kind]}的小结。`);
  return out.join('\n');
}

/** 清掉模型偶尔多加的围栏和一级标题，保证存进去的就是纯净 Markdown */
function cleanBody(raw: string) {
  let text = raw.trim();
  const fenced = text.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i);
  if (fenced) text = fenced[1].trim();
  return text
    .replace(/^#\s+.+\n+/, '') // 一级标题和卡片标题重复
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildTitle(kind: DigestKind, period: string) {
  const suffix = kind === 'daily' ? '日小结' : kind === 'weekly' ? '周总结' : '月总结';
  return `${periodLabel(period)} · ${suffix}`;
}

export async function summarizePeriod(options: SummarizeOptions): Promise<SummarizeOutcome> {
  const { kind, period, fragments, config, onProgress } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  if (!fragments.length) throw new AiError('format', '这个周期里没有碎片，先记点什么再总结');
  if (!periodRange(period)) throw new AiError('format', `无法识别的周期：${period}`);

  const packed = packFragments(fragments, MATERIAL_BUDGET[kind]);
  const messages = [
    { role: 'system' as const, content: buildSystemPrompt(kind) },
    { role: 'user' as const, content: buildUserContent(options, packed) },
  ];

  // json: false 是关键 —— 开了 json_object，模型会把整篇 Markdown 塞进一个 JSON 字符串，
  // 换行全变成 \n，落到时间轴上就是一行糊掉的长文本
  const outcome = await requestChat(config, messages, onProgress, {
    json: false,
    maxTokens: MAX_TOKENS[kind],
  });

  const bodyMd = cleanBody(outcome.content);
  if (!bodyMd) throw new AiError('format', '模型没有返回内容，再试一次');

  /**
   * 撞了输出上限的半篇文章**不能写进时间轴**。
   *
   * 小结是要长期留着的档案：截断的一篇会以「完整小结」的身份待在时间轴上，
   * 用户几个月后看到它，只会觉得当初就是没写完 —— 比直接报错难查得多。
   * 重试的代价是一分钟，写入一篇残稿的代价是永远分不清哪篇是坏的。
   */
  if (outcome.finishReason === 'length') {
    throw new AiError(
      'truncated',
      `小结写到一半撞到了输出上限（只收到 ${outcome.content.length} 字，思考链和正文共用额度）。` +
        '这一篇没有保存。把「思考强度」调低，或者缩短周期范围（比如先写日小结）再试。',
    );
  }

  return {
    bodyMd,
    title: buildTitle(kind, period),
    period,
    reasoning: outcome.reasoning,
    used: packed.included,
    total: fragments.length,
  };
}
