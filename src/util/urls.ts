/**
 * 从一句话里把网址挑出来。
 *
 * 为什么需要单独一个文件：Android 上用户粘贴链接的方式五花八门 ——
 * 微信会带上「https://xxx 复制打开抖音」这种尾巴，浏览器分享会在末尾带标点，
 * 有时还会把链接包在尖括号里。搜索接口把 `https://xxx，` 当关键词是搜不出东西的，
 * 所以**链接必须从 query 里剥掉**，走抓取而不是搜索。
 */

/** 匹配 http(s) 链接。结尾故意不吃中英文标点和右括号，否则 url 会带着标点去请求 */
const URL_RE = /https?:\/\/[^\s<>"'，。；、）】》\]]+/gi;

/** 链接末尾常见的「句末标点」：剪掉再请求，否则会 404 */
const TRAIL = /[.,;:!?)\]}'"。，；：！？）】》]+$/;

/**
 * 取出文本里的所有链接，按出现顺序去重。
 *
 * 只认 http(s)：`www.` 开头的裸域名不猜 —— 猜错了会去请求一个不存在的地址，
 * 而用户想要的往往是「搜这个词」，不是「读这个站」。
 */
export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(text ?? '').match(URL_RE) ?? []) {
    const url = raw.replace(TRAIL, '');
    // 只要协议 + 主机 + 至少一个字符的路径，`https://` 单独一个不算
    if (url.length < 12 || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * 把链接从文本里去掉，留下用户真正想问的话。
 *
 * 剩下的可能只有几个字甚至空 —— 那种情况下不该再拿它去搜索，
 * 用户的意思是「读这个链接」，不是「搜这句话」。
 */
export function stripUrls(text: string): string {
  return String(text ?? '')
    .replace(URL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 搜索用的 query。
 *
 * 搜索接口的 query 上限是 128 字符，超了直接 400。这里做三件事：
 * 去链接、压空白、超长时**在标点处截断**（硬切会把一个词切一半，
 * 中文尤其明显，切出半个词比少一个字影响更大）。
 */
export function searchQueryOf(question: string, max = 128): string {
  const clean = stripUrls(question).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const at = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf('？'), cut.lastIndexOf(' '));
  return at > max * 0.5 ? cut.slice(0, at) : cut;
}
