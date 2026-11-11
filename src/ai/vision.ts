/**
 * 给一张图生成「文字层」。
 *
 * 为什么要有文字层，而不是每次用到图都把图再发一遍：
 *
 * 1. **省钱省流量**。DeepSeek 按尺寸把图折成 token 计费，一张最多 1024；
 *    整理一个月的碎片会把同一张图重复发好几次。解析一次存下来，之后
 *    整理、问答、搜索都只读这段文字。
 * 2. **图片里的字要能被搜到**。FTS 索引的是文本，图里的「错误代码 0x80070005」
 *    如果只在像素里，搜「0x8007」永远命中不了 —— 这在本项目里等于功能够不着。
 * 3. **模型不必每次都看图**。整理是「把材料浓缩成知识」，它需要的是文字信息；
 *    反复送图只会把请求体撑大（48 MiB 上限）却没有更多信息。
 *
 * 原图始终留着（`fragments.image_path`），点开就能看，文字层只是派生物。
 */
import type { AiConfig } from '../types';
import { AiError, requestChat, type ChatMessage } from './chat';

/**
 * 提示词。
 *
 * 三条要求都来自实际问题：
 * - **原样抄文字**：模型很爱把截图里的命令"顺手改成更好的写法"，
 *   那样抄下来的东西跟截图对不上，用户照着做会出错；
 * - **不要开场白**：「这张图片显示了…」这种句子对搜索和整理都是噪声；
 * - **没有文字就描述**：一张拍下来的机器铭牌、一块主板，文字层就是唯一的信息。
 */
const SYSTEM = `你在为一台只记自己事儿的笔记应用做图片转写。读者是记录的主人，三个月后会回来重读。

规则：
1. 图里有文字就**原样抄下来**，不要改错别字、不要补全、不要翻译、不要"优化"命令和参数。
2. 保留原来的结构：表格用 Markdown 表格，多条用列表，代码 / 命令 / 路径用行内代码。
3. 图里没有文字，就客观描述画面里有什么（设备型号、界面长什么样、报错弹窗写了什么）。
4. 不要开场白，不要"这张图片显示了…"，不要评论，不要总结，不要加标题。
5. 看不清的地方写「（看不清）」，不要猜。
6. 用简体中文，除非原文本身是别的语言。`;

/**
 * 把一张图变成文字。
 *
 * `hint` 是用户当时写下的一句话。有它就一起发过去 ——
 * 「这个报错是什么意思」和「这块主板什么型号」看同一张图，要抄的东西不一样。
 */
export async function describeImage(input: {
  base64: string;
  config: AiConfig;
  hint?: string;
}): Promise<string> {
  const { base64, config, hint } = input;
  if (!base64) throw new AiError('format', '这张图读不出来，可能是文件已经不在手机上了');

  const ask = hint?.trim()
    ? `按规则转写这张图。写它的人附了一句：${hint.trim()}`
    : '按规则转写这张图。';

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: ask },
        // data URL 里 MIME 写死 jpeg：`saveFragmentImage` 落盘时统一转成 jpg 了
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
      ],
    },
  ];

  const outcome = await requestChat(config, messages, undefined, { json: false });
  const text = outcome.content.trim();

  /*
   * 空结果必须报出来，不能悄悄存一个空字符串。
   * 空字符串在库里表示「试过了、什么都没读出来」，界面会显示「没读出文字」——
   * 但如果是撞了额度或者被拒答，那是另一回事，用户应该拿到原因。
   */
  if (!text) {
    throw new AiError(
      outcome.finishReason === 'length' ? 'truncated' : 'format',
      outcome.finishReason === 'length'
        ? '图片转写被输出上限截断了，换张小一点的图再试'
        : '模型没有返回任何文字，再试一次',
      { stage: '图片解析', finish: outcome.finishReason },
    );
  }
  return text;
}
