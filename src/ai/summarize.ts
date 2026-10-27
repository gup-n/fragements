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
 * 固定小节。v0.7 把形态从四节散文压成「一句话 + 短小节」；
 * v0.7.3 保留小节骨架，但把每条改成完整书面句子 ——
 * 原来强制 `- **关键词**：短句`，读起来像 AI 生成的卡片，用户反馈「过于 AI 化」。
 */
const SECTIONS: Record<DigestKind, string[]> = {
  daily: ['## 一句话', '## 做了什么', '## 想明白的', '## 悬着的'],
  weekly: ['## 一句话', '## 主线', '## 推进', '## 结论', '## 悬着的'],
  monthly: ['## 一句话', '## 主线', '## 结果', '## 结论', '## 停下来的'],
};

/** 各粒度的篇幅上限。宁可短，不要注水 */
const LENGTH: Record<DigestKind, string> = {
  daily: '150~250 字',
  weekly: '300~500 字',
  monthly: '500~700 字',
};

/**
 * 小结的系统提示词。
 *
 * v0.7.3 的目标是「别像 AI 卡片」，靠「像本人事后补记的工作日志」+ 一份禁词表压形状。
 * v0.8.1 换了思路：真正让文字发假的不是某几个词，是**句式整齐、每条一样长、
 * 事实和判断混在一起**。所以这一版把规则从「不许写什么」往「怎么写才算说清」挪：
 *
 * - 事实边界补两条：计划不等于已执行、尝试不等于成功；细节不能为简短让路
 * - 文体从「语气要求」改成「组织方式」：先事实后判断、一条一个意思、
 *   句长随内容变、连接词只在确有逻辑时用
 * - 禁止项改名为「避免的表达习惯」，并补上「空泛评价」「把记录逐条改写抄一遍」
 *
 * 结构没动：小节、顺序、字数范围仍由 SECTIONS / LENGTH 控制。
 */
function buildSystemPrompt(kind: DigestKind) {
  const sections = SECTIONS[kind].map((s) => `- \`${s}\``).join('\n');
  return [
    '你是一名严谨的记录整理者。用户把想法、待办、事件随手记进一个叫「碎片」的收件箱，',
    `现在要把${KIND_NAME[kind]}的记录整理成一篇精炼的书面小结。`,
    '',
    '【事实边界】',
    '- 只写材料里出现过的事。不补充背景知识，不推测动机，不给材料之外的建议；没有的信息一律不写。',
    '- 区分事实、判断和计划。计划不代表已经执行，尝试不代表已经成功，尚未确认的结果不能写成确定结论。',
    '- 保留对理解事件有用的细节，如具体对象、关键操作、实际结果和未解决的问题。不要为了简短而删掉影响结论的信息。',
    '',
    '【文体】',
    '- 使用自然、准确的现代汉语书面语。以事实、结果和明确的判断为主，表达简洁、平实、克制，不刻意修饰。',
    '- 使用第一人称「我」，但只在主体明确或有必要时写出。不要每条都以「我」开头，也不要为了统一视角而重复主语。',
    '- 先写具体的事，再写结果或判断。能直接说明做了什么、结果如何，就不先铺垫背景；过程会影响理解时，再交代必要的过程。',
    '- 一条内容集中表达一个主要意思。相关内容可以合并叙述，但不要把不同事项硬拼在一起，也不要反复陈述同一事实。',
    '- 句式和长度根据内容自然变化。简单事项直接陈述，复杂事项交代必要的因果和上下文；不为追求短句而割裂语意，也不为追求完整而扩写。',
    '- 保留材料中有实际意义的个人判断、问题和计划，不额外添加感悟、评价或总结。',
    '- 使用明确的对象和动作。优先写具体设备、文件、任务、操作和结果，少用「相关事项」「有关工作」「进一步推进」等无法提供具体信息的表达。',
    '- 只在确有逻辑关系时使用转折、因果和递进连接词。段落之间按内容组织，不刻意制造承接关系。',
    '- 以信息密度为准：删除重复、空泛的解释和没有实际作用的修饰语，但不要把必要的限定条件、失败原因或未完成状态一并删掉。',
    '',
    '【避免的表达习惯】',
    '- 不写「值得注意的是」「可以看出」「这体现了」「这意味着」等缺乏具体信息的引导句，除非后面的判断确实需要说明。',
    '- 不用「首先／其次／最后」「总的来说」「综上所述」等固定套话组织或收尾。',
    '- 不堆砌「赋能」「抓手」「闭环」「链路」「维度」「颗粒度」等抽象词，也不把简单的事情包装成宏大的结论。',
    '- 不使用空泛的评价，如「取得了显著进展」「效果良好」「意义重大」；需要评价时，写明材料中支持这一评价的具体事实。',
    '- 不为了让文字显得完整而添加开场白、过渡句、感悟或结尾总结。',
    '- 不刻意追求工整的句式、对仗、排比或统一的段落长度。允许不同小节的内容详略不同。',
    '- 不把原始记录逐条换一种说法重新抄写，也不把多条记录简单拼成流水账。',
    '',
    '【格式】',
    '- 只使用 `## ` 小标题和 `- ` 列表；不要表格、代码块、一级标题或嵌套列表。',
    `- 固定使用以下小节，顺序不要改，某节确实没有内容就整节省略：\n${sections}`,
    '- 不要为了凑结构硬写：某节只有一条就写一条，写不出来就省略。',
    '- `## 一句话` 只写一句，不超过 40 字，直接说这段时间最要紧的一件事；不要概括全篇。',
    '- 不写开场白，不写结尾总结段；正文之外不输出任何内容，不要输出 JSON 或思考过程。',
    `- 篇幅：${LENGTH[kind]}。信息密度优先，不铺陈、不注水。`,
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
