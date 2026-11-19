# 项目交接：当前开发分支

最后整理：2026-11-19。本文记录当前工作树与接手入口，**不是发布说明**。先读[本轮间距返工与日历](<docs/plans/2026-11-15-spacing-and-calendar.md>)和[SPEC最新节](<SPEC.md>)；此前的[当前UI修订](<docs/plans/2026-11-15-ui-polish.md>)、[A方案](<docs/plans/2026-11-14-ui-refresh-ink-proposal.md>)与[实施契约](<docs/plans/2026-11-14-implementation-contracts.md>)保留为历史依据，操作规则见[项目AGENTS](<AGENTS.md>)。

## 1. 三十秒速览

个人单机Android应用「碎片」：随手记文字/图片，之后在「问」里提问、整理碎片/待办或发起月总结。整理以聊天和可审阅草稿呈现，确认后写文档/待办，来源碎片原文不改。

| 项 | 值 |
|---|---|
| 工作目录 | `F:/coding/python/project/Test/fragments` |
| 包名 | `com.local.fragments`，不变 |
| 版本 | v0.31.1 / versionCode 83 |
| 开发分支 | `feat/ui-polish-20261115` |
| 发布状态 | v0.31.0 已发布（[CI 44466757781](https://github.com/gup-n/fragements/actions/runs/44466757781)，26,359,230 字节，SHA-256 `53819a4e…3bc5`，`draft=false`；经 ghfast.top 镜像整包下载后本地算 sha256 + zip 641 条全绿，文件头 `PK`）。可回退：v0.30.1（26,352,898 字节，SHA-256 `d85538e5…2ba6`）、v0.30.0（26,352,850 字节，SHA-256 `c91544b5…07b6`）。真机仍未验 |
| 本轮代码恢复点 | `backup/pre-ui-polish-20261115` / `76d91b0`（含完整备份、快速记录和分享）；原开发分支不变 |
| 技术 | RN0.88 / Expo SDK58 / React19.3 / TypeScript6；Android单端 |
| 数据 | 本地SQLite和私有文件，已有17段结构迁移；无账号、后端、同步 |
| AI | 配置的OpenAI兼容服务；官方支持模型使用 `deepseek-flash` / `deepseek-v4-pro` |

**不要恢复旧入口：** 没有独立整理页、知识卡实体或标签管理/筛选。回顾分待办 / 日历 / 小结三个 tab；现行小结生成只有月。旧tags、旧类型、旧表或兼容解析仍保留，不表示有对应UI。

路由由 App 的 state 管理，`type Route = MainTab`，没有 Expo Router。五个页面（timeline / docs / ask / review / settings）**全部**由 `src/components/TabBar.tsx` 在底栏平级切换，没有覆盖层式的「设置」；键盘抬起时底栏隐藏。记录正文/待发图保存在 App 生命周期；整理工作区另有 settings 持久化，两者不是同一恢复机制。

## 2. 当前进度与未覆盖项

### v0.31.1：清理没人引用的导出，文案与字数只认一份

用户说「清理资源，继续优化」，这版没有新功能：

- **删掉 14 个「声明了、全仓没有第二个引用」的导出**：`todayISO` / `monthStartOf` /
  `isNewer` / `containsText` / `sameTag` / `sameQaScope` / `isLocalText` / `getSkipVersion` /
  `isDigestReminderEnabled` / `isAbortError` / `pendingProposals` / `ensureTags` /
  `payloadPreview`（提案那三个）/ `DOC_EDIT_LABEL`。
  判据是跨文件扫描（导出名在本文件之外出现过几次），**行为零改动**。
  扫描脚本刻意没进仓库：它会对 `export type` 的再导出误报，当门禁只会逼出豁免名单。
- **三个任务名回到 `TASK_LABEL`**：「问」页三张提示卡原来自己硬写字，常量成了没人用的那一份。
- **字数只认 `doc.charCount`**：`DocViewer` 头部原来自己数 `doc.bodyMd.length`，
  与列表里的「可问 · N 字」是两处各算一次（`db/types.ts` 早就提醒过这件事）。
- **文档行属性只写一份**：库列表与归档列表原来各抄 11 个回调 → 一个 `renderRow`。
  滑开的那行在滚动 / 点开 / 长按 / 进多选时自己收回（原来会一直敞着）。
- 工作树里两个生成物删掉：`.tmp-assert/`（44 KB，`test:md` 会重建）、`build-v0205.log`（45 KB）。
- 断言：`test:ui` 43 → 45（滑开行收回、字数只认 charCount）。

**没验**（要真机）：左滑展开后滚动列表时那一行的回弹是否跟手；`enterSelect` 时正在动画的行会不会闪一下。

### v0.31.0：五条用户报的毛病（三条是这四版自己做出来的）

- **「有没有原文件」只认 `origin === 'file'`**：`DocViewer` 里原来写的是
  `origin !== 'knowledge'`，把「自己写的」也算成有原文件 —— 于是它头上挂着
  「原文件已不在手机上」，菜单里还摆着灰掉的「打开原件 / 云解析 / 重新准备」。
  `DocumentReader` 的快照提示同源，一起改成按 `origin` 分。
- **碎片的配图不再进编辑框**：`startEdit` 先 `stripImageTokens`，保存时由
  `composeContent(text, fragment.images)` 把标记拼回文末；「加图插在光标处」的光标逻辑删掉。
- **复制一条（含图）**：新增 `src/db/duplicate.ts`，文件再复制一份、先落文件再写库、
  失败回收；详情页页头多了个复制图标。**新建碎片时摘掉外来的 `![](img:12)`**
  （`stripStoredImageTokens`，待发键保留）。
- **文档行去掉常驻垃圾桶**：`DocRow` 改用 `SwipeRow`（左滑删除 + 长按菜单），
  `SwipeRow` 新增 `surface` / `role` / `checked` / `label` 四个透传项（卡片底色与多选角色）。
- 断言：`test:ui` 41 → 43、`test:recycle` 32 → 34；`assert_reliability` 的桩补了
  `stripStoredImageTokens`（App 新建碎片要先摘外来标记）。

**没验**（要真机）：文档卡片左滑的手感与「滑开一半松手」的回弹；
长按菜单与滑动手势会不会互相打架；复制一条带 9 张图时的耗时；
自己写的文档在阅读器里的副标题字数：现在与列表同一个数（`charCount`），
但那个数按 `bodyMd.length` 算，**含 Markdown 记号与图片标记**，比肉眼看到的字多。

### v0.30.1：通知那条路留着，但不能「有信号就聚焦」

v0.30.0 删掉冷启动聚焦之后，剩下的条件是 `if (!focusSignal) return` ——
而 `focusSignal` 是只增计数器，点过一次通知之后就不为 0，于是**每次切回时间轴都弹键盘**。
改成 `seenSignal` ref 记住处理过哪一版（初值 0，冷启动那一次才不会被吞）。
`test:ui` 41 项（+1 条钉住这段）。

### v0.30.0：四条手感修正（不改数据结构）

用户 2026-11-19 提的四条，没有一条是功能缺失，全是「用起来别扭」：

- **打开 App 不再自动弹键盘**：`TimelineScreen` 里那个 380ms 后 `focus()` 的冷启动 effect
  和 `autoFocusedOnce` 一起删了。通知栏「记一条」那条路（`focusSignal`）**保留**聚焦。
- **回收站搬到设置根页**（原来在「数据与备份」里）：`SettingsScreen` 的 root 菜单第三行；
  `trashCount` 的读取条件从 `pane === 'data'` 改成 root/data/trash 三处，
  `TrashPane` 的 `onChanged` 外面多包一层回写计数。
- **文档页两个入口去图标**，「写一篇」→「新建文档」，`uploadBtn` 补 `flex: 1`。
- **日历当天碎片一条一块**：`ReviewScreen` 的每条记录包进 `fragRow`，
  左边 `fragTime`（`formatTime`，固定 42 宽），上边一条 hairline 分隔线。

`test:recycle` 的入口断言跟着改了口径：回收站那一行必须落在 `pane === 'root'` 那一段里，
文档页那两个按钮必须不带 `Ionicons`（32 项不变，改的是查法不是数量）。

**没验**（要真机）：去图标之后两个按钮在 320dp 屏上会不会挤、日历每条正文在 xlarge 字号下
时刻列会不会被压窄、以及去掉自动聚焦之后「记一条」通知点进来的落点。

### v0.29.0：文档内嵌图

- 标记 `![](doc-img:<文件名>)`，文件仍放 `fragment-images/` —— 备份、换机、单文件删除都不用改。
- `mdBlocks.ImageBlock` 变成联合类型（`id` 或 `file`），`NoteBody` 用 `fileUri` 回调渲染第二种；
  `TextReader` 传 `fragmentImageUri`。
- **内嵌图没有数据库行**：彻底删除文档要扫正文把文件名删掉（`purgeRefs` / `purgeIn`），
  断言钉住「先扫后删」。
- 编辑器在光标处插（`onSelectionChange` 记位置），没拿过光标就接末尾。
- 没做：点开大图（只有配图 id 有全屏页）。

### v0.28.1：把 v0.28.0 的两条半截路补完

- **「重新整理」有了入口**：审批端早就认识 `kind='retag'`（新建 + 归档旧篇），
  但没有任何地方能发出这种提案 —— 现在阅读器第四个按钮走 `proposeRetag`，
  一次请求同时要正文和标签（`suggestDocRewrite({ withTags: true })`）。
- **批量先问做什么**：`DocBatchSheet` 打开先停一张选择页（整理正文 / 打标签），
  原来一打开就默认跑「整理正文」，批量打标签等于不存在。
- **勾选不再卡 5 篇**：`MAX_ASK_DOCUMENTS` 挪到按下「问」的那一刻判断 ——
  勾选还要服务改标签、批量整理、删除，那边没有这个限制。

### v0.28.0：回收站、自己写文档、标签平铺、AI 只出建议

用户 2026-11-18 的一批需求。三项待定同日定了：**自动入库 / 标签平铺 / 恢复支持多选**。
设计与取舍见 [CHANGELOG v0.28.0](./CHANGELOG.md#v0280--删除先进回收站自己写文档标签平铺ai-只出建议)，
数据契约见 [SPEC §9.1](./SPEC.md)。

**这一版最容易踩的一脚是软删的过滤**：`deleted_at` 一加，所有列表查询都要补 `IS NULL`，
漏一条没有任何报错，界面上只是删掉的东西又冒出来一条。所以有 `npm run test:recycle`：
逐条扫 SQL，例外只认 `DELETE FROM` 和带 `trash:ok` 说明的「按 id 读一行」（目前 5 处）。

- **回收站**（`db/repo.*`、`db/trashFiles`、`components/TrashPane`、`util/trash`）
  - `fragments` / `documents` / `ask_sessions` 各加 `deleted_at`；删除只写时间戳，行与文件都不动。
  - 真删只有 `purgeRefs` 一条路（`purgeTrash` / `purgeExpiredTrash` 共用）。
  - 30 天不存「还剩几天」，由 `trashDaysLeft` 现算；启动清一次（不 await）+ 打开回收站再清一次。
  - 入口：设置 → 数据 → 回收站。三类混排、可多选、彻底删除要两步。
- **自己写文档**（`documents/authored`、`components/DocEditor`）
  - `origin='authored'`、`stage='library'`，保存即入库；默认标签「草稿」。
  - 正文走 `contentFromText` → `replaceDocumentContent`，切片与问答检索接得上。
  - `DocStage` **没有 `draft`**：没有写入路径的枚举值只会多一条分支。
- **标签平铺**（`util/docTags`、`doc_tags` / `doc_tag_links`）
  - 名字 UNIQUE、颜色按名字算、`count` 只数在库且未归档的文档。
  - 文档页顶部一行芯片做筛选；阅读器里能改；批量能给多篇加/减。
- **AI 提案**（`ai/docEdit`、`documents/proposals`、`components/ProposalSheet`）
  - `doc_proposals` 四种 kind，`pending → approved / rejected`；**放弃不写库**。
  - `ai/docEdit` 不 import 数据库（断言盯着），写库只有 `approveProposal` 一处。
  - 优化 / 重新整理只新建一篇（`origin='knowledge'` + `originId`），原稿不动；重新整理把旧的 `archived`。
  - 撞输出上限不返回半篇。
- **批量**（`util/docBatch`、`components/DocBatchSheet`）：一次一篇，每篇单独审批；
  没正文安静跳过，收尾必须把跳过与失败数出来。

**没做**：文档里的插图（`![](img:id)` 依赖 `fragment_images`，文档没有这张表）。见 ROADMAP P1 第 0 条。

**没验**（都要真机）：软删之后回收站列表的观感与多选手感、30 天清理在真有几百张图时的耗时、
写文档时键盘挡不挡正文、原文/建议两页签在长文下的滚动、批量流程中断后重进的观感、
`ALTER TABLE ... ADD COLUMN` 在 v16 老库上的迁移耗时（三张表各一列 + 三张新表，理论上瞬时）。

### v0.27.0：空行、日历权重、页头字数

- **空行**：`parseBlocks` 把空行解析成空段落（`segs: []`），渲染多一个换行符。
  连续空行只留一个、末尾不留、预览跳过 —— 三条都有断言。
- **日历**：格子按字数分四档加深（`depthOf`），碎片行可点开全文（`openFrags`），
  明细标题与本月合计都带字数；日列表改回时间正序。
- **页头**：`todayChars` 从 `days` 聚合里取，显示在条数左边。
- **底栏**：文档与回顾换位（`ITEMS` 顺序，断言同步）。
- **待办**：「哪天做」→「截止日期」。

### v0.26.1：搜索不能只看第一页

v0.26.0 的副作用，发布后自己查出来的：首页搜索原来是在内存里 `includes` 全量数组，
换成按页读之后窗口只剩 200 条 —— 搜更早的词会得到「找到 0 条」。

现在两路合并（`util/paging.mergeWindowHits`）：窗口内的命中（快、能兜住 FTS 分不出的单字/emoji）
+ `repo.searchFragments(q, 200)` 的整库命中，按 id 去重。防抖 150ms、清空词要清掉旧命中、
检索失败时只显示本地命中而不是说「搜不到」。

### v0.26.0：大库分页、四档字号、历史抽屉

三件审阅清单上「必须碰设备」的尾巴，其中两件其实能在桌面验到判据层。

**大库**（`db/repo.*`、`util/paging`、`util/digest`、`App`、`TimelineScreen`、`ReviewScreen`）
- 启动不再 `listAllFragments()`：`listFragmentsPage(0, 200)` + 三个聚合
  （`totalFragments` / `dayCounts` / `monthCounts`）。补页用「已加载条数」当 offset。
- `missingDigests` 的入参从碎片数组换成「每月条数」。判据没改，但它不再需要正文；
  同时修掉月总结面板 `listFragments(4000)` 这个猜的上限（超过 4000 条后更早的月份凭空消失）。
- 回顾页不再收 `fragments`：日历吃 `days`、缺口吃 `months`、点开某天才 `onLoadDay(day)`。
  `onLoadDay` 在 App 里是 `useCallback` —— 每次 render 换新函数会让日历那个 effect 死循环。
- 分页口是**主动按钮**，滚到底不自动加载。按事项筛选只在已加载窗口内，所以多一句
  「只在已加载的 N 条里进行」；搜索是整库的，不显示这句。

**字号档位**（`util/uiTokens`、`util/appearance`、`theme`、`App`、`SettingsScreen`）
- 四档 0.9 / 1 / 1.1 / 1.22，只缩放字号与行高。
- `TYPE` 是**会变的导出**：`metrics.typeScale` 只当缓存键，`useThemedStyles` 的 memo
  以 metrics 为依赖，档位一变整页样式重建，40 多个工厂一行不用改。
- 顺序要紧：`setTypeScale(scale)` 必须早于 `setTypeScaleState(scale)`，否则第一帧还是旧字号。

**历史抽屉**（`components/AskHistoryPanel`）
- 压暗层、页头、分组、空屏、滚动容器搬出去；状态全留页面。`AskScreen` 1866 行。
- 三处不许改：挂载看 `mounted`（要播退场）、压暗层 `pointerEvents="none"`、
  操作簿开着时 `accessibilityElementsHidden`。

**CHANGELOG 压到 64 KB**：保留最近 12 版全文，更早的 45 版压成标题 + 首段。

**没验**：真机上千条库的首屏耗时、翻到底的手感、特大字号下有没有被截断的行、
抽屉动画是否与搬走前一致。

### v0.25.3：分享失败不再静默丢内容；设置页不说「昨天是下次」

- `takeIncomingShare` 读的时候就把幂等键推到最新，于是**导入失败也被记住**，那条分享再也读不到。
  现在 `IncomingShare.prevAt` + `rewindIncomingShare`：只在 `consumed === 0`（一份都没存成功）时退回键，
  下次启动重来；部分成功不退（重复比丢失轻，但能不重复就别重复）。
- 设置页原来把 `digest_reminder_at`（上次排定时刻）一律写成「下次提醒」，响过之后会显示**过去**的时刻。
  现在按 `planDigestReminder` 的三个分支分三种说法：未来 / 已经提醒过（3 天冷却）/ 从没排上。

`test:ui` 37 → 38（分享失败回退），`test:reminder` 13 项（过去时刻不能叫「下次」）。

### v0.25.2：权限失配与「下次提醒」

- **权限在系统里被关掉时，App 里的开关还显示「开启」**。现在两个通知开关都会查这个状态，
  设置页在「通知」卡里用一句红字说明原因（`hasNotifyPermission()` 返回 null 时不说 —— 不确定的事不吓唬人）。
- **提醒在响之前没有可见效果**，看不出排没排上。现在设置页写「下次提醒：11 月 18 日 20:00」；
  没有欠账时写「现在没有欠着的小结，所以还不会提醒」。
- 为此 `syncDigestReminder` 的返回值从 `void` 改成「排在哪一刻」（`number`），
  设置页的 `onReminderChange` 可以 `await` —— 不等的话会读到 0，看起来像没排上。

### v0.25.1：提醒的标题与落点

v0.25.0 发完就发现那条通知有两处「说 A 做 B」，都只影响它：

- 标题原写「这个月的小结还没写」，而欠的可能是三个月前那个月（正文里写着具体月份）。
  改成 `该写月总结了`，用词跟着回顾页的「写月总结」按钮走。
- 点进来停在「待办」（回顾页默认 tab）。现在带 `focusTab: 'note'`；因为页面常驻底栏，
  配一个自增 `focusSignal`，否则值没变、effect 不重跑。

`test:reminder` 补三条：带 `tab: 'note'`、回顾页声明 `focusTab`、**真的 `setTab(focusTab)`**。

### v0.25.0：有欠账才提醒一次，相册多选不再全丢

审阅清单里两条「真的没做完」的项。都不是新界面，是补上「用户已经做过一次动作、App 却没接住」的缺口。

**月度小结提醒**（`src/digestReminder.ts` + `src/util/digestReminder.ts`）
- 判据复用 `util/digest.missingDigests`，不另算一套；纯函数 `planDigestReminder` 输出
  `keep` / `cancel` / `schedule` 三种动作，副作用全在外面。
- 三条容易写错的：**已经排在未来的不重排**（否则天天开 App 永远收不到）、**3 天冷却**
  （否则连着催）、**账清了要撤**（否则写完还被提醒）。
- 设置页「快捷入口」改名「通知」，两行并排；打开开关**先要权限再落库** ——
  反过来的「开着但发不出来」是用户查不出来的状态。
- 通知权限的判断与文案合成 `util/notifyPerm` 一份，`quickRecord` 改用同一个。

**分享接收补多选**（`plugins/withShareReceiver.js`、`src/shareInbox.ts`、`App.tsx`）
- manifest 的同一个 filter 里加 `ACTION_SEND_MULTIPLE`，`captureShare` 分两条读
  `EXTRA_STREAM`（单个 Uri / `ArrayList<Uri>`）。
- json 从 `file`/`name` 变成 `files: [{file, name}]`，旧版留下的 json 仍然认；
  磁盘名 `时间戳-序号-名字`，避免同名文件互相覆盖。
- JS 侧：图片合成**一条**碎片（多选三张图是一件事），文档**一份一条**进文档库；
  中转副本逐个消费逐个删。

**`test:ui` 从来没拦过东西**：收尾是裸 `suite.run()`，而 `createSuite.run()` 把异常收进返回值 ——
失败也退出 0。改成 `process.exitCode`，一跑就是 37 项（不是 28）。并加了一条卫生断言：
凡是用 `createSuite` 的脚本必须设退出码。`check:docs` 的行数表也扩到 `.cjs/.mjs`
（以前只查 `.ts/.tsx`，于是 4 个断言脚本的行数漂了几百行没人发现）。

**`AskScreen` 再搬一块**：`historyRow` → `components/AskHistoryRow.tsx`（1938 行）。
聊天流、抽屉外壳、输入区仍留在页面：与页面状态和 `onLayout` 实测高度缠在一起。

**没验**：通知响不响（要等一个 20:00）、MIUI/vivo 的省电策略会不会吃掉通道、
点通知落不落到回顾页；相册多选在微信里是否真的露出「碎片」。这些都只有装包能验。

### v0.24.2：「先去设置页填一个」现在真的能去

月总结面板缺 API Key 时只写一句话，而面板是覆盖层、自己换不了 tab。现在文案改成
`还没配置 API Key，填一个就能生成`，紧跟 `去设置填 Key` 按钮：先关面板（App 按 route 条件渲染），
再切到设置 tab。回调由 App 传下来，面板不认识路由；**只有缺 Key 才给按钮**，网络/格式错误不给。

`test:ui` 35 → 36：断言面板有按钮、先关后切、App 真接到 `setRoute('settings')` ——
只断言「有按钮」的话，回调没接上照样是死按钮。

### v0.24.1：问页拆出两百行

`AskScreen.tsx` 2205 → **1994** 行。只搬**没有状态**的部分，所以不用逐屏点：

- `citeKey` / `plainPreview` / `coverageLine` / `orderedCitations` → `src/util/askText.ts`；
- `TurnAnswer`（回答 + 来源 + 网页链接）→ `src/components/TurnAnswer.tsx`，
  样式由它导出 `makeTurnStyles`，页面 `...spread` 复用（`aRow` / `aText` 页面里还有两处要用）。

`test:ask` 83 → 88：引用编号按正文首次出现排序、同号不同类不串、`coverageLine` 三种说法、
`plainPreview` 剥外壳。

TEXTS 2.3 不再写行号（v0.21 那套编号早漂了，`check:docs` 只查越界查不出指错），改成按区域定位。

### v0.24.0：空屏统一 + 两处透明度 + 提示条悬空

三件都是「上一轮判为 P3、其实有判据」的活。没有新功能。

- **空屏**：五个页面各写一遍（图标底三种色、说明句 maxWidth 一处有一处没有、标题有的带 header 角色），
  收敛成 `components/EmptyState.tsx`。三种形态：默认 / `tone="accent"`（只给首页那一个邀请型空屏）/ `fill`。
- **不用 opacity 压文字**：日历邻月日期（`text3` × 0.45 → 只剩 2 出头）改成 `text3` + 字重 400；
  问页「不联网」胶囊去掉 0.55。禁用态（`btnDisabled` / `off`）保留 —— 那不在对比度要求里。
- **提示条悬空 56**：`SafeAreaView` 里是「页面 + 底栏」竖排，页面底部**就是**底栏顶边；
  文档页却写 `TAB_BAR_HEIGHT + 8`（多选时又换成写死的 96）。现在多选底条 `onLayout` 实测，
  `Toast.tsx` 的注释改成「那 56 只给铺满整屏的壳层用」。

`test:ui` 31 → 35：新增「空屏只有一份实现」「主色空屏只许一处」「底栏高度只许出现在 App.tsx」。
**没验**：五个空屏在 320dp + 最大字号下的换行；多选底条 `flexWrap` 换行后提示条位置。

### v0.22.1：全量审阅（没有新需求）

128 个文件逐个过，清单见[全量审阅](<docs/plans/2026-11-15-code-audit.md>)。改的是三类：

- **同一件事写了两遍**：`endpoint` ×3 → `chat.apiUrl`；`withAlpha` ×2 → `util/color.ts`（玻璃那份遇到
  三位十六进制会退化成不透明色）；`visualLen` ×2 → `util/text.ts`；`outlineStyle: 'none'` ×6 →
  `util/platformStyle.WEB_INPUT_RESET`。删掉 12 处未使用引入，`qa.ts` 的本地 `clip` 改用 `shortPreview`。
- **说了但点不到**：日历「还有 N 条，去时间轴看」→ 就地展开（`DAY_FRAG_LIMIT` 30 条）；
  小结入口「一个月一篇」→ `{N} 个月还没写`（判据来自 `util/digest.missingDigests`）。
- **文档纠偏**：通知栏常驻入口（v0.20.5 已完成）与「文档接入检索与问」（v0.12.0 已完成）
  在 ROADMAP/SPEC 里还被写成未完成，三处都改了。

`test:ui` 21 → 28 项，新增「只许有一份实现」的全库 grep 断言 —— 它当场抓到了第六处 `outlineStyle`。

**当时没做**（v0.23 已做）：`util/organizePlan.ts` 的死函数，当时以为「删前得真机验杀进程续跑整理」。
**没验**：日历展开后的滚动位置、跨年时「N 个月还没写」的文案，只有断言和编译校验。

### v0.23.0：删掉整条死路径 + 小结入口落到缺口月

清单 P2-9 那一条读完链路后发现比预估大：**organizePlan 只是冰山一角**。
`saveOrganizeSession` / `updateOrganizeSession` / `findUnfinishedOrganizeSession` /
`finishOrganizeSession` / `deleteOrganizeSession`、`saveRun` / `markRunApplied`
在 v0.16 就没有调用方了 —— 整理改成「一次对话 + 草稿」后，续跑靠 `ask_sessions` 和游标，
`plan_json` 写进去从来没被读过。整条链路连同 8 个类型一起删了约 765 行。

- **两张表不删**：`organize_sessions` / `organize_runs` 的建表语句留在迁移里，旧设备的行没动。
- 顺带发现 `listFragmentIds` / `countFragments` / `markMerged` / `markStatus` /
  `setFragmentNature` / `countInbox` 也是死的。碎片合并功能早就不在界面上（待办合并还在），
  所以 `merged_into` 现在只有「取消合并」会写。
- **小结入口落到缺口月**：原来只数总数、面板停在本月（本月通常没碎片，等于点进去看空面板）。
  现在传 `initialPeriod`；页头用 `util/digest.reviewSubtitle` 拼成
  `2 件事没做完 · 3 个月小结没写`。**通知形式的主动提醒仍然没做**，理由见 ROADMAP §6。
- **间距**：36 处裸数字（数值正好等于 `SPACE` 档位）换成 token，**数值一个没动**；
  新断言要求「等于档位的裸数字必须换成 `SPACE.*`」，而 2/3/5/6/7/10/14 这类基线微调保持裸写。
- **顺带删掉 `documents/knowledge.ts`**（86 行）：`writeKnowledgeDocument` / `rewriteKnowledgeDocument` 零引用，
  现行写入只走 `Repo.commitDraft`。SPEC §0.3 第 8 条原来写的是这个旧工具，一并改正。
- **SPEC §6.2 / §9 重写**：那一章描述的是 v0.7 的六类契约，点名的五个文件全不存在，
  照着读会把删掉的东西重建一遍。

`test:ui` 28 → 31 项（「死路径不许复活」「间距档位必须走 token」），`test:todos` 22 → 23 项（页头文案）。
**没验**：小结面板打开时的滚动位置与键盘、页头两分句在 320dp + 最大字号下的换行。

### v0.22.0：间距返工 + 回顾日历

用户四条抱怨，根因是同一个：**某个元素占了一整块位置，而它不该占**。详见
[间距返工与日历](<docs/plans/2026-11-15-spacing-and-calendar.md>)，要点：

- **「展开全文」和下一个隔得很开**：那是个 48 高的按钮 + 14 的行底距。现在 26 高 + hitSlop。
- **文档卡太高**：五行竖排 + 48 的操作按钮。标题 14/21、摘要两行、操作按钮 34 + hitSlop。
- **问页开关在框里**：开关和发送键挤一行，框永远一行高。开关移到框外，框 34 起、5 行封顶。
- **待办一行 96 高**：正文一行、图标另起一行，而 `IconButton` 最小槽 48。
  现在图标回到同一行（新增 `IconButton compact`：36 槽 + hitSlop 补 48），勾选框 28，子项 12/18。
- **回顾新增「日历」tab**：`src/util/calendar.ts` 的 42 格月历（周一开头）+ 点阵 +
  月度小结 + 当天明细（可就地勾待办）。参考 jotsy，采纳与不采纳的理由都写在计划文档里。
- **问页提示条位置改成实测**（`onLayout`），去掉了 `keyboardHeight + 140` 这个估算值。

**没验**：没有设备，日历在 320dp + 200% 字号下的换行、待办长文本换行对齐、
问页输入框在真实输入法下的自动长高，都只有断言和编译校验。

### v0.21.0：一次 UI 复查（没有新需求）

用户说「重新审阅 UI 方面所有代码，帮我扣细节」。逐文件读过去，找到的是几类**自相矛盾**，不是缺功能：

- **默认浅色的 `page` 和 `card` 都是 `#FFFFFF`** —— 这是最大的一处。去边框之后结构本该由底色差承担，
  但两者同色，于是设置子页的每个分组、文档卡、待办组、整理产出卡、月总结卡全部「白叠白」，
  只剩 0.5px 的 `hair`。`assert_appearance` 里那条 `card !== page` **原来只对墨水生效**，所以一直没被抓到。
  现在改成三层（card 白 / page `#F4F5F9` / hairSoft `#EAECF2`），`text3` 跟着加深到 `#626878`
  以维持 4.5:1，断言扩到四套色表。
- **设置页点进去底栏消失**：底栏渲染条件还写着 `route !== 'settings'`，与「设置是第五项」矛盾。
  根因是三份东西描述同一件事（`Route` 字面量 + `TABS` + `isTab`），现在 `type Route = MainTab`。
- **按下闪黑框还有四个来源**：`ChoiceChip`（`(pressed || focused)` 共用一个 2px focus 描边）、
  `DocsScreen.cardSelected`、`DocViewer.optionOn/actionSelected`、`TodoPanel.toolBtnOn`，
  外加阅读器的 `SearchBar.boxFocused` 与 `SheetReader.tabOn`。统一成「按下只换底色、选中靠底色 + 实心图标」。
  墨水主题的 `accentBg` 因此从 `#EFEFEF` 加深到 `#E4E4E4`（原来和 hairSoft 只差 3 个色阶，去掉描边就没有选中信号）。
- **五份文件没走 token**：`SummarySheet`（含 `12.5` 半像素字号）、`UpdateSheet`（含 `15.5`）、
  `ImportSheet`、`NoteBody`（三个 `*Reading` 变体全写成 `TYPE.body`）、以及零散几处。
  `TYPE` 补 `subtitle`(17/24) 与 `compact`(14/21)，断言加「新角色必须夹在中间」。
- **空状态六种写法收敛成一个规格**：48 圆 + 浅灰底 + 标题 18 + 说明 14。
- **Toast 被底栏盖住**：`Toast` 导出 `TAB_BAR_HEIGHT`，App 与文档页改用它。
- 删死代码：`navigationLayout`、`R.card/R.btn`、`SettingsScreen` 的 `groupHint`/`chip*`/`toggle*`/`menuDescription`、
  `AskScreen.ghostBtnText`、`IconButton` 的 `primary` tone（无调用方且标签色对比度不够）。

改写的断言（都是结构变了跟着改，不是删）：`TYPE` 键集合与层级、`IconButton` 的 tone（primary→accent，
并新增「图标与标签同色」）、`assert_appearance` 的 `card !== page` 覆盖范围。

### v0.20.9：设置进底栏 + 墨水去线去黑框 + 整体再收一档

六条实机反馈，逐条落地：

- **底栏五项**：碎片 / 文档 / 问 / 回顾 / 设置（问居中、设置最右）。设置从「齿轮 + 覆盖层」变成平级页：
  删了 `settingsFrom`（不再有来路），`TABS` 加 `'settings'`，SettingsScreen 加 `embedded`（根层不画返回）。
  `test:ui` 两条断言改写：底栏四项→五项、`首页只留设置入口`→`首页不该再有任何导航入口`。
- **输入框降高**：首页 `input.minHeight` 48→38、问页 64→44；断言 `input.minHeight >= 48` → `>= 38`（写明理由：书写密度不是触控目标）。
- **文档区缩小**：`cardMain` 内边距 20→12、`name` 18→16、`excerpt` 16/26→14/20、`cardActions`/`pill` 收紧；删 `limitText`「添加只保存原件…」。
- **待办紧凑**：`row` 内边距 12→8、`main.minHeight` 48→40、`text` 15/22、工具栏与空态一起收。
- **墨水重做**：`INK_LIGHT/DARK` 的 `hair` 降到 `#E4E4E4`/`#333333`，`card` 给 `#F7F7F7`/`#1B1B1B` 承担分层。
  `assert_appearance` 的「墨水 hair ≥3:1」**有意放宽到 1.1:1**，同时新增「`card` 与 `page` 必须不同色」守住结构。
- **去点击黑框**：`IconButton.pressed` 删掉 `borderColor: c.focus`（墨水 focus 是纯黑，按下即闪黑框），只留底色反馈。
- **删设置文案**：配置 `fieldHint`、外观三段说明、数据常驻通知说明，以及导出/备份两段冗余从句。

未覆盖：淡化后的边线在强光下是否还看得见、38 高的书写区会不会局促 —— 只有装包能验。

### v0.20.8：修更新 bug + 转向 DeepSeek 设计语言

**先修 bug**：`UpdateSheet.tsx` 的下载进度回调里调了 `useHeadingFocus`（`useCallback` 内部），
第一次进度回调就抛 `Invalid hook call`，界面显示「更新失败」。已删掉那一行（组件体第 253 行本来就有一份正确的），
并全仓扫过 `^\s{4,}.*= use[A-Z]`，其余三处 `useHeadingFocus` 都在组件体顶层。**这类错误 tsc 与断言都不报。**

**再改视觉**：用户要求「像 DeepSeek 一样简约」，换的是分层方式而不是色号。

- **色板**：`page` 纯白 `#FFFFFF`；主色统一 `#3F5EE8`（深色 `#8FA6FF`）；`hairSoft #F4F5F7` 承担所有「浅灰块」，
  `hair #ECEDF1` 只做必要分隔线；`teal` 从绿转灰蓝并只表示「已归档」。
- **几何**：`cardRadius` 16→20、`buttonRadius` 12→14；首页与问页输入卡单独 28。
- **字体**：`TYPE.body` 15/24 → 16/26（断言 `input.fontSize === TYPE.body.fontSize` 自动跟随）。
- **去边框**：`composerCard`、Ask `inputRow`、`qBubble`、设置 `card`/`cardTight` 的 `borderWidth` 全部撤掉，
  改由 `hairSoft` 底色分层；设置菜单卡片从「白底细框」变成浅灰块。
- **圆形发送键**：首页与问页都是 48×48 圆形箭头，不带「发布」二字；`accessibilityLabel` 保留可读名字。
  **`test:ui` 那条断言从「宽 ≥ 84 的横条」改成「宽高相等 + 直径 ≥ 48」——换形状不换底线**。
- **问页胶囊**：只写「深度思考 / 联网」，状态靠淡蓝底 + 蓝字加粗 + 实心图标（`bulb`/`globe` vs outline）三信号。
- **空屏**：「今天记点什么？」+ 浅蓝圆底图标，替代原来的两行产品说明。

未覆盖：真机观感、强光下白底是否刺眼、圆形键手感、胶囊在最大字号下的换行、墨水毛玻璃强度 —— 都只有装包能验。

### v0.20.7（同一分支上一版）

用户基于 v0.20.6 提了 10 条（去绿、删冗余字、缩小控件与间距、四入口换位置、墨水柔化与毛玻璃）。
v0.20.6 的完整备份、快速记录、分享接收和可靠性代码保留；v0.20.7 不改 Repo/AI/organize、数据库结构和原生接收逻辑，新增原生依赖 `expo-blur`。

- **导航**：底栏四 tab（碎片/文档/回顾/问），设置回首页右上角。`ReviewScreen`/`DocsScreen`/`AskScreen` 新增 `embedded`，tab 内不画返回箭头、问页不画关闭叉。切 tab 前走 `flushBeforeLeave` 落盘会话并暂停整理。
- **密度**：页头 72→56；页面内边距 20→16；搜索框 48→44、缩略图 62→52、空状态图标 64→52、工具按钮 78→52 宽。
- **删字**：首页「你的日常记录」、设置根层「按你的习惯来」+ 一句说明、四行菜单下的 `description` 全部移除。
- **墨水几何**：`cardRadius` 4→8、`strokeWidth` 1.25→1、`hair` #767676→#8A8A8A。新增 `ThemeMetrics.outline`（墨 1 / 默认 0），`surfaceStroke` 改用它判断，不再从 `cardRadius <= 4` 反推。
- **毛玻璃**：`src/components/GlassBackdrop.tsx` + `expo-blur`；墨水风格下输入卡、底栏、长文底栏透明化并叠 dimezis 真模糊 + 纸色遮罩（面板 72% / 底栏 86%）。默认风格不渲染该层。
- `test:ui` 从 20 项增至 21 项；`assert_ui.cjs` 需要 `glassable` 与 `./GlassBackdrop` 桩，否则无法加载底栏样式。

### 保留的先前实现

以下是基线中的实现，不是本轮新开发；现有安装包不包含本轮额外UI修改。

- 主题改为明暗 `ui_theme` 与风格 `ui_style` 两轴；新增默认/墨水四套配色、动态几何、48dp控件、非颜色状态和减少动效策略。没有原生偏好桥或实体墨水屏刷新驱动。
- 主页面、输入、问答/整理、回顾与阅读器使用共享控件。文档操作可展开收纳；PDF白纸原色不动，高亮/选区用半透明灰墨与轮廓，主题只发消息不重挂WebView。
- App/两端Repo调整记录与图片原子提交、全量读取、可见搜索投影和文字迁出；提交后刷新失败不清已引用文件。
- 整理执行移至organize模块：稳定身份、逐项授权、真实session-source、原材料重试、固定id范围、草稿/进度一起保存。批准写入使用原子提交与持久凭据，恢复与凭据对账，不自动重发AI。
- 清理只限已确认的孤立组件、未使用取色函数和Web演示注入。旧迁移、存储字段、平台变体和兼容解析仍保留。
- 新可靠性/外观检查已加入包脚本和本地CI配置；本轮未以此宣称已经在远端发布成功。

### 验证入口与范围

源码冻结后，2026-11-15 由Lead串行实跑全部当前回归（本机Node24.14.1）。以下是本轮结果，不代表视觉或发布验收。

| 入口 | 实跑结果 |
|---|---|
| `npm run typecheck` | 通过，0错误 |
| `npm run test:md` | 24 项通过 |
| `npm run test:docs` | 71 项通过（问答16 + 任务8 + 阅读器47） |
| `npm run test:todos` | 23 项通过 |
| `npm run test:ask` | 89 项通过 |
| `npm run test:reliability` | 88 项通过（既有真实控制流+内存桩） |
| `npm run test:appearance` | 46 项通过 |
| `npm run test:backup` | 19 项通过 |
| `npm run test:reminder` | 13 项通过 |
| `npm run test:paging` | 10 项通过 |
| `npm run test:recycle` | **34 项通过**（v0.28：软删过滤逐条扫 SQL + 30 天口径 + 标签平铺 + 提案/批量状态机） |
| `npm run test:ui` | **45 项通过**（真实控件/菜单/样式、间距 token、导航预算及回调保留；v0.31.1 新增「滑开行收回」「字数只认 charCount」） |
| `npm run check:docs` | 通过；保留并同步源码行数地图和当前文案索引 |
| `npm run build:web` | 通过，4.71 MiB；产物已删除，不供预览 |
| `node scripts/prepare_pdf.mjs --check` | 通过；本轮未改PDF模板、协议或生成物 |

当前已有462项回归保持通过（上表逐项相加）。此前的一次性Node内存SQLite实验仍只属于历史记录，本轮没有重跑，也不能代替手机SQLite驱动、真实文件或升级迁移验证。

**不能据此宣称通过的项目：** 真机布局/字体/配色、中文输入法、TalkBack与回焦、手势跟手感、原生WebView/PDF、覆盖安装、原生SQLite迁移及故障恢复、真实模型输出。源码与内存桩不等于原生端到端验收。

**仍单列的风险：** 16段历史迁移执行器未完成专门的事务/备份故障验收；Markdown不是完整数据库/附件备份；Git恢复点不能恢复手机数据；冷启动原生颜色与JS偏好可能不同。不要写“功能完整、只差装包”。

### 仍未实现（本期未覆盖，不要当成已完成）

| 项 | 现状 |
|---|---|
| 原生迁移事务与迁移前恢复点（F11） | 仍未专门实现/验收；v0.20.5完整ZIP备份不等于每次迁移前自动恢复点，本轮没有修改迁移 |
| 统一排版体系 | 本轮新增TYPE/SPACE并接入主页面、聊天/草稿与阅读内容；不是全工程每个字号都已替换，后续局部界面按实际需要继续接入 |
| 应用内图标体系 | 本轮重新统一图标载体、主次和可见标签；桌面PNG/自适应品牌资源未重绘，不宣称全品牌图标设计完成 |
| TalkBack 关闭回焦 | 只有开层标题聚焦（`useHeadingFocus`）；关闭覆盖层后回到触发点未实现，仍依赖系统 |
| 旧业务清理（第一批之外） | v0.23 已删：`organizePlan` 整文件、5 个整理会话方法、`saveRun`/`markRunApplied`、`listFragmentIds`/`countFragments`/`markMerged`/`markStatus`/`setFragmentNature`/`countInbox`、8 个旧类型。v0.23.0 又补删了 `documents/knowledge.ts`（86 行，零引用）。仍在的有 `findFragmentsByIds`/`listFragmentsByIds`——都有现行调用方，删前要改调用点 |
| 通知栏快速记录、Android 分享接收、完整本地备份 | 已在v0.20.5有实现，本轮保留；测试backup纯判据，不代表真实手机恢复/系统Intent验收 |
| 设备级墨水屏优化、OTA、原生偏好桥、桌面品牌图标 | 本轮未实现；原生冷启动/系统级刷新与媒体观感仍需专门设计和设备验证 |

## 3. 接手与执行顺序

1. 读最新批准节、契约、本交接与对应源码，检查分支和未提交差异；不能只看旧版本历史推断现状。
2. 多Agent先 `list/get/claim`，按write scope开发；共享契约、App/Repo及最终Git/构建归Lead。不因同一工作目录可写就跨scope。
3. 冻结源码后由Lead串行跑完整检查、生成PDF资源、更新本节结果和行数地图。失败要修真实问题，不通过删断言/删地图避开。
4. 子Agent不做Git操作；Lead可按已获授权范围创建可回退的本地Commit。本轮不push/tag/Release，不装依赖、不起服务、不做HTML界面预览、不本地构建APK；发布须另获明确授权。
5. 获准设备测试时先确认设备、包来源和版本；每次动作后截图核对。没有设备或无法看图时停止视觉步骤，如实列未验。

依赖/脚本以[package](<package.json>)为准。当前[Android CI](<.github/workflows/android.yml>)使用Node22/JDK21：生成PDF资源 → 类型与各组断言 → 文档检查 → 原生工程/APK。只有版本tag会创建Release并挂raw APK；artifact与Release asset不是一回事。本分支改版尚无新Release。

本地已有工程如需获准prebuild，必须保留 `--no-clean`；不要手改原生生成目录，不根据旧日志擅自删工程或重装依赖。文件清理先核对绝对路径，保护用户数据及其它Agent产物。

## 4. 主要源码行数地图

**行数采样于2026-11-15本轮冻结代码。** 不删除行数表或改变检查规则。第一列保持机器可识别格式，后附打开链接；测试脚本行数是文件长度，不是用例数。

### 4.1 入口、页面、主题与类型

| 文件 | 行 | 当前职责 |
|---|---|---|
| `App.tsx` [打开](<App.tsx>) | 906 | route state、两轴偏好落盘、底栏五页与键盘让位、记录草稿/待发图、数据/图片提交接线、分享接收（多文件）、两条通知的接线、返回与文档运行时 |
| `src/quickRecord.ts` | 141 | 通知栏常驻「记一条」：MIN 渠道 sticky 通知、点击回时间轴并聚焦输入框；冷启动那次靠 `getLastNotificationResponseAsync` 单独捞 |
| `src/shareInbox.ts` | 177 | 读系统分享进来的内容：`files/incoming/` 那份 json + 文件列表，用时间戳做幂等键只消费一次（失败可退回 `prevAt`）；`files[]` 与旧版单文件 json 都认；每个文件各自判 mime / 扩展名 |
| `src/digestReminder.ts` | 215 | 月度小结提醒：DEFAULT 渠道、先要权限再落库、固定 id 排/撤那条通知、点通知落回顾页；冷启动那次单独捞 |
| `src/util/digestReminder.ts` | 102 | 纯函数：`nextRemindAt`（最近一个 20:00）、`planDigestReminder`（keep/cancel/schedule）、提醒正文本 |
| `src/util/notifyPerm.ts` | 41 | 通知权限只有一份：`ensureNotifyPermission` 当场要权限、`hasNotifyPermission` 只查不问（null = 查不出来），两个通知入口共用 |
| `src/screens/TimelineScreen.tsx` [打开](<src/screens/TimelineScreen.tsx>) | 2004 | 日/月折叠、可见文字/OCR搜索、事项筛选、输入与外置附件、手势和详情入口 |
| `src/screens/AskScreen.tsx` [打开](<src/screens/AskScreen.tsx>) | 1866 | 问答聊天流、输入区、引用与文档范围、整理控制器接线；历史抽屉已搬成组件 |
| `src/components/AskHistoryPanel.tsx` [打开](<src/components/AskHistoryPanel.tsx>) | 160 | 历史抽屉外壳：压暗层、页头、分组、空屏、滚动容器；状态全在页面，自己只读 props |
| `src/components/AskHistoryRow.tsx` [打开](<src/components/AskHistoryRow.tsx>) | 117 | 历史会话一行：标题、时间与轮数、状态徽标、那句预览、「⋯」；不持有状态，点击全部上抛 |
| `src/components/TurnAnswer.tsx` [打开](<src/components/TurnAnswer.tsx>) | 163 | 一条回答：正文（可点引用小标）+ 引用来源 + 网页来源；`makeTurnStyles` 由问页 spread 复用 |
| `src/util/askText.ts` [打开](<src/util/askText.ts>) | 71 | 引用编号排序、历史预览、读了多少（coverageLine）；纯函数，无状态 |
| `src/screens/ReviewScreen.tsx` [打开](<src/screens/ReviewScreen.tsx>) | 796 | 待办/日历/小结三个tab（可由 `focusTab` 指定落在哪个），日历为42格月历与当天明细，作为底栏一页时不画返回 |
| `src/screens/DocsScreen.tsx` [打开](<src/screens/DocsScreen.tsx>) | 1610 | 原件导入、搜索/多选、任务状态、逐次云授权、删除确认与阅读入口 |
| `src/screens/SettingsScreen.tsx` [打开](<src/screens/SettingsScreen.tsx>) | 1672 | 四模块四子页、两轴外观、配置、文字迁出/导入、索引与更新、通知组两个开关 |
| `src/theme.tsx` [打开](<src/theme.tsx>) | 117 | 动态ThemeProvider、useTheme/useThemedStyles与系统减少动效 |
| `src/util/appearance.ts` [打开](<src/util/appearance.ts>) | 306 | 四套完整色表（主色靛蓝、无绿）、两轴规范化、语义色和metrics，纯函数可测试 |
| `src/util/uiTokens.ts` [打开](<src/util/uiTokens.ts>) | 117 | 无颜色 TYPE/SPACE、四档字号倍数与 `setTypeScale`、装饰边线与显式 outline 判据 |
| `src/types.ts` [打开](<src/types.ts>) | 476 | 领域类型、引用/会话、文档、配图与PendingFragmentImage |
| `src/version.ts` [打开](<src/version.ts>) | 8 | 与包配置同步的应用版本常量 |
| `src/components/DocEditor.tsx` [打开](<src/components/DocEditor.tsx>) | 456 | 写文档（新建与编辑同一界面）：标题、正文、标签、放弃确认；保存即入库 |
| `src/components/TrashPane.tsx` [打开](<src/components/TrashPane.tsx>) | 320 | 回收站：三类混排、多选、批量恢复/彻底删除（两步确认）、30 天倒计时 |
| `src/components/ProposalSheet.tsx` [打开](<src/components/ProposalSheet.tsx>) | 238 | 审批面板：建议/原稿两页签、字数对比，三个出口（存为新文档/只存标签/放弃） |
| `src/components/DocBatchSheet.tsx` [打开](<src/components/DocBatchSheet.tsx>) | 288 | 批量工作流：一篇篇过，每篇都要单独审批；跳过与失败分开计数 |
| `src/util/trash.ts` [打开](<src/util/trash.ts>) | 96 | 30 天口径、剩几天、分组与顶部那句话（纯函数） |
| `src/util/docTags.ts` [打开](<src/util/docTags.ts>) | 96 | 标签命名规范化、去重、芯片色档、按标签筛（纯函数） |
| `src/util/proposal.ts` [打开](<src/util/proposal.ts>) | 116 | 提案 payload 宽容读取、派生标题、字数对比（纯函数） |
| `src/util/docBatch.ts` [打开](<src/util/docBatch.ts>) | 73 | 批量进度状态机：一次只有一个 running（纯函数） |

### 4.2 Repo、文件与文字迁出

| 文件 | 行 | 当前职责 |
|---|---|---|
| `src/db/types.ts` [打开](<src/db/types.ts>) | 498 | 两端Repo唯一接口、原子草稿输入/回执等共享契约 |
| `src/db/repo.native.ts` [打开](<src/db/repo.native.ts>) | 2229 | SQLite、17段历史迁移（含软删/标签/提案）、FTS投影、记录/图片与草稿原子提交 |
| `src/db/repo.web.ts` [打开](<src/db/repo.web.ts>) | 1246 | localStorage平台实现与回滚边界；不证明原生迁移通过 |
| `src/db/backup.ts` | 283 | 完整备份的文件层：`VACUUM INTO` 快照 → 库 + 配图 + 文档原件打 zip；恢复前先留 `backups/pre-restore-*.db`，替换时连 `-wal`/`-shm` 一起删 |
| `src/db/backup.web.ts` | 22 | 网页端占位：没有私有目录和本地库文件，直接抛一句人话，不假装备份成功 |
| `src/db/repo.ts` [打开](<src/db/repo.ts>) | 7 | 平台分流入口 |
| `src/db/draftCommit.ts` [打开](<src/db/draftCommit.ts>) | 135 | 输入/凭据验证、稳定key、共享提交项处理，平台事务内调用 |
| `src/db/importMd.ts` [打开](<src/db/importMd.ts>) | 187 | 系统选文件、预览、完整分钟判重、串行单条原子导入与部分失败说明 |
| `src/db/fragmentImages.ts` [打开](<src/db/fragmentImages.ts>) | 95 | 图片私有文件保存、读取与删除；引用/清理时机由上层提交边界决定 |
| `src/db/duplicate.ts` [打开](<src/db/duplicate.ts>) | 52 | 复制一条碎片（含图）：先落文件再写库，失败回收刚复制出来的副本 |
| `src/db/docFiles.ts` [打开](<src/db/docFiles.ts>) | 327 | 文档原件保存/读取/删除及外部应用content URI打开 |
| `src/export/markdown.ts` [打开](<src/export/markdown.ts>) | 57 | 全量碎片读取、Markdown文件IO与系统分享 |
| `src/util/mdExport.ts` [打开](<src/util/mdExport.ts>) | 26 | 可读文字迁出投影、未读/无字图片占位和备份范围声明 |
| `src/util/mdBuild.ts` [打开](<src/util/mdBuild.ts>) | 113 | 兼容Markdown拼接：按日文字、只读待办清单、旧标签索引 |
| `src/util/mdParse.ts` [打开](<src/util/mdParse.ts>) | 286 | 旧格式解析、日期警告、二进制判断与唯一判重指纹 |

### 4.3 AI与问答资料

| 文件 | 行 | 当前职责 |
|---|---|---|
| `src/ai/chat.ts` [打开](<src/ai/chat.ts>) | 567 | 唯一请求层，四段超时、SSE、finish_reason、额度与错误证据 |
| `src/ai/stream.ts` [打开](<src/ai/stream.ts>) | 148 | 流分片解析，reasoning/content分离 |
| `src/ai/config.ts` [打开](<src/ai/config.ts>) | 35 | 模型服务配置读取/保存 |
| `src/ai/keyStore.ts` [打开](<src/ai/keyStore.ts>) | 37 | 系统安全存储中的API Key |
| `src/ai/knowledge.ts` [打开](<src/ai/knowledge.ts>) | 403 | fragments/session材料、docs/todos/note输出、预算、改稿与身份/授权对账 |
| `src/ai/qa.ts` [打开](<src/ai/qa.ts>) | 759 | 记录问答、按需检索与预算、联网、真实引用和历史快照 |
| `src/ai/documentRetrieval.ts` [打开](<src/ai/documentRetrieval.ts>) | 530 | 限定文档检索、公平装填、内容版本与D引用快照 |
| `src/ai/summarize.ts` [打开](<src/ai/summarize.ts>) | 303 | 月总结材料与提示词，按日事件表/重要进展 |
| `src/ai/search.ts` [打开](<src/ai/search.ts>) | 192 | 官方工具搜索、退避与结果兜底 |
| `src/ai/fetchPage.ts` [打开](<src/ai/fetchPage.ts>) | 144 | 用户打开联网并发送链接后的页面读取 |
| `src/ai/vision.ts` [打开](<src/ai/vision.ts>) | 90 | 指定图片的文字/内容识别请求，不在保存图片时调用 |
| `src/ai/imageReads.ts` [打开](<src/ai/imageReads.ts>) | 86 | 按需串行读图、预算/失败/剩余统计、取消代次与库/内存同步 |
| `src/ai/balance.ts` [打开](<src/ai/balance.ts>) | 122 | 官方服务余额查询，失败不阻断其它功能 |
| `src/ai/mineru.ts` [打开](<src/ai/mineru.ts>) | 648 | 显式通道云解析、预签名上传、轮询、过滤zip与服务错误 |

### 4.4 整理工作区

| 文件 | 行 | 当前职责 |
|---|---|---|
| `src/organize/workspace.ts` [打开](<src/organize/workspace.ts>) | 372 | 稳定草稿/条目身份、改稿授权对账、批次合并、统一写入计划与严格恢复验证 |
| `src/organize/storage.ts` [打开](<src/organize/storage.ts>) | 47 | settings单键串行保存、快照恢复、与原子提交凭据对账 |
| `src/organize/run.ts` [打开](<src/organize/run.ts>) | 157 | 可注入真实执行器，固定来源、pending批次、检查点与代次防迟到 |
| `src/organize/useOrganize.ts` [打开](<src/organize/useOrganize.ts>) | 394 | Ask控制器：发起/改稿/原源重试/批准/暂停/保存/恢复/放弃 |
| `src/util/askIntent.ts` [打开](<src/util/askIntent.ts>) | 148 | 月总结/待办/整理/问答路由、草稿输入分流与气泡显示判据 |
| `src/util/knowledgeDoc.ts` [打开](<src/util/knowledgeDoc.ts>) | 355 | 模型草稿收敛、真实日期校验、摘要/命名与兼容单篇形状 |
| `src/util/batch.ts` [打开](<src/util/batch.ts>) | 61 | 条数/字数装箱与批次数边界，至少保留一条材料 |

### 4.5 文档、PDF与其它阅读器

| 文件 | 行 | 当前职责 |
|---|---|---|
| `src/documents/importLocal.ts` [打开](<src/documents/importLocal.ts>) | 55 | 本地文件入库的唯一顺序：先落原文件→再写记录→失败删原件；选择器与系统分享共用 |
| `src/documents/formats.ts` [打开](<src/documents/formats.ts>) | 128 | 本机格式、容量、能问判据和真实定位标签 |
| `src/documents/jobs.ts` [打开](<src/documents/jobs.ts>) | 487 | 应用级本地/云准备任务，每文档互斥、取消与版本写回 |
| `src/documents/readers/DocumentReader.tsx` [打开](<src/documents/readers/DocumentReader.tsx>) | 81 | 只读分派，嵌入时不再外包滚动容器 |
| `src/documents/readers/readerAvailability.ts` [打开](<src/documents/readers/readerAvailability.ts>) | 18 | original/snapshot/unavailable纯判据，不依赖能问索引状态 |
| `src/documents/readers/extract.ts` [打开](<src/documents/readers/extract.ts>) | 164 | 本地提取分派，完整正文/切片/定位 |
| `src/documents/readers/chunk.ts` [打开](<src/documents/readers/chunk.ts>) | 182 | 按完整文本切片、真实行号和contentFromText |
| `src/documents/readers/PdfReader.tsx` [打开](<src/documents/readers/PdfReader.tsx>) | 230 | PDF阅读与本地查找命令、文字索引三态、主题消息更新 |
| `src/documents/readers/PdfWebView.tsx` [打开](<src/documents/readers/PdfWebView.tsx>) | 83 | 稳定source、命令桥、本地导航与WebView安全边界 |
| `src/documents/readers/PdfWebView.web.tsx` [打开](<src/documents/readers/PdfWebView.web.tsx>) | 22 | Web编译占位，非PDF网页产品 |
| `src/documents/readers/pdfRuntime.tsx` [打开](<src/documents/readers/pdfRuntime.tsx>) | 301 | App根常驻的串行PDF提取队列 |
| `src/documents/readers/pdfProtocol.ts` [打开](<src/documents/readers/pdfProtocol.ts>) | 94 | RN/WebView消息及纸面主题字段契约 |
| `src/documents/readers/pdfTheme.ts` [打开](<src/documents/readers/pdfTheme.ts>) | 35 | 白纸专用灰墨/轮廓/选区与动态几何转换 |
| `src/documents/readers/pdfjs/reader.template.html` [打开](<src/documents/readers/pdfjs/reader.template.html>) | 772 | 产品PDF源模板：本地渲染/查找、CSS变量与低内存页窗口；不是界面预览 |
| `src/documents/readers/SheetReader.tsx` [打开](<src/documents/readers/SheetReader.tsx>) | 648 | 只读工作表、真实行列定位、当前命中、按视口渲染列 |
| `src/documents/readers/excelWorkbook.ts` [打开](<src/documents/readers/excelWorkbook.ts>) | 421 | dense/稀疏有效单元格解析、不按!ref面积遍历 |
| `src/documents/readers/workbookCache.ts` [打开](<src/documents/readers/workbookCache.ts>) | 39 | 按fileUri+size的单槽内存缓存 |
| `src/documents/readers/viewCache.ts` [打开](<src/documents/readers/viewCache.ts>) | 128 | 磁盘视图缓存，损坏当缓存未命中 |
| `src/documents/readers/sheetWindow.ts` [打开](<src/documents/readers/sheetWindow.ts>) | 96 | 列窗口、偏移与占位计算 |
| `src/documents/readers/TextReader.tsx` [打开](<src/documents/readers/TextReader.tsx>) | 204 | TXT/Markdown/快照的分块虚拟化与字面查找，当前命中非颜色标识 |
| `src/documents/readers/textBlocks.ts` [打开](<src/documents/readers/textBlocks.ts>) | 92 | 正文分块，保留代码围栏与连续表格 |
| `src/documents/readers/SearchBar.tsx` [打开](<src/documents/readers/SearchBar.tsx>) | 121 | 48dp查找/清除/前后命中，busy与disabled分开 |
| `src/documents/readers/markdownSearch.ts` [打开](<src/documents/readers/markdownSearch.ts>) | 30 | 与NoteBody一致的可见Markdown块命中计数 |
| `src/documents/readers/fragmentSearch.ts` [打开](<src/documents/readers/fragmentSearch.ts>) | 32 | 详情OCR→正文→事项的真实命中目标与局部序号 |

### 4.6 共用组件与覆盖层

| 文件 | 行 | 当前职责 |
|---|---|---|
| `src/components/TabBar.tsx` [打开](<src/components/TabBar.tsx>) | 119 | 底栏四项（碎片/文档/回顾/问），flex:1 四等分且每槽≥48dp；选中用实心图标+加粗+短线头，不只靠颜色 |
| `src/components/GlassBackdrop.tsx` [打开](<src/components/GlassBackdrop.tsx>) | 63 | 墨水风格专属毛玻璃垫层：dimezis 真模糊 + 纸色遮罩保证正文可读；`glassable()` 决定卡片是否让出实底 |
| `src/components/IconButton.tsx` [打开](<src/components/IconButton.tsx>) | 171 | 默认48dp槽；compact为36槽+hitSlop补48；短label、选中/禁用/焦点语义，diameter只管视觉底 |
| `src/components/EmptyState.tsx` [打开](<src/components/EmptyState.tsx>) | 80 | 空屏的唯一实现：48 圆底 + 标题 + 可选一句说明；`fill` 撑满、`tone="accent"` 只给首页那一个「邀请型」空屏 |
| `src/components/ScreenHeader.tsx` [打开](<src/components/ScreenHeader.tsx>) | 52 | 共享页头（56高）、返回/右侧动作及标题聚焦 |
| `src/components/BusyIndicator.tsx` [打开](<src/components/BusyIndicator.tsx>) | 23 | 减少动效时静态忙碌图形，不改变业务进度 |
| `src/components/ChoiceChip.tsx` [打开](<src/components/ChoiceChip.tsx>) | 67 | 带文字/状态的共享选项控件 |
| `src/components/useHeadingFocus.ts` [打开](<src/components/useHeadingFocus.ts>) | 20 | 只为屏幕阅读器聚焦新标题，不抢普通键盘 |
| `src/components/KnowledgeDraft.tsx` [打开](<src/components/KnowledgeDraft.tsx>) | 248 | 全部产出可审阅、稳定key、逐项授权与统一写入计数 |
| `src/components/DraftDocPage.tsx` [打开](<src/components/DraftDocPage.tsx>) | 235 | 草稿单篇整页阅读/编辑与批准入口 |
| `src/components/FragmentDetail.tsx` [打开](<src/components/FragmentDetail.tsx>) | 1107 | 分页阅读/编辑、原比例多图、删除确认、OCR/正文/事项命中与实测y |
| `src/components/DocViewer.tsx` [打开](<src/components/DocViewer.tsx>) | 773 | 只按id读取文档、独立读/问门槛、一行主动作、展开操作与逐次云确认 |
| `src/components/NoteBody.tsx` [打开](<src/components/NoteBody.tsx>) | 622 | Markdown/图片块、单Text预览、字面引用、当前命中及动态纸面排版 |
| `src/components/NoteViewer.tsx` [打开](<src/components/NoteViewer.tsx>) | 109 | 小结整页阅读与列表同序分页 |
| `src/components/SummarySheet.tsx` [打开](<src/components/SummarySheet.tsx>) | 785 | 月总结单篇/缺口队列、原稿对照和确认保存 |
| `src/components/TodoPanel.tsx` [打开](<src/components/TodoPanel.tsx>) | 512 | 父子待办、独立勾选/编辑、合并恢复与非颜色状态 |
| `src/components/TodoEditor.tsx` [打开](<src/components/TodoEditor.tsx>) | 229 | 全屏覆盖编辑、子项和到期日 |
| `src/components/UpdateSheet.tsx` [打开](<src/components/UpdateSheet.tsx>) | 529 | 更新提示/下载/安装/错误状态 |
| `src/components/ImportSheet.tsx` [打开](<src/components/ImportSheet.tsx>) | 216 | 文字导入预览、范围/日期警告与确认 |
| `src/components/CitationSheet.tsx` [打开](<src/components/CitationSheet.tsx>) | 238 | 引用快照、真实来源位置，不回库猜原文 |
| `src/components/SwipeRow.tsx` [打开](<src/components/SwipeRow.tsx>) | 319 | 固定方向的时间轴手势，保留纵滚/长按和减少动效 |
| `src/components/Toast.tsx` [打开](<src/components/Toast.tsx>) | 70 | 就近消息呈现，不自行决定业务成功或计时 |
| `src/components/ReasoningFold.tsx` [打开](<src/components/ReasoningFold.tsx>) | 76 | 答后仍可打开的思考折叠 |
| `src/components/ReasoningStream.tsx` [打开](<src/components/ReasoningStream.tsx>) | 91 | 流式思考展示，减少动效与滚动策略 |
| `src/components/ReasoningTrace.tsx` [打开](<src/components/ReasoningTrace.tsx>) | 60 | 过程轨迹显示 |
| `src/components/AgentError.tsx` [打开](<src/components/AgentError.tsx>) | 152 | 错误短提示/阶段/原始证据展开，不吞掉失败原因 |

### 4.7 共用纯函数

| 文件 | 行 | 当前职责 |
|---|---|---|
| `src/util/fragmentText.ts` [打开](<src/util/fragmentText.ts>) | 81 | 材料文字、可见检索投影、配图文字与状态判据 |
| `src/util/backupPlan.ts` | 219 | 备份清单的纯函数：文件名、manifest、恢复前校验（拿错包 / 版本更新 / 缺库）、路径过滤、SQLite 文件头、体积文案与上限 |
| `src/util/inlineImages.ts` [打开](<src/util/inlineImages.ts>) | 148 | 图片定位标记、待发键替换、删除和无定位图判定 |
| `src/util/pendingImages.ts` [打开](<src/util/pendingImages.ts>) | 52 | 按图id选择未读图片、保持顺序与读图预算 |
| `src/util/tokenize.ts` [打开](<src/util/tokenize.ts>) | 158 | 中文bigram/FTS查询与旧标签规范化兼容工具 |
| `src/util/highlight.ts` [打开](<src/util/highlight.ts>) | 55 | 唯一字面命中findHits/countHits |
| `src/util/mdBlocks.ts` [打开](<src/util/mdBlocks.ts>) | 493 | Markdown、表格、代码、引用与图片块解析 |
| `src/util/text.ts` [打开](<src/util/text.ts>) | 53 | 文本规范化、显示宽度与截取 |
| `src/util/date.ts` [打开](<src/util/date.ts>) | 183 | 日/月等历史日期键、标签与月末锚点 |
| `src/util/calendar.ts` [打开](<src/util/calendar.ts>) | 92 | 回顾日历的纯日期网格：固定42格、周一开头、翻月跨年、本地时区解析；`DayCount` 是日历的唯一输入 |
| `src/util/color.ts` [打开](<src/util/color.ts>) | 23 | 唯一一份 `withAlpha`：三位/六位十六进制、alpha 夹紧；PDF 高亮与毛玻璃共用 |
| `src/util/platformStyle.ts` [打开](<src/util/platformStyle.ts>) | 14 | `WEB_INPUT_RESET`：web 上 TextInput 的 outline 复位，全库只此一处 `any` |
| `src/util/digest.ts` [打开](<src/util/digest.ts>) | 152 | 月总结缺口与历史小结分组，组内不重排；缺口只吃「每月条数」（`countByMonth` / SQL 聚合） |
| `src/util/paging.ts` [打开](<src/util/paging.ts>) | 64 | 首页分页的纯判据：页大小、按 id 去重接页、窗口命中与整库命中的合并、还剩多少条（夹到 0） |
| `src/util/todoTree.ts` [打开](<src/util/todoTree.ts>) | 125 | 父子树、唯一完成级联计划与展开 |
| `src/util/qaScope.ts` [打开](<src/util/qaScope.ts>) | 65 | 记录/文档范围规范化与身份键 |
| `src/util/qaNote.ts` [打开](<src/util/qaNote.ts>) | 20 | 历史纪要文本包装工具，不是恢复旧整理产物入口 |
| `src/util/jsonRepair.ts` [打开](<src/util/jsonRepair.ts>) | 193 | JSON语法宽容修复与出错位置，不补残缺结构 |
| `src/util/urls.ts` [打开](<src/util/urls.ts>) | 61 | 链接提取与查询词构建 |
| `src/util/keyboard.ts` [打开](<src/util/keyboard.ts>) | 39 | edge-to-edge键盘高度与占位 |
| `src/util/docSupport.ts` [打开](<src/util/docSupport.ts>) | 208 | 云通道判据、显式解析分派和本地容量说明 |

### 4.8 自更新

| 文件 | 行 | 当前职责 |
|---|---|---|
| `src/update/check.ts` [打开](<src/update/check.ts>) | 172 | Release查询、节流、自动检查/跳过版本 |
| `src/update/mirror.ts` [打开](<src/update/mirror.ts>) | 66 | 自定义→官方→镜像候选顺序 |
| `src/update/download.ts` [打开](<src/update/download.ts>) | 316 | 停滞/低速切源、字节核验和content URI安装 |
| `src/update/notify.ts` [打开](<src/update/notify.ts>) | 142 | 下载状态通知；后台JS挂起时数字可能暂停 |
| `src/util/semver.ts` [打开](<src/util/semver.ts>) | 57 | 数值分段比较版本，不比较字符串 |

### 4.9 检查脚本

| 文件 | 行 | 当前职责 |
|---|---|---|
| `scripts/assert_md.cjs` [打开](<scripts/assert_md.cjs>) | 303 | 原有Markdown往返断言 |
| `scripts/assert_backup.cjs` | 243 | 完整备份的 19 项断言：命名、清单、四种拒绝、路径穿越过滤、SQLite 头、体积上限 |
| `scripts/assert_document_qa.cjs` [打开](<scripts/assert_document_qa.cjs>) | 483 | 限定文档问答/预算/引用 |
| `scripts/assert_document_jobs.cjs` [打开](<scripts/assert_document_jobs.cjs>) | 576 | 文档任务控制流 |
| `scripts/assert_readers.cjs` [打开](<scripts/assert_readers.cjs>) | 730 | 读取/切片/表格/协议等纯逻辑 |
| `scripts/assert_todos.cjs` [打开](<scripts/assert_todos.cjs>) | 392 | 父子待办和月总结规则 |
| `scripts/assert_ask.cjs` [打开](<scripts/assert_ask.cjs>) | 850 | 89项：问页意图、草稿与输出兼容；抽屉的挂载条件/压暗层/读屏屏蔽 |
| `scripts/assert_reliability.cjs` [打开](<scripts/assert_reliability.cjs>) | 1880 | 真实模块+内存桩的故障、授权、迁出/恢复和控制流回归 |
| `scripts/assert_appearance.cjs` [打开](<scripts/assert_appearance.cjs>) | 447 | 两轴外观、真实对比度、PDF与阅读器契约 |
| `scripts/assert_ui.cjs` [打开](<scripts/assert_ui.cjs>) | 798 | 45项纯内存UI布局/控件回归：语义字号、窄屏底栏、间距 token、空屏与分享契约，非真机视觉验收 |
| `scripts/assert_reminder.cjs` [打开](<scripts/assert_reminder.cjs>) | 227 | 13项：提醒时刻、不重排、3天冷却、账清就撤、正文与权限失配口径，外加「用 createSuite 的脚本必须设退出码」的卫生检查 |
| `scripts/assert_paging.cjs` [打开](<scripts/assert_paging.cjs>) | 159 | 10项：页大小、去重接页、剩余条数、SQL 的 localtime 口径、四处不再依赖全量数组、筛选只覆盖已加载、搜索两路合并 |
| `scripts/test_loader.cjs` [打开](<scripts/test_loader.cjs>) | 305 | 测试用内存编译/依赖桩/AST抽取，不加载真实数据库或网络 |
| `scripts/check_docs.mjs` [打开](<scripts/check_docs.mjs>) | 265 | 文档机器一致性（行数表连 .cjs/.mjs 一起查）；不得通过降低覆盖率躲检查 |

## 5. 数据模型与可靠性边界

结构版本仍为16，**没有本轮新表或改写历史迁移**。

| 存储 | 当前用途与兼容边界 |
|---|---|
| fragments / fragment_images | 原始记录与多张配图；保留旧tags/nature/单图列，定位标记和检索投影受同一提交保护 |
| todos | parent_id自引用两层；保留merged恢复关系，已完成仍有最近5条清理规则 |
| notes | 现行写月总结，旧类型仅兼容；不要重新执行历史日/周清理或恢复其入口 |
| documents / document_chunks / 专用FTS | 原件元数据、正文版本、切片与定位；正文不参加列表查询，索引必须与内容版本一致 |
| ask_sessions | 会话范围、问答/整理轮与引用快照；旧document_id与多篇document_ids兼容，删会话不删文档 |
| settings | 配置、两轴外观、搜索投影版本、整理工作区与草稿提交凭据，不需要为本轮另建表 |
| organize_runs / organize_sessions | 旧历史兼容存储，不是当前草稿恢复机制；不能因旧游标存在就认定内容已保存 |

- Native与Web接口同步，但Web内存测试不等于SQLite升级/文件系统故障测试。迁移执行器及完整备份仍需独立验收，不宣称本轮无schema变化已解决它们。
- 图片先落私有文件，再经Repo提交引用。失败只清确定未提交的文件；提交成功后刷新失败不能删引用或诱导重复发布。
- `insertFragmentImages`是一批提交；记录正文/定位/FTS、导入单条文字/旧标签/状态都守同一事务边界。
- `commitDraft`验证本地key与输入，只写明确批准目标。文档、父子待办、来源标记、会话关系和 `draft.commit.<draftId>` 凭据同事务；重复key/已删除旧目标不偷偷重建。
- 记录输入草稿在App内存持有；整理工作区存 `organize.workspace.v1`。不要把前者的跨页保留写成进程重启也可恢复。

## 6. 当前主要流程

### 6.1 记录与查找

App拥有正文、待发图片与唯一key → Repo提交记录/配图/定位/FTS → UI清除该次已提交草稿并刷新。提交与刷新错误分开处理，晚到回调不清后来新输入。

搜索投影是可见正文+图文字+事项，去掉图片定位语法，不含旧标签。Native索引同时核对条数和投影版本；FTS/LIKE兜底仍保留中文bigram口径。阅读器字面查找另用findHits及可见Markdown块，不拿相关性检索候选数报全文命中。

### 6.2 聊天式整理与恢复

```text
routeAsk / planDraftInput
  → useOrganize：选择来源、持有草稿与锁、按会话代次接线
  → executeOrganize：固定范围、pending材料、按需读图、保存检查点
  → extractKnowledge：fragments或session实际提炼，docs/todos/note
  → workspace：稳定身份、保留授权、可审阅产出、selectDraftTargets
  → commitDraft：原子写目标与凭据
  → 保存UI快照、刷新/历史（失败不否认已经提交）
```

- 全量范围是固定id列表，不按排序后的最大id推进；每批真实材料先留存，再发送。处理完成id与草稿一起保存，来源缺失另列。
- session-source真的使用所选会话问答；重试/改稿保留原来源、要求与历史，不退回最近40条。文档范围会话不夹带全库待办。
- 初始模型内容形状是docs/todos/note，内部使用bodyMd/keep/key等字段；key和授权由应用掌握，不让模型重新批准。新项无法唯一对上旧项时保守不勾。
- 存储串行化保存快照；恢复严格验证，和提交凭据对账。损坏/冲突停止并说明，不清掉后伪装一份新草稿；恢复不自动调用AI。
- 暂停阻止后续批次/未发图片与迟到写回，不能撤回已发送请求。保存失败需保留页面或提供明确补救，不悄悄丢产出。
- 单次输入预算、篇数和输出额度以当前函数为准；截断如实标明，JSON未完成不得补结构后写库。已保存项和逐项选择不靠数组下标识别。

### 6.3 文档与问答

导入仅复制/核验原件 → 可读判据分派原件或快照 → 用户另行选择本地准备/逐次确认云解析 → 应用级任务按版本写正文/切片/FTS → `isDocumentReady`允许限定提问。

- 阅读不要求索引已就绪；扫描PDF能看页面不代表有文字层/可问，超过本地上限仍能外部打开。
- 云解析发送整份原文件至mineru.net，每次重新确认。问答只发送所选资料片段到配置AI；图片识别会发图像，联网会发查询/链接，不能统称资料永远不离开手机。
- 文档会话最多8份且范围锁定，未就绪项不静默丢弃；空/非法范围不回退全库。D引用来自真实版本/切片/定位，旧正文不能反推PDF页码。
- PDF模板、协议、主题源需同步，生成物归Lead。白纸canvas不反相，高亮不盖字；主题变化不重挂。Excel按有效单元格、两层缓存和窗口渲染，文档长文本保持虚拟化。

### 6.4 月总结、待办与文字迁出

- 月总结仍由SummarySheet审阅并 `upsertNote`，不经整理草稿产生小结。按日事件表与重要进展替代旧固定三节；保留旧Markdown阅读兼容。
- 父子待办级联只认todoTree，合并过滤有效项；删父解除子关系而不连带删，合并转移子项；给完成父项加子项需重开父项。
- Markdown全量迁出已有可读文字、分钟时间与旧标签；原图、文档、月总结、会话、完整元数据不在里面。待办清单不导入，图片文字回来只是普通正文，多行及关系信息有损。
- 导入先审阅日期与范围，再出队重新判重，查询覆盖整分钟；部分成功报实际已写数并支持重试，不把每条原子提交说成全文件回滚。

## 7. 后续验收与交付提醒

1. Lead继续真实问题修复，冻结所有源码/测试后更新本表行数与最终验证结果，串行跑聚合检查、PDF生成及Web编译校验。不要由多个Agent抢同一生成物/临时目录。
2. 新增回归应使用真实模块和故障桩，覆盖提交凭据恢复、读图停止、OCR/事项/旧标签检索边界、500+文字导出、部分写入及连续重试；不要把手工等价算法测试当真实控制流通过。
3. Android设备验收按[ROADMAP](<ROADMAP.md>)与本轮提案补充：默认/墨水×明暗、窄屏/大字体、中文输入法、实际热区、草稿/附件切页、返回层级、PDF/表格定位、TalkBack与回焦。
4. 独立设计并验证完整备份/恢复与原生迁移故障保护；不得为试验直接清空真实库、卸载App或改历史迁移。
5. 通知栏快速记录、分享接收、Word/PPT本地版式等仍是后续范围，不因已有依赖就宣称完成。
6. 未获发布授权前不push/tag/Release。获准后由CI产出并核对Release非draft、raw APK asset、版本和字节数；代码恢复点、外观切回和手机数据恢复分别说明。
