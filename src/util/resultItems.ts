/**
 * 「逐条确认」这一类界面逻辑的元数据表。
 *
 * 整理结果有九类输出，以前每加一类都要在四个地方同步改：
 * 确认项的 key 生成、`allKeys` 的汇总、`withFreshOff` 的默认勾选、
 * 「AI 认为不需要处理」的空结果判断。漏一个就是 bug，而且是很难发现的那种
 * （比如新加的类型默认被勾上了，用户点一下「应用」就把东西删了）。
 *
 * 现在只有这张表需要改，其余三处都是遍历它。`GroupTable` 是
 * `{[F in keyof OrganizeResult]: …}`，所以**少写一个字段会直接编译不过** ——
 * 契约加了新字段而忘了登记，tsc 会拦住你。
 */
import type { OrganizeResult } from '../types';

/**
 * 确认项的稳定 key。
 *
 * 不能用数组下标 —— 追问之后模型会重排、增删条目，下标一动，
 * 用户刚才取消掉的勾选就会落到另一条内容上。用内容本身做 key，
 * 只要这一条没变，它的勾选状态就跟着它走。
 */
export const K = {
  todo: (text: string) => `todo|${text}`,
  knowledge: (topic: string, title: string) => `knowledge|${topic}|${title}`,
  tag: (id: number) => `tag|${id}`,
  merge: (keepId: number, dropIds: number[]) => `merge|${keepId}|${dropIds.join(',')}`,
  done: (todoId: number) => `done|${todoId}`,
  card: (cardId: number) => `card|${cardId}`,
  archive: (cardId: number) => `archive|${cardId}`,
  drop: (todoId: number) => `drop|${todoId}`,
  mergeTodo: (keepId: number) => `mergeTodo|${keepId}`,
};

type ResultField = keyof OrganizeResult;

interface GroupMeta<F extends ResultField> {
  /** 这一类里单条结果的确认 key */
  key: (item: OrganizeResult[F][number]) => string;
  /**
   * 会让内容从列表里消失的操作。新冒出来的默认不勾选 ——
   * 误操作的后果是「东西不见了」，而用户当时多半没注意到。
   */
  destructive: boolean;
}

type GroupTable = { [F in ResultField]: GroupMeta<F> };

const GROUPS: GroupTable = {
  tags: { key: (t) => K.tag(t.id), destructive: false },
  todos: { key: (t) => K.todo(t.text), destructive: false },
  merge: { key: (m) => K.merge(m.keep_id, m.drop_ids), destructive: false },
  knowledge: { key: (k) => K.knowledge(k.topic, k.title), destructive: false },
  // 标完成不让内容消失：回顾页有独立的已完成区，时间轴上对应碎片带「已完成」标记。
  // 而且用户明确要求过「已经做完的自动标掉」，所以它默认勾选。
  todo_done: { key: (d) => K.done(d.todo_id), destructive: false },
  card_update: { key: (c) => K.card(c.card_id), destructive: false },
  // 归档只是折叠，能恢复；但内容确实从知识库里消失了，所以算破坏性操作。
  archive_cards: { key: (a) => K.archive(a.card_id), destructive: true },
  drop_todos: { key: (d) => K.drop(d.todo_id), destructive: true },
  // 合并是「隐藏」不是「删除」，回顾页能撤回，但仍然算消失。
  merge_todos: { key: (m) => K.mergeTodo(m.keep_id), destructive: true },
};

export const RESULT_FIELDS = Object.keys(GROUPS) as ResultField[];

/**
 * 某一类输出的确认 key 列表。
 *
 * key 生成函数的入参类型逐类不同，联合起来不收窄没法直接调用；
 * 但表里每一项的 key 只接受自己那一类的 item，运行期一定安全。
 */
function keysOf(result: OrganizeResult, field: ResultField): string[] {
  const keyOf = GROUPS[field].key as (item: unknown) => string;
  return (result[field] as unknown[]).map(keyOf);
}

/** 结果里所有确认项。空数组就意味着「AI 认为这批碎片不需要处理」 */
export function resultKeys(result: OrganizeResult | null): string[] {
  if (!result) return [];
  const out: string[] = [];
  for (const field of RESULT_FIELDS) out.push(...keysOf(result, field));
  return out;
}

/**
 * 追问产生新一版结果时，只把**这一轮新冒出来的**破坏性操作置为不勾选；
 * 用户已经表过态的（勾上的、取消的）保持原样。
 */
export function freshOffKeys(
  prev: Set<string>,
  fresh: OrganizeResult | null,
  before: OrganizeResult | null,
): Set<string> {
  const next = new Set(prev);
  if (!fresh) return next;
  const known = new Set(resultKeys(before));
  for (const field of RESULT_FIELDS) {
    if (!GROUPS[field].destructive) continue;
    for (const key of keysOf(fresh, field)) {
      if (!known.has(key)) next.add(key);
    }
  }
  return next;
}
