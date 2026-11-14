# 碎片：接手审计与 UI / 墨水风格改版提案

日期：2026-11-14（Asia/Shanghai）

审查基线：v0.20.4 / versionCode 55 / `5befe65a43939d00f50d6e9f08bcc67cd7b5eb3c`
**状态：接手、审查、恢复分支和基线验证已完成；以下实施方案待用户确认。业务源码尚未修改。**

## 1. 接手结论

- 产品是个人单机 Android 记录工具「碎片」，不是 Web 应用或 Expo Router 模板。实际依赖为 React Native 0.88、Expo 58、React 19.3、TypeScript 6，SQLite 已有 16 段迁移。
- 按要求先读了工作区及项目 README、两级 AGENTS，再读 WorkBuddy 长期记忆及 11 月 12 / 14 日记录；随后核对交接、规格、路线图、近期变更与实际代码。
- 当前业务包括时间轴、问答/整理、文档、待办/月小结、设置；整理已并入「问」，标签入口已下线。不能按旧交接把它们恢复回来。
- 起始 Git 工作区干净，原分支为 `master`。没有需要代存或覆盖的用户未提交源码。
- 根规则引用的专项 `docs/agent-rules` 文件以及 PROJECT / PLAN / DECISIONS 记录未找到。按已存在的根规范与项目专属规则执行，不机械补造整套规范。
- 本次是跨主页面、阅读器、设计系统及状态链路的 **L3 改版**，分阶段实施；首次设计须确认。关闭工具审批不等于自动批准方案、推送或数据破坏操作。

### 文档漂移不是小问题

[项目 README](<F:/coding/python/project/Test/fragments/README.md>)、[交接文档](<F:/coding/python/project/Test/fragments/HANDOFF.md>)、[项目 AGENTS](<F:/coding/python/project/Test/fragments/AGENTS.md>) 和 [规格](<F:/coding/python/project/Test/fragments/SPEC.md>) 仍夹杂 SQLite v9、只有两组测试、旧标签、旧整理 JSON、已废弃日/周小结、本地打包等描述。较新的决策与代码已不同。

现有 `check:docs` 检查版本、路径、行数、提示词抄录等，**不能证明文档的业务含义没有过时**。本期应校正现状说明，把真正的历史理由留在变更记录中，而非让下一位 Agent 再次踩坑。

## 2. 已完成的回退保护

| 引用 | 用途 | 当前基线 |
|---|---|---|
| `master` | 保持原版，不在其上开发 | `5befe65` |
| `backup/pre-ui-20261114` | 固定保存此次改版前状态 | `5befe65` |
| `feat/ui-refresh-ink-20261114` | 本次提案及后续获批开发 | 从 `5befe65` 创建 |

没有 push、没有新 tag、没有 Release、没有历史重写，也没有修改手机数据。

后续每个独立步骤使用本地 Conventional Commit。主题底座、页面改版、逻辑修复分开提交，方便逐项撤销。不会以一个“大杂烩提交”包住整次改造。

工作区干净时可切换查看原版：

```powershell
# 在 fragments 仓库内运行；有未提交修改时先保存，不强制切换
git switch backup/pre-ui-20261114

# 回到开发版本
git switch feat/ui-refresh-ink-20261114
```

只撤销某一步时优先 `git revert <commit>`，不使用 `reset --hard` 或强制推送。

**三个“回退”要区分：**
1. 设置里退出墨水风格：运行时即时切回新版默认风格。
2. 恢复 v0.20.4 的全部代码/布局：使用恢复分支或撤销提交。
3. 恢复手机数据：需要完整数据备份；Git 不包含手机 SQLite、图片或原件。旧 APK 也可能被 Android 的版本号规则阻止直接覆盖安装，不能承诺切分支就能降级手机。

## 3. 基线验证（主 Agent 实际执行）

执行环境：Windows，本机 Node v24.14.1 / npm 11.11.0；CI 使用 Node 22，两者差异须在未来 CI 验证时记录。

| 命令 | 结果 | 实际数量 |
|---|---|---|
| `npm run typecheck` | exit 0 | TypeScript 无错误 |
| `npm run test:md` | exit 0 | 24 |
| `npm run test:docs` | exit 0 | 问答 16 + 任务 8 + 阅读器 47 = 71 |
| `npm run test:todos` | exit 0 | 18 |
| `npm run test:ask` | exit 0 | 83 |
| `npm run check:docs` | exit 0 | 文档机器一致性检查通过 |
| `npm run build:web` | exit 0 | 4.53 MiB，产物由脚本删除 |

**现有自动断言共 196 项通过。** Web 仅是编译检查，没有提供网页预览或启动预览服务；未安装依赖、未运行本地 APK 构建、未调用项目 AI 或上传用户文件。

运行前核对了脚本临时删除目标的绝对路径；仅原有 `.tmp-assert` 包含 7 个可再生成的 CJS 文件，该目录没有删除。其它测试临时目录和 Web 产物由现有脚本处理。

`adb devices -l` 没有连接设备。没有安装 APK、启动手机 App 或模拟操作。当前图片查看工具也不支持本会话模型，未实际查看现有图标图像；不能以源码推断冒充视觉验收。

**尚未验证：** 真机布局、配色观感、中文输入法、手势、TalkBack、WebView PDF 渲染、原生 SQLite 迁移、真实模型输出、手机覆盖安装。196 项通过不覆盖下面的页面控制流缺陷。

## 4. 发现的问题与证据

以下是代码风险或已用桩复现的缺陷，**不表示已经确认用户手机发生了损坏**。P1 为数据/授权/恢复风险，P2 为功能与交互缺陷，P3 为维护性。

| 编号 | 问题 | 证据与验证状态 | 建议 |
|---|---|---|---|
| F01 / P1 | 配图已入库，之后索引或刷新失败，仍可能删除图文件 | [App:278–314](<F:/coding/python/project/Test/fragments/App.tsx#L278-L314>)；[SQLite:855–887](<F:/coding/python/project/Test/fragments/src/db/repo.native.ts#L855-L887>)。**真实 handleAdd + 内存桩已复现**：插库成功，仅 reload 抛错，仍调用删图 | 区分未提交文件与已提交引用；正文、配图、FTS 的写入边界一致；提交后刷新失败不能删除已引用文件或诱导重复发送 |
| F02 / P1 | 导出复用首页数组，最多只有最近 500 条 | [App:179–188](<F:/coding/python/project/Test/fragments/App.tsx#L179-L188>) → [Repo:788–794](<F:/coding/python/project/Test/fragments/src/db/repo.native.ts#L788-L794>) → [Settings:312–318](<F:/coding/python/project/Test/fragments/src/screens/SettingsScreen.tsx#L312-L318>)。静态调用链确认 | 导出独立读取完整范围，与首页加载窗口解耦；501 条及以上必须覆盖旧记录，不把提高上限当完整性方案 |
| F03 / P1 | 导入判重漏掉最后一分钟有秒数的记录；部分失败后按原预览重试会重复插入 | [importMd:94–110](<F:/coding/python/project/Test/fragments/src/db/importMd.ts#L94-L110>) 上界是末条分钟 + 1ms；[applyImport:131–148](<F:/coding/python/project/Test/fragments/src/db/importMd.ts#L131-L148>) 不重新判重；[重试提示:291–307](<F:/coding/python/project/Test/fragments/src/screens/SettingsScreen.tsx#L291-L307>)。**两种情况均已内存复现** | 查询范围与“天+分钟”指纹一致；写入时重验重复，记录部分成功，连续点击/失败重试幂等 |
| F04 / P1 | Markdown 导出没有图文字；纯图条目再导入甚至变成“12:34”这类时间字符串 | [mdBuild:34–43](<F:/coding/python/project/Test/fragments/src/util/mdBuild.ts#L34-L43>) 只读 content，未读 images；[mdParse:237–278](<F:/coding/python/project/Test/fragments/src/util/mdParse.ts#L237-L278>)。**真实拼接/解析已内存复现** | 明确纯图与图文字的可迁出表达，导入/导出一起设计和测试；不声称 Markdown 带原图或是完整备份 |
| F05 / P1 | 草稿写入失败重试不幂等；改稿会重置逐项选择，数组下标误认已保存篇 | [批准写入:1716–1822](<F:/coding/python/project/Test/fragments/src/screens/AskScreen.tsx#L1716-L1822>)；[收敛:92–162](<F:/coding/python/project/Test/fragments/src/util/knowledgeDoc.ts#L92-L162>)。静态确认，待故障注入 | 草稿项使用稳定身份，内容与 keep/已保存状态分开；逐项登记或事务化提交；返回结果校验会话/草稿代次，不能恢复用户取消的选择 |
| F06 / P1 | “整理全部”先存游标、草稿只在内存；退出后可能跳过未保存材料；按日期排序却用 id 游标也不自洽 | [游标写入:1534–1541](<F:/coding/python/project/Test/fragments/src/screens/AskScreen.tsx#L1534-L1541>)；[读取:1878–1906](<F:/coding/python/project/Test/fragments/src/screens/AskScreen.tsx#L1878-L1906>)。静态确认，待退出/乱序导入复现 | 已生成、已持久化、已确认分别记录；先定任务快照与恢复契约，不能只再加一个 offset，也不复活旧整理页 |
| F07 / P2 | 历史会话“整理成文档”没有执行提炼，却记录“没有知识” | [分支:1435–1443](<F:/coding/python/project/Test/fragments/src/screens/AskScreen.tsx#L1435-L1443>)、[唯一调用:1500–1507](<F:/coding/python/project/Test/fragments/src/screens/AskScreen.tsx#L1500-L1507>)。**抽取真实 startDraft + 内存桩复现：模型调用 0 次、完成记录 1 条** | 补 session-source 分支；错误重试保留原会话、材料、要求与失败批次，不改成“最近40条” |
| F08 / P2 | 跨批可有 12 篇，但只展示 8 篇；“全部写入”仍包含不可审阅的后几篇，权限关掉后按钮文案也可能不符 | [KnowledgeDraft:121–128](<F:/coding/python/project/Test/fragments/src/components/KnowledgeDraft.tsx#L121-L128>)、[169–183](<F:/coding/python/project/Test/fragments/src/components/KnowledgeDraft.tsx#L169-L183>)；F05 写入路径。静态确认 | 每篇可展开/分页审阅；展示计数、按钮文案和实际写入共用同一计划，权限关闭即排除相应目标 |
| F09 / P2 | 正文草稿跨页保留，但待发图/序号在时间轴组件内，切页会丢图，重新选图可能复用旧 p1 | [App:101](<F:/coding/python/project/Test/fragments/App.tsx#L101>)；[Timeline:195–205](<F:/coding/python/project/Test/fragments/src/screens/TimelineScreen.tsx#L195-L205>)。静态生命周期确认 | 正文、附件和稳定键归同一 ComposerDraft 生命周期；切主题/切页不能清除，显式放弃才清 |
| F10 / P2 | 首页只搜正文/事项，不能搜 OCR；FTS/降级还包含已下线标签，搜索口径不一致 | [Timeline:298–305](<F:/coding/python/project/Test/fragments/src/screens/TimelineScreen.tsx#L298-L305>)；[SQLite searchIn](<F:/coding/python/project/Test/fragments/src/db/repo.native.ts#L698-L735>)。静态确认 | 共用可见文字/OCR/事项的搜索投影；保留历史 tags 数据但不当隐形命中来源；更改投影须考虑旧索引同条数不重建 |
| F11 / P1，单独验收 | 规格声称迁移事务化且有恢复点，执行器实际逐段 exec、未见事务或备份 | [migrate:326–333](<F:/coding/python/project/Test/fragments/src/db/repo.native.ts#L326-L333>)；[规格:20](<F:/coding/python/project/Test/fragments/SPEC.md#L20>)。静态确认，未跑原生迁移故障测试 | 不重写已发布迁移、不删旧字段；需要单独的迁移/恢复故障验收。本期 UI 不新增表结构，不能宣称 Git 恢复点解决了数据库恢复 |

### 本次额外复现的准确边界

主 Agent 用 TypeScript 在内存中编译真实模块，或用 AST 抽取真实页面函数；依赖改为内存 Repo / 图片操作 / 模型桩。没有创建真实数据库、没有真实图片删除、没有网络请求。

五个场景是 F01、F03 的两个分支、F04、F07。这些实验是**缺陷复现**，不是新增回归测试已落地，也不是修复后的通过记录。获批后应将它们固化为回归，再修改业务代码。

## 5. 可以清理什么，必须保留什么

### 已证实的清理候选

- 孤立组件 [ReasoningCollapse](<F:/coding/python/project/Test/fragments/src/components/ReasoningCollapse.tsx>)：没有入口、注册副作用或调用。当前仍使用的 ReasoningFold / Stream / Trace 不能一起删。
- 无当前运行时调用的叶子导出：[tagColor](<F:/coding/python/project/Test/fragments/src/theme.tsx#L140-L154>)、[pendingOnly](<F:/coding/python/project/Test/fragments/src/util/batch.ts#L42-L45>)、[rewriteKnowledgeDocument](<F:/coding/python/project/Test/fragments/src/documents/knowledge.ts#L72-L85>) 等，删除前再核对测试与平台链。
- [旧 organizePlan](<F:/coding/python/project/Test/fragments/src/util/organizePlan.ts>) 的旧计划合并/标签分组/应用业务导出可逐步剥离；不能整文件删除，因为 Web 加载旧会话仍用 emptyPlan / normalizePlan。
- 旧 Repo 整理会话/运行记录等方法可作为 interface + native + web 同步清理的候选。保留历史存储数据，不用“清理代码”名义 DROP 或清空表。
- [App 的示例注入](<F:/coding/python/project/Test/fragments/App.tsx#L404-L459>) 仍在 Web 分支可达，**不是无引用死码**。可以依据“不提供预览”的当前产品决策移出生产外壳，但必须注明这是范围调整。

### 明确不能顺手删

- 16 段已发布迁移、旧表/列/原图路径、旧会话字段回填、引用快照。
- Markdown 导入还在使用的 applyTags / markStatus；正常问答还使用的 listFragmentsByIds / citedKeys。
- `.native.ts` / `.web.ts` 平台变体及 WebView 的 Web 编译占位实现。
- 没有证实任何直接 npm 依赖可安全移除。expo-system-ui、expo-asset、pdfjs-dist、Web 编译依赖与动态 require 都有非普通 import 的使用路径。

清理的收益是减少误导与维护面积，不承诺这些删除会显著缩小 APK；未进入包的死代码本来可能已被打包器消除。

## 6. 推荐设计 A：纸面默认风格 + 黑白墨水风格

### 6.1 外观拆成两个维度

```text
设置 → 外观
  界面风格：默认 / 墨水
  明暗模式：浅色 / 深色 / 跟随系统
```

- 明暗继续使用 `ui_theme`，新增独立 `ui_style`；缺失/非法风格值回默认，不改数据库表结构。
- 墨水可以组合浅色、深色、跟随系统。退出墨水只改风格，不重置原有明暗偏好。
- [现有 ThemeProvider](<F:/coding/python/project/Test/fragments/src/theme.tsx#L162-L216>) 继续作为唯一入口，扩展语义色、边线、字号/间距、交互策略；保留现有 useThemedStyles 的兼容调用，不到处手写 `if ink`。
- 选择实时生效；设置根层仍是原来的四模块四行，当前值可显示“跟随系统 · 墨水”。落盘失败要说“本次已应用，未能保存”，不能伪报永久保存。

### 6.2 视觉语言与便捷性

- **默认风格**：克制纸面、单一低饱和强调色、清晰标题/正文/元信息层级；减少卡片套卡片、过淡小字和重复装饰。
- **墨水风格**：浅色白纸黑字，深色黑底白字，中性灰辅助；控件用清晰边线与实心选中态，不用彩色区分错误、完成、联网等状态。
- 统一间距档位 4/8/12/16/24；正文目标约 15/24，阅读态 17/28–30，辅助信息 12–13。关键说明不使用最淡文字色，保留系统字体缩放。
- 应用内图标继续用已安装 Ionicons，统一轮廓、尺寸、选中与禁用规则；可点击图标配明确语义，常用导航增加短文字标签。
- **保留顶部“文档 / 回顾 / 设置 / 问”的顺序**，问仍最右突出。按钮使用至少 48dp 的实际布局点击槽，视觉图形可小于点击槽；不能仅靠 hitSlop 扩大相互重叠的区域。
- 暂不加入底部导航。当前条件渲染会卸载页面，底栏会牵动输入区、任务、草稿与返回栈；这不是低风险的“换布局”。
- 时间轴保留按日/月折叠与既有左右滑方向；输入仍是文字整行、展开在左、图片和发布在右，图片选择行仍在卡片内部。
- 问答/整理继续是“用户右气泡 + 助手左正文”，草稿不恢复外层大通知卡。深度思考/联网增加“开/关”或勾选标记，不能只变颜色。
- 待办明确显示“逾期”，勾选区与文字编辑区分开；保留父子层级、合并恢复入口。
- 文档阅读器保留主要动作；次要操作可收进有文字的“文档操作”展开区，增加阅读面积，但不隐藏云上传确认、删除确认或当前准备状态。
- 设置保持四个子页，区分配置“需保存”与外观“即时生效”，不再制造多个入口指向同一页面。

### 6.3 不能漏掉的例外

- 在 [IconButton](<F:/coding/python/project/Test/fragments/src/components/IconButton.tsx>) / [ScreenHeader](<F:/coding/python/project/Test/fragments/src/components/ScreenHeader.tsx>) 等共用组件补齐 selected / checked / disabled / expanded 和就近反馈。覆盖层要考虑 TalkBack 不穿透、关闭回焦，但不换成 Modal。
- 墨水及系统减少动态效果时减少装饰动画、回弹和程序性平滑滚动；保留手指拖动反馈、进度与完成信息，不把“减少动效”变成“无法判断是否在运行”。
- 图片与 PDF 原稿保真，不给照片或 PDF canvas 全局反相/灰度。墨水是界面风格，不承诺实体墨水屏的局刷、防残影或节能。
- [PDF 高亮](<F:/coding/python/project/Test/fragments/src/documents/readers/pdfTheme.ts#L12-L25>) 叠在白纸 canvas 上，不能直接复用深色墨水的白色强调值；需要纸面专用半透明灰色/轮廓，避免遮字或不可见。
- 修改 PDF 时同步 [协议](<F:/coding/python/project/Test/fragments/src/documents/readers/pdfProtocol.ts>)、[产品阅读器模板](<F:/coding/python/project/Test/fragments/src/documents/readers/pdfjs/reader.template.html>) 与生成资源；不重挂 WebView 丢页码/查询。产品阅读器模板不是新增网页预览。
- 原生启动窗使用静态明暗资源，JS 偏好要等数据库打开；只改 Palette 不能承诺所有冷启动零闪烁。首轮不增加原生偏好桥或刷新驱动。
- 桌面图标已有 Android 单色资源。应用内墨水开关不等于动态更换桌面图标；本期首先统一应用内图标，不承诺桌面品牌图标重绘或自动切换。

### 6.4 备选 B：最小主题层

只做两轴设置、墨水配色、关键硬编码色/阅读器高亮、按钮状态与必要点击区；大体保留页面排列、密度和阅读器底部操作。

优点：改动更少、回退更简单。缺点：对“页面整体更漂亮、更便捷”的改善有限。B 也不能省掉非颜色状态、PDF/媒体例外或数据写入确认。

## 7. 实施顺序与主 / 子 Agent 边界（待确认）

1. **先固化缺陷回归和安全边界**：五项已复现问题、500+条导出、附件草稿跨页、隐藏产出审阅；先修记录与迁出安全，再做外观。对草稿身份、权限、重试和游标恢复先形成具体状态契约，不能边改配色边顺手改写入语义。
2. **清理明确无用项**：叶子组件/函数和误导注释优先；旧业务整链单独提交。历史存储与两端兼容保持。
3. **主题底座与共用组件**：两轴偏好、语义 token、设置选择、页头/图标/按钮/状态与反馈。先保证旧模式兼容，再启用 ink。
4. **分模块调整布局**：时间轴/输入、问答/草稿、回顾、文档/阅读器、设置/覆盖层。每块独立审查，避免同一文件多 Agent 写冲突。
5. **集中回归与记录**：现有检查 + 新增控制流回归 + 主题契约/对比度/协议检查；同步现状文档；有真机再验 UI，未验保持明确标记。

推荐分工：
- **主 Agent** 独占共享类型/主题契约、App 路由与草稿接线、Repo/事务、规格、包脚本和最终集成；统一审查 diff 与运行完整测试。
- **UI 子 Agent** 负责经约定的主页面/共用组件，按 token 契约工作，不擅自改路由或写库。
- **逻辑子 Agent** 负责限定的草稿/历史控制器与纯函数，共享类型先由主 Agent 定稿。
- **阅读器或测试子 Agent** 按独立收益安排；模板、生成物和脚本目录明确单一写入者，主 Agent 集中生成/验证。

各开发任务登记不重叠的 write scopes，依赖主题/类型契约的任务在契约定稿后才开始。审计子 Agent 已完成报告，不把“Agent 已闲置”当作实施完成。

**首期不扩展：** 账号/云同步/后端、OTA、导航/全局状态库、设备级墨水屏驱动、新的 AI 能力、Word/PPT 本地排版引擎。没有新依赖预算。通知栏快速记录、Android 分享接收、完整本地备份属于真实未完成项，单列后续设计；不借本轮范围泛化直接加上。

F11 的原生迁移/备份保障需独立验收，不重写历史迁移，也不承诺本次无 schema 变更的 UI 分支解决了它。若草稿恢复方案确需改变数据库关键结构，必须另行确认。

## 8. 验收标准

### 自动化与源码层

- 现有 196 项回归、typecheck、check:docs、build:web 保持通过；不删除断言或降低限制来制造通过。
- 500+ 条导出包含旧记录；纯图/图文字/多行/旧标签格式的迁出和再导入行为明确；两次导入与失败重试不制造重复。
- 插库前失败只清理未引用文件；插库后刷新失败不丢图片；正文/图片/FTS 一致。
- 历史整理确实使用原会话；重试不换材料；部分写入、会话切换与旧回调不串台。
- 已取消的文档/待办/子项不会因改稿重新获得授权；9–12篇均可审阅；可见计数与实际写入目标一致。
- 两轴偏好规范化、旧设置兼容、连续切换最终值正确；切风格不卸载编辑器、不清正文/附件/未保存草稿。
- 四套实际配色覆盖共用组件与阅读器；普通文字至少4.5:1，重点正文优先7:1，必要控件/焦点目标3:1；硬编码仅保留明确媒体/原件例外。
- native / web 接口一致；产品 PDF 协议、模板和生成资源一致；不引入用户未授权的外发。

### 真机层（当前未执行）

- 默认/墨水 × 浅/深/跟随系统；系统切色、重启、冷启动、快速切换。
- 320–360dp 窄屏、常规及最大字体；实际48dp热区可点且不串点。
- 真正中文输入法下，时间轴、长文、问、详情、待办编辑、阅读搜索的按钮不被遮；翻旧对话时不强拉到底。
- 所有返回键按层关闭，草稿与附件跨页保留；左右滑方向不变，删除仍二次确认。
- PDF/Excel/Markdown/TXT 的高亮、命中计数、定位、翻页与原件颜色保持正确。
- TalkBack 可读状态、只访问最上层覆盖内容、关闭后焦点恢复；流式输出不逐字轰炸播报。

## 9. 调研与待确认

本次尝试获取 Android/W3C 官方资料；搜索得到候选，正文抓取均因工具 HTTP 401 失败。没有更改检索/Fetch 配置，也不把片段伪装成已阅读的官方正文。48dp、对比度与非颜色状态是本提案的明确验收目标；具体 RN/Expo 能力以已安装版本的类型/源码核对，不猜新版 API。

**请用户确认：按推荐 A（安全/逻辑修复 + 克制纸面 UI + 独立黑白墨水风格）分阶段实施，还是选择较小的 B。** 默认理解“墨水”为普通 Android 上的黑白视觉风格，“回退”为设置切回风格 + Git 分支/提交恢复；不额外预设实体墨水屏适配或 App 内旧版布局开关。

确认前不修改业务实现；确认后先更新已批准规格再开发。Push、合并主分支、发 tag/Release 仍需明确授权，构建交给现有 CI，不本地打包。
