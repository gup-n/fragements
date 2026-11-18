/**
 * 首页的按页读取（v0.26）。
 *
 * 以前启动就是 `listAllFragments()`：整库读进内存，再在上面叠过滤、日历、缺口三件事。
 * 几千条之后这段时间是真的能感觉到的（而且每存一条就重来一次）。现在首屏只要一页，
 * 往下要更多时再读下一页 —— 计数类的需求改走 SQL 聚合，不再依赖「手里有全量」。
 *
 * 这里只放能单独验的部分：页大小、怎么把新的一页接上去、还剩多少条。
 * 真正的 SQL 在 `db/repo.native.ts`，界面在 `App.tsx` / `TimelineScreen`。
 */
import type { Fragment } from '../types';

/**
 * 一页多少条。
 *
 * 200 的选择：时间轴默认月/天两级收起，一屏大约 8~10 行，200 条够翻十几屏；
 * 再大只会拉长启动那一次读取 —— 而后台补读并不比首屏快。
 * 小屏/大字号下不会因此显示更多，行数由折叠决定。
 */
export const PAGE_SIZE = 200;

/**
 * 把新读的一页接到已加载的后面。
 *
 * **按 id 去重**，不是直接 concat：两次读取之间如果新增了碎片，
 * 第二页的 offset 会整体后移，最后一条会与第一页的最后一条重叠 ——
 * 不处理就会出现两个 key 相同的行（React 会警告，用户会看到一条重复）。
 * 去重放在这里而不是「读的时候算准 offset」：并发写入时 offset 本来就不稳。
 */
export function appendPage(current: Fragment[], page: Fragment[]): Fragment[] {
  if (!page.length) return current;
  const seen = new Set(current.map((f) => f.id));
  const fresh = page.filter((f) => !seen.has(f.id));
  return fresh.length ? current.concat(fresh) : current;
}

/**
 * 把「窗口内的命中」和「整库的命中」合起来。
 *
 * v0.26 把首页的碎片换成按页加载之后，搜索框原本是**在内存里过滤那个数组**的 ——
 * 于是搜一个三个月前的词会得到「找到 0 条」，而那条碎片明明在库里。
 * 这就是 ROADMAP 里当初写着「只给时间轴分页会让搜索变成谎话」的那件事。
 *
 * 现在两路都走：窗口内的（快、能立刻出结果、含 `includes` 这种 FTS 分不出的短词）
 * 加上整库检索回来的（`repo.searchFragments`），按 id 去重。
 * 顺序不动本地那一段 —— 用户在输入框里看着列表一条条减少，位置跳动比少几条更烦。
 */
export function mergeWindowHits(local: Fragment[], remote: Fragment[]): Fragment[] {
  if (!remote.length) return local;
  const seen = new Set(local.map((f) => f.id));
  const extra = remote.filter((f) => !seen.has(f.id));
  return extra.length ? local.concat(extra) : local;
}

/**
 * 还没读进来的条数（底栏那句「还有 N 条更早的」）。
 *
 * 用总数减已加载 —— 不拿「这一页是不是满的」反推：满了不代表还有，
 * 不满也不代表到头了（中间可能有重复被去重掉）。夹到 0 是因为并发删除
 * 会让总数小于已加载，那时说「还有 -3 条」比不说更糟。
 */
export function olderCount(total: number, loaded: number): number {
  return Math.max(0, total - loaded);
}
