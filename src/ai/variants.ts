/**
 * 「问」页的回答版本（v0.33，抄自 DeepSeek 官方 chat-demo 的 message branches）。
 *
 * chat-demo 里每条消息可以有多份内容、用一个 `‹ 2/3 ›` 切换；重新生成、
 * 编辑提问都往同一个位置追加，而不是覆盖。碎片的问答是一问一答成对存的，
 * 所以这里把「一对」当成一个槽位：**一个 QaTurn = 一个问题槽，里面可以有多个版本**。
 *
 * - 原地点「重新生成」→ 追加一版，问题相同；
 * - 原地点「改问题」→ 追加一版，问题不同，切回去时上面的气泡也跟着换；
 * - 旧数据没有 `variants`，按当前字段视作只有一版（读取时现造，不写库）。
 *
 * **兼容镜像**：追加 / 切换之后把激活版本写回 `turn.question` / `answer` / … 上。
 * 这么做的原因有两个，都不是洁癖：
 * 1. `ai/qa.ts` 只用 question/answer 拼上下文，镜像之后它一个字都不用改；
 * 2. 用户回退到旧 APK 时，旧代码读到的还是这一轮当前显示的那一版，不会白屏。
 * 镜像只在本文件里实现一次（`mirror`），别在界面里手写。
 */
import type { QaTurn, QaVariant } from '../types';

/**
 * 一轮最多留几版。
 *
 * 不设上限的话，一个手痒的用户能在同一问上按二十次重新生成 ——
 * 每一版都带着引用快照，会话 JSON 会越滚越大，而 `turns_json` 是整行读写的。
 * 超过就丢**最老的非当前版**，当前看的这版永远不丢。
 */
export const MAX_VARIANTS = 10;

/** 旧数据（没有 variants）的一版：全是缺省值，`at` 用 0 表示「不知道什么时候」 */
export function legacyVariant(turn: QaTurn): QaVariant {
  return {
    question: turn.question,
    answer: turn.answer,
    sourceIds: turn.sourceIds ?? [],
    citations: turn.citations,
    webSources: turn.webSources,
    reasoning: turn.reasoning,
    truncated: turn.truncated,
    documentCoverage: turn.documentCoverage,
    at: 0,
  };
}

/** 这一轮的所有版本。旧数据返回「一版」，调用方不用自己判断有没有 `variants` */
export function variantsOf(turn: QaTurn): QaVariant[] {
  if (turn.variants && turn.variants.length) return turn.variants;
  return [legacyVariant(turn)];
}

/** 当前显示第几版。脏数据（越界、负数、非整数）一律回到 0，不让界面没有答案可画 */
export function activeIndexOf(turn: QaTurn): number {
  const list = variantsOf(turn);
  const raw = turn.active;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw >= list.length) return 0;
  return raw;
}

/** 当前显示的那一版 */
export function activeVariant(turn: QaTurn): QaVariant {
  return variantsOf(turn)[activeIndexOf(turn)];
}

/** 把「激活的这一版」写回旧字段。追加与切换都只走这里 */
function mirror(turn: QaTurn, variants: QaVariant[], active: number): QaTurn {
  const v = variants[active];
  return {
    ...turn,
    variants,
    active,
    question: v.question,
    answer: v.answer,
    sourceIds: v.sourceIds,
    citations: v.citations,
    webSources: v.webSources,
    reasoning: v.reasoning,
    truncated: v.truncated,
    documentCoverage: v.documentCoverage,
  };
}

/** 从一版回答造出一轮（新提问用） */
export function turnFromVariant(variant: QaVariant): QaTurn {
  return mirror(
    {
      question: variant.question,
      answer: variant.answer,
      sourceIds: variant.sourceIds,
      // 下面这些先占位，mirror 会用 variant 覆盖掉
      citations: variant.citations,
      webSources: variant.webSources,
      reasoning: variant.reasoning,
      truncated: variant.truncated,
      documentCoverage: variant.documentCoverage,
      variants: [variant],
      active: 0,
    },
    [variant],
    0,
  );
}

/**
 * 追加一版并切过去。
 *
 * 超过上限时丢**最老的一版**（`shift`）：新追加的排最后，激活的也是最后，
 * 所以被丢的永远不是用户正看着的那一版。
 */
export function withVariant(turn: QaTurn, variant: QaVariant): QaTurn {
  const list = [...variantsOf(turn), variant];
  while (list.length > MAX_VARIANTS) list.shift();
  return mirror(turn, list, list.length - 1);
}

/** 切到第 index 版。越界就原样返回，别让界面因为一次误点丢掉当前答案 */
export function withActive(turn: QaTurn, index: number): QaTurn {
  const list = variantsOf(turn);
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return turn;
  return mirror(turn, list, index);
}

/** 供「改问题」用：这一版的问题文本和别的版本不一样吗（界面上标一句「改过问法」） */
export function hasEditedQuestion(turn: QaTurn): boolean {
  const list = variantsOf(turn);
  if (list.length < 2) return false;
  const first = list[0].question.replace(/\s+/g, ' ').trim();
  return list.some((v) => v.question.replace(/\s+/g, ' ').trim() !== first);
}

/**
 * 第 index 轮之前的问答上下文（不含整理轮、不含自己）。
 *
 * 重新生成时**不能把这一问的旧答案**塞回上下文 —— 那等于让模型「照着上一版再写一遍」。
 * 所以只取前面几轮，且每轮只取当前显示的那一版。
 */
export function historyBefore(turns: QaTurn[], index: number): QaTurn[] {
  return turns.slice(0, Math.max(0, index)).filter((t) => t.kind !== 'organize');
}
