# 项目交接：当前开发分支

最后整理：2026-11-14。本文记录当前工作树与接手入口，**不是发布说明**。先读[SPEC最新批准节](<SPEC.md#2026-11-14-已批准可靠性修复与两轴外观>)、[方案A](<docs/plans/2026-11-14-ui-refresh-ink-proposal.md>)和[实施契约](<docs/plans/2026-11-14-implementation-contracts.md>)；操作规则见[项目AGENTS](<AGENTS.md>)，历史原因查[CHANGELOG](<CHANGELOG.md>)。

## 1. 三十秒速览

个人单机Android应用「碎片」：随手记文字/图片，之后在「问」里提问、整理碎片/待办或发起月总结。整理以聊天和可审阅草稿呈现，确认后写文档/待办，来源碎片原文不改。

| 项 | 值 |
|---|---|
| 工作目录 | `F:/coding/python/project/Test/fragments` |
| 包名 | `com.local.fragments`，不变 |
| 版本 | v0.20.5 / versionCode 56 |
| 开发分支 | `feat/ui-refresh-ink-20261114` |
| 发布状态 | 2026-11-14改版开发中，未发布；版本号仍沿用发布基线 |
| 基线与代码恢复点 | `master`、`backup/pre-ui-20261114` 均保留 `5befe65` |
| 技术 | RN0.88 / Expo SDK58 / React19.3 / TypeScript6；Android单端 |
| 数据 | 本地SQLite和私有文件，已有16段结构迁移；无账号、后端、同步 |
| AI | 配置的OpenAI兼容服务；官方支持模型使用 `deepseek-flash` / `deepseek-v4-pro` |

**不要恢复旧入口：** 没有独立整理页、知识卡实体或标签管理/筛选。回顾只有待办和小结；现行小结生成只有月。旧tags、旧类型、旧表或兼容解析仍保留，不表示有对应UI。

路由由App的state管理：timeline / settings / review / ask / docs，没有Expo Router。记录正文/待发图保存在App生命周期；整理工作区另有settings持久化，两者不是同一恢复机制。

## 2. 当前进度与未覆盖项

用户已回复「开始」批准方案A。以下是**本分支代码改动**，仍需Lead最终整合检查和后续设备验收；现有Release安装包不包含本分支新增改版。

- 主题改为明暗 `ui_theme` 与风格 `ui_style` 两轴；新增默认/墨水四套配色、动态几何、48dp控件、非颜色状态和减少动效策略。没有原生偏好桥或实体墨水屏刷新驱动。
- 主页面、输入、问答/整理、回顾与阅读器使用共享控件。文档操作可展开收纳；PDF白纸原色不动，高亮/选区用半透明灰墨与轮廓，主题只发消息不重挂WebView。
- App/两端Repo调整记录与图片原子提交、全量读取、可见搜索投影和文字迁出；提交后刷新失败不清已引用文件。
- 整理执行移至organize模块：稳定身份、逐项授权、真实session-source、原材料重试、固定id范围、草稿/进度一起保存。批准写入使用原子提交与持久凭据，恢复与凭据对账，不自动重发AI。
- 清理只限已确认的孤立组件、未使用取色函数和Web演示注入。旧迁移、存储字段、平台变体和兼容解析仍保留。
- 新可靠性/外观检查已加入包脚本和本地CI配置；本轮未以此宣称已经在远端发布成功。

### 验证入口与范围

源码已冻结，2026-11-14 由 Lead 串行实跑下列检查。**这是本机（Node 24.14.1）在开发分支上的结果，不是发布验收。**

| 入口 | 实跑结果 |
|---|---|
| `npm run typecheck` | 通过，0 错误 |
| `npm run test:md` | 24 项通过 |
| `npm run test:docs` | 71 项通过（问答 16 + 任务 8 + 阅读器 47） |
| `npm run test:todos` | 18 项通过 |
| `npm run test:ask` | 83 项通过 |
| `npm run test:reliability` | 88 项通过（真实控制流 + 内存桩） |
| `npm run test:appearance` | 45 项通过（两轴主题 + PDF 协议） |
| `npm run check:docs` | 通过 |
| `npm run build:web` | 通过，产物同次删除（不供预览） |
| `npm run prepare:pdf` + `--check` | 资源已按冻结模板重建且校验最新 |

旧回归 196 项与新增 133 项（88 + 45）合计 **329 项机器检查通过**。另有一次性的 Node 内置内存 SQLite 实验（17 场景、132 条断言）验证了 native Repo 的真实 SQL 语义；它不在 CI 套件内，也不等于 Expo Android 驱动或真机迁移验收。

**不能据此宣称通过的项目：** 真机布局/字体/配色、中文输入法、TalkBack与回焦、手势跟手感、原生WebView/PDF、覆盖安装、原生SQLite迁移及故障恢复、真实模型输出。源码与内存桩不等于原生端到端验收。

**仍单列的风险：** 16段历史迁移执行器未完成专门的事务/备份故障验收；Markdown不是完整数据库/附件备份；Git恢复点不能恢复手机数据；冷启动原生颜色与JS偏好可能不同。不要写“功能完整、只差装包”。

### 仍未实现（本期未覆盖，不要当成已完成）

| 项 | 现状 |
|---|---|
| 原生迁移事务与迁移前恢复点（F11） | `repo.native.migrate` 仍逐段 `execSync(MIGRATIONS[i])`，无事务/备份；只做了一版内存 SQL 可行性实验，未改实现 |
| 统一排版体系 | 无字号/间距 token；`metrics` 只有圆角、边线、控件高度、页面边距；约 369 处 `fontSize` 仍硬编码，正文/标题/辅助字号未成体系 |
| 应用内图标体系 | 只统一了按钮承载、短标签、48dp 槽与语义状态；图标资源未重绘（仍为 10 月生成的旧图标），也没有系统性替换轮廓/实心规则 |
| TalkBack 关闭回焦 | 只有开层标题聚焦（`useHeadingFocus`）；关闭覆盖层后回到触发点未实现，仍依赖系统 |
| 旧业务清理（第一批之外） | `organizePlan` 的旧计划/标签函数、`documents/knowledge.ts` 的旧写入工具、Repo 的 `saveRun`/旧整理会话/`markMerged`/`setFragmentNature`/`countInbox`/`countFragments`/`listFragmentIds` 仍在；目前仅文件内自用或无引用，未动 |
| 通知栏快速记录、Android 分享接收、完整本地备份 | 方案中已单列为后续，不在本期 |
| 设备级墨水屏优化、OTA、原生偏好桥、桌面品牌图标 | 明确不做或单列；冷启动仍可能出现颜色差 |

## 3. 接手与执行顺序

1. 读最新批准节、契约、本交接与对应源码，检查分支和未提交差异；不能只看旧版本历史推断现状。
2. 多Agent先 `list/get/claim`，按write scope开发；共享契约、App/Repo及最终Git/构建归Lead。不因同一工作目录可写就跨scope。
3. 冻结源码后由Lead串行跑完整检查、生成PDF资源、更新本节结果和行数地图。失败要修真实问题，不通过删断言/删地图避开。
4. 当前不commit/push/tag/Release，不装依赖、不起服务、不做HTML界面预览、不本地构建APK。正式发布需另获明确授权，APK交CI产出。
5. 获准设备测试时先确认设备、包来源和版本；每次动作后截图核对。没有设备或无法看图时停止视觉步骤，如实列未验。

依赖/脚本以[package](<package.json>)为准。当前[Android CI](<.github/workflows/android.yml>)使用Node22/JDK21：生成PDF资源 → 类型与各组断言 → 文档检查 → 原生工程/APK。只有版本tag会创建Release并挂raw APK；artifact与Release asset不是一回事。本分支改版尚无新Release。

本地已有工程如需获准prebuild，必须保留 `--no-clean`；不要手改原生生成目录，不根据旧日志擅自删工程或重装依赖。文件清理先核对绝对路径，保护用户数据及其它Agent产物。

## 4. 主要源码行数地图

**行数采样于2026-11-14当前工作树，仍可能随最后修复变化。** Lead在源码冻结后统一刷新；不删除行数表或改变检查规则。第一列的源码标识保持现有机器可识别格式，后附打开链接。测试脚本的行数是文件长度，**不是用例数量**。

### 4.1 入口、页面、主题与类型

| 文件 | 行 | 当前职责 |
|---|---|---|
| `App.tsx` [打开](<App.tsx>) | 627 | route state、两轴偏好落盘、记录草稿/待发图、数据/图片提交接线、返回与文档运行时 |
| `src/quickRecord.ts` | 129 | 通知栏常驻「记一条」：MIN 渠道 sticky 通知、点击回时间轴并聚焦输入框；冷启动那次靠 `getLastNotificationResponseAsync` 单独捞 |
| `src/shareInbox.ts` | 100 | 读系统分享进来的内容：`files/incoming/` 那份 json + 文件，用时间戳做幂等键只消费一次；类型判断以 mime 为主、扩展名兜底 |
| `src/screens/TimelineScreen.tsx` [打开](<src/screens/TimelineScreen.tsx>) | 1979 | 日/月折叠、可见文字/OCR搜索、事项筛选、输入与外置附件、手势和详情入口 |
| `src/screens/AskScreen.tsx` [打开](<src/screens/AskScreen.tsx>) | 2290 | 问答聊天、历史抽屉、引用、文档范围及整理控制器接线 |
| `src/screens/ReviewScreen.tsx` [打开](<src/screens/ReviewScreen.tsx>) | 280 | 待办/小结两类回顾，没有标签tab |
| `src/screens/DocsScreen.tsx` [打开](<src/screens/DocsScreen.tsx>) | 988 | 原件导入、搜索/多选、任务状态、逐次云授权、删除确认与阅读入口 |
| `src/screens/SettingsScreen.tsx` [打开](<src/screens/SettingsScreen.tsx>) | 1601 | 四模块四子页、两轴外观、配置、文字迁出/导入、索引与更新 |
| `src/theme.tsx` [打开](<src/theme.tsx>) | 91 | 动态ThemeProvider、useTheme/useThemedStyles与系统减少动效 |
| `src/util/appearance.ts` [打开](<src/util/appearance.ts>) | 225 | 四套完整色表、两轴规范化、语义色和metrics，纯函数可测试 |
| `src/types.ts` [打开](<src/types.ts>) | 532 | 领域类型、引用/会话、文档、配图与PendingFragmentImage |
| `src/version.ts` [打开](<src/version.ts>) | 8 | 与包配置同步的应用版本常量 |

### 4.2 Repo、文件与文字迁出

| 文件 | 行 | 当前职责 |
|---|---|---|
| `src/db/types.ts` [打开](<src/db/types.ts>) | 429 | 两端Repo唯一接口、原子草稿输入/回执等共享契约 |
| `src/db/repo.native.ts` [打开](<src/db/repo.native.ts>) | 1890 | SQLite、16段历史迁移、FTS投影、记录/图片与草稿原子提交 |
| `src/db/repo.web.ts` [打开](<src/db/repo.web.ts>) | 1069 | localStorage平台实现与回滚边界；不证明原生迁移通过 |
| `src/db/backup.ts` | 283 | 完整备份的文件层：`VACUUM INTO` 快照 → 库 + 配图 + 文档原件打 zip；恢复前先留 `backups/pre-restore-*.db`，替换时连 `-wal`/`-shm` 一起删 |
| `src/db/backup.web.ts` | 22 | 网页端占位：没有私有目录和本地库文件，直接抛一句人话，不假装备份成功 |
| `src/db/repo.ts` [打开](<src/db/repo.ts>) | 7 | 平台分流入口 |
| `src/db/draftCommit.ts` [打开](<src/db/draftCommit.ts>) | 135 | 输入/凭据验证、稳定key、共享提交项处理，平台事务内调用 |
| `src/db/importMd.ts` [打开](<src/db/importMd.ts>) | 187 | 系统选文件、预览、完整分钟判重、串行单条原子导入与部分失败说明 |
| `src/db/fragmentImages.ts` [打开](<src/db/fragmentImages.ts>) | 95 | 图片私有文件保存、读取与删除；引用/清理时机由上层提交边界决定 |
| `src/db/docFiles.ts` [打开](<src/db/docFiles.ts>) | 327 | 文档原件保存/读取/删除及外部应用content URI打开 |
| `src/export/markdown.ts` [打开](<src/export/markdown.ts>) | 57 | 全量碎片读取、Markdown文件IO与系统分享 |
| `src/util/mdExport.ts` [打开](<src/util/mdExport.ts>) | 26 | 可读文字迁出投影、未读/无字图片占位和备份范围声明 |
| `src/util/mdBuild.ts` [打开](<src/util/mdBuild.ts>) | 113 | 兼容Markdown拼接：按日文字、只读待办清单、旧标签索引 |
| `src/util/mdParse.ts` [打开](<src/util/mdParse.ts>) | 286 | 旧格式解析、日期警告、二进制判断与唯一判重指纹 |

### 4.3 AI与问答资料

| 文件 | 行 | 当前职责 |
|---|---|---|
| `src/ai/chat.ts` [打开](<src/ai/chat.ts>) | 558 | 唯一请求层，四段超时、SSE、finish_reason、额度与错误证据 |
| `src/ai/stream.ts` [打开](<src/ai/stream.ts>) | 148 | 流分片解析，reasoning/content分离 |
| `src/ai/config.ts` [打开](<src/ai/config.ts>) | 35 | 模型服务配置读取/保存 |
| `src/ai/keyStore.ts` [打开](<src/ai/keyStore.ts>) | 37 | 系统安全存储中的API Key |
| `src/ai/knowledge.ts` [打开](<src/ai/knowledge.ts>) | 403 | fragments/session材料、docs/todos/note输出、预算、改稿与身份/授权对账 |
| `src/ai/qa.ts` [打开](<src/ai/qa.ts>) | 763 | 记录问答、按需检索与预算、联网、真实引用和历史快照 |
| `src/ai/documentRetrieval.ts` [打开](<src/ai/documentRetrieval.ts>) | 530 | 限定文档检索、公平装填、内容版本与D引用快照 |
| `src/ai/summarize.ts` [打开](<src/ai/summarize.ts>) | 303 | 月总结材料与提示词，按日事件表/重要进展 |
| `src/ai/search.ts` [打开](<src/ai/search.ts>) | 196 | 官方工具搜索、退避与结果兜底 |
| `src/ai/fetchPage.ts` [打开](<src/ai/fetchPage.ts>) | 148 | 用户打开联网并发送链接后的页面读取 |
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
| `src/util/knowledgeDoc.ts` [打开](<src/util/knowledgeDoc.ts>) | 352 | 模型草稿收敛、真实日期校验、摘要/命名与兼容单篇形状 |
| `src/util/batch.ts` [打开](<src/util/batch.ts>) | 61 | 条数/字数装箱与批次数边界，至少保留一条材料 |
| `src/util/organizePlan.ts` [打开](<src/util/organizePlan.ts>) | 465 | 旧计划形状和兼容读取工具，不是现行整理页面/执行链 |

### 4.5 文档、PDF与其它阅读器

| 文件 | 行 | 当前职责 |
|---|---|---|
| `src/documents/formats.ts` [打开](<src/documents/formats.ts>) | 128 | 本机格式、容量、能问判据和真实定位标签 |
| `src/documents/jobs.ts` [打开](<src/documents/jobs.ts>) | 487 | 应用级本地/云准备任务，每文档互斥、取消与版本写回 |
| `src/documents/knowledge.ts` [打开](<src/documents/knowledge.ts>) | 86 | 旧文档写入工具，不承担当前整理写入；是否删除须再做引用审查，主链为Repo commitDraft |
| `src/documents/readers/DocumentReader.tsx` [打开](<src/documents/readers/DocumentReader.tsx>) | 72 | 只读分派，嵌入时不再外包滚动容器 |
| `src/documents/readers/readerAvailability.ts` [打开](<src/documents/readers/readerAvailability.ts>) | 18 | original/snapshot/unavailable纯判据，不依赖能问索引状态 |
| `src/documents/readers/extract.ts` [打开](<src/documents/readers/extract.ts>) | 164 | 本地提取分派，完整正文/切片/定位 |
| `src/documents/readers/chunk.ts` [打开](<src/documents/readers/chunk.ts>) | 182 | 按完整文本切片、真实行号和contentFromText |
| `src/documents/readers/PdfReader.tsx` [打开](<src/documents/readers/PdfReader.tsx>) | 239 | PDF阅读与本地查找命令、文字索引三态、主题消息更新 |
| `src/documents/readers/PdfWebView.tsx` [打开](<src/documents/readers/PdfWebView.tsx>) | 83 | 稳定source、命令桥、本地导航与WebView安全边界 |
| `src/documents/readers/PdfWebView.web.tsx` [打开](<src/documents/readers/PdfWebView.web.tsx>) | 22 | Web编译占位，非PDF网页产品 |
| `src/documents/readers/pdfRuntime.tsx` [打开](<src/documents/readers/pdfRuntime.tsx>) | 301 | App根常驻的串行PDF提取队列 |
| `src/documents/readers/pdfProtocol.ts` [打开](<src/documents/readers/pdfProtocol.ts>) | 94 | RN/WebView消息及纸面主题字段契约 |
| `src/documents/readers/pdfTheme.ts` [打开](<src/documents/readers/pdfTheme.ts>) | 35 | 白纸专用灰墨/轮廓/选区与动态几何转换 |
| `src/documents/readers/pdfjs/reader.template.html` [打开](<src/documents/readers/pdfjs/reader.template.html>) | 772 | 产品PDF源模板：本地渲染/查找、CSS变量与低内存页窗口；不是界面预览 |
| `src/documents/readers/SheetReader.tsx` [打开](<src/documents/readers/SheetReader.tsx>) | 674 | 只读工作表、真实行列定位、当前命中、按视口渲染列 |
| `src/documents/readers/excelWorkbook.ts` [打开](<src/documents/readers/excelWorkbook.ts>) | 421 | dense/稀疏有效单元格解析、不按!ref面积遍历 |
| `src/documents/readers/workbookCache.ts` [打开](<src/documents/readers/workbookCache.ts>) | 39 | 按fileUri+size的单槽内存缓存 |
| `src/documents/readers/viewCache.ts` [打开](<src/documents/readers/viewCache.ts>) | 128 | 磁盘视图缓存，损坏当缓存未命中 |
| `src/documents/readers/sheetWindow.ts` [打开](<src/documents/readers/sheetWindow.ts>) | 96 | 列窗口、偏移与占位计算 |
| `src/documents/readers/TextReader.tsx` [打开](<src/documents/readers/TextReader.tsx>) | 201 | TXT/Markdown/快照的分块虚拟化与字面查找，当前命中非颜色标识 |
| `src/documents/readers/textBlocks.ts` [打开](<src/documents/readers/textBlocks.ts>) | 92 | 正文分块，保留代码围栏与连续表格 |
| `src/documents/readers/SearchBar.tsx` [打开](<src/documents/readers/SearchBar.tsx>) | 112 | 48dp查找/清除/前后命中，busy与disabled分开 |
| `src/documents/readers/markdownSearch.ts` [打开](<src/documents/readers/markdownSearch.ts>) | 30 | 与NoteBody一致的可见Markdown块命中计数 |
| `src/documents/readers/fragmentSearch.ts` [打开](<src/documents/readers/fragmentSearch.ts>) | 32 | 详情OCR→正文→事项的真实命中目标与局部序号 |

### 4.6 共用组件与覆盖层

| 文件 | 行 | 当前职责 |
|---|---|---|
| `src/components/IconButton.tsx` [打开](<src/components/IconButton.tsx>) | 120 | 真实48dp槽、可选短label、选中/禁用/焦点语义；diameter只管视觉底 |
| `src/components/ScreenHeader.tsx` [打开](<src/components/ScreenHeader.tsx>) | 69 | 共享页头、返回/右侧动作及标题聚焦 |
| `src/components/BusyIndicator.tsx` [打开](<src/components/BusyIndicator.tsx>) | 23 | 减少动效时静态忙碌图形，不改变业务进度 |
| `src/components/ChoiceChip.tsx` [打开](<src/components/ChoiceChip.tsx>) | 49 | 带文字/状态的共享选项控件 |
| `src/components/useHeadingFocus.ts` [打开](<src/components/useHeadingFocus.ts>) | 20 | 只为屏幕阅读器聚焦新标题，不抢普通键盘 |
| `src/components/KnowledgeDraft.tsx` [打开](<src/components/KnowledgeDraft.tsx>) | 213 | 全部产出可审阅、稳定key、逐项授权与统一写入计数 |
| `src/components/DraftDocPage.tsx` [打开](<src/components/DraftDocPage.tsx>) | 259 | 草稿单篇整页阅读/编辑与批准入口 |
| `src/components/FragmentDetail.tsx` [打开](<src/components/FragmentDetail.tsx>) | 1042 | 分页阅读/编辑、原比例多图、删除确认、OCR/正文/事项命中与实测y |
| `src/components/DocViewer.tsx` [打开](<src/components/DocViewer.tsx>) | 426 | 只按id读取文档、独立读/问门槛、一行主动作、展开操作与逐次云确认 |
| `src/components/NoteBody.tsx` [打开](<src/components/NoteBody.tsx>) | 598 | Markdown/图片块、单Text预览、字面引用、当前命中及动态纸面排版 |
| `src/components/NoteViewer.tsx` [打开](<src/components/NoteViewer.tsx>) | 108 | 小结整页阅读与列表同序分页 |
| `src/components/SummarySheet.tsx` [打开](<src/components/SummarySheet.tsx>) | 745 | 月总结单篇/缺口队列、原稿对照和确认保存 |
| `src/components/TodoPanel.tsx` [打开](<src/components/TodoPanel.tsx>) | 511 | 父子待办、独立勾选/编辑、合并恢复与非颜色状态 |
| `src/components/TodoEditor.tsx` [打开](<src/components/TodoEditor.tsx>) | 250 | 全屏覆盖编辑、子项和到期日 |
| `src/components/UpdateSheet.tsx` [打开](<src/components/UpdateSheet.tsx>) | 525 | 更新提示/下载/安装/错误状态 |
| `src/components/ImportSheet.tsx` [打开](<src/components/ImportSheet.tsx>) | 209 | 文字导入预览、范围/日期警告与确认 |
| `src/components/CitationSheet.tsx` [打开](<src/components/CitationSheet.tsx>) | 282 | 引用快照、真实来源位置，不回库猜原文 |
| `src/components/SwipeRow.tsx` [打开](<src/components/SwipeRow.tsx>) | 302 | 固定方向的时间轴手势，保留纵滚/长按和减少动效 |
| `src/components/Toast.tsx` [打开](<src/components/Toast.tsx>) | 55 | 就近消息呈现，不自行决定业务成功或计时 |
| `src/components/ReasoningFold.tsx` [打开](<src/components/ReasoningFold.tsx>) | 84 | 答后仍可打开的思考折叠 |
| `src/components/ReasoningStream.tsx` [打开](<src/components/ReasoningStream.tsx>) | 93 | 流式思考展示，减少动效与滚动策略 |
| `src/components/ReasoningTrace.tsx` [打开](<src/components/ReasoningTrace.tsx>) | 70 | 过程轨迹显示 |
| `src/components/AgentError.tsx` [打开](<src/components/AgentError.tsx>) | 169 | 错误短提示/阶段/原始证据展开，不吞掉失败原因 |

### 4.7 共用纯函数

| 文件 | 行 | 当前职责 |
|---|---|---|
| `src/util/fragmentText.ts` [打开](<src/util/fragmentText.ts>) | 81 | 材料文字、可见检索投影、配图文字与状态判据 |
| `src/util/backupPlan.ts` | 219 | 备份清单的纯函数：文件名、manifest、恢复前校验（拿错包 / 版本更新 / 缺库）、路径过滤、SQLite 文件头、体积文案与上限 |
| `src/util/inlineImages.ts` [打开](<src/util/inlineImages.ts>) | 99 | 图片定位标记、待发键替换、删除和无定位图判定 |
| `src/util/pendingImages.ts` [打开](<src/util/pendingImages.ts>) | 52 | 按图id选择未读图片、保持顺序与读图预算 |
| `src/util/tokenize.ts` [打开](<src/util/tokenize.ts>) | 165 | 中文bigram/FTS查询与旧标签规范化兼容工具 |
| `src/util/highlight.ts` [打开](<src/util/highlight.ts>) | 55 | 唯一字面命中findHits/countHits |
| `src/util/mdBlocks.ts` [打开](<src/util/mdBlocks.ts>) | 488 | Markdown、表格、代码、引用与图片块解析 |
| `src/util/text.ts` [打开](<src/util/text.ts>) | 32 | 文本规范化、包含判断与截取 |
| `src/util/date.ts` [打开](<src/util/date.ts>) | 188 | 日/月等历史日期键、标签与月末锚点 |
| `src/util/digest.ts` [打开](<src/util/digest.ts>) | 106 | 月总结缺口与历史小结分组，组内不重排 |
| `src/util/todoTree.ts` [打开](<src/util/todoTree.ts>) | 125 | 父子树、唯一完成级联计划与展开 |
| `src/util/qaScope.ts` [打开](<src/util/qaScope.ts>) | 70 | 记录/文档范围规范化、身份与比较 |
| `src/util/qaNote.ts` [打开](<src/util/qaNote.ts>) | 20 | 历史纪要文本包装工具，不是恢复旧整理产物入口 |
| `src/util/jsonRepair.ts` [打开](<src/util/jsonRepair.ts>) | 193 | JSON语法宽容修复与出错位置，不补残缺结构 |
| `src/util/urls.ts` [打开](<src/util/urls.ts>) | 61 | 链接提取与查询词构建 |
| `src/util/keyboard.ts` [打开](<src/util/keyboard.ts>) | 39 | edge-to-edge键盘高度与占位 |
| `src/util/docSupport.ts` [打开](<src/util/docSupport.ts>) | 212 | 云通道判据、显式解析分派和本地容量说明 |

### 4.8 自更新

| 文件 | 行 | 当前职责 |
|---|---|---|
| `src/update/check.ts` [打开](<src/update/check.ts>) | 176 | Release查询、节流、自动检查/跳过版本 |
| `src/update/mirror.ts` [打开](<src/update/mirror.ts>) | 66 | 自定义→官方→镜像候选顺序 |
| `src/update/download.ts` [打开](<src/update/download.ts>) | 316 | 停滞/低速切源、字节核验和content URI安装 |
| `src/update/notify.ts` [打开](<src/update/notify.ts>) | 142 | 下载状态通知；后台JS挂起时数字可能暂停 |
| `src/util/semver.ts` [打开](<src/util/semver.ts>) | 62 | 数值分段比较版本，不比较字符串 |

### 4.9 检查脚本

| 文件 | 行 | 当前职责 |
|---|---|---|
| `scripts/assert_md.cjs` [打开](<scripts/assert_md.cjs>) | 303 | 原有Markdown往返断言 |
| `scripts/assert_backup.cjs` | 243 | 完整备份的 19 项断言：命名、清单、四种拒绝、路径穿越过滤、SQLite 头、体积上限 |
| `scripts/assert_document_qa.cjs` [打开](<scripts/assert_document_qa.cjs>) | 482 | 限定文档问答/预算/引用 |
| `scripts/assert_document_jobs.cjs` [打开](<scripts/assert_document_jobs.cjs>) | 567 | 文档任务控制流 |
| `scripts/assert_readers.cjs` [打开](<scripts/assert_readers.cjs>) | 730 | 读取/切片/表格/协议等纯逻辑 |
| `scripts/assert_todos.cjs` [打开](<scripts/assert_todos.cjs>) | 340 | 父子待办和月总结规则 |
| `scripts/assert_ask.cjs` [打开](<scripts/assert_ask.cjs>) | 776 | 问页意图、草稿与输出兼容 |
| `scripts/assert_reliability.cjs` [打开](<scripts/assert_reliability.cjs>) | 1727 | 真实模块+内存桩的故障、授权、迁出/恢复和控制流回归 |
| `scripts/assert_appearance.cjs` [打开](<scripts/assert_appearance.cjs>) | 390 | 两轴外观、真实对比度、PDF与阅读器契约 |
| `scripts/test_loader.cjs` [打开](<scripts/test_loader.cjs>) | 305 | 测试用内存编译/依赖桩/AST抽取，不加载真实数据库或网络 |
| `scripts/check_docs.mjs` [打开](<scripts/check_docs.mjs>) | 264 | 文档机器一致性；不得通过降低覆盖率躲检查 |

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
