/**
 * Markdown 导入：选文件 → 解析 → 与库里比对 → 写库。
 *
 * 存在的理由只有一个：**导出的文件现在只能给人看，装不回来**。
 * 手机丢了、误删了 App、换手机，导出的 md 是唯一的副本。
 *
 * 分工：
 * - `util/mdParse.ts` 解析文本（纯函数，有断言脚本）
 * - 这里只做 IO、判重、落库
 * - 界面只负责把 `ImportPreview` 摆给用户看、收一个「确认」
 */

import type { ParsedFragment } from '../util/mdParse';
import { fragmentKey, parseMarkdown } from '../util/mdParse';
import { dayKey } from '../util/date';
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
  /** 真正会写进去的 */
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

export async function previewImport(file: PickedFile): Promise<ImportPreview> {
  const parsed = parseMarkdown(file.text, Date.now());
  const items = parsed.items;

  const base: ImportPreview = {
    fileName: file.name,
    total: items.length,
    duplicates: 0,
    fresh: [],
    withoutDate: parsed.withoutDate,
    badDateCount: parsed.badDates.length,
    mergedSkipped: parsed.mergedSkipped,
    sectionSkipped: parsed.sectionSkipped,
    from: '',
    to: '',
  };
  if (!items.length) return base;

  // 只查文件覆盖的那段区间：导入一年前的备份时不必把整张表读进内存
  const from = items[0].createdAt;
  const to = items[items.length - 1].createdAt + 1;
  const existing = await repo.listFragmentsBetween(from, to);

  const seen = new Set(existing.map((f) => fragmentKey(f.createdAt, f.content)));
  const fresh: ParsedFragment[] = [];
  let duplicates = 0;
  for (const it of items) {
    const key = fragmentKey(it.createdAt, it.content);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    // 同一个文件里出现两次也只进一条
    seen.add(key);
    fresh.push(it);
  }

  return {
    ...base,
    duplicates,
    fresh,
    from: dayKey(from),
    to: dayKey(to),
  };
}

/**
 * 真正写库。
 *
 * 标签走 `applyTags`，然后把状态推到 `tagged`：有标签说明这条在原来那台机器上
 * 已经整理过了，再扔进「待整理」等于让用户白重排一遍。没标签的留在 `inbox`。
 *
 * 逐条写、不包事务：几百条的量在手机上也就一两百毫秒，换来的是
 * 中途失败时已经写进去的那些不会跟着滚掉，重跑一遍靠判重不会产生重复。
 */
export async function applyImport(
  items: ParsedFragment[],
): Promise<{ inserted: number; tagged: number }> {
  let inserted = 0;
  let tagged = 0;

  for (const it of items) {
    const id = await repo.insertFragment(it.content, 'import', it.createdAt);
    inserted++;
    if (it.tags.length) {
      await repo.applyTags(id, it.tags, null);
      await repo.markStatus([id], 'tagged');
      tagged++;
    }
  }

  return { inserted, tagged };
}
