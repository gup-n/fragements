import type { Fragment, TagStat, Todo } from '../types';
import { dayKey, formatTime, todayISO, weekdayCN } from '../util/date';

/**
 * v0.7 的整理 prompt：一次只处理一批，输出**六类 + 一句摘要**。
 *
 * 和 v0.6 最大的不同是**没有知识卡/主题**了。那套结构的问题（主题等于一个
 * 免费新建的字符串、卡片没有唯一约束、合并只能靠猜）不是改 prompt 能修的，
 * 详见 SPEC 0.1。现在模型的职责窄了很多，反而更容易稳定。
 *
 * `batch_summary` 是这一版的关键：模型看不到别的批次，全靠这句摘要接力，
 * 才不会再抽一遍上一批已经抽过的待办、或者给同一个事项起第二种写法。
 */
export const SYSTEM_PROMPT = `你是一个个人碎片笔记整理助手。用户平时把随手想到的事记成一条条碎片，你要**一批一批**地处理它们：给每条打标签、抽出真正要做的事、把重复的碎片折叠起来、把已经做完或不该存在的待办清理掉。

你每次只能看到一小批碎片，看不到别的批次。所以你要认真写 \`batch_summary\`，它是下一批唯一的交接信息。

【输出格式】
只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块。结构如下：

{
  "tags":         [{"id": 1, "labels": ["工作", "报销"], "project": "报销单"}],
  "todos":        [{"text": "提交报销单", "due": "2026-10-21", "id": 1}],
  "merge":        [{"keep_id": 3, "drop_ids": [5], "reason": "同一件事"}],
  "todo_done":    [{"todo_id": 2, "reason": "碎片里说了已经交了"}],
  "drop_todos":   [{"todo_id": 6, "reason": "从纯感想里误抽的，不是真事"}],
  "merge_todos":  [{"keep_id": 6, "drop_ids": [9, 14], "text": null, "reason": "三条说的是同一件事"}],
  "batch_summary": "这批主要是 NAS 换盘和报销，新建标签「装机」，抽了 3 条待办，并了 2 条重复待办。"
}

七个字段都必须出现。没有内容的用空数组，\`batch_summary\` 必须有内容。

【tags】为每一条碎片打 1-3 个标签。
- 标签要短，**2-4 个字**，中文，不要带 # 号。
- **必须先看【已有标签】再决定**：意思能对上的一律沿用已有写法，一个字符都不要改。已有「NAS」就不要新建「群晖」；已有「工作」就不要新建「职场」「上班」。
- 只有确实没有一个已有标签能概括这条碎片时，才新建。新建的标签在确认页会被单独标出来让用户审，"多造一个近义词"就是给用户添麻烦。
- 拿不准归到哪一类时，用最宽的那个已有标签（比如「想法」「生活」），不要为此新开一个。
- \`project\` 是这条碎片属于哪个具体事项（如「报销」「NAS 换盘」「搬家」），看不出明确事项就填 null。同一个事项在不同碎片里必须用**完全一样**的写法。
- **每一条碎片都必须出现在 tags 里，一条都不能漏。**

【todos】只抽取真正"还需要去做"的事。
- 纯感想、纯记录、已经做完的、别人的事、纯事实，都不要抽。
- \`text\` 用动词开头，不超过 20 字，写清楚做什么。
- \`due\` 只在碎片里**明确写了**日期或期限时才填，格式 YYYY-MM-DD；推断不出来就填 null，**绝对不要编造日期**。
- \`id\` 填这条待办来自哪条碎片，必须是本批碎片的 id。
- **先对照【已完成待办】**：那件事已经办完了，就不要再抽一条新的出来，哪怕是换个说法。
- **再对照【本轮已抽出的待办】**：同一个意思不要抽第二遍。这一批前面已经抽了「交报销单」，就不要再来一条「把报销单提交了」。

【merge】只标记**本批碎片里**"确实是同一件事、可以合并"的。
- \`keep_id\` 选信息最全的那条，\`drop_ids\` 是其余几条。
- 宁可少标，不要错标：只是话题相近（都在讲 NAS）但内容不同的，不要合并。
- 没有就返回空数组。

【todo_done】用来标记"用户已经做完"的已有待办。
- 只有当本批碎片**明确写了**某件事已经完成（"报销单交了""盘换好了"），并且【未完成待办】里确实有对应那条时，才输出。
- \`todo_id\` 必须来自【未完成待办】。
- 拿不准就不要输出。误标完成会让用户真的漏掉这件事。

【drop_todos】用来删掉不该存在的待办。
- **每一批都要主动扫一遍【未完成待办】清单本身**，不只看本批碎片。清单攒久了必然有重复项和误抽项。
- 只针对三种情况：说的不是真事（当初从纯感想里误抽的）、已经被别的事实质取代、**重复且没什么信息量的那条**。
- 如果几条重复项各自都带了信息（一条说了时间、一条说了对象），不要用 drop_todos，用 merge_todos。
- **已经做完的不要用 drop_todos**，那要用 todo_done，两者含义完全不同。
- 这是真删除，不可撤销。拿不准就保留。
- 没有就返回空数组。

【merge_todos】用来把几条说同一件事的待办并成一条。
- \`keep_id\` 选信息最全的那条；\`drop_ids\` 是被并进去的其余几条，至少一条。
- 几条各说了半句、需要拼起来才完整时，把拼好的完整文案填进 \`text\`（不超过 20 字）；只靠 keep 那条就够清楚时 \`text\` 填 null。
- 和 drop_todos 互斥：同一条待办不能既被删又被并。
- 没有就返回空数组。

【batch_summary】一句话，**不超过 60 字**。
- 写清"这批做了什么、下一批要注意什么"：处理了什么主题、新建了哪些标签、抽了哪几件事、并掉/删掉了哪些待办。
- 它会和以后各批的摘要一起交给下一批当上下文，所以只写有交接价值的东西。**不要复述碎片原文**，不要写"本批共 40 条"这种废话。

【硬性约束】
- 所有 id 必须来自用户给的列表，不许新造 id。
- 不许编造用户没说过的事实、人名、数字、日期。
- 内容无意义的碎片（单个字符、纯表情）可以不抽 todo，但仍然要给它 tag。
- 标了（已整理）的碎片是以前整理过的。重新整理它们时以现在的判断为准，不要因为"已经整理过"就放过明显的问题。
- **这是很多批中的一批**：不要替别的批做决定，也不要因为"清单里没看到"就认为那件事不存在。
- 只输出 JSON，不要解释你在做什么。`;

/** 一批交给模型的全部上下文 */
export interface BatchContentOptions {
  fragments: Fragment[];
  /** 全量标签表（名字 + 使用次数），让模型优先复用 */
  existingTags: TagStat[];
  /** 现有待办，含已完成 —— 已完成的必须让模型看见，否则会重复抽 */
  todos: Todo[];
  /** 本轮之前已经抽出来的新待办文案 */
  plannedTodos: string[];
  /** 前几批的摘要，代码已裁到 1,500 字 */
  summaries: string;
  /** 第几批（从 1 开始） */
  round: number;
  /** 一共几批 */
  total: number;
  /** all 模式：会把旧标签一并展示，让模型知道"哪里变了" */
  refactor: boolean;
}

/**
 * 清单上限。
 *
 * 标签表给全量（最多 80 个）—— 模型的"复用"完全依赖看得见已有写法，
 * 只给前 20 个，它就会给长尾标签再造一堆同义词，而这正是 v0.6 裂开的原因。
 * 待办同理：只给前 20 条时，清单里那几十条重复项它根本发现不了。
 */
const TAG_LIMIT = 80;
const OPEN_TODO_LIMIT = 60;
const DONE_TODO_LIMIT = 30;
const PLANNED_TODO_LIMIT = 40;

export function buildUserContent(options: BatchContentOptions): string {
  const {
    fragments,
    existingTags,
    todos,
    plannedTodos,
    summaries,
    round,
    total,
    refactor,
  } = options;

  const sorted = [...fragments].sort((a, b) => a.createdAt - b.createdAt);
  const out: string[] = [
    `今天是 ${todayISO()} ${weekdayCN(new Date())}。`,
    `这是**第 ${round} / ${total} 批**，本批 ${sorted.length} 条碎片。以下是待整理的碎片：`,
  ];

  if (refactor) {
    out.push(
      '（这是一次**重新整理**：这些碎片以前整理过。请独立判断一遍，不要因为标签已经存在就照抄；带【旧标签】的以现在的判断为准。）',
    );
  }

  let lastDay = '';
  for (const f of sorted) {
    const key = dayKey(f.createdAt);
    if (key !== lastDay) {
      out.push(`\n日期：${key} ${weekdayCN(new Date(f.createdAt))}`);
      lastDay = key;
    }
    const text = f.content.replace(/\s+/g, ' ').trim();
    let suffix = '';
    if (f.status !== 'inbox') {
      const old = [
        f.tags.length ? `旧标签：${f.tags.join('、')}` : '旧标签：无',
        f.project ? `旧事项：${f.project}` : null,
      ]
        .filter(Boolean)
        .join('｜');
      suffix = refactor ? `（已整理｜${old}）` : '（已整理）';
    }
    out.push(`[${f.id}] ${formatTime(f.createdAt)} ${text}${suffix}`);
  }

  out.push('');
  if (existingTags.length) {
    const shown = existingTags.slice(0, TAG_LIMIT);
    const more = existingTags.length > shown.length ? `……另有 ${existingTags.length - shown.length} 个` : '';
    out.push('【已有标签】（能对上就用这里的写法，不要造近义词；括号里是已用次数）');
    out.push(shown.map((t) => `${t.name}(${t.count})`).join(' / ') + more);
  } else {
    out.push('【已有标签】暂无。这一批会建出第一批标签，尽量用通用词（工作、生活、设备、财务、健康、学习、人际、想法）。');
  }

  out.push('');
  const open = todos.filter((t) => !t.done);
  if (open.length) {
    out.push('【未完成待办】（某条做完了用 todo_done；重复的用 merge_todos；不该存在的用 drop_todos）');
    for (const t of open.slice(0, OPEN_TODO_LIMIT)) {
      out.push(`[${t.id}] ${t.text}${t.dueAt ? ` · ${t.dueAt}` : ''}`);
    }
  } else {
    out.push('【未完成待办】暂无');
  }

  out.push('');
  const done = todos.filter((t) => t.done);
  if (done.length) {
    out.push('【已完成待办】（这些事已经办完了，**不要**再为它们抽新的待办）');
    for (const t of done.slice(0, DONE_TODO_LIMIT)) {
      out.push(`[${t.id}] ✓ ${t.text}`);
    }
  } else {
    out.push('【已完成待办】暂无');
  }

  // 前面几批抽出来的待办还没写库，模型在【未完成待办】里看不到它们。
  // 不给这份清单，同一件事会被每一批各抽一遍，确认页就会冒出七八条一模一样的待办。
  if (plannedTodos.length) {
    out.push('');
    out.push('【本轮已抽出的待办】（前面几批刚抽的，还没写库。不要再抽同样的，也不要对它们提 todo_done）');
    for (const text of plannedTodos.slice(0, PLANNED_TODO_LIMIT)) out.push(`- ${text}`);
  }

  if (summaries.trim()) {
    out.push('');
    out.push('【前几批做了什么】（只是交接信息，不是待办来源；不要据此补抽别批的碎片）');
    out.push(summaries.trim());
  }

  return out.join('\n');
}
