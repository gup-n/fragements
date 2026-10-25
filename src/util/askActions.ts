/**
 * 问答里的「操作提案」：从模型回答里抠出 `:::action` 块，校验，再交给界面勾选。
 *
 * 为什么不用 JSON 模式整段返回：
 * 问答的主要产出是一篇给人读的 Markdown，塞进 json_object 会把换行全变成 `\n`、
 * 整篇变成一坨字符串（`summarize` / `ask` 都踩过这个坑）。
 * 所以正文照常写 Markdown，只有真正要动手时，才在末尾追加一个带围栏的片段。
 *
 * 校验是**必须的**，不是防御性冗余：模型经常把主题名写错一个字、把卡片 id 记成
 * 另一张卡。放过去的话，`retopicCards` 会静默改 0 张（看起来成功），
 * `update_card` 会改到用户没打算改的那张卡上。
 */
import type { AskAction, KnowledgeCard } from '../types';

export interface ActionContext {
  /** 现有全部主题名 */
  topics: string[];
  /** 现有全部卡片 id */
  cardIds: number[];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * 围栏标记。三种冒号/反引号各写三遍，用字符类而不是分组：
 * `(?:::{3})` 在 JS 里会被解析成「`(?:` + `::{3}`」，实际要求四个冒号，
 * 结果 `:::action` 一个都匹配不上 —— 这个坑排查起来毫无线索，别再改成分组。
 */
const ACTION_OPEN = /^\s*[:`]{3}\s*action\b/i;
const BLOCK_CLOSE = /^\s*[:`]{3}\s*$/;
/** 只有三个反引号的一行 —— 模型爱把 action 块包进代码围栏里 */
const FENCE_ONLY = /^\s*```\s*$/;

/**
 * 把回答切成「正文 + action 块」。
 *
 * 按行扫而不是用正则跨行匹配：模型偶尔会漏写收尾的 `:::`，
 * 正则那种写法会把后面所有正文一起吃掉，用户看到的是半截回答。
 *
 * 还要处理围栏：模型常写成 ``` 里包一个 :::action。
 * 只剥 action 块会把那对围栏留在正文里，用户会看到一对空的代码块。
 * 所以紧贴 action 块的围栏行一起丢掉 —— 只丢紧贴的，
 * 回答里正常的代码块一行都不能动。
 */
function splitBlocks(raw: string): { text: string; blocks: string[] } {
  const lines = raw.split('\n');
  const keep: string[] = [];
  const blocks: string[] = [];
  let buf: string[] | null = null;
  /** 只有围栏的行先压着，确认它不是包 action 的才写回正文 */
  let fenceHold: string[] = [];
  /** 刚关掉一个 action 块：紧跟其后的收围栏也属于它 */
  let justClosed = false;

  const flushFence = () => {
    if (fenceHold.length) {
      keep.push(...fenceHold);
      fenceHold = [];
    }
  };

  for (const line of lines) {
    if (buf) {
      if (BLOCK_CLOSE.test(line)) {
        blocks.push(buf.join('\n'));
        buf = null;
        justClosed = true;
      } else {
        buf.push(line);
      }
      continue;
    }

    if (ACTION_OPEN.test(line)) {
      // 开围栏如果就压在 action 上面，那它是包装，不是正文
      fenceHold = [];
      justClosed = false;
      buf = [];
      continue;
    }

    if (FENCE_ONLY.test(line)) {
      if (justClosed) {
        justClosed = false;
        continue;
      }
      fenceHold.push(line);
      continue;
    }

    justClosed = false;
    flushFence();
    keep.push(line);
  }

  flushFence();
  // 没闭合的块当正文还回去 —— 宁可显示一段奇怪的标记，也别吞掉用户的回答
  if (buf && buf.length) keep.push(...buf);

  return { text: keep.join('\n').replace(/\n{3,}/g, '\n\n').trim(), blocks };
}

function readJson(body: string): any {
  const cleaned = body
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // 常见形态是一行注释加 JSON，抠第一个 { 到最后一个 }
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(cleaned.slice(s, e + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function toAction(raw: any, ctx: ActionContext): AskAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const topicSet = new Set(ctx.topics);
  const cardSet = new Set(ctx.cardIds);
  const kind = String(raw.kind ?? raw.type ?? '').trim();

  if (kind === 'merge_topics') {
    const list = Array.isArray(raw.from) ? raw.from.map(str).filter(Boolean) : [];
    const from = Array.from(new Set(list as string[]));
    // 少于两个主题就不叫合并；名字必须真实存在，编出来的名字改了也是 0 张
    if (from.length < 2 || !from.every((t) => topicSet.has(t))) return null;
    const to = str(raw.to);
    if (!to) return null;
    return { kind: 'merge_topics', from, to, reason: str(raw.reason) };
  }

  if (kind === 'rename_topic') {
    const from = str(raw.from);
    if (!from || !topicSet.has(from)) return null;
    const to = str(raw.to);
    if (!to || to === from) return null;
    return { kind: 'rename_topic', from, to, reason: str(raw.reason) };
  }

  if (kind === 'archive_cards') {
    const rawIds: unknown[] = Array.isArray(raw.ids) ? raw.ids : [];
    const ids: number[] = Array.from(
      new Set(rawIds.map((v) => Number(v)).filter((n) => Number.isFinite(n) && cardSet.has(n))),
    );
    if (!ids.length) return null;
    return { kind: 'archive_cards', ids, reason: str(raw.reason) };
  }

  if (kind === 'update_card') {
    const id = Number(raw.id);
    if (!cardSet.has(id)) return null;

    const patch: {
      topic?: string;
      subtopic?: string | null;
      title?: string;
      gist?: string;
      body?: string;
    } = {};
    const topic = str(raw.topic);
    if (topic) patch.topic = topic;

    // 显式 null 是「清掉」，不传是「不动」。用 in 判断，不能用真值判断
    if ('subtopic' in raw) {
      if (raw.subtopic === null) patch.subtopic = null;
      else {
        const sub = str(raw.subtopic);
        if (sub) patch.subtopic = sub;
      }
    }

    const title = str(raw.title);
    if (title) patch.title = title;
    const gist = str(raw.gist);
    if (gist) patch.gist = gist;
    // 正文是长文本，换行很多，不做 trim 之外的处理
    const body = typeof raw.body === 'string' ? raw.body.trim() : '';
    if (body) patch.body = body;

    if (!Object.keys(patch).length) return null;
    return { kind: 'update_card', id, ...patch, reason: str(raw.reason) };
  }

  return null;
}

/** 同一条建议只留一份 —— 模型偶尔会把同一个合并写两遍 */
export function parseAskActions(
  raw: string,
  ctx: ActionContext,
): {
  text: string;
  actions: AskAction[];
  /**
   * 模型写了 `:::action` 块、但校验没过的条数。
   *
   * 必须回传给界面：主题名差一个字、卡片 id 记错，提案就会被静默丢掉，
   * 用户看到模型说「我帮你改好了」而界面上一条建议都没有，只能理解为「它没有权限」。
   */
  rejected: number;
} {
  const { text, blocks } = splitBlocks(raw);
  const seen = new Set<string>();
  const actions: AskAction[] = [];
  let rejected = 0;

  for (const block of blocks) {
    const action = toAction(readJson(block), ctx);
    if (!action) {
      rejected++;
      continue;
    }
    const key = actionKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push(action);
  }

  return { text, actions, rejected };
}

/** 勾选状态按内容做 key，不按数组下标 —— 提案会被去重、重排 */
export function actionKey(a: AskAction): string {
  switch (a.kind) {
    case 'merge_topics':
      return `merge|${[...a.from].sort().join(',')}|${a.to}`;
    case 'rename_topic':
      return `rename|${a.from}|${a.to}`;
    case 'archive_cards':
      return `archive|${[...a.ids].sort((x, y) => x - y).join(',')}`;
    case 'update_card': {
      const fields = [
        a.topic ?? '',
        a.subtopic === null ? '~' : (a.subtopic ?? ''),
        a.title ?? '',
        a.gist ?? '',
        a.body ?? '',
      ].join('\u0001');
      return `update|${a.id}|${fields}`;
    }
  }
}

export interface ActionText {
  label: string;
  detail: string;
  /** 需要多看一眼的：内容不会丢，但会从视野里消失（归档） */
  risky: boolean;
}

export function describeAction(
  a: AskAction,
  titleOf?: (id: number) => string | null,
): ActionText {
  switch (a.kind) {
    case 'merge_topics':
      return {
        label: '合并主题',
        detail: `${a.from.join('、')} → ${a.to}`,
        risky: false,
      };
    case 'rename_topic':
      return { label: '主题改名', detail: `${a.from} → ${a.to}`, risky: false };
    case 'archive_cards':
      return {
        label: '归档卡片',
        detail: a.ids
          .map((id) => titleOf?.(id))
          .filter((t): t is string => !!t)
          .join('、') || `${a.ids.length} 张卡`,
        risky: true,
      };
    case 'update_card': {
      const changed: string[] = [];
      if (a.topic !== undefined) changed.push(`主题 → ${a.topic}`);
      if (a.subtopic !== undefined) changed.push(`方向 → ${a.subtopic ?? '不分'}`);
      if (a.title !== undefined) changed.push('改标题');
      if (a.gist !== undefined) changed.push('改要点');
      if (a.body !== undefined) changed.push('重写正文');
      return {
        label: `重构卡片${titleOf?.(a.id) ? `「${titleOf(a.id)}」` : ` #${a.id}`}`,
        detail: changed.join(' · '),
        risky: false,
      };
    }
  }
}

/** 提案里提到的卡片，用来在界面上回链 */
export function actionCardIds(a: AskAction): number[] {
  return a.kind === 'archive_cards' ? a.ids : a.kind === 'update_card' ? [a.id] : [];
}

/** 只看提案会不会动到知识库 —— 用于「本轮共 N 条改动建议」计数 */
export function countActions(actions: AskAction[]): number {
  return actions.length;
}

/** 供外部按 id 找卡片标题 */
export function cardTitle(cards: KnowledgeCard[], id: number): string | null {
  return cards.find((c) => c.id === id)?.title ?? null;
}
