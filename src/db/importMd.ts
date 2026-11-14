/**
 * Markdown 文字导入：选文件 → 解析 → 与库里比对 → 写库。
 *
 * 只迁回碎片文字、分钟时间和旧标签；图文字是普通正文，不能恢复原图，
 * 也不恢复文档、月总结、会话或待办，不是完整数据库备份的恢复入口。
 *
 * 分工：
 * - `util/mdParse.ts` 解析文本（纯函数，有断言脚本）
 * - 这里只做 IO、判重、落库
 * - 界面只负责把 `ImportPreview` 摆给用户看、收一个「确认」
 */

import type { ParsedFragment } from '../util/mdParse';
import { fragmentKey, parseMarkdown } from '../util/mdParse';
import { dayKey } from '../util/date';
import { stripImageTokens } from '../util/inlineImages';
import { exportFragmentText } from '../util/mdExport';
import { repo } from './repo';

export interface PickedFile {
  name: string;
  text: string;
}

export interface ImportPreview {
  fileName: string;
  /** 文件里读出来的条目总数 */
  total: number;
  /** 库里已有、或文件内部重复，不会再写一遍的 */
  duplicates: number;
  /** 预览时的新条目；真正写入时仍会重新查询判重 */
  fresh: ParsedFragment[];
  /** 读不到日期、被记到今天的条数 */
  withoutDate: number;
  /** 标题里的日期读不懂的个数（内容仍然保留，落到今天） */
  badDateCount: number;
  mergedSkipped: number;
  sectionSkipped: number;
  /** 时间跨度，让人一眼确认这是不是自己那份文件 */
  from: string;
  to: string;
}

async function readText(uri: string): Promise<string> {
  try {
    const fs = require('expo-file-system');
    const file = new fs.File(uri);
    const out = await file.text();
    return String(out ?? '');
  } catch {
    // 老 API 兜底：新 File API 在某些 content:// URI 上会抛
    const legacy = require('expo-file-system/legacy');
    return String(await legacy.readAsStringAsync(uri));
  }
}

/**
 * 打开系统文件选择器。
 *
 * 故意不按 MIME 过滤（传通配符）而不是列一串类型：安卓上 `.md` 的注册五花八门
 * （text/markdown、text/x-markdown、application/octet-stream 都有），
 * 按类型过滤会让一部分机型**根本看不到自己的文件**——那才是真的没法救。
 * 选错文件由 `looksBinary` 在预览阶段拦下来。
 */
export async function pickMarkdown(): Promise<PickedFile | null> {
  const DocumentPicker = require('expo-document-picker');
  const res = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (!res || res.canceled || !res.assets || !res.assets.length) return null;
  const asset = res.assets[0];
  const text = await readText(asset.uri);
  return { name: asset.name || '导入文件', text };
}

const MINUTE_MS = 60000;

/** 预览与真正写入共用；调用时重新查库，不缓存可能已过期的预览结果。 */
async function findFreshItems(items: ParsedFragment[]) {
  if (!items.length) return { fresh: [] as ParsedFragment[], duplicates: 0, from: '', to: '' };

  // 不假定调用方保持排序。指纹精确到分钟，查询必须覆盖首尾的整个分钟。
  let first = items[0].createdAt;
  let last = first;
  for (const it of items) {
    first = Math.min(first, it.createdAt);
    last = Math.max(last, it.createdAt);
  }
  const from = Math.floor(first / MINUTE_MS) * MINUTE_MS;
  const to = Math.floor(last / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const existing = await repo.listFragmentsBetween(from, to);
  const seen = new Set<string>();
  for (const f of existing) {
    // 新导出含 OCR/缺失说明；旧文件只含去掉图片定位标记的正文。两种都认，
    // 不能因导出文字投影升级就把同一条记录再插一份，也不去猜测/恢复原图。
    seen.add(fragmentKey(f.createdAt, exportFragmentText(f)));
    const legacyBody = stripImageTokens(f.content);
    // 纯图没有旧正文：只能比较完整迁出投影，不能登记共享的空正文别名。
    // 非空的纯标点正文仍按旧规则判重，保证这类有效条目的失败重试也不复制。
    if (legacyBody.trim()) {
      seen.add(fragmentKey(f.createdAt, legacyBody));
      seen.add(fragmentKey(f.createdAt, f.content));
    }
  }

  const fresh: ParsedFragment[] = [];
  let duplicates = 0;
  for (const it of items) {
    const key = fragmentKey(it.createdAt, it.content);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    fresh.push(it);
  }

  return {
    fresh,
    duplicates,
    from: dayKey(from),
    // to 是半开上界；23:59 的最后一条不能把预览日期显示成次日。
    to: dayKey(to - 1),
  };
}

export async function previewImport(file: PickedFile): Promise<ImportPreview> {
  const parsed = parseMarkdown(file.text, Date.now());
  return {
    fileName: file.name,
    total: parsed.items.length,
    withoutDate: parsed.withoutDate,
    badDateCount: parsed.badDates.length,
    mergedSkipped: parsed.mergedSkipped,
    sectionSkipped: parsed.sectionSkipped,
    ...(await findFreshItems(parsed.items)),
  };
}

/** 已完成的条目不会回滚，失败行及本次成功数供界面明确提示安全重试。 */
export class ImportWriteError extends Error {
  constructor(
    public readonly inserted: number,
    public readonly tagged: number,
    public readonly line: number,
    public readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`第 ${line} 行导入失败，本次已写入 ${inserted} 条；重试会跳过已写入条目。${detail}`);
    this.name = 'ImportWriteError';
  }
}

// 锁覆盖「重新查询 → 所有单条提交」，而不只是 insert，避免连点都读到旧快照。
// 仅串行化本模块的导入调用；不声称是跨进程或数据库级的唯一性约束。
let importQueue: Promise<void> = Promise.resolve();

/**
 * 真正写库。每次出队后重新判重，原预览 items 可以在部分成功后原样重试。
 * 每条的正文、旧标签/状态与索引由 Repo 原子提交；不回退为先插入再补标签。
 */
export function applyImport(
  items: ParsedFragment[],
): Promise<{ inserted: number; tagged: number }> {
  // 排队期间调用方可能刷新预览，固定本次已经确认的内容，不修改传入数组。
  const snapshot = items.map((it) => ({ ...it, tags: it.tags.slice() }));
  const result = importQueue.then(async () => {
    const { fresh } = await findFreshItems(snapshot);
    let inserted = 0;
    let tagged = 0;
    for (const it of fresh) {
      try {
        await repo.insertImportedFragment(it.content, it.createdAt, it.tags);
      } catch (error) {
        throw new ImportWriteError(inserted, tagged, it.line, error);
      }
      inserted++;
      if (it.tags.length) tagged++;
    }
    return { inserted, tagged };
  });
  // 保留本次失败给调用方；队尾恢复为 fulfilled，让之后的显式重试仍能运行。
  importQueue = result.then(() => undefined, () => undefined);
  return result;
}
