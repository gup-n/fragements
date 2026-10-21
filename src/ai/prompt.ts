import type { Fragment } from '../types';
import { dayKey, formatTime, todayISO, weekdayCN } from '../util/date';

export const SYSTEM_PROMPT = `你是一个个人碎片笔记整理助手。用户会把随手记下的碎片按时间顺序给你，你要一次性完成五项工作。

【输出格式】
只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块。结构如下：
{
  "tags":      [{"id": 1, "labels": ["工作"], "project": "报销单"}],
  "todos":     [{"text": "提交报销单", "due": "2026-10-21", "id": 1}],
  "summary":   {"body_md": "……"},
  "merge":     [{"keep_id": 3, "drop_ids": [5], "reason": "同一件事"}],
  "knowledge": [{"topic": "NAS 维护", "title": "换盘前先确认热备盘位", "gist": "- 先看存储池状态确认降级盘位\\n- 热备盘会自动顶上，别急着拔", "source_ids": [3]}]
}

【tags】为每条碎片给 1-3 个中文标签。标签要短，2-4 个字，优先复用常见类别（工作、生活、设备、财务、健康、学习、人际、想法）。project 填这条碎片所属的具体事项名（如"报销""NAS 维护"），看不出明确事项就填 null。每条碎片都必须出现在 tags 里。

【todos】只抽取真正"需要去做的事"。纯感想、纯记录、已经做完的不要抽。text 用动词开头，不超过 20 字。due 根据上下文推断日期，格式 YYYY-MM-DD；推断不出来就填 null，绝对不要编造日期。

【summary】写一段 80-200 字的自然语言小结，分两层：先说这段时间你主动推进了什么，再说发生了哪些事（包括琐事和被打断的事）。要像人写的日记小结，不要罗列，不要用 markdown 标题。

【merge】只标记"确实是同一件事、可以合并"的碎片。keep_id 选信息最全的那条，drop_ids 是其余几条。没有就返回空数组。宁可少标，也不要错标。

【knowledge】这是最重要的一项。判断碎片里有没有"下次还能用到"的东西：
- 方法、步骤、操作技巧
- 事实、参数、型号、结论
- 踩过的坑、注意事项
纯事件（"带 U 盘给小李"）、纯情绪、纯待办，一律不要出知识卡。宁可少出，不要凑数。没有就返回空数组。

每张卡的字段要求：
- topic：归属主题，2-6 个字，如"NAS 维护""装机""网络"。必须优先从下面【已有主题】里选，只有确实是全新领域才新建。
- title：一句话结论，8-15 字，要具体。反例："NAS 相关知识"（太泛）。正例："RAID5 换盘前先确认热备盘位"。
- gist：2-4 条要点，每行以 "- " 开头，每行不超过 30 字。这是给人快速扫读的索引。
- source_ids：来源碎片的 id 数组，必须来自用户给的列表。
- 不要输出 body 字段，原文由系统直接从碎片里取。

【硬性约束】
- 所有 id 必须来自用户给的列表，不许新造 id。
- 不许编造用户没说过的事实、人名、数字。
- 内容无意义的碎片（比如单个字符）可以不抽 todo，但仍然要给它 tag。
- 全部字段都必须出现，没有内容就用空数组或 null。`;

export function buildUserContent(fragments: Fragment[], existingTopics: string[] = []) {
  const sorted = [...fragments].sort((a, b) => a.createdAt - b.createdAt);
  const out: string[] = [`今天是 ${todayISO()} ${weekdayCN(new Date())}。以下是待整理的碎片：`];
  let lastDay = '';
  for (const f of sorted) {
    const key = dayKey(f.createdAt);
    if (key !== lastDay) {
      out.push(`\n日期：${key} ${weekdayCN(new Date(f.createdAt))}`);
      lastDay = key;
    }
    const text = f.content.replace(/\s+/g, ' ').trim();
    out.push(`[${f.id}] ${formatTime(f.createdAt)} ${text}`);
  }

  out.push('');
  out.push(
    existingTopics.length
      ? `【已有主题】${existingTopics.join('、')}`
      : '【已有主题】暂无，可以新建',
  );
  return out.join('\n');
}
