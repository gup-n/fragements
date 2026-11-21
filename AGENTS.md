# 项目 Agent 速查

先读[当前交接](<HANDOFF.md>)、[SPEC 最新批准节](<SPEC.md>)与[当前 UI 修订](<docs/plans/2026-11-15-ui-polish.md>)，再读本次任务涉及的源码。历史原因在[CHANGELOG](<CHANGELOG.md>)，不要把旧说明当现行实现。

本文件是项目专属规则，不替代[上级工作区规范](<../AGENTS.md>)。2026-11-15 用户已授权并完成本次GitHub发布：`feat/ui-polish-20261115` 的tag `v0.20.6`（versionCode57）经CI 43677692760成功构建，公开APK下载、版本、哈希与旧版同签名已核验；真机未验。此授权仅对应本次版本，后续新tag/合并仍需确认。原v0.20.5恢复点、旧tag和master不动，近期备份/快速记录/分享实现保留。

## 1. 固定边界

- 个人单机 Android 应用：不引账号、后端、同步、导航库、状态库或设备级墨水屏驱动。本轮不新增依赖或数据库表结构。
- 实际技术栈以[依赖清单](<package.json>)为准：Expo SDK58、RN0.88、React19.3、TypeScript6。不要照标准 Expo Router 模板开发。
- 路由由[App](<App.tsx>)的state管理，当前是：

```ts
type Route = MainTab; // 五个页面即底栏五项，只此一处定义
```

- **没有标签入口、独立整理页或知识卡实体。** 整理在「问」里，以聊天和可审阅草稿呈现；产出文档/待办，不造新碎片，不改写来源原文。
- 回顾有待办 / 日历 / 小结三个 tab；日历是纯日期网格（`src/util/calendar.ts`），现行小结生成只有月。旧字段、旧记录或兼容解析的存在不代表要恢复已下线入口。
- 工作前检查分支、Git状态和差异，保护已有修改。多人按共享任务 `list → get → claim → complete` 工作；不越write scope，不擅改共享契约。Lead统一整合、全测、生成资源和Git操作。
- 本轮子Agent不commit/push，不切分支、不装依赖、不启动服务、不本地构建APK、不调用真实AI或外发用户文件。推送、合并主分支、tag/Release和真实数据操作须另获明确授权。
- `master` 和 `backup/pre-ui-20261114` 保留旧版 `5befe65`；本轮 `backup/pre-ui-polish-20261115` 保留 `76d91b0`（含近期备份/快速记录/分享）。旧开发分支和tag不动。Git恢复的是代码，不是手机数据库、附件或APK降级能力。

## 2. 验证与发布

[包脚本](<package.json>)是入口清单，[Android CI](<.github/workflows/android.yml>)是构建流程来源。

| 入口 | 覆盖 |
|---|---|
| `npm run typecheck` | TypeScript |
| `npm run test:md` | Markdown导入/导出往返 |
| `npm run test:docs` | 阅读器、文档任务、限定文档问答 |
| `npm run test:todos` | 待办层级、月总结 |
| `npm run test:ask` | 意图与整理草稿规则 |
| `npm run test:reliability` | 真实控制流、故障注入、授权与恢复 |
| `npm run test:appearance` | 两轴主题、对比度与PDF协议 |
| `npm run test:backup` | 新备份清单与路径等纯判据 |
| `npm run test:reminder` | 小结提醒的时刻、不重排、冷却、撤销与正文本 |
| `npm run test:paging` | 页大小、去重接页、剩余条数、SQL 的 localtime 口径、别处不再依赖全量数组 |
| `npm run test:ui` | 语义排版、窄屏导航、控件与原事件保留、分享契约、空屏只有一份 |
| `npm run check:docs` | 版本、文件行数、路径/链接、提示词等 |
| `npm test` | 以上检查的串行聚合 |
| `npm run prepare:pdf` | 生成产品PDF阅读器资源，Lead/CI执行 |

**断言脚本自己会不会失败，也要能查出来。** `createSuite` 的 `run()` 把用例异常收进返回值里
（为了打完整报告），所以只写 `suite.run();` 的脚本**失败也退出 0** —— `assert_ui` 就这样
白跑了两个版本（v0.25 修好，一跑从 28 项变成 37 项）。新写断言脚本必须 `process.exitCode`，
`test:reminder` 里有一条卫生断言专门查这个。`check:docs` 的行数表连 `.cjs/.mjs` 一起查了。
| `npm run build:web` | Web编译校验，产物同次清理，不供预览 |

- 并行开发期间不要各自跑整套检查、争用测试临时目录或生成PDF资源。可以做获分配范围的内存断言，最终集中验证由Lead负责。
- 不删测试、不降低断言、不忽略失败来制造绿灯；临时目录清理前核对绝对路径，只清理自己生成的可恢复产物。
- **构建交给CI，发布走获授权的tag → Release。** 只推主分支不会产生Release；手机更新只认Release的raw APK asset，不认需登录下载的artifact压缩包。
- 不把过去“自己本地打包”的说明当授权。不要手改原生生成目录；配置由[构建插件](<plugins/withBuildOptimizations.js>)和[启动窗插件](<plugins/withNoSplashAnimation.js>)维护。在已有本地工程上获准运行prebuild时必须带 `--no-clean`，不得默认清工程。
- CI使用Node22/JDK21；本机版本差异要记录。CI已有SDK，不盲加会与预装目录冲突的安装action；缓存键在prebuild后取。保持Release非draft及asset名称核验，不绕过现有发布检查。

## 3. 不做预览，不虚报视觉验收

- **不生成单文件HTML界面预览、不起预览服务、不用文件展示工具打开网页。** 产品PDF模板是运行资源源文件，不是预览。
- UI验证需设备已连接、安装包来源与版本已核对，并获得相应操作授权。先检查设备，没有设备就停止真机步骤，不去猜坐标或代称截图已看过。
- 每次模拟点按、滑动、返回后都要截图确认实际页面。命令exit 0不等于UI通过。
- ADB输入不能替代中文输入法测试；布局、手势、配色、字体、TalkBack、冷启动和原生WebView须按真实覆盖情况报告。没有图像能力时不能声称完成视觉审阅。
- 不用旧Release验收当前新界面。v0.20.6已发布并核验包内容；后续未发布源码仍须新构建验证。Markdown不是完整备份，不能随意卸载/清数据做试验。

## 4. Android UI与主题

- 禁用 `Modal`、`KeyboardAvoidingView`。覆盖层用 `position:absolute`，按层处理 `BackHandler`；键盘占位用[键盘高度hook](<src/util/keyboard.ts>)，不改变既有edge-to-edge约定。
- [App](<App.tsx>)向Ask转发关闭动作，`registerClose`等回调身份必须稳定。关闭顺序先顶层确认/引用/图片/菜单，再编辑或页面；不能一按返回丢掉未保存草稿。
- 详情只持有id/序列位置，从当前props/Repo得到新内容，不留业务对象快照。分页FlatList等实测宽度大于0才挂载；滑动集合和顺序必须与列表一致。
- 时间轴方向固定：长按复制、左滑露出删除并确认、右滑进入「问」。[SwipeRow](<src/components/SwipeRow.tsx>)不能裁掉伸出的时间线；只在明确横向意图时接管，不抢纵滚与长按。
- 拖动中的Animated值不要混原生/JS驱动。减少动效不能取消手指拖动反馈或隐藏任务状态；墨水/系统偏好通过 `reduceMotion` 控制程序滚动、回弹与装饰动画。
- 输入文字占整行，工具行展开在左、图片/发布在右；图片选择行必须在布局流里，不能绝对定位到键盘下面。Ask只在原本接近底部时随键盘滚动，不把正在读旧消息的人拉到底。
- 图标和页头优先复用[IconButton](<src/components/IconButton.tsx>)、[ScreenHeader](<src/components/ScreenHeader.tsx>)。实际触控槽至少48dp，不以相互重叠的hitSlop代替布局。
- 常用导航有短标签；selected/checked/disabled/expanded/busy等有语义与就近反馈，不只改变颜色。覆盖层隐藏下层无障碍树；[标题聚焦hook](<src/components/useHeadingFocus.ts>)只面向屏幕阅读器，关闭回焦须真机确认。

### 两轴外观（本分支开发中）

[主题Provider](<src/theme.tsx>)是唯一入口，[纯外观模块](<src/util/appearance.ts>)管理四套调色板、规范化与metrics。

- `ui_theme`：light/dark/system；`ui_style`：default/ink。两轴独立，非法旧设置安全回退；最终一次选择获胜。持久化失败要说“本次已应用但未保存”，不能假称永久成功。
- 颜色来自 `c`；圆角、边线、48dp控件高度来自 `metrics`。字体/行高使用主题入口导出的 `TYPE`，留白使用 `SPACE`；装饰边线用 `surfaceStroke(metrics)`，选中和焦点仍保留明确轮廓。不可关闭系统字体缩放来修窄屏。
- 旧单参数样式工厂兼容，新工厂可接两参数：

```ts
const makeStyles = (c: Palette, metrics: ThemeMetrics) => StyleSheet.create({
  button: {
    minHeight: metrics.controlHeight,
    borderRadius: metrics.buttonRadius,
    backgroundColor: c.accent,
  },
});
const { c, styles, metrics } = useThemedStyles(makeStyles);
```

- JSX内联颜色也用 `c`；不要在模块加载时固化带色StyleSheet或带色常量数组。实心强调按钮用 `c.onAccent`，危险按钮用 `c.onDanger`，媒体背景/字色/遮罩用媒体语义色。
- 不以主题值作为页面、编辑器或WebView的key，切风格不得重挂而丢页码、查询、正文或附件。
- 墨水是界面风格：照片/PDF canvas保原色，不全局反相或灰度。PDF白纸上的高亮用纸面专用半透明墨与轮廓，不能用深色界面的白色accent盖白纸。
- 原生启动窗早于JS偏好加载；没有原生偏好桥，不承诺完全消除冷启动色差或提供设备级局刷/防残影。

### v0.20.7 起的两条硬约束

- **主入口在底栏，不在页头**。timeline/docs/ask/review/settings 五项由[底栏](<src/components/TabBar.tsx>)平级切换 —— **设置也在里面，它不再是覆盖层**。五个页面都是 tab，没有「覆盖层形态」：`embedded` 为真时不画返回箭头、不画关闭叉，出口就是底栏。键盘抬起时底栏整条隐藏，所以页面自己的 `keyboardHeight` 占位不要额外加底栏高度。**页面底部就是底栏顶边**（`SafeAreaView` 里是「页面 + 底栏」竖排），所以页面里的 `Toast` 不加底栏高度；只有 App 根节点那个和底栏同父的 `writeNotice` 要加 `TAB_BAR_HEIGHT`。页面底部若有工具条（如文档多选的底条），用 `onLayout` 实测它的高度 —— v0.23.1 文档页写的是 `TAB_BAR_HEIGHT + 8`，多选时又换成写死的 `96`，提示条一直悬在半空。`assert_ui` 钉着「这个常量只许出现在 `App.tsx`」。
- **「要不要画边线」看 `metrics.outline`，不要从圆角大小反推**。以前是 `cardRadius <= 4 ? strokeWidth : 0.5`，墨水圆角一调圆（4→8）就静默掉回 0.5，边线全没而 tsc 与断言都不响。`surfaceStroke` 现在读 `outline`；新增风格时必须显式给这个字段。
- **毛玻璃（[GlassBackdrop](<src/components/GlassBackdrop.tsx>)）只给墨水风格**，且宿主卡片的 `backgroundColor` 必须用 `glassable(metrics, c.card)` 让出实底 —— 不透明底会把模糊盖死，看起来像什么都没做。Android 侧必须 `experimentalBlurMethod="dimezisBlurView"`，默认那套只是半透明白。`assert_ui` 里为它留了桩，改它的导出签名要同步改断言。
- **缩视觉可以，缩触控不行**。搜索框、缩略图、空状态图标、工具按钮都可以小一档；48dp 槽、发布按钮 84 宽、输入框 48 高是断言钉着的无障碍底线，用户说「缩小」也不放开。
- **空屏只有 [EmptyState](<src/components/EmptyState.tsx>) 一份实现**（v0.24）。要「希望用户做点什么」的整屏空屏才用 `tone="accent"`，全 App 只许首页一处；列表为空的占位用 `fill`。别再自己拼 `emptyIcon` / `emptyTitle`，`assert_ui` 会拦。
- **次要文字用色阶，不用 `opacity`**。`opacity: 0.45` 乘在 `text3` 上只剩 2 出头的对比度，深色下几乎看不见；禁用态（`btnDisabled` / `off`）是唯一例外。

## 5. 存储、历史兼容与配图

- [Repo接口](<src/db/types.ts>)、[Native实现](<src/db/repo.native.ts>)和[Web实现](<src/db/repo.web.ts>)必须同步。Web驱动服务编译/内存测试，不证明原生SQLite迁移、文件或事务故障已验。
- **17段已发布迁移不改写，旧id/字段/原件路径不随清理删除。** 数据库结构为v17（v0.28 加软删、`stage`/`origin_id`、`doc_tags`/`doc_tag_links`/`doc_proposals`）；v0.34 起每一版的 SQL 与版本号在同一个事务里，但仍缺一次「升级中途断电」的真机验收（现在最多验证到代码级事务边界）。
- 保留旧 `tags`、`nature`、旧会话指针等兼容字段。标签不是实体，不建标签表或恢复管理UI；清理导入标签时 `cleanTag` 保留显示大小写，`normalizeTag` 只作比较键，统一去重逻辑。
- v16已把单图列迁入 `fragment_images`；旧 `image_path` / `image_text` 列不删。每张图有独立id、路径、ordinal和文字状态，忙碌/失败集合的键是**配图id**。
- `text === null` 表示未读，空串表示已读但无字；两者不能混。自动读图只在需要材料时发生，保存图片不触发模型。读图应串行、守预算，失败和剩余数量如实报告。
- 读图结果写库后还要更新本次材料对象；每次await后核对取消/代次，停止后不发后续图片，也不让迟到结果写入新状态。停止不等于撤回已上传字节。
- 新增碎片的正文、配图、待发标记替换与FTS在一次提交内；已有碎片一批加图走 `insertFragmentImages`，不能单张循环造成部分成功。
- 文件只在**确定未提交**时清理。提交后刷新失败属于非致命提示，不能删已引用文件、清掉后来新输入或诱导重复发布。
- App持有记录正文、待发图片、唯一待发键；它们跨页面/风格保留，但当前没有进程重启恢复承诺。不要和整理工作区的持久化混为一谈。
- 正文配图标记仅走[inlineImages](<src/util/inlineImages.ts>)：光标插入、pending键换id、去重与删除标记。模型材料、检索、文字导出剥离定位语法；原图与图片文字不是同一数据。
- 历史SQL清空字段沿用 `NULL` 字面量，不把已踩过坑的UPDATE改回绑定null；不拿驱动返回的 `changed === 0` 判失败。刷新与实际提交状态分别处理。
- **`fragments` 不再是「全部」**（v0.26 起）。它是首页已加载的一窗（首屏 200 条，往下补）。
  「一共有多少」「哪天有几条」「每月有几条」一律走 `totalFragments` / `dayCounts` /
  `monthCounts` 三个聚合；**不许**在任何页面里对 `fragments` 做 `filter(...).length` 当统计用。
  导出/备份是例外 —— 那是「把东西完整拿走」，继续用 `listAllFragments()`。
- **SQL 的分组必须带 `'localtime'`**：`created_at` 是毫秒时间戳，`strftime('%Y-%m-%d', created_at/1000, 'unixepoch', 'localtime')`。
  少了它，UTC+8 的夜里记的东西会被算到前一天/前一月 —— 日历上「今天明明记了」却没有点，
  而桌面时区跑断言看不出来。改这里要同步 web 侧（它用同一个 `dayKey` / `countByMonth`）。
- **首页搜索必须同时问库**（`repo.searchFragments`），不能只过滤已加载的那一窗。
  v0.26.0 就栽在这里：`includes` 一窗 = 搜不到更早的记录，界面还很确定地说「找到 0 条」。
  两路合并的判据在 `util/paging.mergeWindowHits`。
- **`onLoadDay` 这类回调必须 `useCallback`**。日历把它当 effect 依赖，每次 render 换新函数
  就会「读到 → setState → 重渲染 → 再读」，日历一打开就不停发查询。
- **`TYPE` 是会变的导出**（v0.26 字号档位）。它现在等于「当前档位下的一套字号」，
  改档位必须先 `setTypeScale(scale)` 再 `setTypeScaleState(scale)`，顺序反了第一帧还是旧字号。
  不要在模块顶层把 `TYPE.body` 存进常量（那时读到的是标准档，之后永远不变）。
- **系统分享的 json 有两个形状**：v0.25 起是 `files: [{file, name}]`，之前是单个 `file`/`name`。读的时候两条都要认 —— 升级前分享、升级后才打开 App 的机器上，磁盘里躺的是旧形状。`disk`（安全名）只用来删文件，`name`（原名）才入库。
- **分享的幂等键在读的时候就推进了**（`share_last_at`），所以「读到了」不等于「存进去了」。一份都没存成功时必须 `rewindIncomingShare(prevAt)` 退回去，否则文件还在私有目录、界面什么都没有 —— 静默丢内容。已经存进去一部分时不许退（会让那部分再进一遍）。
- **两条本地通知各认各的 `kind`**（`quick-record` / `digest-reminder`）。都靠 `getLastNotificationResponseAsync` 补冷启动那一次点击，所以谁都不许无条件 `clearLastNotificationResponseAsync` —— 那会把另一条的手势吞掉。新增第三种通知时同样处理。

- **删除一律是软删**（v0.28）。`deleteFragment` / `deleteDocument` / `deleteAskSession`
  只写 `deleted_at`，**不删行、不删文件** —— 30 天内恢复要能看到图、能打开原件。
  真删只有一条路：`purgeRefs`（`purgeTrash` / `purgeExpiredTrash` 共用它）。
- **每一条列表查询都要带 `deleted_at IS NULL`**，这是软删唯一的系统性风险：
  漏一条不会有任何报错，界面上只是删掉的东西又冒出来一条。
  `npm run test:recycle` 逐条扫 SQL 来钉它：例外只有两类 —— `DELETE FROM`，
  或者语句前 400 字内有 `trash:ok` 并写清理由（针对「按 id 读一行」这类必须能看到已删行的内部动作，
  比如 `reindexFragment`）。加例外前先问自己「真的不能只读没删的吗」。
- **写也要挡**（v0.34）。`UPDATE documents / fragments / ask_sessions` 同样要带
  `deleted_at IS NULL`：迟到的云解析、AI 提案、保存会话都会写进已删的行，
  恢复时看到一份「删除那一刻并不存在」的内容。`saveAskSession` 还要看影响行数，
  0 行就抛错，不许返回一个假 id。那条扫描器只看 `SELECT`，写路径靠单独三条断言钉。
- **一次业务动作里的多条写必须同事务**（v0.34）：待办的 insert/toggle/delete/merge、
  改标签 + 重建索引、迁移的 SQL + `PRAGMA user_version`。分开写的失败态是
  「父项打勾、子项没打勾」这类自相矛盾的数据，没有任何操作能修回来。
- **一条迁移 = 一个事务**。迁移里有 `ALTER TABLE ADD COLUMN`，不可重入；
  两句分开执行时中途被杀，版本号停在旧值、列却加上了，下次启动就报 `duplicate column name`，
  而启动流程把 `init` 的错误只 `warn` 掉 —— 应用照常打开，跑在一个半截的库上。
- **FTS 行在软删时就要删掉**，恢复时 `reindexFragment` 补回。它是投影不是数据：
  留着会让启动自检「索引条数 = 碎片条数」永远不等，每次启动白重建一遍索引。
- **文档的 `stage` 只有 `library` / `archived`，没有 `draft`**。用户 2026-11-18 定的是
  「新建文档自动入库」；草稿是出生时挂的标签（`DEFAULT_DOC_TAG`），不是另一块存放区。
  留一个没有写入路径的枚举值，只会让「这篇在哪」多一条分支。
- **新建文档只走 `repo.createDocumentWithContent`**（v0.35：记录 + 正文切片 + 标签同一个事务），
  **改正文走 `contentFromText` → `replaceDocumentContent`**（`documents/authored.ts` 一处）。
  在调用侧拼 `insertDocument` + `replaceDocumentContent` + `setDocumentTags` 时，第二步失败会留下
  一篇「列表里有、点开是空的、也没有任务会去补」的文档 —— 这种错在界面上看起来完全正常。
- **`repo.web.ts` 只有一条写路径 `writeAtomically`**（v0.35）。`persist()` 已删；新增写方法就
  `return writeAtomically((d) => { ... })`，回调必须同步、不许调公开的 async Repo 方法。
  没有 localStorage 时它抛错 —— 不要再加 `?.` 或 `catch`，那等于把「没存上」说成「存上了」。
- **启动失败要停在 `components/BootError`**（v0.35），不许「warn 一句然后照常进门」：
  那样列表是空的、统计 0 条，首页还写着「还没有碎片，记一条试试」，用户会以为记录没了。
  `App.boot()` 是唯一入口，重试也走它 —— 别再写第二条初始化路径。
- **标签查重只有一把尺子 `util/docTags.docTagKey`**（v0.35）：全半角与大小写折叠，**标点不折**。
  native / web / `attachTagNames` 三处同源。**不做数据迁移、不自动合并已有标签** ——
  合并标签是在改用户的组织方式（他可能故意用「读/写」和「读写」区分两件事）。
- **AI 层不碰数据库**这条在 v0.28 有断言（`ai/docEdit.ts` 不许 import `db/`）。
  AI 产物一律走 `doc_proposals` → `documents/proposals.approveProposal`；
  **放弃不写业务表**，只留一条 `rejected` 审计。优化/重新整理只新建一篇，原稿一个字不动。
- **撞到输出上限（`finish_reason='length'`）不返回半篇**。截断的正文存成新文档之后，
  没人分得清它和原稿的差别 —— 宁可报错让人重试。
- **批量是一篇篇过**（`util/docBatch`）：一次只有一个 `running`，每篇都停在 `review` 等用户点。
  没正文的**安静跳过**（不是失败），但收尾那句必须把跳过与失败都数出来，
  否则用户会以为全都处理了。
- **首页冷启动不许自动聚焦输入框**（v0.30，用户 2026-11-19 定的）。只有
  `focusSignal`（通知栏「记一条」点进来）那一路才 `focus()` —— 从通知进来的人目的就是打字，
  冷启动进来的人多半是来翻的，键盘先挡住半个屏幕。别再以「记录工具打开就该能打字」为由加回去。
- **回收站是设置根页的一行**，不在「数据与备份」子页里；它也不是底栏项。
  改位置时 `assert_recycle` 会拦：那条断言查的是「这一行落不落在 `pane === 'root'` 段内」，
  光把字符串留在文件里没用。
- **状态是 `DocStage` / `TrashKind` / `ProposalKind` 这些联合类型，别再散成字符串**。
  新增一种回收对象或提案类型时，改类型、加迁移、补 `assert_recycle` 三件事一起做。

## 6. 搜索与Markdown文字迁出

- [fragmentText](<src/util/fragmentText.ts>)统一正文/图文字；`fragmentSearchText`只投影可见正文、OCR和事项，不以已下线标签形成隐形命中。
- 中文检索保持FTS5+bigram，不能换成unicode61整句或对短词无效的trigram。碎片FTS rowid就是碎片id；影响投影的写入同步重建该条。
- 索引复用同时核对条数和投影版本；版本变更需主动重建，不能只比条数。FTS失败/零命中保留转义后的LIKE兜底，不丢掉中文短词。
- 导出必须独立 `listAllFragments`，不能沿用首页窗口或仅提高limit。时间范围查询、按id查材料也不能先取有限列表再自己筛。
- [mdBuild](<src/util/mdBuild.ts>)、[mdParse](<src/util/mdParse.ts>)和[mdExport](<src/util/mdExport.ts>)是同一文字格式的两端/投影，修改须一起验证。
- Markdown包含可读碎片文字、分钟时间和旧标签；已有图文字是文本，未读/无字图明确占位；原图、文档、月总结、会话和完整元数据不在里面。多行压为一行、事项/合并关系不能原样恢复，待办清单只供阅读且不导入。**不得声称完整备份。**
- 导入只从用户确认的预览写入，判重用唯一 `fragmentKey`；时间查询覆盖首尾整分钟。每次写入重新查询，导入调用串行化；每条原子提交，整份部分成功要报已写条数并支持安全重试，不冒充全文件回滚。
- 导入支持旧正文与新文字迁出投影判重；纯图没有旧正文时不能登记共享空串别名，否则会吞掉不同图片条目。
- 文件选择器不按单一Markdown MIME过滤；错误文件由二进制检查拦。日期需真实校验，回退日期或无日期必须在预览明确说明，不能静默当今天。块注释不要直接写会提前结束注释的MIME通配符。

## 7. 文档任务与阅读器

- **保存原件、应用内读、提取正文、能问是四种能力。** 本地格式/容量由[formats](<src/documents/formats.ts>)和[docSupport](<src/util/docSupport.ts>)的现有判据决定；[readerAvailability](<src/documents/readers/readerAvailability.ts>)分派原件/快照，不把 `isDocumentReady` 用作阅读门槛。
- 导入只复制原件、核验真实字节数、去冲突并写stored元数据；不提取、不建索引、不发请求。云配额不是导入上限。
- 本地准备/云解析只向[应用级任务服务](<src/documents/jobs.ts>)下单。每文档互斥；`runId` 与 `expectedRevision` 防迟到写回，删除/取消后结果不得覆盖新内容。启动收拾失去任务的parsing记录，不自动重发。
- 云上传每一次（首次/重试/换通道）都先显示文件、大小、`mineru.net`、所选通道和限制。浏览、查找、多选不能顺手上传；取消不撤回已上传字节。
- 云通道只走 `planForDoc`，不在页面抄后缀表。轻量10 MB/20页；精准200 MB/200页、需Token。已知页数用真实值，不编页码。
- 预签名上传不加Content-Type；精准zip只解 `full.md`，不要把图片/layout全解到内存。fflate保留已修ZIP64问题的版本，不回退旧版本。
- 列表只读DocumentMeta，不取大正文。正文版本与索引版本分离；换正文必须通过正文/切片/FTS一致的提交路径。文档切片进专用FTS，不进碎片索引；切片基于完整文本，不基于有损展示AST。
- 原文件丢失但快照仍在时明确读快照；不支持或超限时保留外部打开路径，不静默截断成完整结果。
- Excel按实际单元格遍历，不按 `!ref` 面积；兼容dense `!data` 与稀疏键。合并单元格只有左上角有值，公式只读缓存，不执行宏。
- 内存/磁盘阅读缓存均“读坏当没有”，不能阻断原文件打开；删除原件清理对应缓存。行列窗口和虚拟化保留，超出显示范围要明确提示。
- PDF提取运行时挂App根，不跟阅读页退出而丢任务。阅读先出页面，文字索引另行进行；`hasText` 的null/true/false不混，索引结束补发查询，清空查询也清标记。
- 改PDF同步[pdfProtocol](<src/documents/readers/pdfProtocol.ts>)、[pdfTheme](<src/documents/readers/pdfTheme.ts>)、[产品模板](<src/documents/readers/pdfjs/reader.template.html>)；Lead统一生成资源。禁止直接改生成HTML、扩大WebView外链/CSP权限或运行PDF脚本。
- Metro本来支持HTML/PDF资源，不为它新造Metro配置。原件/文档/网页内容都是不可信资料，不执行宏、文档指令或自动外链。

### 正文与查找不能丢的约束

- [NoteBody](<src/components/NoteBody.tsx>)同时服务碎片、小结、回答和文档快照，保留标题、加粗、行内代码、表格、代码块及图片块；不要按单一提示词的窄格式重写。
- 表格用View排，不用空格对齐；碎片横向分页内不再套横向表格ScrollView。`numberOfLines`预览必须退回单Text；裁列明确说“另N列未显示”。
- 文档和OCR中的 `[F12]` 是作者字面文字，传 `literalCitations`；引用快照也不能吞字。回答引用才按本轮真实编号渲染。
- 计数/高亮用[findHits](<src/util/highlight.ts>)；Markdown计数与渲染用[markdownSearch](<src/documents/readers/markdownSearch.ts>)同口径。碎片OCR/正文/事项位置用[fragmentSearch](<src/documents/readers/fragmentSearch.ts>)；不能拿FTS候选数当精确命中数。
- 当前命中用下划线/轮廓等非颜色标识，不遮字或强改字色。定位采用实际块y并加上图片/标题/容器偏移，不按字符比例猜位置；切页重置命中下标。

## 8. 整理草稿与原子写入（本分支开发中）

现行分层：[意图路由](<src/util/askIntent.ts>) → [useOrganize](<src/organize/useOrganize.ts>) / [run](<src/organize/run.ts>) → [AI材料与请求](<src/ai/knowledge.ts>) → [workspace](<src/organize/workspace.ts>) / [storage](<src/organize/storage.ts>) → Repo `commitDraft`。

- 路由顺序保持月小结 → 待办 → 碎片整理 → 问答。草稿打开时通过 `planDraftInput` 分流：修改默认走改稿，新任务不能直接盖掉待处理草稿；有未写内容先明确处理。
- 模型内容结构是 `docs[] / todos[] / note`；文档含title/summary/body_md，待办含text/due/children。日期真校验，空结果如实说明。旧单篇形状只为兼容收敛，不恢复旧标签/合并规划流程。
- 只从材料提炼事实，保留参数、命令、路径、报错原文；每次请求的材料预算和截断说明与源码一致。输出受限必须在JSON修复前拦截，不补出一份“完整”残稿。
- 稳定 `draftId` 和条目key由本地掌握，不能用数组下标当已写身份。改稿只修内容；用户取消的keep/权限不得恢复。不能唯一匹配的新项保守不勾，并提示需重审；已写入内容不被模型重写。
- 每篇产出都能审阅；展示计数、按钮文案和实际写入只用 `selectDraftTargets`，不能隐藏后几篇却让“全部写入”包含它们。
- 来源明确为fragment ids或session turns。历史“整理成文档”必须真正执行会话来源提炼；重试保留原材料/要求/会话，不换成最近记录。限定文档会话的提炼不夹带全库待办。
- 全量整理固定id范围与次序，不按日期排序后再用最大id当进度。当前批次/失败请求保留准确材料；缺失来源单列，不标成已处理。
- 草稿、授权、已处理id和pending批次一起存现有settings的 `organize.workspace.v1`，先留准确请求再发送。保存失败不能抹掉内存产出或让页面无声退出。
- 恢复先对账 `draft.commit.<draftId>` 的事务凭据；凭据/快照损坏或冲突必须停下来，不换新身份重插。恢复只恢复本地状态，不自动重发AI。
- 写入使用 `commitDraft`：只传用户批准目标；文档正文/切片/FTS、父子待办、来源标记、会话关联及凭据同事务提交。重复key不复制，已写项后来被用户删除也不偷偷重建。
- 已提交后的刷新/草稿快照保存失败和未提交失败分别提示；回调核对草稿/会话代次，不把旧请求写到新会话。
- **整理计划这条路径已在 v0.23 整条删除**（`util/organizePlan.ts`、5 个整理会话方法、`saveRun`/`markRunApplied`，以及 `OrganizePlan`/`OrganizeSession`/`BatchResult` 等类型）。续跑靠 `ask_sessions` 与游标，**不要**再读 `plan_json`，也不要照着 SPEC 旧章节重建确认页。另外 `documents/knowledge.ts` 也已在 v0.23 删除（现行写入只走 `Repo.commitDraft`）；`markMerged`/`markStatus`/`setFragmentNature`/`countInbox`/`countFragments`/`listFragmentIds` 同样已删 —— 碎片合并不在界面上（待办合并仍走 `mergeTodos`），`merged_into` 只有「取消合并」会写。

## 9. 问答、流式与历史

- 请求统一经[chat](<src/ai/chat.ts>)；流式用 `expo/fetch`，同一TextDecoder实例逐块调用 `decode(chunk, { stream: true })`，不要换回没有response.body的旧RN fetch。
- reasoning_content只展示/按既有字段保存，content才参与答案或JSON解析；UI流更新节流。思考展示不依赖busy存活，答完不能消失。
- 四段超时保持建连90秒、首字120秒、空闲60秒、硬上限12分钟；不要改成一个总超时。
- `max_tokens`包含思考与正文。先读finish_reason再读可能为空的delta；length/资源不足/空输出分别解释。额度遵从当前请求函数与服务商能力，不抄旧12K/6K或整齐但失真的统一数字。
- 官方模型使用已配置支持的 `deepseek-flash` / `deepseek-v4-pro`，不用已停用旧名；effort只对支持它的官方接口生效，不把“high”等同于显示思考的开关。
- 问答用 `json:false`。只装填检索后的资料并守总预算，历史只带问题/回答，资料每轮重新检索。直接上下文碎片优先且可绕过merged过滤；不恢复已删除的标签意图检索。
- 文档范围合法且锁定，空/非法范围不回退全库；用[D引用检索](<src/ai/documentRetrieval.ts>)保留版本、片段与真实定位，不把局部检索说成通读全文。
- F/N/T/W/D引用只接受本轮给过的编号，编号按首次出现顺序；历史引用用快照，不依赖原记录仍在。行内/块代码的标记不是引用。
- 联网只有用户打开后发送才执行：有链接走fetch，没有才search；失败保留本地回答与明确失败信息。网页标题/链接可作为独立来源显示，不依赖模型一定写W标记。
- `ask_sessions`与碎片分开；每轮完成保存，切会话校验代次，不因重复退出把旧历史顶到最前；归档不改活动时间，删除有确认且不连带删已产出文档。旧document_id与document_ids指针兼容读写，删文档两者都处理。
- **回答版本（v0.33，抄 chat-demo 的 message branches）**：`QaTurn.variants[]` + `active` 是唯一真相，`variants[active]` 必须经 `ai/variants.ts` 的 `mirror` 回写到旧字段 —— 旧版 APK 与 `qa.ts` 都读旧字段，别在界面里手拼 `variants`。重新生成 / 改问题只追加不覆盖，上下文只取这一轮之前（`historyBefore`），绝不能带本轮的旧答案；切换与追加立即落库；每轮上限 `MAX_VARIANTS`，当前版不丢；失败重试记住原轮次（`lastRun`），不能退化成新开一问。
- 错误保留阶段、状态码、finish和原始返回等证据，默认短提示、需要时展开；日志/诊断不得包含API密钥或未经授权的用户全文。

## 10. 待办与月总结

- 两层父子关系只用[todoTree](<src/util/todoTree.ts>)的规则，两端Repo共用。父项勾选级联，子项全部完成才完成父项，取消子项取消父项，取消父项也取消子项。
- 计算兄弟时排除merged项；父项不在有效列表不能回写。给已完成父项加子项要重开父项。
- 删除父待办先解除子项parent_id，不连带删子项；合并要转移子项。导出/问答统一flatten，不漏孤儿。
- 已完成清理仍按真实完成时间及旧数据回退规则保留最近5条，不要改成永久存档或声称待办导出能恢复它。
- 月总结保存仍走 [SummarySheet](<src/components/SummarySheet.tsx>) → `upsertNote`；同周期查询用 `findNote`，不取有限列表自己筛。批量生成传明确period参数，不在队列里读取尚未更新的state。
- 月总结现行格式是按日事件表和重要事件/进展，不强制旧三节。旧已存Markdown继续可读，不重写历史内容。
- 时间轴与回顾的排序分别核对；`periodAnchor`为月末锚点，时间轴还会按月/日结构展示；[groupNotes](<src/util/digest.ts>)组内不另排序。阅读器传列表同一批数据并保持顺序。

## 11. 更新、SDK与文档维护

- 更新源只认GitHub Release。候选顺序自定义地址 → 官方 → 内置镜像；保留停滞/低速切源，按bytesWritten而非“是否收到回调”判进展。切源提示不能与用户主动取消混淆。**切到后台期间两个判据都不算**（`update/resume.ts` 的 `stallApplies`）：进度回调本来就要等回前台才补发，照判会把正常跑着的后台下载掐掉 —— 这正是 v0.32 之前「切走 10 秒回来从头下」的根因。
- 下载完成核验字节数；安装通过content URI交给系统，不能直接传file URI。保留当前新文件API与legacy content URI桥的明确分工；后台JS被挂起时通知数字不实时，不承诺前台服务能力。
- **下载必须可续**：`createDownloadResumable` + 残包旁的 `fragments-update.json`（版本/源/目标大小），能不能续只由 `resumeOffset` 判。不许退回一次性的 `File.createDownloadTask`（不能给 Range），也不许在面板卸载时删残包（用户切走/关面板就白下）。
- 版本比较用[semver工具](<src/util/semver.ts>)，不比较字符串/parseFloat。不要因网络失败伪称有更新或无更新。
- Expo/RN接口先核对已安装版本的源码/类型与对应版本文档。网络fetch401等失败只说明没取得资料，不凭记忆编造新版API，不自主改搜索/代理配置或装依赖。
- 正式记录各司其职：[README](<README.md>)讲产品，[SPEC](<SPEC.md>)讲批准设计，[HANDOFF](<HANDOFF.md>)讲现状，[ROADMAP](<ROADMAP.md>)讲剩余事项，[CHANGELOG](<CHANGELOG.md>)留历史；[TEXTS](<TEXTS.md>)是提示词与文案索引。
- 改功能先由相应owner更新批准规格；提示词改动同步对应文案记录。机器检查只覆盖部分完整抄录，不代表节选/业务含义无漂移。
- 保留HANDOFF主要源码行数表并同步新增模块；不删地图、不改正则、不弱化检查来躲漂移。开发中先写测试入口/范围，源码冻结后由Lead填最终行数、实跑数量和未验项。
