import type { Fragment, KnowledgeCard, Todo } from '../types';
import { dayKey, formatTime, todayISO, weekdayCN } from '../util/date';

export const SYSTEM_PROMPT = `你是一个个人碎片笔记整理助手。用户会把随手记下的碎片按时间顺序给你，你要一次性完成九项工作。

【输出格式】
只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块。结构如下：
{
  "tags":          [{"id": 1, "labels": ["工作"], "project": "报销单"}],
  "todos":         [{"text": "提交报销单", "due": "2026-10-21", "id": 1}],
  "summary":       {"body_md": "……"},
  "merge":         [{"keep_id": 3, "drop_ids": [5], "reason": "同一件事"}],
  "knowledge":     [{"topic": "NAS 维护", "title": "换盘前先确认热备盘位", "gist": "- 先看存储池状态确认降级盘位\\n- 热备盘会自动顶上，别急着拔", "source_ids": [3]}],
  "todo_done":     [{"todo_id": 2, "reason": "碎片里说了已经交了"}],
  "card_update":   [{"card_id": 4, "add_source_ids": [12], "title": null, "gist": null, "reason": "同属 RAID 换盘"}],
  "archive_cards": [{"card_id": 7, "reason": "内容已被新卡完整覆盖"}],
  "drop_todos":    [{"todo_id": 6, "reason": "和另一条重复"}]
}

【tags】为每条碎片给 1-3 个中文标签。标签要短，2-4 个字，优先复用常见类别（工作、生活、设备、财务、健康、学习、人际、想法）。project 填这条碎片所属的具体事项名（如"报销""NAS 维护"），看不出明确事项就填 null。每条碎片都必须出现在 tags 里。

【todos】只抽取真正"需要去做的事"。纯感想、纯记录、已经做完的不要抽。text 用动词开头，不超过 20 字。due 根据上下文推断日期，格式 YYYY-MM-DD；推断不出来就填 null，绝对不要编造日期。
- **先对照【已完成待办】**：一件事在那份清单里已经办完了，就不要再抽一条新的待办出来，哪怕是换个说法。

【summary】写一段 80-200 字的自然语言小结，分两层：先说这段时间你主动推进了什么，再说发生了哪些事（包括琐事和被打断的事）。要像人写的日记小结，不要罗列，不要用 markdown 标题。

【merge】只标记本轮碎片里"确实是同一件事、可以合并"的。keep_id 选信息最全的那条，drop_ids 是其余几条。没有就返回空数组。宁可少标，也不要错标。

【knowledge】这是最重要的一项。判断碎片里有没有"下次还能用到"的东西：
- 方法、步骤、操作技巧
- 事实、参数、型号、结论
- 踩过的坑、注意事项
纯事件（"带 U 盘给小李"）、纯情绪、纯待办，一律不要出知识卡。宁可少出，不要凑数。没有就返回空数组。

每张卡的字段要求：
- topic：归属主题，2-6 个字，如"NAS 维护""装机""网络"。必须优先从【已有主题】里选，只有确实是全新领域才新建。
- title：一句话结论，8-15 字，要具体。反例："NAS 相关知识"（太泛）。正例："RAID5 换盘前先确认热备盘位"。
- gist：2-4 条要点，每行以 "- " 开头，每行不超过 30 字。这是给人快速扫读的索引。
- source_ids：来源碎片的 id 数组，必须来自用户给的列表。
- 不要输出 body 字段，原文由系统直接从碎片里取。

【todo_done】用来标记"用户已经做完"的已有待办。
- 只有当本轮碎片明确写了某件事已经完成（"报销单交了""盘换好了"），且【未完成待办】里确实有对应那条时，才输出。
- todo_id 必须来自【未完成待办】列表。
- 拿不准就不要输出。误标完成会让用户真的漏掉这件事。

【card_update】用来把本轮碎片补充进【已有知识卡】。
- 只有当本轮碎片属于某张已有卡的主题、并且能补上它缺的信息时才输出。
- card_id 必须来自【已有知识卡】；add_source_ids 只放真正要补进去的那几条。
- title / gist：如果补进去之后原来的说法不够准了，给新的；否则填 null。宁可不改。
- 如果更合适的是单独建一张新卡，就放 knowledge 里，不要硬塞 card_update。

【archive_cards】用来归档已经过时的【已有知识卡】。
- 典型场景：一张旧卡讲的和另一张重复、或者被新增的卡完整覆盖了。
- card_id 必须来自【已有知识卡】。归档是可恢复的，但仍然要想清楚：**只有确认这张卡的信息已经被别处完整承接，才建议归档**。
- 信息有独特性、只是你觉得标题不好，不要归档 —— 那种情况应该用 card_update 去改它。
- 没有就返回空数组。

【drop_todos】用来删掉不该存在的【未完成待办】。
- 只针对三种情况：明显重复、说的不是真事（当初从纯感想里误抽的）、已经被别的事实质取代。
- **已经做完的事不要用 drop_todos**，那要用 todo_done —— 两者含义不同。
- 这是真删除，不能撤销。拿不准就保留。
- 没有就返回空数组。

【硬性约束】
- 所有 id 必须来自用户给的列表，不许新造 id。
- 不许编造用户没说过的事实、人名、数字。
- 内容无意义的碎片（比如单个字符）可以不抽 todo，但仍然要给它 tag。
- 标记了（已整理）的碎片是以前整理过的，重新整理它们时以现在的判断为准，不要因为"已经整理过"就放过明显的问题。
- 全部字段都必须出现，没有内容就用空数组或 null。`;

/** 交给模型的上下文。字段都可选，缺省时对应段落显示「暂无」 */
export interface UserContentOptions {
  fragments: Fragment[];
  topics?: string[];
  cards?: KnowledgeCard[];
  todos?: Todo[];
  /**
   * organize = 整理未读碎片；refactor = 把已整理过的碎片重新过一遍，
   * 结果是和旧标签/旧知识卡做对照，而不是当全新内容处理。
   */
  mode?: 'organize' | 'refactor';
}

/** 单次塞给模型的已有卡片/待办上限，避免上下文过长把碎片挤掉 */
const CONTEXT_LIMIT = 30;

export function buildUserContent(options: UserContentOptions) {
  const { fragments, topics = [], cards = [], todos = [], mode = 'organize' } = options;
  const refactor = mode === 'refactor';

  const sorted = [...fragments].sort((a, b) => a.createdAt - b.createdAt);
  const out: string[] = [`今天是 ${todayISO()} ${weekdayCN(new Date())}。以下是待整理的碎片：`];

  if (refactor) {
    out.push(
      '（这是一次**重构**：这些碎片以前整理过，现在重新判断一遍。请独立判断，不要因为标签已经存在就照抄。）',
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
    // 重构时把旧标签一并给模型看，它才知道「哪里变了」
    let suffix = '';
    if (f.status !== 'inbox') {
      if (refactor) {
        const old = [
          f.tags.length ? `标签：${f.tags.join('、')}` : '无标签',
          f.project ? `项目：${f.project}` : null,
        ]
          .filter(Boolean)
          .join('｜');
        suffix = `（已整理｜${old}）`;
      } else {
        suffix = '（已整理）';
      }
    }
    out.push(`[${f.id}] ${formatTime(f.createdAt)} ${text}${suffix}`);
  }

  out.push('');
  out.push(
    topics.length
      ? `【已有主题】${topics.join('、')}`
      : '【已有主题】暂无，可以新建',
  );

  out.push('');
  if (cards.length) {
    out.push('【已有知识卡】（能补充它们就用 card_update，不要重复建同主题的卡）');
    for (const c of cards.slice(0, CONTEXT_LIMIT)) {
      out.push(`[${c.id}] ${c.topic} | ${c.title}`);
    }
  } else {
    out.push('【已有知识卡】暂无');
  }

  out.push('');
  const open = todos.filter((t) => !t.done);
  if (open.length) {
    out.push('【未完成待办】（本轮碎片表明某条已经做完，就用 todo_done）');
    for (const t of open.slice(0, CONTEXT_LIMIT)) {
      out.push(`[${t.id}] ${t.text}${t.dueAt ? ` · ${t.dueAt}` : ''}`);
    }
  } else {
    out.push('【未完成待办】暂无');
  }

  // 已完成的待办必须让模型看见。否则重构时它不知道这件事已经办完了，
  // 会照着原文再抽一遍同样的待办，列表里就多出一条永远做不完的重复项。
  out.push('');
  const done = todos.filter((t) => t.done);
  if (done.length) {
    out.push('【已完成待办】（这些事已经办完了。**不要**再为它们抽新的待办，也不要重复建同主题的卡）');
    for (const t of done.slice(0, CONTEXT_LIMIT)) {
      out.push(`[${t.id}] ✓ ${t.text}`);
    }
  } else {
    out.push('【已完成待办】暂无');
  }

  return out.join('\n');
}

/**
 * 多轮的追问消息。
 * 必须强调「输出完整结果」——否则模型容易只返回被改动的那几项，
 * 上层的逐条确认界面就会丢掉用户还没确认的内容。
 */
export function buildRefineContent(instruction: string) {
  return `【补充要求】${instruction}

请按上面的要求修改整理结果，然后输出完整的新 JSON：

- 输出的是**完整结果**，不是增量。没有要求改的部分必须原样保留，不要顺手删掉。
- 仍然只输出 JSON 对象，不要任何解释文字。
- id 仍然只能来自上面给过的列表。`;
}
