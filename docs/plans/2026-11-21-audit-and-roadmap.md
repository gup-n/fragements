# 2026-11-21 全仓复审：缺陷清单、开发计划与优化计划

> 用户原话：「阅读项目，从头开始审阅代码，列出后续的开发计划，优化计划，并写一份计划书，
> 在完成后打勾，当前不要求写代码，仅要求审阅项目，写计划书，以及继承之前的开发习惯，
> 每次完成后提交 git 以及提交 github 的构建」。
>
> **本轮不改代码。** 下面每一条都是一个复选框：做完一条勾一条；没做的不勾，并保留原因。
> 判断有没有做完，看代码与断言，不看这张表 —— 这条规矩和 ROADMAP 开头那句一样。

## 0. 范围、方法与基线（可复现）

| 项 | 值 |
|---|---|
| 代码 | `src/**/*.ts(x)` 152 个文件、39,222 行；`App.tsx` 951 行；合计 **40,173 行** |
| 脚本 | `scripts/` 20 个 `.cjs/.mjs`、9,235 行 |
| 原生插件 | `plugins/` 3 个文件、422 行 |
| 文档 | README、AGENTS 全读；HANDOFF/ROADMAP 读现状与验收相关节；SPEC/CHANGELOG/TEXTS 按引用抽查（**没有逐行读完**） |
| 运行环境 | Windows，Node v22.22.2，npm 10.9.7，分支 `feat/ui-polish-20261115` |

**基线（2026-11-21 本机实跑，未改任何源码）**

- `npm test` 全绿：类型检查 + 12 组断言（按 HANDOFF 口径合计 488 项）+ 文档一致性。
- `npx tsc --noEmit --noUnusedLocals`：0 告警。
- `npm run build:web`：通过，4.73 MiB，产物已删除。
- 没有真机、没有真实模型请求、没有真实微信分享、没有原生迁移断电测试。
  **本轮所有结论都不代表这些已验。**

**怎么找的（不是凭印象列几条）**

- 导出扫描：712 个 `export`，16 个在全库只出现一次；其中 13 个被断言脚本引用，3 个没有调用方。
- Repo 方法扫描：`insertFragmentImage`、`listProposals`、`markAskSessionConverted`、
  `listSafetyCopies` 在界面与脚本里都没有调用（见 D-12）。
- 模块扫描：153 个模块（含 App），6 个「没有 import」里 5 个是平台后缀/类型声明，`App.tsx` 是入口。
- 软删扫描：逐条读 `repo.native.ts` 的 `SELECT/UPDATE/INSERT/DELETE`，与 `assert_recycle` 的覆盖面对账。
- CI 对账：`.github/workflows/android.yml` 的步骤与 `package.json` 的 `test` 脚本比对。
- 文档对账：ROADMAP/HANDOFF 里的版本、分支、体积、上限等数字与源码/实际输出比对。

## 1. 结论

1. **工程质量高于同类个人项目。** 事务边界、软删过滤、任务代次、引用快照、断言密度都有明确判据；
   v0.34/v0.35 刚做过一次全仓审阅，这次没有发现「大功能缺一块」。
2. **剩下的风险集中在失败路径的表述**：读库失败装成空库、恢复失败没有回退、会话保存失败不说话。
   它们的共同点是「界面看起来完全正常」——这类错误比崩溃更难发现。
3. **三处口径不一致、一处 CI 漏跑。** 今日条数只数窗口、搜索 200 上限仍说「找到 N 条」、
   小结在时间轴与回顾里是 120/60 两个上限；`test:recycle` 38 项只在本地跑，CI 不拦。
4. **文档有一处会误导下一个人。** ROADMAP 顶部还写着「新改版在 `feat/ui-refresh-ink-20261114`，
   尚未发布」，而 v0.35.0 已经从 `feat/ui-polish-20261115` 发布；P0-1 仍在验 v0.17 的整理确认页，
   那条路径 v0.23 就连代码删了。

## 2. 缺陷清单（要修的）

### D-01 启动读库失败被当成「空库」（P0）

- [x] **修：首屏加载失败要停在错误页，不许 `setReady(true)` 后照常进门。**
  - 证据：`App.tsx` 的 `reload()` 用 `Promise.all` 读六项，任一失败整体 reject；
    调用处只 `console.warn`，`finally` 无条件 `setReady(true)`（第 466–477 行）。
  - 后果：`fragments`/`days`/`months` 全空，时间轴渲染 `EmptyState tone="accent"` 的
    「今天记点什么？」（`TimelineScreen.tsx` 第 1018 行），页头显示 0 条。
    用户看到的是「记录没了」，而库里其实一条没少。这和 v0.35 用 `BootError` 修掉的是同一类，
    但 `reload` 在 `boot` 的 try 之外。
  - 做法：`Shell` 增加 `loadError`；失败时渲染与 `BootError` 同一套的「数据没读出来」页，
    文案必须写「不要卸载、不要清数据」，重试就是再调 `reload()`；成功后才 `setReady(true)`。
  - 验收：用桩让任一查询 reject → 界面显示加载失败而不是空状态；点重试成功后才出现列表。
    新增断言钉住「`reload` 失败路径不许调用 `setReady(true)` 作为成功」。

  - **落地（v0.36.0）**：`Shell` 增加 `loadError`/`loadBusy`，首屏收成 `loadInitial`；`BootError` 加可选文案；`test:ui` 48 项钉住。
### D-02 恢复备份不是原子替换，且安全副本没有入口（P0）

- [ ] **修：恢复要能失败回退；安全副本要能在 App 里恢复；恢复前要排空文档任务。**
  - 证据：`src/db/backup.ts` 的 `restoreBackup()` 顺序是
    `close()` → 删 `-wal/-shm` → 删主库 → `target.write(dbBytes)` → `reopen()+migrate()`（第 226–264 行）。
    中间任何一步失败（磁盘满、迁移报错、进程被杀），库里已经没有一份可用的主文件。
  - 后果：`_db` 被置空；下一次任意 repo 调用会 `openDatabaseSync` 打开一个空/半截文件，
    `init()` 不会在本进程重跑 → `no such table`；下次冷启动对着空库跑迁移 → **静默变成空库**。
  - 安全副本 `backups/pre-restore-*.db` 确实生成了，但 `listSafetyCopies()` 在
    `src/`、`App.tsx`、`scripts/` 里**没有任何调用方**（只有 Repo 接口和两侧实现）——
    成功提示告诉用户「旧库已另存为 xxx」，App 里却没有一处能把它恢复回来。
  - 另外：`documents/jobs.ts` 的在跑任务不感知恢复。云解析迟到的结果会带着旧库的
    `runId/expectedRevision` 写进新库；恢复后也没有重跑 `initDocumentJobs()`。
  - 做法：
    1. 两阶段替换：新库先写 `fragments.db.new`；把当前库改名为 `fragments.db.old`；
       在 `.new` 上 `reopen()+migrate()`；全部成功后才删 `.old`。失败则把 `.old` 改回来并重新打开。
    2. 恢复前新增 `cancelAllDocumentJobs()`（等待 settle），恢复后重跑 `initDocumentJobs()`。
    3. 「数据与备份」增加「从安全副本恢复」：复用 `peekBackup` 的清单预览与二次确认。
    4. 失败提示必须能说「当前数据未被替换」——在上面两条成立之后这句话才是真的。
  - 验收：对「写新库失败 / 迁移失败 / 改名失败」三种注入，旧库仍可读、界面可继续用；
    安全副本列表能看到并成功恢复一份；恢复时正在跑的任务被取消且不再写回。

### D-03 软删的写闸门还漏五条路径（P1）

- [x] **修：`fragments` 的写路径补 `deleted_at IS NULL`，并扩 `assert_recycle`。**
  - 证据（`src/db/repo.native.ts`）：
    - 第 1384 行 `updateFragmentContent`：`UPDATE fragments SET content = ? WHERE id = ?`；
    - 第 1328 行 `insertFragmentImages`：只查 `SELECT id ... WHERE id = ?`，不看软删；
    - 第 1351 行 `setFragmentImageText`：写完直接 `reindexFragment`，不看碎片是否已删；
    - 第 1397 行 `markFragmentsOrganized`、第 1134 行 `commitDraft` 的 `organized_at`：
      同样只按 id 更新。
  - 后果：迟到的读图结果（`App.parseImage` 在用户删掉碎片后才返回）会把文字写进回收站里的行，
    并重建一条指向已删碎片的 FTS 行。`ensureSearchIndex` 下次启动看到
    `indexed > total`，白重建一遍全量索引；恢复那条碎片时，会看到一份「删除之后才有的」内容。
    v0.34 已经把「写也要挡回收站」写进 AGENTS，但只覆盖了文档/会话/`applyTags`。
  - 做法：这五处一起补（native 与 web 两侧同步）；`insertFragmentImages` 找不到存活行时抛
    「这条碎片已经不存在」；`setFragmentImageText` 找不到存活碎片时直接返回（不 reindex）。
  - 验收：`assert_recycle` 从「三条写路径」扩到逐方法断言；另加一条
    「软删后读图结果不落库、FTS 条数不变」的故障桩用例。

  - **落地（v0.36.0）**：五处补 `deleted_at IS NULL`（native/web 同步），`assert_recycle` 扩到八条写路径。
### D-04 会话保存失败无声（P1）

- [x] **修：保存失败要看得见；离开前要等最后一次保存。**
  - 证据：`AskScreen.tsx` 的 `persistSession` catch 是空的（第 529–531 行）；
    `flushBeforeLeave` 里 `if (dirtyRef.current) void persistSession(...)`（第 550 行）不 await，
    随即返回 `true` 让页面卸载。
  - 后果：会话在回收站里（`saveAskSession` 会抛「这场会话已被删除」）、
    或磁盘/库写入失败时，每轮回答都只活在内存里；切个 tab 就全没，界面一句提示都没有。
  - 做法：`persistSession` 返回成功/失败并设置 `saveError`；页面顶部一条可关闭的条
    「这次会话没存上（原因），离开会丢」；`flushBeforeLeave` 等待最后一次保存，
    失败时留在页面并给重试，而不是静默放行。
  - 验收：桩让 `saveAskSession` reject → 条出现、离开被拦住；重试成功后条消失、可离开。

  - **落地（v0.36.0）**：`persistSession` 返回结果并设 `saveError`；横幅带重试；离开/新建/切换都等保存，失败二次放行。
### D-05 分享接收在主线程整文件复制，且没有大小上限（P1）

- [ ] **修：复制挪到后台线程、加单文件/总大小上限，并把跳过项告诉 JS。**
  - 证据：`plugins/withShareReceiver.js` 的 `saveStream()`（第 84 行）用 `input.copyTo(output)`
    同步复制；`captureShare()`（第 114 行）在 `onCreate` 注入点（第 203 行）
    与 `onNewIntent`（第 154–157 行）里直接调用，也就是主线程。
    `MIME` 收了 `image/*`、PDF、Office，但没有体积判断。
  - 后果：从微信分享一个几百 MB 的视频/压缩包，复制期间主线程卡住（ANR 风险），
    还会把 App 私有目录塞满；失败的文件被 `return@forEachIndexed` 静默跳过，
    JS 只看到少了几项，不知道是「没分享」还是「没复制成功」。
  - 做法：Kotlin 侧用后台线程（`Thread`/协程）复制，JSON 增加 `skipped: [{name, reason}]`
    与 `bytes`；单文件上限（先定 200 MB）与总上限，超限记原因不复制。
    JS 侧在提示里说「N 份太大没接住」，不要只说成功。
  - 验收：分享一个 >上限 的文件 → App 不 ANR、提示明确；分享 3 份同名文件 → 三份都在；
    分享过程中切走再回来，JSON 仍能被读取（文件落盘完成才算一次分享）。

### D-06 CI 少跑 `test:recycle`（P1）

- [x] **修：把 38 项软删/迁移/标签断言加进 Android CI。**
  - 证据：`package.json` 的 `test` 包含 `npm run test:recycle`；
    `.github/workflows/android.yml` 的步骤从 `test:update` 直接到 `test:ui`，没有 recycle。
  - 后果：v0.28 以来最重要的那条「逐条扫 SQL 的软删过滤」在 CI 里从未拦过任何东西，
    只有本地 `npm test` 会跑。PR 与 tag 构建都可能带着漏过滤的 SQL 发出去。
  - 做法：在「更新下载续传断言」之后加一步 `npm run test:recycle`；
    顺手把「CI 步骤 = package.json 的 test 链」写成一条 `check:docs` 或 `assert_ui` 的源码断言，
    防止下次再加脚本又漏。
  - 验收：CI 日志出现 `回收站与标签：38 项通过`；故意删掉一条 `deleted_at IS NULL` 能让 CI 红。

  - **落地（v0.36.0）**：workflow 在 `test:update` 后加了 `test:recycle`，当前 38 项。
### D-07 搜索 200 上限却报「找到 N 条」（P1）

- [ ] **修：上限要可见，或给「继续加载」。**
  - 证据：`TimelineScreen.tsx` 第 398 行 `repo.searchFragments(q, 200)`；
    统计行（第 993–996 行）用合并后的 `visibleFragments.length` 直接说「找到 N 条」。
  - 后果：命中超过 200 条时，界面很确定地报一个偏小的数，且没有任何「还有更多」。
    这和 v0.26「只搜第一页还说找到 0 条」是同一类错误，只是方向相反。
  - 做法：最省事的是「返回条数 === limit 时在统计行补一句（已显示前 200 条）」；
    完整做法是 Repo 返回 `{ items, capped }` 或增加 `searchFragmentsCount`，
    并让「继续加载」走 offset。先做前者，等真机上真的遇到再升级。
  - 验收：内存桩造 250 条命中 → 文案包含「前 200 条」；不超过 200 时不多这句话。

### D-08 首页「今天 N 条」只数已加载窗口（P1）

- [ ] **修：条数与字数都从 `dayCounts` 聚合来。**
  - 证据：`TimelineScreen.tsx` 第 618–621 行 `fragments.filter(f => dayKey(f.createdAt) === key).length`；
    同一句里的字数来自 `App.tsx` 传入的 `todayChars`（SQL 聚合）。
  - 后果：今天记了 200 条以上时，一句话里的「N 条」和「M 字」来自两个口径；
    这是 AGENTS 明令禁止的「对 `fragments` 做 filter().length 当统计」。
  - 做法：`dayCounts` 已经带 `count`，App 直接传 `todayCount`；删掉页面里的 filter。
  - 验收：`test:paging` 或 `test:ui` 增加源码断言：时间轴里不许再用 `fragments.filter` 做统计。

### D-09 小结在时间轴与回顾里是两个上限（P2）

- [ ] **修：统一常量，或给回顾页分页。**
  - 证据：`App.tsx` 第 406 行 `listNotes(120)` 供时间轴；`ReviewScreen.tsx` 第 166 行
    `listNotes(60)` 供回顾。同一批月总结，两个页面能看到的最早一篇不同。
  - 后果：写到第 61 篇月总结之后，时间轴还看得到那一篇，回顾里已经没有它了。
    一个月一篇，五年才会遇到；但「同一份数据两个上限」是会长期留着的暗坑。
  - 做法：抽 `NOTES_WINDOW` 一个常量；或两处都改成「最近 60 + 加载更早」。
    在没做分页之前，至少让两个页面用同一个数。

### D-10 内容截断仍有裸 `slice`（P2）

- [ ] **修：用户文字一律走 `clip` / `shortPreview` / `clampTitle`。**
  - 证据（5 处落库/落文件 + 1 处纯显示）：
    `AskScreen.tsx` 第 511 行会话标题 `.slice(0, 32)`；
    `organize/useOrganize.ts` 第 158 行标题 `.slice(0, 32)`；
    `util/proposal.ts` 第 67 行 note `.slice(0, 200)`；
    `db/docFiles.ts` 第 74 行文件名 `.slice(0, 80)`；
    `documents/readers/chunk.ts` 第 97 行标题 `.slice(0, 40)`（进 locator）；
    `util/trash.ts` 第 52 行 `.slice(0, 60)`（只在回收站副标题里显示，顺手改）。
  - 后果：正好切在 emoji 代理对中间时，半个字符会变成 `�` 并被写进库/文件名/引用快照。
    v0.34 已经把 `safeCutIndex` 定为唯一口径，但只替换了 AI 与正文路径。
  - 做法：逐个换成 `clip(...)`（含省略号）或 `shortPreview(...)`；纯显示的可不动。
    加一条源码断言：`screens/`、`organize/`、`util/` 里对 `content/title/question/bodyMd`
    的 `.slice(0, 数字)` 一律拦下。

### D-11 文档搜索 60 条上限没有说明（P2）

- [ ] **修：命中被截断时说出来。**
  - 证据：`DocsScreen.tsx` 第 221 行 `repo.searchDocuments(q, 60)`；结果直接铺列表。
  - 后果：文档上百篇、搜一个常用词时只显示 60 篇，没有「还有更多」也没有计数。
    用户会以为「就这些」。
  - 做法：与 D-07 同一套：`=== limit` 时在结果头补一句「已显示前 60 篇」。

### D-12 没有调用方的导出与 Repo 方法（P2）

- [ ] **修：能用的接上，没用的删掉。**
  - 证据（全库导出扫描 + Repo 方法逐个 grep）：
    - 导出：`qaScopeKey`、`DigestKind` 在 `src/`、`App.tsx`、`scripts/` 都没有第二个引用。
    - Repo 方法：`insertFragmentImage`（单图包装，现全部走 `insertFragmentImages`）、
      `listProposals`（没有「待审提案」列表页）、`markAskSessionConverted`（v0.16 前
      「会话转碎片」的遗留）、`listSafetyCopies`（D-02 的 UI 半边）——四处都只有接口和两侧实现。
  - 判断：`listSafetyCopies` **保留并接上**（F-02）；其余五个删掉。
    `listProposals` 若将来要做「提案收件箱」再按需加回，不要留一个没人读的表接口。
  - 验收：删完 `tsc --noUnusedLocals` 仍 0 告警；导出扫描不再出现这些名字。

### D-13 ROADMAP 顶部与 P0-1 已过期（P2，本轮顺手改）

- [x] **改：把「当前分支/发布状态」改成 v0.35.0 的事实，并给 P0-1 加历史说明。**
  - 证据：ROADMAP 第 25 行「新改版在 `feat/ui-refresh-ink-20261114`，尚未发布」；
    实际当前分支是 `feat/ui-polish-20261115`，v0.35.0 已发布。
    P0-1 仍在验 v0.17 的「整理确认页 / 标签分组 / 应用回报」，而整理计划与标签入口
    已分别在 v0.23、v0.28 下线 —— 照着重做会复活死路径。
  - 本轮只改描述与指路，不删历史验收项（它们是当时的证据）。

### D-14 HANDOFF 的 Web 产物体积与实际差 0.01 MiB（P3）

- [ ] **改：要么更新成 4.73，要么别在文档里记两位小数。**
  - 证据：HANDOFF 验证表写「4.72 MiB」，本轮 `npm run build:web` 输出 4.73 MiB。
  - 判断：这不是缺陷，是「记录了一个会漂的数字」。`check:docs` 不查它，所以会一直漂。
    下次发版顺手改；或者写成「约 4.7 MiB」。

### D-15 `listAskSessions` 会解析全部 `turns_json`（P3，先量）

- [ ] **观察：会话上百场之后再决定要不要拆。**
  - 证据：`repo.native.ts` 的 `listAskSessions` 对每一行 `JSON.parse(turns_json)`；
    历史抽屉只需要标题、时间、轮数和一句预览。
  - 现状：个人库通常几十场，没问题；v0.33 之后每轮还有 `variants[]`，单场更大。
    先量「100 场 × 每场 10 轮」的列表耗时，超过 100ms 再考虑加 `preview`/`turn_count` 列（要迁移）。
  - 不做：在没有测量前不加列、不引缓存。

## 3. 开发计划（新能力）

### F-01 迁移前自动快照（P1，HANDOFF 里挂了很久的 F11）

- [ ] **做：升级前先留一份库快照，迁移失败能退。**
  - 为什么：v0.34 把「每版 SQL + `user_version`」包进同一事务，解决了「半截迁移」；
    但没有解决「迁移本身写坏了数据」。`ALTER TABLE` 之外还有 `DELETE`/`UPDATE`（v7、v11），
    一旦逻辑错，事务提交之后就不可逆。
  - 做法：`repo.init()` 在 `migrate()` 之前，如果 `user_version < MIGRATIONS.length`，
    先 `VACUUM INTO backups/pre-migrate-v{from}-{date}.db`；保留最近 2 份；
    快照失败就**不要迁移**，直接 `BootError`（宁可不开，也不带病开）。
    迁移成功后在设置页「数据与备份」里能看到这份快照（复用 D-02 的安全副本列表）。
  - 代价：升级那一次启动多写一份库大小（个人库通常几 MB～几十 MB）；只在升级时发生。
  - 验收：造一个 v16 的库 → 启动后 `backups/` 有 pre-migrate 文件、`user_version` 到 17；
    把迁移 SQL 故意改错 → 启动停在 BootError，原库仍是 v16 且可被安全副本恢复。
  - 需要真机：只有原生 SQLite 能做这个验收，Node 内存桩不算。

### F-02 「从安全副本恢复」入口（P1，D-02 的 UI 半边）

- [ ] **做：设置 → 数据与备份 → 安全副本，能看到、能预览、能恢复。**
  - 为什么：现在成功提示把文件名告诉用户，却没有一处能把它装回去；等于「后悔药放在柜子里，柜子锁着」。
  - 做法：复用 `peekBackup` 的清单与二次确认，复用 D-02 的两阶段替换；
    列表显示时间、体积、来源版本；删除旧副本要二次确认。
  - 验收：恢复一份 pre-restore 副本 → 条数、图片、文档都回到那一刻；列表少一份。

### F-03 记录草稿落盘（P2）

- [ ] **做：只落文字，进程被杀后能恢复；图片不落。**
  - 为什么：`App.tsx` 的正文/待发图只活在内存（AGENTS 明确写了「不等于重启恢复」）。
    一个随手记应用，写到一半被系统杀掉，回来一个字都不剩 —— 这是真实痛点。
  - 做法：`draft` 变化后 800ms 防抖写 `settings` 的 `composer.draft.v1`（纯文本 + 时间）；
    启动读回时给一条「已恢复上次没发布的内容」提示；提交成功清空。
    **不落待发图片的 URI**：那是选择器的缓存路径，重启后可能已经失效，恢复一半比不恢复更糟。
  - 代价：每次打字多一次 settings 写（防抖后）；纯本地，不出手机。
  - 验收：输入一段 → 杀进程 → 重开，输入框有那段字和提示；提交后重开为空。

### F-04 分享接收的体积/数量上限（P2，D-05 的完整形态）

- [ ] **做：上限、后台复制、跳过清单三件一起。**
  - 做法与验收见 D-05。数量上限先定 20 份（相册多选），单文件 200 MB，总 500 MB；
    超限的在提示里列名字，不静默丢。

### F-05 搜索可继续加载（P2，D-07 的完整形态）

- [ ] **做：`searchFragments(query, limit, offset)` + 结果尾部「继续加载」。**
  - 为什么：现在的 200 是硬顶；真到几千条、搜单字时，「只显示前 200」仍然会让用户找不到更早的那条。
  - 做法：沿用首页分页的 `mergeWindowHits` 思路，但搜索结果的 offset 必须由 Repo 给，
    不能在内存里切片；FTS 的 `ORDER BY rank` 要稳定（同分按 id）。
  - 验收：造 250 条命中 → 第一页 200、继续加载拿到剩下 50、无重复；计数准确。

### F-06 设备验收（P1，长期阻塞，不由代码完成）

- [ ] **验：v0.34 / v0.35 与 D-01～D-05 的真机路径。**
  - 现有 ROADMAP 第 0 节（当前分支验收）仍有效；第 1 节是 v0.7–v0.17 的历史清单，
    只取仍然存在的入口，已下线的整理确认页/标签那几条不要照做。重点：
    四套外观、320dp + 最大字号、中文输入法、返回层级、PDF 高亮、冷启动与覆盖安装。
  - 本轮没有设备，**不能勾**。没有截图就不写「已验」。

## 4. 优化计划（工程/清理/性能）

### O-01 把 D-01/D-03/D-06 变成断言（P1）

- [ ] **做：新增/扩展断言，而不是靠下次记得。**
  - `assert_recycle`：从「三条写路径」扩到 `updateFragmentContent` / `insertFragmentImages` /
    `setFragmentImageText` / `markFragmentsOrganized` / `commitDraft` 五条。
  - `assert_ui`：钉住「时间轴不许用 `fragments.filter` 做统计」（D-08）。
  - 新增 `assert_boot`（或在 `assert_reliability` 里）：`reload` 失败不 `setReady(true)`（D-01）；
    CI 步骤与 `package.json` 的 `test` 链一致（D-06）。
  - 原则不变：断言要能失败。新脚本必须设 `process.exitCode`。

### O-02 失败态只留一套组件（P1）

- [ ] **做：`BootError` 扩成 `ErrorScreen`，`LoadError` / `RestoreError` 共用。**
  - 为什么：D-01、D-02 都要「出错了，但数据还在，别卸载」这一屏；
    各写一份必然文案不一致。现有 `BootError` 已经有三段结构和重试按钮，直接复用。
  - 约束：文案里「不要卸载」这句不能删；重试必须走真正的入口（`boot()` / `reload()`），
    不许另开第二条初始化路径。

### O-03 截断与上限各留一份（P2）

- [ ] **做：`clip`/`clampTitle` + `NOTES_WINDOW` + `SEARCH_LIMIT` 三个常量。**
  - 对应 D-09、D-10、D-11。加源码断言拦裸 `slice`，比逐个 review 可靠。

### O-04 CI 步骤清单脚本化（P2）

- [ ] **做：`scripts/check_ci.mjs` 或 `check_docs` 的一条检查。**
  - 比对 `package.json` 的 `test` 链与 workflow 的 `run: npm run test:*` 步骤，
    缺一个就报错。这次是 `test:recycle`，下次可能是新脚本。

### O-05 清理死导出与死 Repo 方法（P2）

- [ ] **做：删 `qaScopeKey`、`DigestKind`、`insertFragmentImage`、`listProposals`、
  `markAskSessionConverted`（两侧实现 + 接口 + web 占位）；接上 `listSafetyCopies`。**
  - 对应 D-12。删之前再跑一次导出扫描与 `grep repo.方法名`，确认断言脚本没有间接引用；
    `assert_recycle` 里若按名字扫过这些方法，要一起改。

### O-06 AskScreen 继续外搬纯逻辑（P3，等设备轮）

- [ ] **观察：只搬无状态部分，不拆页面。**
  - 现状 2,072 行。v0.24.1/v0.25 已搬走 `askText` / `TurnAnswer` / `AskHistoryRow`；
    剩下的是聊天流、抽屉外壳、输入区，和 `onLayout` 实测高度、键盘、滚动强耦合。
  - 不做：在没有设备的轮次拆页面 —— 拆完必须逐屏点一遍，否则「看起来没变」的东西会坏。

### O-07 会话列表懒加载（P3，先量）

- [ ] **观察：D-15 的量测结果决定。**
  - 如果 100 场列表 >100ms，再考虑 v18 迁移加 `preview`/`turn_count`；
    否则不动 schema。

## 5. 执行顺序（按版本切）

> 2026-11-22：v0.36.0 第一批已落地 D-01 / D-03 / D-04 / D-06；
> **D-02（恢复备份回退）与 D-05（分享上限）顺延到 v0.36.1**，它们是下一批的第一条。

| 版本 | 内容 | 为什么先做 |
|---|---|---|
| **v0.36** | D-01、D-02（含 F-02）、D-03、D-04、D-05、D-06；O-01、O-02 | 全是「数据看起来没了 / 保存失败不说话」；不改 schema |
| **v0.37** | D-07、D-08、D-09、D-10、D-11；O-03、O-04 | 口径与上限；改动小、断言好钉 |
| **v0.38** | D-12、D-13、D-14；O-05、O-06 | 清理与文档；不碰业务 |
| **设备轮** | F-01、F-06；D-15/O-07 的量测 | 需要原生 SQLite / 真机 / 真实分享 |
| **待决** | F-03（草稿落盘）、F-05（搜索续页）、OTA | 先问要不要，不默认做 |

**下一轮从哪开始**：D-01 → D-02 → D-03。前两个是「数据没了」的假象，第三个是「删了还会被写」；
修完这三条，再谈体验。

## 6. 明确不做 / 待决

**明确不做（理由见 ROADMAP，不在这里重复展开）**

- 账号体系 / 云同步 / 多端；AI 自动改用户数据；物理删除原文（去重只写 `merged_into`）。
- 知识卡 / 主题 / 卡片详情页；向量检索 / embedding；真 tool calls 的整理 agent。
- 标签管理/筛选、独立整理页、日/周小结生成入口 —— 已下线，不复活。
- Word/PPT 本机版式阅读、扫描件 OCR、文档多轮追问回带上一轮片段 —— 代价大于收益。
- 时间轴 `renderItem` memo（v0.35 试过又退回，`extraData` 清单漏一项就静默失效）。
- 两套标签归一化合并（会改用户的组织方式）。

**待决**

1. 应用最终名称（占位「碎片」，包名 `com.local.fragments`）。
2. 要不要上 EAS Update（OTA）；当前 GitHub Release 一档已够用。
3. 月总结删除是否也进回收站（现在是两步确认后硬删，和三类软删口径不同）。
4. vivo Y78 的实际 Android 版本（影响通知权限分支，不阻塞开发）。

## 7. 本轮完成清单

- [x] 通读 README/AGENTS，按现状读 HANDOFF/ROADMAP，抽查 SPEC/CHANGELOG/TEXTS；
  核对四份文档与代码的版本、分支、入口描述。
- [x] 按模块读入口、数据层、AI、文档、整理、页面与断言脚本的关键路径（不是逐行读每个页面的样式）；
  统计 40,173 行源码。
- [x] 实跑 `npm test`（488 项全绿）、`tsc --noUnusedLocals`（0 告警）、`build:web`（4.73 MiB）。
- [x] 做导出扫描、模块扫描、软删写路径扫描、CI 与 package 对账。
- [x] 写这份计划书，并把 ROADMAP 的过期描述与 HANDOFF 的现状入口回填。
- [x] 提交 git、推送分支、触发 GitHub Actions 构建（本轮只构建，不打 tag、不发 Release）。
- [ ] 真机验收 —— **没有设备，未做**，不勾。

> 这张表的勾只代表「本轮确实做了」，不代表「功能已验」。真机与真实数据的结论，
> 必须另起一行、写明设备与包来源，按 AGENTS 第 3 节来。

## 8. 2026-11-22 执行记录（v0.36.0 第一批）

- [x] **D-01** 首屏读库失败停在 `BootError` 的「数据没读出来」，重试走 `loadInitial`；
  `test:ui` 48 项钉住，旧写法（失败也 `setReady(true)`）被源码断言拦下。
- [x] **D-03** 五条软删写路径补 `deleted_at IS NULL`（native/web 同步）；
  `assert_recycle` 的写路径检查从三条扩到八条。
- [x] **D-04** `persistSession` 返回成功/失败并设 `saveError`；横幅带重试；
  离开/新建/切换会话都等保存，失败第一次拦住、第二次放行。
- [x] **D-06** Android CI 在 `test:update` 之后跑 `test:recycle`（38 项）。
- [ ] **D-02** 恢复备份的两阶段替换、安全副本入口、恢复前排空文档任务 —— **下一批第一条**。
- [ ] **D-05** 分享接收后台复制、单文件/总量上限、跳过清单 —— 下一批。
- [ ] **真机** 错误页观感、保存失败横幅与键盘/返回键层叠、软删迟到写入的实际时序。
  没有设备，不勾。

本地验证：`npm test` **489 项**全绿；`tsc --noEmit --noUnusedLocals` 0 告警；
`build:web` 4.73 MiB。CI 由本轮提交触发（只构建，不打 tag、不发 Release）。
