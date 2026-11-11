# 交接文档（给下一个模型）

> 写于 2026-10-24，**2026-10-25 重整过结构**，**2026-11-10 更新到 v0.16.0**：变更记录迁到 [CHANGELOG.md](./CHANGELOG.md)，
> 本文只留「现在的状态」和「怎么接着干」。对应版本 **v0.16.0（versionCode 45）**。
>
> **阅读顺序**：本文件（10 分钟）→ [SPEC.md](./SPEC.md) 第 0 节（v0.7 定稿）+ 第 6 节（请求层）
> + 第 8.1 节（Android UI 红线）→ [ROADMAP.md](./ROADMAP.md) 未完成项。
> 想知道「某个设计为什么长这样」，翻 [CHANGELOG.md](./CHANGELOG.md)；`AGENTS.md` 是速查，
> `README.md` 是给人看的门面。

---

## 1. 三十秒速览

一个**个人单机 Android 应用**，叫「碎片」。核心是「随手记 + 在同一个地方问和整理」：

随手记一条 → 想整理时在「问」里说一句「整理这些碎片」→ AI 读最近的碎片写出一篇文档
→ **先在对话里给你看、你可以直接改、也可以继续说「第二段并进第一段」** → 点「通过并写入」才进文档区。
想不起来时还是同一页问，答案带引用。

v0.16 起**没有独立的整理页**：整理、整理待办、写月小结、提问，全在「问」里用一句话发起。

| 项 | 值 |
|---|---|
| 路径 | `F:/coding/python/project/Test/fragments` |
| 包名 | `com.local.fragments`（固定，改包名等于换 App） |
| 版本 | v0.17.0 / versionCode 46 |
| 技术 | RN 0.88 + Expo SDK 58 + TS 6.0，Android 单端，SQLite v9 |
| 模型 | DeepSeek `deepseek-flash`（`deepseek-chat` / `-reasoner` 已停用） |
| 数据 | 本地 SQLite，无账号、无后端、无同步 |

**v0.7 是推倒重做**：删掉了知识卡、主题、问答记录三块，理由见 CHANGELOG v0.7.0 第一节。
现在**时间轴就是知识库**，没有第二份数据、没有第二套 id。

---

## 2. 现在是什么状态

| 项 | 状态 |
|---|---|
| 编译 | `tsc --noEmit` 零错误 |
| Web 编译校验 | `npm run build:web` 通过（约 1.28 MiB，产物跑完即删） |
| 自动化测试 | 没有单测框架，但有一组机器检查：`npm run test:md`（导入导出往返 24 项）、`npm run test:docs`（阅读器 47 / 任务 8 / 问答 16）、`npm run test:todos`（待办与小结 18 项）、`npm run test:ask`（指令路由与整理草稿 21 项）、`npm run check:docs`、`npm run typecheck` |
| 真机验证 | v0.7 / v0.8 这批**基本没验**，110 条清单在 [ROADMAP P0-1](./ROADMAP.md) |
| 外观 | 深色 / 浅色 / 跟随系统三档，默认跟随系统（v0.8.0） |
| 月总结格式 | **一张按天的「日期 \| 事件」表 + 3–6 条重要事件与进展**，650 字上限（v0.16，见 `TEXTS.md` 1.3） |
| 已知阻塞 | 无。剩下的是「验」和「补」（通知栏快速记录入口） |
| 数据迁移 | v12。碎片 / 待办 / 小结 / 文档全保留。v12 给 `documents` 加 `origin`（原件 / 整理产出）与 `excerpt`（列表摘要），给 `ask_sessions` 加 `document_id` / `source_ids`（会话跳转与重新整理）；v11 删掉库里日/周小结并给 `todos` 加 `parent_id`；v7 加 `todos.done_at`；v8 建 `ask_sessions`；v9 建 `documents`；v10 加切片与版本号 |

**一句话：功能完整，但 v0.7 的重做还没经过真机检验。** 别在这之前继续叠功能。

> **v0.7.3（2026-10-26）**：已完成待办只留最近 5 条（迁移 v7 + 物理清理）、小结改为书面语、
> 时间轴周总结独占周级分区置顶。三处只动保留策略与展示，未改整理 / 问答链路。
>
> **v0.7.4（2026-10-26）**：回顾页「小结」也按粒度分组（`util/digest.ts` 的 `groupNotes`），
> 月 → 周 → 日 → 主题，组内才按时间倒序；summary prompt 的禁令写具体（禁排比、禁空泛动词、
> 允许省略小节）。只动展示与 prompt。
>
> **v0.8.8（2026-10-31）**：时间轴手势重排（长按复制 / 左滑删除 / 右滑问），
> 去掉长按编辑小窗；问页改为历史会话自动落库 + 引用小标 + 左滑开历史；
> 设置页删掉三段说明文字；SQLite v8 新增 `ask_sessions`。
>
> **v0.8.9（2026-10-31）**：修三个真机反馈 —— 深度思考答完不再消失（`QaTurn.reasoning`
> + `ReasoningFold`）；「整理为碎片」改为**先调 AI 提炼精要、预览确认后写库**
> （`ai/qaSummary.ts` + `buildQaFragment`，失败退回 `buildQaNote` 完整转录兜底）；
> 时间轴 / 碎片详情用 `NoteBody` 渲染 Markdown。版本 0.8.9 / code 36。
>
> **v0.9.0（2026-10-31）**：更新下载改多源回退 —— 自定义地址（NAS / 自建）→
> 内置加速镜像（ghproxy 系）→ GitHub 官方，逐个尝试、失败换下一个。
> 新增 `update/mirror.ts`（候选地址构建 + 下载地址设置），设置页「关于」加「下载地址」输入。
> 版本 0.9.0 / code 37。
>
> **v0.10.0（2026-11-02）**：三件事。① 搜索命中可视化：正文描底色、每条标「N 处」、
> 详情页「第 i / N 处」逐处跳转（段落实测 y，不按字符比例估）。② 新增文档库：
> 上传 PDF / Word / PPT / Excel / 图片 / txt / md，原文件留在手机，正文走 MinerU
> 轻量接口转 Markdown（免 Token，≤10 MB / 20 页）；SQLite v9 新增 `documents`。
> ③ 更新公告改成「一行摘要 + GitHub 链接」，设置页加仓库与更新记录入口，
> 线上历史 Release 说明一并压到要点。版本 0.10.0 / code 38。
>
> **v0.11.0（2026-11-02）**：真机反馈两条。① **下载**：v0.9.0 的回退链把镜像排在最前，
> 实测镜像更慢且卡住不切 —— 根因是没有超时（连接建住了但不出字节不算报错）。
> 顺序改成 自定义 → **GitHub 官方** → 镜像兜底，并加巡检：15s 无新字节或
> 60s 平均 < 25 KB/s（且还有下一个源）就掐掉换源；进度 setState 节流到 250ms 治界面卡顿。
> ② **文档**：轻量接口本来就认 xlsx（不认 xls/csv），真正缺的是大文件通道。新增 MinerU
> 精准 `/api/v4`（Token、200 MB / 200 页、每天 1000 页），设置页加「文档解析 → MinerU Token」。
> 支持矩阵收敛成 `util/docSupport.ts` 的 `planForDoc`，上传预判 / 确认卡 / 失败重试都走它。
> 新增依赖 `fflate`（只解 zip 里的 `full.md`）。数据库不动。版本 0.11.0 / code 39。

---

## 3. 跑起来

```bash
cd F:/coding/python/project/Test/fragments
npm run typecheck      # tsc --noEmit
npm run build:web      # 只当编译校验，产物在同一次运行里删掉
npx expo start         # 手机 Expo Go 扫码（AI 功能需要配 API Key）
```

**打包**（改完必须自己打，用户明确要求过）：

```bash
npx expo prebuild --platform android --no-install --no-clean   # app.json 改了才需要
cd android
unset JAVA_HOME
export ANDROID_HOME="C:/Users/14428/AppData/Local/Android/Sdk"
export JAVA_HOME="D:/Program Files/Java/jdk-21"
export PATH="/d/Program Files/Java/jdk-21/bin:$PATH"
./gradlew assembleRelease --console=plain > build-vXXX.log 2>&1
```

产物 `android/app/build/outputs/apk/release/app-release.apk` → 复制成 `fragments-v<版本>.apk` 放根目录。
增量 2–3 分钟；首次全量约 45 分钟。详细环境与三个坑见 SPEC 第 12 节。

---

## 4. 代码地图

`App.tsx` + `src/` 共 **26,511 行**（不含 `android/`、`node_modules/`）。行数每次发版校正。

### 入口与页面

| 文件 | 行 | 干什么 |
|---|---|---|
| `App.tsx` | 438 | 外壳：`ThemeProvider` 接线 + 读 `ui_theme`；`Shell` 里是路由 state、全局 BackHandler、`draft` / `settingsFrom` / `askContextId`、数据加载 |
| `src/screens/TimelineScreen.tsx` | 1301 | 时间轴：**本月按日、更早按月**折叠，搜索、标签筛选、输入框、详情页入口、长按复制 / 左滑删除 / 右滑问；碎片正文走 NoteBody |
| `src/screens/AskScreen.tsx` | 2339 | 「问」：**提问 / 整理碎片 / 整理待办 / 写月小结四合一**；指令路由、agent 式整理（步骤日志 + 多篇产出 + 逐篇入库）、错误详情、历史会话（左滑进 / 右滑退、跳文档 / 重新整理 / 删除）、引用小标 |
| `src/screens/ReviewScreen.tsx` | 280 | 回顾：待办 / 小结 / 标签三个 tab；只负责取数与切 tab，列表在 `TodoPanel` |
| `src/screens/DocsScreen.tsx` | 1061 | 文档库：上传确认、保存原文件、解析流水线、列表状态、删除确认 |
| `src/screens/SettingsScreen.tsx` | 1085 | 外观、AI 接口（官方只填 Key + 余额 + 跳转，第三方折叠）、测试连接、索引健康度与自检、导出导入、统计、下载地址 |
| `src/theme.tsx` | 216 | 两套调色板、`ThemeProvider`、`useThemedStyles`、`tagColor` |

### AI 层

| 文件 | 行 | 干什么 |
|---|---|---|
| `src/ai/chat.ts` | 536 | **唯一请求层**：四段超时、SSE 解析调用、`finish_reason` 判定、错误映射；`AiError.detail` 带原始证据 |
| `src/ai/stream.ts` | 148 | SSE 逐块解析（`reasoning_content` 与 `content` 分开） |
| `src/ai/config.ts` | 35 | 读写 AI 配置 |
| `src/ai/keyStore.ts` | 37 | API Key 存 SecureStore |
| `src/ai/knowledge.ts` | 351 | **整理成文档**：只收知识的判据、多篇拆分、材料装填（70/30 截断）、已有待办去重、`extractKnowledge` / `reviseDraft` |
| `src/ai/qa.ts` | 688 | 「问」：四路检索 + 上下文碎片、预算装填、并行联网、引用反查与快照 |
| `src/ai/summarize.ts` | 302 | 月总结 prompt（表格 + 重要事件）与素材装填 |
| `src/ai/search.ts` | 162 | `/v1/tools/search`，退避重试、结果兜底 |
| `src/ai/balance.ts` | 122 | 官方余额：`GET /user/balance`、只认官方域名、失败不拦任何功能 |
| `src/ai/mineru.ts` | 648 | 文档解析两条通道：轻量（免 Token，≤10 MB/20 页）+ 精准 `/api/v4`（Token，≤200 MB/200 页）；签名上传 PUT（不带 Content-Type）、状态轮询、zip 只解 `full.md`、错误码映射 |

### 数据层

| 文件 | 行 | 干什么 |
|---|---|---|
| `src/db/types.ts` | 319 | `Repo` 接口（唯一契约）、`parseTags`、`OrganizeSessionPatch`、问答会话方法 |
| `src/db/repo.native.ts` | 1586 | SQLite 实现 + 迁移 v1–v11 + FTS 索引维护 + 标签重写 + 问答会话 |
| `src/db/repo.web.ts` | 879 | localStorage 实现（只为编译校验，**不能验证真实数据流**） |
| `src/db/repo.ts` | 7 | 平台分流入口（Metro 解析 `.native.ts` / `.web.ts`） |
| `src/db/importMd.ts` | 148 | Markdown 导入：选文件 / 读文本 / 判重 / 落库（解析全在 `util/mdParse.ts`） |
| `src/db/docFiles.ts` | 327 | 文档文件层：选文件、复制进私有目录、读纯文本、`content://` 交给系统打开 |

### 文档层（v0.12.0 起）

导入只保存原件，读与问都建立在「正文 + 切片」上。**判据只有一份**（`documents/formats.ts`），
页面不许自己写「这个后缀算不算能读」。

| 文件 | 行 | 干什么 |
|---|---|---|
| `src/documents/formats.ts` | 128 | 格式判定与唯一判据：`documentFormat` / `isDocumentReady` / `notReadyReason` / `locatorLabel` / `LOCAL_READER_LIMITS` |
| `src/documents/jobs.ts` | 487 | **应用级任务服务**：单文档互斥、`runId` + `expectedRevision` 写回、`AbortSignal` 取消、离页不中断、杀进程后收拾 `parsing` 尸体 |
| `src/documents/readers/extract.ts` | 164 | 本地提取总入口：按格式分派，产出正文 + 切片 + locator；表格复用解析缓存 |
| `src/documents/readers/chunk.ts` | 182 | 切片：按段落/行切、真实行号、`contentFromText`；超片数明确失败 |
| `src/documents/readers/excelWorkbook.ts` | 421 | 表格解析：`dense` 二维数组、**不按 `!ref` 遍历**、宽表不丢列、公式只读缓存值、先认文件头 |
| `src/documents/readers/workbookCache.ts` | 39 | 工作簿解析结果**单槽内存缓存**（键 = `fileUri + size`），阅读器与本地准备共用 |
| `src/documents/readers/viewCache.ts` | 128 | 解析结果**落盘缓存**（`documents/.cache/<原名>.view.json`）：重启后不用重解析；损坏或大小不符一律当没有 |
| `src/documents/readers/sheetWindow.ts` | 96 | 表格分列渲染的窗口计算（纯函数）：列偏移、可见列区间、左右占位 |
| `src/documents/readers/pdfRuntime.tsx` | 301 | 常驻 PDF 提取队列，`<DocumentRuntime />` 挂在 App 根，不跟页面生死 |
| `src/documents/readers/PdfReader.tsx` | 240 | PDF 阅读：PDF.js 文本层 + 跨页查找；首屏不等文字索引，索引完成后才放开查找 |
| `src/documents/readers/SheetReader.tsx` | 678 | 表格阅读：工作表切换、单元格/行列定位、内查找；列按视口窗口渲染 |
| `src/documents/readers/TextReader.tsx` | 335 | txt / md / **云解析快照**共用：分块虚拟化、真实行号、内查找；本机提取过就直接用库里的正文，不再读盘 |
| `src/documents/readers/textBlocks.ts` | 92 | 正文分块（纯函数）：代码围栏与表格不切断；断言「切完拼回去一个字不少」 |
| `src/documents/readers/SearchBar.tsx` | 156 | 阅读器查找栏：`disabled`（没有文字）与 `busy`（正在索引）是两种状态，不能合并 |
| `src/ai/documentRetrieval.ts` | 530 | 文档检索与装填：逐篇检索、每篇保底预算、概括类覆盖策略、D 引用快照 |
| `src/util/qaScope.ts` | 70 | 问答范围：`normalizeQaScope` / `qaScopeKey` / `sameQaScope` |

**阅读器的三条口径**（v0.13.0 起，改这里先看这三条）：

1. **`hasText` 是三态**：`true` / `false` / `null`（= 还没索引）。`null` 不能当 `false` 显示，
   否则每份正常 PDF 打开都会闪一下「没有文字层」。界面用 `SearchBar` 的 `busy` 表达它。
2. **PDF 首屏与文字索引解耦**：`open()` 在阅读模式下只建占位、画第一页，
   `startTextIndex()` 在首屏之后跑；索引完成后 RN 要把当前查询词**补发一次**，否则「打开就搜」永远没结果。
3. **长正文一律分块**：`textBlocks.buildBlocks` 是唯一实现，txt / md / 云解析快照共用。
   它有两处不许切（代码围栏、表格行之间），`assert_readers` 里既有「拼回去不少字」也有这两条。

**表格打开的四层**（v0.14.0 起，按顺序试，命中就返回）：

1. 内存单槽 `recallWorkbook`（同一次运行内，退出再进就没了）；
2. 磁盘 `readViewCache` → `documents/.cache/<原名>.view.json`（**重启后仍然有效**，
   读回来 40 ms vs 重新解析 340 ms）；原件连读都不读；
3. `readDocBytes` + `readWorkbook`（`dense:true`，手机上一张 10 万格的表 1.1–2.2 秒冻结）；
4. 解析完落盘（首屏之后 300 ms，不 await，失败只影响下次）。

第 3 步省不掉：`XLSX.read` 是同步的，进了就交不出主线程。已经做的只有「进去之前先把
『正在解析 N MB』画出来」。缓存这一层**不能抛** —— 任何读不出来都当作没有缓存。

### 纯函数层（改动时最好写断言）

| 文件 | 行 | 干什么 |
|---|---|---|
| `src/util/askIntent.ts` | 90 | **指令路由唯一判据**：`routeAsk`（月小结 → 待办 → 碎片整理 → 问答）+ 提示框种子的默认指令 |
| `src/util/knowledgeDoc.ts` | 271 | 整理草稿：模型 JSON 收敛、日期真校验、摘要、`draftProblem` 写入前校验 |
| `src/util/organizePlan.ts` | 465 | **唯一业务判据**：`mergeBatchResult`、`buildTagGroups`、`finalizePlan`、`appendSummary` |
| `src/util/tokenize.ts` | 167 | 中文 bigram、`buildFtsQuery`、`cleanTag` / `normalizeTag` / `dedupeTags` |
| `src/util/batch.ts` | 41 | `packFragments`（条数 + 字数双上限，至少收一条）、`pendingOnly` |
| `src/util/qaNote.ts` | 20 | 会话转碎片：AI 精要包装 `buildQaFragment` + 完整转录兜底 `buildQaNote` + 来源清单 |
| `src/util/text.ts` | 32 | `normText` / `containsText` / `clip` |
| `src/util/mdBuild.ts` | 112 | 导出拼接（时间轴 + 待办 + 标签索引）。纯函数，只为和 `mdParse` 做往返测试 |
| `src/util/mdParse.ts` | 285 | 导入解析：日期分节、`- HH:MM 正文 #tag`、`fragmentKey` 判重指纹、`looksBinary` |
| `src/util/date.ts` | 188 | 日 / 周 / 月键、`periodAnchor`、格式化；`recentMonths` 只算月 |
| `src/util/digest.ts` | 106 | 待补月总结清单（按月倒序，跳过本月与已写的月） |
| `src/util/todoTree.ts` | 125 | **待办父子唯一判据**：`buildTodoTree` / `planToggle`（四条级联规则）/ `flattenTodos` |
| `src/util/keyboard.ts` | 39 | `useKeyboardHeight()`（替代 `KeyboardAvoidingView`） |
| `src/util/highlight.ts` | 55 | 搜索命中位置：`findHits` / `countHits`。**计数与高亮共用同一份实现** |
| `src/util/docSupport.ts` | 212 | 文档支持矩阵与通道判据：`planForDoc`（local / lite / pro）+ `parseDocFile` 统一入口 + `SUPPORT_HINT`。**页面里不允许另写后缀判断** |

### 组件与类型

| 文件 | 行 | 干什么 |
|---|---|---|
| `src/components/KnowledgeDraft.tsx` | 591 | 整理草稿卡：编辑 / 预览（真渲染器）、待办勾选、**写入权限位**、写入后变成「已写入」 |
| `src/components/FragmentDetail.tsx` | 669 | 全屏详情：左右滑、整屏内联编辑、当天小结；搜索命中高亮与逐处跳转 |
| `src/components/DocViewer.tsx` | 803 | 文档阅读器：Markdown 阅读、打开原文件、重新解析、删除（二次确认） |
| `src/components/SummarySheet.tsx` | 744 | 月度总结面板：单篇 / 勾选缺口排队、新旧左右对照、替换确认、保存 |
| `src/components/TodoPanel.tsx` | 551 | 待办列表：两层缩进、勾选级联、折叠、多选合并、已合并撤回 |
| `src/components/TodoEditor.tsx` | 245 | 待办编辑层：新建 / 加子项 / 改文字与到期日（全屏覆盖，不用 Modal） |
| `src/components/UpdateSheet.tsx` | 520 | 更新弹窗：发现新版 / 下载中 / 待安装 / 失败四态；下载中显示当前源 |
| `src/update/check.ts` | 176 | 查 GitHub Release、6 小时节流、跳过版本、自动检查开关 |
| `src/update/mirror.ts` | 66 | 下载源候选构建：自定义地址 → **GitHub 官方** → 内置镜像（只留一个）；下载地址设置 |
| `src/update/download.ts` | 316 | 多源回退下载 + **停滞/低速巡检自动切源**（15s 无字节或 60s 低速）+ 校验字节数 + 拉起系统安装器 |
| `src/update/notify.ts` | 142 | 下载进度通知（LOW 渠道、sticky）。**JS 在后台被挂起，通知数字会停在切走那刻** |
| `src/util/semver.ts` | 62 | 版本号拆段比较（**不能比字符串**：`'0.10.0' < '0.9.9'`） |
| `src/components/NoteViewer.tsx` | 220 | 小结全屏阅读器：左右滑动在筛选集内切换 |
| `src/components/TagPanel.tsx` | 313 | 标签管理：改名 / 合并 / 删除 |
| `src/components/ImportSheet.tsx` | 202 | 导入预览：共读到多少 / 新增多少 / 跳过多少，确认才写库 |
| `src/components/NoteBody.tsx` | 550 | 正文渲染：标题 / 列表 / 表格 / 代码块 / 分隔线 / 引用小标；`variant` / `selectable` / `muted` 支持碎片与详情页。**表格用 View 排** |
| `src/util/mdBlocks.ts` | 459 | Markdown 分块解析 + 引用标记识别（纯函数，可断言）。渲染本地看不见，能验的都在这里 |
| `src/components/IconButton.tsx` · `ScreenHeader.tsx` | 101 / 84 | 全项目唯一的图标按钮与页头；`ScreenHeader` 的左侧按钮可换成「历史」 |
| `src/components/SwipeRow.tsx` | 279 | 时间轴行的手势：左滑露出删除、右滑直接进问。**不能加 `overflow:'hidden'`**，会切断时间轴竖线 |
| `src/components/CitationSheet.tsx` | 275 | 点引用小标后从底部展开的来源面板；正文走快照，不回库查 |
| `src/components/Toast.tsx` | 55 | 复制 / 归档 / 删除成功的轻提示；不自己计时 |
| `src/components/Reasoning*.tsx` | 75 / 86 / 69 | 思维链实时流 / 整理页折叠 / 轨迹 |
| `src/components/ReasoningFold.tsx` | 83 | 「问」页每轮答案上方的深度思考折叠块；最新一轮默认展开 |
| `src/components/TagPill.tsx` | 64 | 标签胶囊（哈希取色） |
| `src/types.ts` | 456 | 全部领域类型（`Fragment` / `QaTurn` / `QaCitation` / `AskSession` …；`QaTurn.reasoning` v0.8.9） |
| `src/export/markdown.ts` | 56 | 导出的 IO 部分：写文件 + 系统分享（拼接在 `util/mdBuild.ts`） |
| `src/version.ts` | 8 | 版本号常量（与 app.json 手工同步） |

---

## 5. 数据模型（SQLite v11）

```sql
fragments         id, content, created_at, source, status, tags(JSON), project, merged_into, nature
todos             id, text, due_at, done, done_at, source_fragment_id, created_at, merged_into, parent_id
notes             id, type(monthly|theme), title, body_md, period, created_at   -- v11 起只有 monthly 会被写入
settings          key, value
organize_runs     id, started_at, fragment_ids, model, result_json, applied   -- 历史表，v0.7 起不再写入
organize_sessions id, scope, pending_ids, cursor, plan_json, context_summary, finished, created_at, updated_at
ask_sessions      id, title, turns_json, scope_json, archived, fragment_id, created_at, updated_at
documents         id, name, ext, size, file_uri, body_md, pages, char_count, state, error, content_revision, indexed_revision, chunk_count, content_source, created_at, updated_at
document_chunks   id, document_id, content_revision, ordinal, text, locator_json
document_chunks_fts FTS5(text)  —— rowid 就是 document_chunks.id
fragment_fts      FTS5(text)  —— rowid 就是 fragments.id
```

索引：`fragments(created_at DESC)`、`todos(done)`、`todos(merged_into)`、`todos(parent_id)`、
`idx_todos_done_at(done_at DESC)`、`idx_sessions_open(finished, updated_at DESC)`、
`idx_ask_sessions_updated(archived, updated_at DESC)`、`idx_documents_updated(updated_at DESC)`、
`idx_document_chunks_doc(document_id, content_revision, ordinal)`。

**v6 迁移做了三件事**：`DROP TABLE knowledge_cards`、`DROP TABLE ask_logs`、
建 `fragment_fts` 与 `organize_sessions`。

**v7 只干一件事**：`todos` 加 `done_at`，并用 `created_at` 回填已有的已完成项。
「已完成只保留最近 5 条」靠它排序 —— 没有完成时间，就只能按创建时间清，会把
刚勾掉的旧待办先删掉。注意这一步**会物理删除**超出的条目（v0.7.3 升级时一次性收敛）。

**v8 只干一件事**：建 `ask_sessions`。`turns_json` 存 `QaTurn[]`，每轮带
`citations` 快照（kind / id / label / body / url），所以历史会话重开时点引用
不依赖碎片、待办、小结还在不在。它**不写 `fragments`**：只有用户点「整理为碎片」
才落一条纪要。

**v9 只干一件事**：建 `documents`。正文单独一列 `body_md`，**列表查询不取它** ——
一篇几十万字的文档每次都读一遍，首屏会肉眼可见地卡。`char_count` 由写入方按
`body_md.length` 一起写，调用方不要自己算。文档**不进** `fragment_fts`。

**v10 只干一件事**：给文档补「可检索」的那一半 —— `documents` 加
`content_revision` / `indexed_revision` / `chunk_count` / `content_source`，
建 `document_chunks` 与 `document_chunks_fts`，并给 `ask_sessions` 加 `scope_json`。

- 两个版本号的作用是**判断检索结果还能不能用**：`content_revision` 是正文被写了几次，
  `indexed_revision` 是索引建到第几版。两者不等时，切片查出来的是旧正文的片段，
  `searchDocumentChunks` 必须把它们排除掉，否则回答会引用一段已经不存在的文字。
- 已有文档的 `content_revision` 保持 0（正文在库里，没有切片），**迁移故意不自动建索引**：
  建索引要跑分词和入库，属于用户点「准备」的动作，不能借迁移之名悄悄做掉。
- 切片**不进 `fragment_fts`**：一条碎片和一段 PDF 正文混在同一个索引里，时间轴搜索会被
  文档段落污染。文档有自己的一份 FTS。

**v11 干两件事**：`todos` 加 `parent_id`（两层子项，自引用，另加索引
`idx_todos_parent`），以及 `DELETE FROM notes WHERE type IN ('daily','weekly')`
—— 日 / 周小结下线，旧内容一并清掉（用户 2026-11-10 要求「更新后也不保存」）。

- 子项用**自引用而不是独立表**：两者字段完全一样，拆表之后「列出所有未完成待办」
  要 UNION，父项完成时还得跨表更新，而「一条待办能挂子项、也能被挂」本来就是自引用。
- 删除**不用 `hidden` 标记**：加了标记迟早有某条查询忘了过滤；直接删干净。
  `monthly` 与更早的 `theme` 不动。
- 迁移**不重建任何索引**，也不回填父子关系 —— 旧数据全是顶层，这是正确的默认。

**v12 干两件事**：`documents` 加 `origin`（`file` / `knowledge`）与 `excerpt`，
`ask_sessions` 加 `document_id` 与 `source_ids`。

- `origin` 不能省成「`file_uri` 为空就是知识文档」：导入的原件被用户清掉之后
  `file_uri` 也会变空，那时它是「原件没了但正文还在」，要提示重新导入；
  而知识文档天生没有原件。**两种状态用一个字段表达，最后一定是两处判据对不上。**
- `excerpt` 在写入时算一次。列表查询**永远不会**为了一行摘要去读 `body_md` ——
  那等于把「列表不带正文」这条规矩废掉。
- `source_ids` 存的是当初喂给模型的碎片 id，供「重新整理」复现同一批输入。
  不存的话，重新整理只能拿「最近 40 条」重跑，结果和上次不是一回事。

前十一段迁移原样保留（回滚就得重放），`PRAGMA user_version` 就是「跑过几条」。

几个容易误解的点：

- **`nature` 字段还在，但没人读**。v0.7 起不再写 `knowledge`，v0.16 起整理也不再改它。
  留着只为兼容旧数据，不要基于它做判断。
- **`notes.type = 'theme'` 同样只是历史遗留**，新数据只有 `monthly`（v0.15 起日/周已下线，
  v11 迁移会把库里的 daily/weekly 删掉）。`NOTE_GROUP_LABEL` 里仍留着四种文案，
  是因为**万一某台设备的迁移没跑到**，旧数据要能照常显示，而不是凭空消失。
- **标签没有表**。`fragments.tags` 是 JSON 数组，`listTags()` 是遍历所有碎片统计出来的。
  改名 / 合并 / 删除走 `rewriteTags`，全库重写 JSON 并重建索引。
- **`notes` 的 `(type, period)` 唯一性由应用层保证**（`upsertNote` 先查后写）。
  period 可空，SQLite 的 UNIQUE 对 NULL 不去重。
- **`done_at` 为空但有 `done = 1` 的是旧数据**（v7 迁移前完成的）。清理逻辑用
  `COALESCE(done_at, created_at)` 兜底，别直接拿 `done_at` 排序，否则这些会全排到最后。
- **`organize_runs` / `organize_sessions` 是死数据**。v0.16 删掉了整理页与批循环，
  这两张表只剩历史价值：`Repo.saveRun` / `saveSession` 还在接口里，**没有任何调用点**。
  别以为它在记录历史；也不要基于 `organize_sessions` 做「续跑」——那个功能已经不存在。

---

## 6. AI 契约

**服务商** DeepSeek，OpenAI 兼容 `POST {baseUrl}/chat/completions`，默认模型 `deepseek-flash`。
`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用，别写。

| 功能 | 文件 | 输出 | `json` | 备注 |
|---|---|---|---|---|
| 整理成文档 | `ai/knowledge.ts` | `{title, body_md, todos, note}` | `true` | 12K 额度，`effort: high`；撞额度直接抛错，草稿不落地 |
| 只抽待办 | `ai/knowledge.ts` | 同上（`body_md` 空） | `true` | 6K 额度，`effort: low` |
| 改稿 | `ai/knowledge.ts` | 同结构 | `true` | 只改用户点到的地方，其余原样返回 |
| 月总结 | `ai/summarize.ts` | Markdown（表格 + 列表） | **`false`** | 撞额度直接抛错，不保存 |
| 问 | `ai/qa.ts` | Markdown + `[F]/[N]/[T]/[W]` 引用 | **`false`** | 撞额度标 `truncated` |

### 整理草稿的输出契约

```json
{
  "title": "群晖换盘",
  "body_md": "## 结论\n4 块 8T，RAID5 重建 30 小时完成。",
  "todos": [{"text": "把旧盘跑一次 SMART 长检", "due": null}],
  "note": "覆盖换盘全过程，2 条待办"
}
```

四个字段都可能为空，但**形状不能变**：`normalizeDraft` 按名字取，改一个字母草稿就是空的。
`due` 只接受 `YYYY-MM-DD` 且必须是真实日期 —— `2026-02-31` 会被 `Date` 悄悄滚到 3 月 3 日，
所以 `dueValid` 解析回来还要和输入比对一次。

### 整理的材料与预算

| 项 | 值 | 为什么 |
|---|---|---|
| 单次条数 | 40 条 | 再多输出会撞额度，而撞额度等于这一批白跑 |
| 单次字数 | 16,000 字 | 与 `packFragments` 同一口径（条数 + 字数双上限，至少收一条） |
| 超长材料 | 保留前 70% + 后 30% | 只留前面丢结论，只留后面丢起因；截断要在卡片上如实写出来 |
| 输出额度 | 12,000（文档）/ 6,000（待办） | **思考链和正文共用**，给少了会「想到一半停住」 |

---

## 7. 五条主流程

### 7.1 「问」里的四种任务：路由 → 执行 → 草稿 → 写入

```
用户输入
  ↓ routeAsk(text)                     util/askIntent.ts（唯一判据）
  ├─ digest   → 打开 SummarySheet（月小结）
  ├─ todos    → extractKnowledge(mode:'todos')
  ├─ organize → extractKnowledge(mode:'knowledge')
  └─ answer   → askQuestion(...)       原有问答链路
        ↓
   整理类：草稿落在对话流里（KnowledgeDraft）
        ├─ 直接改（标题 / 正文 / 待办逐条勾）
        ├─ 继续说一句 → reviseDraft（只改点到的地方）
        └─ 通过并写入 → writeKnowledgeDocument + insertTodo
```

**路由顺序不能改**：月小结 → 待办 → 碎片整理 → 问答。「整理这个月的碎片」同时命中
「整理」和「这个月」，先判「整理」的话这句话永远写不出月总结。

**草稿开着时，任何一句话都是「改哪里」**，不再重新判意图。想提问就先把草稿收掉
（卡片上有按钮）—— 让「这到底是在改稿还是在提问」变成一条明确的规则，比让分类器猜靠谱。

### 7.2 写入的三条纪律（`documents/knowledge.ts`）

1. **先插一条 `parsing` 记录，再 `replaceDocumentContent` 写正文**。
   正文要靠 document id 才能写；而 `replaceDocumentContent` 会把 state 改成 `done`。
   直接 `updateDocument({bodyMd})` 只写正文、不建切片 —— 文档能读、能按标题搜到，
   但「就这份文档提问」查不到它的任何一段。
2. **写失败要把空壳删掉**。留一条 `parsing` 的空文档，用户点开是空白，而且没有入口能清掉它。
3. **先文档、后待办、最后改会话标记**。顺序反了就可能「待办进去了、文档没进去」，
   用户没法从界面上判断缺了哪一半。

### 7.3 问：四路检索 → 装填 → 并行联网 → 回答

```
retrieveLocal(question, turns, contextIds)
  ├─ contextIds（右滑带入的那条，绕过 merged 过滤）  ⭐ v0.8.8
  ├─ repo.searchFragments(question, 40)          FTS5 + LIKE 兜底
  ├─ timeRange(question) → listFragmentsBetween  今天/上周/最近 N 天…
  ├─ 提到的标签名（≥2 字，最多 2 个）→ listFragmentsByTag
  └─ 上一轮 sourceIds 最后 12 条
  ↓ 去重、去 merged（上下文那条除外）、按 18 条 / 单条 1200 字 / 总 36000 字装填
  ↓ 小结按 token 命中取前 6 篇（没命中就不给）；待办 40 未完成 + 20 已完成
  ↓ useWeb ? searchWeb() 并行（失败只记 webError）
requestChat({json:false, effort: thinking ? 'high' : undefined})
  ↓ 引用反查：只认本轮给过的 [F id]
  ↓ buildCitations：F/N/T/W 各取正文快照，随 QaTurn 一起存
```

- 多轮只带「问题 + 回答」，最多 8 轮；**不带上一轮资料**（每轮重新检索）。
- 网络资料单独成段，硬性要求 `[W]` 引用，**不许说成「你记过的事」**。
- 每答完一轮 `AskScreen` 立刻 `repo.saveAskSession`；失败只静默，不拦回答。
  保存带**会话代次**（`sessionGenRef`）：切换/新建会话后，旧请求回来不能再改新会话的标题和 id。

### 7.4 从历史会话整理：跳转、重跑、删除

历史行上如果 `document_id` 非空，就带一个「已写入文档」徽标，点它直接打开那篇文档
（`DocViewer` 以内嵌覆盖层打开，不跳页）。会话操作面板有三项：

| 操作 | 行为 |
|---|---|
| 整理成文档（AI 提炼） | 把**这场会话的问答**当材料，走同一条 `extractKnowledge` |
| 打开整理出的文档 | 只有整理过才出现；指向 `document_id` |
| 重新整理 | 优先用 `source_ids` 找回**当初那批碎片**；碎片被删了才退回会话原文 |

- 重新整理走 `findFragmentsByIds`，**不能**用 `listFragments(limit)` 再自己筛：
  limit 一旦小于总数，较早的碎片就查不到，重跑会静默少一半材料。
- 删除会话**不删文档**：文档已经是独立的一篇东西，删会话把它带走等于「删聊天记录顺手删了笔记」。
  删除确认卡上写清了这一点。
- 写入成功后 `markAskSessionDocument(sessionId, docId, sourceIds)`；同一场会话再整理一次会覆盖指向，
  旧文档留在文档区（不自动删，用户可能已经引用过它）。

### 7.5 小结、待办与导出

- 月总结：`SummarySheet` 取该月全部碎片 → `summarizePeriod()` → 预览 → `upsertNote`。
  入口现在只在「问」里（提示框或一句「写个月小结」）。输出是**一张按天的
  「日期 \| 事件」表 + 3–6 条重要事件与进展**，650 字上限，素材预算 60k 字。
  有旧稿时左右对照；缺口可勾选排队生成、逐篇确认。**完整规格见 SPEC §6.3，这里不重复。**
- 待办：勾选级联全在 `util/todoTree.planToggle`，两份 repo 只负责执行；
  两层子项、可新建/编辑/多选合并。**四条级联规则与四个边界坑见 AGENTS「待办的两层子项」。**
- 导出：`# 碎片导出 · 日期` → `## 时间轴`（按天 `###`）→ `## 待办`（未完成 / 已完成，子项缩进两格）
  → `## 标签索引`。

---

## 8. 踩过的坑（v0.7 相关优先）

### 8.1 循环与游标

- **别用 offset / 池子长度算进度。** v0.6 两次翻车都在这里：批次永远从池子头部装填，
  重构不改变碎片状态，点多少次「继续」都是同一批。现在只用「快照 − 已处理 − 已跳过」。
  删掉的碎片会让「total − 池子长度」偏大，所以进度也只按集合算。
- **`skipBatch` 不标状态。** 跳过的是这一次的请求，不是这些内容。
- **装箱至少收一条。** 否则一条超长碎片会让批次永远为空，那条就永远整理不了。
- **`truncated` 对半拆，不是失败。** 拆到只剩一条还截断，才报错。
- **校验用原始 `todos`，不是有效视图。** 计划里的变更没落库，拿有效视图校验会把合法 id 判掉。

### 8.2 标签

- **`cleanTag` 存库，`normalizeTag` 只做比较。** 混用会把 `NAS` 存成 `nas`。
- **`normalizeTag(' # NAS')` 曾经返回 `#nas`。** 只削 `^#+` 匹配不到带前导空格的写法；
  改成 `^[\s#]+`。从正文复制标签时很容易带空格。
- **一条碎片的多个标签组要先合并再写。** 逐组 `applyTags` 会互相覆盖。
- **标签全被取消时不要写空数组。** 静默清空找不回来。

### 8.3 全文检索

- **中文只能 bigram。** `unicode61` 把整句当一个词；`trigram` 对 <3 字查询不命中（「报销」搜不到）。
  两种都是**零报错**的静默失败。
- **`fragment_fts.rowid = fragments.id`。** 写入先删后插；改内容 / 改标签 / 合并 / 删除都要同步。
- **FTS 0 命中要退回 LIKE。** 慢一点可以，不能给空结果还说是搜过了。

### 8.4 问答

- **只给筛过的资料。** 全库塞上下文会让问题越具体、答得越偏。
- **引用反查只认本轮编号。** 模型会编 `[F999]`。
- **`json:false` 不能省。** 否则整篇 Markdown 被压成一个字符串，换行变 `\n`。
- **返回键由 App 转发。** 页面自己注册的 `BackHandler` 抢不过 App 那个（后注册优先），
  而「要不要存纪要」是页面内部状态，只能由 App 反过来调 `registerClose`。
- **`buildQaNote` 不用正则 lookbehind。** Hermes 对零宽断言的支持看版本，且 `tsc` / Web 构建都不报。

### 8.5 历史坑（仍然有效，压缩）

- **`prebuild` 必须 `--no-clean`**，否则删掉整个 android/，下次编译 45 分钟。
- **`max_tokens` 含思考链**。空结果先看 `finish_reason`：`length` = 撞额度，
  `insufficient_system_resource` = 对方资源不足。两者不能报同一句话。
- **`reasoning_effort: high` 是加压指令**，不是「想久一点」。机械抽取用 `low`（= 不加前缀）。
- **`finish_reason` 要在读 `delta` 之前读**，它挂在最后一个 `delta` 为空的 chunk 上。
- **SQL 清空字段写 `NULL` 字面量**，别用 `?` 绑 JS null（部分版本会静默改 0 行）。
- **别用 `changed` 判断成败**，写库后重新查询。
- **全屏详情只存 id**，内容 `useMemo` 派生；存对象快照会「看起来没变」。
- **跨页面草稿要提到 `App`**。`TimelineScreen` 切走就卸载。
- **显示与写入共用同一个函数**。两份实现迟早漂移，表现是「界面说改 A，实际改 B」。

---

### 8.7 CI（v0.8.3）

仓库 `github.com/gup-n/fragements`（拼写就是 fragements）。推送 master 触发构建，
8 分钟左右出 APK artifact。

- **不要加 `android-actions/setup-android`**。runner 自带 SDK，再加会和预装目录抢。
  用预装的 `$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager` 补组件。
- **`local.properties` 要手写**：prebuild 生成的工程里没有它，gradle 有时找不到 SDK。
- **缓存 key 要在 prebuild 之后算**，否则 hash 的是还没生成的文件。
- **`cancel-in-progress: true` 会在连推时取消上一次**。构建要 8 分钟，
  短时间内推两次等于白跑第一次 —— 想每次都留产物就把它关掉。
- 公开仓库的**构建日志要 admin 权限**才能通过 API 下载（403），
  失败时只能靠 steps 状态反推，必要时去网页点开看。
- **CI 里有一道 `npm run check:docs`**（v0.8.7 起）。它挡的是「改了代码没改文档」：
  版本号三处不一致、HANDOFF 行数表漂了、`TEXTS.md` 抄的提示词和源码不一样、
  死链、路径写错、「N 条清单」和 ROADMAP 对不上。**这些不用人眼扫，别绕过它。**

### 8.8 发版流程（v0.8.4 起）

```
# 1. 改版本号三处：src/version.ts、package.json、app.json(version + versionCode)
# 2. 写 CHANGELOG 的本版小节 —— Release 说明从这里抠，别另写一份
# 3. prebuild + assembleRelease，本地验一遍
# 4. 提交并推送 master
git push origin master
# 5. 打 tag 并推 —— 这一步才会建 Release
git tag -a v0.8.5 -m "v0.8.5 xxx"
git push origin v0.8.5
```

CI 在 tag 构建成功后用 `gh release create` 建 Release，asset 是
`fragments-v0.8.5.apk`，说明来自 `scripts/release_notes.mjs`（读 CHANGELOG）。

**没打 tag 就不会有 Release**，App 也就查不到更新。反过来说，
推 master 只跑构建、不发布，可以放心推。

两个注意：

- Release 需要 `permissions: contents: write`，workflow 里已经写了。
  不加的话 `gh release create` 会 403，而且报错不明显。
- **删过 tag 再重建，旧 Release 会变成草稿**（`gh release view` 查得到，匿名访问 404）。
  v0.12.0 第一次重建就栽在这：CI 全绿、步骤显示「创建 Release 成功」，手机端更新却下不到。
  workflow 现在**无条件**再跑一次 `gh release edit --draft=false` 并打印最终状态，
  别把那一行删掉。同一版重跑也只更新说明和 APK，不会重复建。
- asset 名要先 `cp` 再传，不要用 `gh` 的 `file#name` 语法 —— v0.8.4 试过，
  没生效，落成了 `app-release.apk`。

### 8.6 主题（v0.8.0）

- **`StyleSheet.create` 会在模块加载时把色值固化。** 所以「给 `C` 加个 setter 就行」
  是错的 —— 换主题后旧样式表不会变。任何带颜色的样式必须是
  `const makeStyles = (c: Palette) => StyleSheet.create({...})`，
  组件里 `const { c, styles } = useThemedStyles(makeStyles)`。
- **JSX 内联的颜色也要走 `c`。** `<Ionicons color={c.text2}>`、`placeholderTextColor`。
  写死一个 `#FFFFFF`，深色下就是一块拍在脸上的白。
- **模块级常量拿不到 `c`。** `IconButton` 的 `TONE_BG` 因此改成了函数。
- **实心按钮上的字不能恒白。** 深色的 `accent` 是 `#5B9BD8`，压白字只有 2.5:1，
  要用 `c.onAccent`。
- **`userInterfaceStyle: "automatic"` 要装 `expo-system-ui`**，不装 prebuild 会警告、
  Android 侧开关不生效。
- **启动屏有第二份颜色。** `plugins/withNoSplashAnimation.js` 会写
  `values-night/colors.xml`，改 `DARK.page` 时记得同步 `PAGE_COLOR_DARK`。

### 8.9 问页会话与引用（v0.8.8）

- **会话保存是异步的，必须带代次。** `sessionGenRef` 在新建 / 切换会话时 +1；
  旧请求回来发现代次变了就只落库、不改当前界面状态。否则上一场的标题和 id
  会写到新会话上，表现是「新会话一打开就带着旧标题」。
- **不要每次关闭都重存会话。** `dirtyRef` 只标记「有还没成功落库的新轮次」；
  否则点开历史再退出，会话就被顶到列表最前，排序会莫名其妙地变。
- **归档不动 `updated_at`。** 归档是收纳，不是新活动；动了排序就会把归档项顶上来。
- **引用编号按正文首次出现顺序。** 同一个来源在回答里出现两次，必须还是同一个号；
  不能用 `citations` 数组下标 —— 那个顺序是 F→N→T→W，和正文对不上。
- **代码块里的 `[F12]` 不是引用。** `parseInline` 先认代码，再由 `pushText` 认引用；
  顺序反了会把示例命令变成可点来源。
- **历史会话里的引用走快照，不回库查。** 碎片可删、待办可合并、小结会被覆盖；
  回查会得到空面板，而用户明明看到「按 [F3] 的做法」。
- **思维链不能只在 `busy` 时渲染。** 答完 `busy` 变 false，组件一卸载就是「闪一下没了」；
  现在 `QaTurn.reasoning` 持久化，`ReasoningFold` 在答案上方折叠，最新一轮默认展开。
- **会话转碎片先 AI 提炼，再预览确认。** `summarizeQaSession` 出 300-800 字精要，
  `buildQaFragment` 包装，用户点「存为碎片」才写库。不要直接存全文，也不要按字数硬截。
- **AI 失败要留兜底。** 「保存全文」走 `buildQaNote`（完整转录、不截断），
  否则没配 Key / 断网时用户会卡在预览页。
- **碎片正文也要走 `NoteBody`。** 会话转出来的碎片有 `##` / `- ` / 表格 / 代码；
  时间轴和详情页都不能再拿 `<Text>` 原样显示。详情页传 `variant="reading"` + `selectable`。
- **引用小标不能画成 `[F12]` 原文。** 用户不知道 F 是什么；渲染层只给序号，
  详情放到 `CitationSheet`。

### 8.10 时间轴手势（v0.8.8）

- **方向是用户定的：左滑 → 右侧「删除」；右滑 → 左侧「问」。** 别再按直觉反过来写。
  `SwipeRow` 的 `leftAction` 由右滑露出（`leftInstant` 时直接执行），
  `rightAction` 由左滑露出。
- **SwipeRow 不能加 `overflow:'hidden'`。** 时间轴竖线靠 `bottom:-8` 伸到下一行，
  裁了每行底部会缺 8px，整条线变成虚线。横向滑出的内容本来就在屏幕外，不需要裁。
- **回弹动画必须 `useNativeDriver: false`。** 拖动时用 `tx.setValue()` 逐帧写值，
  同一个 Value 再交给原生驱动，部分安卓机上直接不动。
- **只在横向意图明确时接管手势。** `|dx| > 8` 且 `|dx| > |dy| * 1.5`；否则列表滚不动。
- **长按复制不要和滑动抢。** 手指没移动时 PanResponder 不接管，Pressable 的
  `onLongPress` 才会正常触发。
- **删除必须二次确认。** 滑一下只是露出按钮，点按钮才弹确认；确认框仍是覆盖层，
  不是 `Modal`。

## 9. 真机待验

110 条清单在 [ROADMAP.md P0-1](./ROADMAP.md)，按风险排序。最要紧的七条：

1. 50 条以上能不能**一路跑完**
2. 确认页标签分组条数**加起来对不对**
3. 「应用」回报的写入数与实际变化**对不对**
4. 跑到一半杀 App，重进有没有**继续上次**
5. 「问」的引用 `[F12]` 点开**是不是原文**
6. **导出 → 卸载重装 → 导入**，条数/时间/标签能不能原样回来（这条最像「真的会用到」）
7. 新生成一篇日小结，**读起来像不像 AI 写的** —— prompt 只能压形状，最终看语感

v0.6.x 的老功能（折叠、搜索、详情页、导出、小结）已经在之前版本验过，
但v7 迁移（`todos.done_at`）之后升级路径必须验一次：**从更早的版本直接升到最新，旧数据要在**。

---

## 10. 我犯过的错（给接手的人）

- **把「结构问题」当成「prompt 问题」修了很久。** 知识卡重复、主题裂开，本质是
  「主题是免费新建的字符串、卡片没有唯一约束」，改 prompt 只是在拖时间。v0.7 才承认这一点。
- **提需求时替用户预设了答案。** 问「问答基于什么资料」时直接给了三个形态，
  用户反问「这个要看怎么整理」。应该先问「你希望沉淀成什么」，再给方案。
- **一个变量服务两个语义。** `overflow = available - batch.length` 被当成「还有没有剩」，
  50 条跑完 30 条后它是 0，按钮消失。判「有没有剩」看 `available`，显示「下一批几条」看 `batch.length`。
- **判重分母用 `min()`。** 一张只引用 1 条原文的窄卡能把 10 条来源的大卡判成「被取代」。
  用 Jaccard（两边都进分母）。
- **空结果没留出口。** `acceptedCount === 0` 时主按钮禁用，于是「放弃 → 重进 → 同一批 → 还是空」死循环。
  现在 0 项时主按钮变「跳过这批」。
- **写了「移除方向」但藏在输入框留空里。** 真机上没人发现。
  **隐藏的语义等于没有功能**，破坏性或非常规动作必须做成看得见的按钮。

---

## 11. 下一步（按顺序）

1. **装 `fragments-v0.12.0.apk`，按 ROADMAP 的清单验。** 有问题先修，不要叠新功能。
   如果手机已经是 v0.8.5 以上，直接打开 App 就能收到更新提示，不用手动装。
2. 通知栏常驻的「快速记录」入口（ROADMAP P0-2）。通知库 v0.8.6 已经因为下载进度通知装好了，
   剩下是 JS 改动，见 ROADMAP 里重估过的成本。
3. 大库性能：几千条时时间轴全量读进内存会开始慢，等量真上来再动。
4. OTA（EAS Update）要不要上，等用户定 —— GitHub Release 已经在用，装包这件事不疼了。

> 「从 Markdown 导入」已在 v0.7.2 补上，回归测试是 `npm run test:md`，**改导出格式前后都要跑**。
> 发版流程见 8.8：改三处版本号 → 写 CHANGELOG → 打 tag。**没打 tag 就不会有 Release**。
