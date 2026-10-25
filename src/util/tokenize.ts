/**
 * 本地全文检索的分词。
 *
 * 手机上没有中文分词器，也不值得为几百上千条笔记引一个 jieba。
 * 这里用**二元组**（bigram）：
 *
 *   换盘前先确认热备 → 换盘 / 盘前 / 前先 / 先确 / 确认 / 认热 / 热备
 *
 * 好处是「换盘」「报销」这类两字词一定能命中；代价是索引比原文大一点，
 * 个人笔记量级完全无所谓。**不要换成 trigram** —— SQLite 的 trigram
 * 对少于 3 个字的查询直接不命中，而中文两字词恰恰是最常见的。
 *
 * 英文/数字按整词，标签和事项也一起进索引。
 */

/** 中日韩统一表意文字（含扩展 A）。够用，不追求生僻字全覆盖 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
/** 一段连续中文，或一段连续英文/数字/下划线/点/加号/井号 */
const RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]+|[a-zA-Z0-9_.+#-]+/g;

/** 单字/双字里的高频虚词，进索引只会稀释 BM25，直接丢掉 */
const STOP = new Set([
  '的',
  '了',
  '是',
  '在',
  '有',
  '和',
  '就',
  '不',
  '也',
  '这',
  '那',
  '我',
  '你',
  '他',
  '它',
  '们',
  '一个',
  '一下',
  '什么',
  '怎么',
  '可以',
  '还是',
  '然后',
  '因为',
  '所以',
  '但是',
  '如果',
  '已经',
  '现在',
  '今天',
]);

/** 标签归一：去 #、全半角、空白、英文小写，截到 12 字 */
export function normalizeTag(raw: string): string {
  const text = String(raw ?? '')
    // 开头的空白和 # 一起剥掉：「 # NAS」这种从正文里复制出来的写法很常见，
    // 只削 `^#+` 会因为前面那个空格匹配不上，标签就变成「#nas」
    .replace(/^[\s#]+/, '')
    // 全角 ASCII → 半角；中文标点也会被映射成对应半角符号，标签里不需要它们
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s，。、,.!！?？~～;；:：'"“”‘’()（）[\]【】\-—_/]+/g, '')
    .toLowerCase()
    .trim();
  return text.slice(0, 12);
}

/**
 * 存进库的**显示形式**：去 #、全半角归一、合并空白、截 12 字。
 *
 * 和 `normalizeTag` 的区别只有一条但很关键：**不转小写**。
 * 归一化成的是「比较键」，拿去存库会把 NAS 变成 nas、AI 变成 ai，
 * 界面上看着就像个错别字。键归键、显示归显示。
 */
export function cleanTag(raw: string): string {
  const text = String(raw ?? '')
    .replace(/^[\s#]+/, '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
  return text.slice(0, 12);
}

/**
 * 标签去重 + 截断：按 `normalizeTag` 判同，保留第一次出现的**写法**。
 *
 * 两处一定要共用它：写库（`repo.applyTags`）和确认页的计划层。
 * 各写一份的下场是「界面显示 3 个标签、库里存了 2 个」。
 */
export function dedupeTags(labels: string[], max = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const name = cleanTag(raw);
    const key = normalizeTag(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

/** 比较两个标签是不是同一个意思（只做字面归一，不做语义） */
export function sameTag(a: string, b: string): boolean {
  const x = normalizeTag(a);
  const y = normalizeTag(b);
  return !!x && x === y;
}

/**
 * 切成检索 token。
 * - 中文：重叠二元组；单字保留（否则「盘」这种查询完全搜不到）
 * - 英文/数字：整词；单字符不索引（噪音太大）
 */
export function tokenizeText(text: string): string[] {
  const out: string[] = [];
  const runs = String(text ?? '')
    .toLowerCase()
    .match(RUN_RE);
  if (!runs) return out;

  for (const run of runs) {
    if (CJK_RE.test(run)) {
      if (run.length === 1) {
        out.push(run);
      } else {
        for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
      }
    } else if (run.length >= 2) {
      out.push(run);
    }
  }

  const seen = new Set<string>();
  const kept: string[] = [];
  for (const t of out) {
    if (STOP.has(t) || seen.has(t)) continue;
    seen.add(t);
    kept.push(t);
  }
  return kept;
}

/** 碎片进 FTS 的文本：正文 + 标签 + 事项，全部 token 化后用空格拼起来 */
export function indexText(content: string, tags: string[], project: string | null): string {
  const tagText = tags.map(normalizeTag).filter(Boolean).join(' ');
  const all = `${content}\n${tagText}\n${project ?? ''}`;
  return tokenizeText(all).join(' ');
}

/** 问题 → FTS5 MATCH 表达式。返回空串表示这个问题没有可用 token */
export function buildFtsQuery(question: string, maxTokens = 24): string {
  const tokens = tokenizeText(question).slice(0, Math.max(1, maxTokens));
  if (!tokens.length) return '';
  // 引号包成短语，避免 - / + / OR 之类的 FTS 语法被当成操作符
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** LIKE 兜底用的针；去掉首尾空白，转义 % 和 _ */
export function likeNeedle(question: string): string {
  const q = question.replace(/\s+/g, ' ').trim();
  if (!q) return '';
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}
