/**
 * 问答范围（QaScope）的解析与比较。**只有这一份**。
 *
 * 范围是这个应用的隐私边界：用户勾了「只问这两份」，任何一处降级成
 * 「其实查了全库」都是把没选的资料交给了模型。所以这里的原则是
 * **宁可报错，不要猜**：
 *
 * - 新数据里 scope 缺失 / 非法 / 文档集合为空 → 报错，不默认 records；
 * - 只有**加载历史旧会话**时才允许缺字段（那些会话创建时还没有这个概念，
 *   它们百分之百是 records），而且要调用方显式传 `allowLegacyMissing`。
 *
 * 「容错」在这一层是危险词：宽进来的每一条，都是一次范围越界。
 */
import { MAX_ASK_DOCUMENTS, type QaScope } from '../types';

/** 文档集合的规范化：去重、去非正整数、保持原顺序、截到上限 */
function normalizeIds(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error('文档范围格式不对');
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of value) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
      throw new Error('文档范围里有无效的文档编号');
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out.slice(0, MAX_ASK_DOCUMENTS);
}

/**
 * 把存储或界面传来的任意值解析成一个合法范围。
 *
 * `allowLegacyMissing` 只在**读旧会话**时为 true：那时缺 scope 意味着
 * records。新建会话、发送请求都必须传 false —— 少传一个字段就变成
 * 「查全库」，这种默认值比报错危险得多。
 */
export function normalizeQaScope(value: unknown, allowLegacyMissing = false): QaScope {
  if (value === undefined || value === null) {
    if (allowLegacyMissing) return { kind: 'records' };
    throw new Error('这次提问没有指定范围');
  }
  if (typeof value !== 'object') throw new Error('问答范围格式不对');

  const raw = value as { kind?: unknown; documentIds?: unknown };
  if (raw.kind === 'records') return { kind: 'records' };

  if (raw.kind === 'documents') {
    const ids = normalizeIds(raw.documentIds);
    // 空集合是「什么都没选」，不能悄悄变成全库
    if (!ids.length) throw new Error('没有选择任何文档');
    return { kind: 'documents', documentIds: ids };
  }

  if (allowLegacyMissing && raw.kind === undefined) return { kind: 'records' };
  throw new Error('问答范围的类型无法识别');
}

/** 范围的稳定字符串，用于判断「是不是同一场会话」 */
export function qaScopeKey(scope: QaScope): string {
  if (scope.kind === 'records') return 'records';
  // 排序：勾选顺序不同但集合相同应当算同一个范围，否则会白开一场新会话
  return `documents:${[...scope.documentIds].sort((a, b) => a - b).join(',')}`;
}

/** 两个范围是不是同一个集合。换集合必须开新会话，比较用这个 */
export function sameQaScope(a: QaScope, b: QaScope): boolean {
  return qaScopeKey(a) === qaScopeKey(b);
}
