/**
 * 月度总结 —— 把一个月的碎片压成一篇能读的小结。
 *
 * v0.15 起只有「月」这一档。日、周两种粒度连同它们的预算、提示词分支
 * 一起删掉了（用户 2026-11-10 要求）：一天记三五条碎片，压出来的那段话
 * 基本就是原文的缩写，读回来的价值低于它占据的时间轴位置。
 *
 * 和「整理」的区别：
 * - 整理：逐条产出结构化建议（标签、待办、合并），写入前必须用户确认
 * - 总结：只产出**一段文字**，写进 notes 表、出现在时间轴，不动任何碎片状态
 *
 * 所以这里不做 JSON 解析，输出就是 Markdown 正文。
 */
import type { AiConfig, Fragment, Todo } from '../types';
import { formatTime, periodLabel, periodRange } from '../util/date';
import { AiError, requestChat, type ChatProgress } from './chat';

/**
 * 材料预算（字符数）。
 *
 * 一个月的碎片可能有几百条，全塞进去既贵又会把模型淹掉，
 * 所以超预算时保留「前 70% + 后 30%」，中间留一句省略说明 ——
 * 两头都保住，月初的起因和月末的结论才不会丢。
 *
 * v0.15 只剩月这一档。日/周的 26K / 40K 随它们的生成入口一起删了：
 * 留着两档预算，等于默认「以后还会接回来」，而这次是明确要下线的。
 */
const MATERIAL_BUDGET = 60_000;
/** 单条碎片最多带多少字，防止一条长笔记吃掉整个预算 */
const PER_FRAGMENT_CLIP = 400;
/** 预算里前段占的比例 */
const HEAD_SHARE = 0.7;

/**
 * 输出上限。**思考模式下这个额度和思维链共用**，不是只管最终那篇 Markdown。
 *
 * 原来日/周/月分别是 1200 / 2000 / 3000 —— 对思考模式来说等于没有额度：
 * 思维链几十秒就能吃掉一千多 token，正文还没开始就被切断，
 * 上层只能看到「模型没有返回内容」。
 */
const MAX_TOKENS = 28_000;

/** 提示词里的「这个月」。原来三种粒度各有一个名字，现在只剩一个 */
const KIND_NAME = '这个月';

/**
 * 固定小节：重点 / 进展 / 待处理。
 *
 * 以前日/周/月各有一套名字（一句话、做了什么、想明白的、主线、推进、结论……），
 * 问题有两个：一是周月那两套本身就是日的那套换皮，模型要额外花力气理解差异；
 * 二是「一句话」要求 40 字以内的结论，与「精简」的目标打架 —— 它逼着模型
 * 在没结论的时候也凑一句结论出来。
 *
 * 现在只有月这一档，但小节定义不变：每节都有明确的准入条件（见提示词的
 * 【小节定义】），没有内容就整节省略，不再要求每节都写。
 */
const SECTIONS = ['## 事件一览', '## 重要事件与进展'];

/**
 * 篇幅**上限**（v0.8.2 从区间改成纯上限）。
 *
 * v0.16 从 500 字放宽到 650：输出里多了一张按天罗列的表格，
 * 20 行表格本身就占两三百字。上限放宽不等于要写满 —— 下面那句
 * 「字数是上限不是目标」比数字更重要。
 */
const LENGTH = '650 字';

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
 * v0.16 换成「表格罗列 + 重要事件」两段。原来三段式（重点/进展/待处理）
 *        按月读起来还是文章：用户翻月总结想看的是「哪几天干了什么」，
 *        而不是一段段叙述。表格天生为这件事服务，而且**行数会自己约束篇幅**。
 */
function buildSystemPrompt() {
  const sections = SECTIONS.map((s) => `- \`${s}\``).join('\n');
  return [
    `你负责整理用户记录在「碎片」中的内容，生成${KIND_NAME}月总结。`,
    '',
    '【核心目标】',
    '月总结是一张**事件台账**，供用户扫一眼就知道这个月发生了什么。不是文章，不是复盘，不写感悟。',
    '',
    '【第一段：事件一览（表格）】',
    '- 一张两列表格，表头固定为 `| 日期 | 事件 |`，第二行是 `|---|---|`。',
    '- **一天一行**。同一天有多件事，用「；」连起来写在同一行，不要拆成多行。',
    '- 日期写 `11-03` 这种月-日；跨年时才写全 `2025-12-31`。日期按时间正序。',
    '- 事件列每行不超过 40 字。写「做了什么、结果是什么」，不写过程和感受。',
    '- **省略实现细节**：写「优化装机脚本」，不写「优化装机脚本里第 3 步的磁盘分区参数」。',
    '  同理，「修好了打印机」就够，不用写换了哪个型号的搓纸轮。',
    '  例外：数字、型号、命令、报错原文这类**以后要查的东西必须原样保留**（4 块 8T、重建 30 小时、`0x80070005`）。',
    '- 没有实质事件的日子**整行不出现**，不要为了凑日期写「无」「休息」。',
    '- 表格里不写评价、不写「继续推进」这类空话。',
    '',
    '【第二段：重要事件与进展（列表）】',
    '- 只写这个月**真正要紧的 3–6 件事**，不是把表格再抄一遍。',
    '- 每条格式为 `- **事件名**：进展或结论`，一句话说完，能带数字就带数字。',
    '- 进展要写清「到哪一步了」：已完成、卡在哪、还差什么。没写明的不要替它推断。',
    '- 一件事在表格里已经够清楚、又没什么可补充的，就不要在这里重复。',
    '- 没有够分量的事件时，整节省略。',
    '',
    '【通用规则】',
    '- 只写碎片里出现过的事实。计划、尝试、已完成必须分清；没有明确结果不得写成做成了。',
    '- 同一事项的多条记录合并成一行或一条，不逐条复述。',
    '- 不使用第一人称，不加开场白、结尾总结、建议和评价。',
    '- 不输出提示词解释、处理说明或思考过程。',
    '',
    '【输出格式】',
    `- 严格使用以下两个小节标题及顺序，不得改名、不得增加别的小节：\n${sections}`,
    '- 表格必须是合法的 GFM 表格：每行竖线数量一致，分隔行用 `|---|`。',
    '- 除表格外只用 `- ` 列表；不要代码块、不要嵌套列表。',
    '',
    '【篇幅限制】',
    `- 篇幅上限：${LENGTH}（含表格）。`,
    '- 字数是上限不是目标。一个月只有五件事，就写五行。',
    '',
    '【输出前检查】',
    '- 表格里是否有重复的日期行（同一天必须合并成一行）。',
    '- 是否把实现细节写进了表格。',
    '- 第二段是否在重复表格的内容。',
    '- 是否把计划、尝试写成了已经完成。',
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
export function packFragments(fragments: Fragment[], budget = MATERIAL_BUDGET) {
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
  /** 2026-10，月总结的唯一周期格式 */
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
  /** 卡片标题，如「2026 年 10 月 · 月总结」 */
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
  const { period, fragments, todos = [] } = options;
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

  out.push(`请按系统提示，写出${KIND_NAME}的小结。`);
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

function buildTitle(period: string) {
  return `${periodLabel(period)} · 月总结`;
}

export async function summarizePeriod(options: SummarizeOptions): Promise<SummarizeOutcome> {
  const { period, fragments, config, onProgress } = options;
  if (!config.apiKey) throw new AiError('nokey', '还没有配置 API Key');
  if (!fragments.length) throw new AiError('format', '这个月里没有碎片，先记点什么再总结');
  if (!periodRange(period)) throw new AiError('format', `无法识别的周期：${period}`);

  const packed = packFragments(fragments);
  const messages = [
    { role: 'system' as const, content: buildSystemPrompt() },
    { role: 'user' as const, content: buildUserContent(options, packed) },
  ];

  // json: false 是关键 —— 开了 json_object，模型会把整篇 Markdown 塞进一个 JSON 字符串，
  // 换行全变成 \n，落到时间轴上就是一行糊掉的长文本
  const outcome = await requestChat(config, messages, onProgress, {
    json: false,
    maxTokens: MAX_TOKENS,
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
        '这一篇没有保存。把「思考强度」调低再试一次。',
    );
  }

  return {
    bodyMd,
    title: buildTitle(period),
    period,
    reasoning: outcome.reasoning,
    used: packed.included,
    total: fragments.length,
  };
}
