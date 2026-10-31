# 交接文档（给下一个模型）

> 写于 2026-10-24，**2026-10-25 重整过结构**，**2026-10-31 更新到 v0.8.8**：变更记录迁到 [CHANGELOG.md](./CHANGELOG.md)，
> 本文只留「现在的状态」和「怎么接着干」。对应版本 **v0.8.8（versionCode 35）**。
>
> **阅读顺序**：本文件（10 分钟）→ [SPEC.md](./SPEC.md) 第 0 节（v0.7 定稿）+ 第 6 节（请求层）
> + 第 8.1 节（Android UI 红线）→ [ROADMAP.md](./ROADMAP.md) 未完成项。
> 想知道「某个设计为什么长这样」，翻 [CHANGELOG.md](./CHANGELOG.md)；`AGENTS.md` 是速查，
> `README.md` 是给人看的门面。

---

## 1. 三十秒速览

一个**个人单机 Android 应用**，叫「碎片」。核心是「碎片化记录 + AI 分批整理 + 问自己的记录」：

随手记一条 → 点整理，AI **一批一批跑到完** → 全部跑完统一确认 → 才写库。
想不起来时直接问，答案带引用；退出可以留一条「问答纪要」碎片。

| 项 | 值 |
|---|---|
| 路径 | `F:/coding/python/project/Test/fragments` |
| 包名 | `com.local.fragments`（固定，改包名等于换 App） |
| 版本 | v0.8.8 / versionCode 35 |
| 技术 | RN 0.88 + Expo SDK 58 + TS 6.0，Android 单端，SQLite v8 |
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
| 自动化测试 | 没有单测框架，但有三道机器检查：`npm run test:md`（导入导出往返 24 项）、`npm run check:docs`（文档一致性 7 项）、`npm run typecheck` |
| 真机验证 | v0.7 / v0.8 这批**基本没验**，67 条清单在 [ROADMAP P0-1](./ROADMAP.md) |
| 外观 | 深色 / 浅色 / 跟随系统三档，默认跟随系统（v0.8.0） |
| 小结文风 | 精简优先，三节统一（重点/进展/待处理），字数是纯上限（v0.8.2，见 `TEXTS.md`） |
| 已知阻塞 | 无。剩下的是「验」和「补」（通知栏快速记录入口） |
| 数据迁移 | v8。从 v0.6.x 直接升，碎片 / 待办 / 小结全部保留；v7 加 `todos.done_at` 并清理超过 5 条的旧完成项；v8 新建 `ask_sessions` |

**一句话：功能完整，但 v0.7 的重做还没经过真机检验。** 别在这之前继续叠功能。

> **v0.7.3（2026-10-26）**：已完成待办只留最近 5 条（迁移 v7 + 物理清理）、小结改为书面语、
> 时间轴周总结独占周级分区置顶。三处只动保留策略与展示，未改整理 / 问答链路。
>
> **v0.7.4（2026-10-26）**：回顾页「小结」也按粒度分组（`util/digest.ts` 的 `groupNotes`），
> 月 → 周 → 日 → 主题，组内才按时间倒序；summary prompt 的禁令写具体（禁排比、禁空泛动词、
> 允许省略小节）。只动展示与 prompt。
>
> **v0.8.8（2026-10-31）**：时间轴手势重排（长按复制 / 右滑删除 / 左滑问），
> 去掉长按编辑小窗；问页改为历史会话自动落库 + 引用小标 + 左滑开历史；
> 设置页删掉三段说明文字；SQLite v8 新增 `ask_sessions`。

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

`App.tsx` + `src/` 共 **16,813 行**（不含 `android/`、`node_modules/`）。行数每次发版校正。

### 入口与页面

| 文件 | 行 | 干什么 |
|---|---|---|
| `App.tsx` | 411 | 外壳：`ThemeProvider` 接线 + 读 `ui_theme`；`Shell` 里是路由 state、全局 BackHandler、`draft` / `settingsFrom` / `askContextId`、数据加载 |
| `src/screens/TimelineScreen.tsx` | 1231 | 时间轴：按日折叠、搜索、标签筛选、输入框、详情页入口、长按复制 / 右滑删除 / 左滑问 |
| `src/screens/OrganizeScreen.tsx` | 933 | 整理：起会话 / 续跑 / 停止 / 失败三选一 / 确认页 / 应用 |
| `src/screens/AskScreen.tsx` | 1214 | 「问」：聊天布局、两个开关、引用小标、历史会话（归档 / 整理为碎片 / 删除）、左滑开历史 |
| `src/screens/ReviewScreen.tsx` | 480 | 回顾：待办 / 小结 / 标签三个 tab；小结有全部/日/周/月筛选 |
| `src/screens/SettingsScreen.tsx` | 750 | 外观、API 配置、测试连接、索引健康度与自检、导出导入、统计 |
| `src/theme.tsx` | 216 | 两套调色板、`ThemeProvider`、`useThemedStyles`、`tagColor` |

### AI 层

| 文件 | 行 | 干什么 |
|---|---|---|
| `src/ai/chat.ts` | 457 | **唯一请求层**：四段超时、SSE 解析调用、`finish_reason` 判定、错误映射 |
| `src/ai/stream.ts` | 148 | SSE 逐块解析（`reasoning_content` 与 `content` 分开） |
| `src/ai/config.ts` | 35 | 读写 AI 配置 |
| `src/ai/keyStore.ts` | 37 | API Key 存 SecureStore |
| `src/ai/prompt.ts` | 208 | 整理 prompt：六类 + `batch_summary`，四份上下文清单 |
| `src/ai/deepseek.ts` | 158 | 一次整理请求：`json:true`、`pickEffort`、只收敛形状 |
| `src/ai/organizeRun.ts` | 293 | **整理循环**：id 快照、装箱、批循环、截断对半拆、每批落库 |
| `src/ai/qa.ts` | 434 | 「问」：四路检索 + 上下文碎片、预算装填、并行联网、引用反查与快照 |
| `src/ai/summarize.ts` | 313 | 日 / 周 / 月小结 prompt 与素材装填 |
| `src/ai/search.ts` | 162 | `/v1/tools/search`，退避重试、结果兜底 |

### 数据层

| 文件 | 行 | 干什么 |
|---|---|---|
| `src/db/types.ts` | 204 | `Repo` 接口（唯一契约）、`parseTags`、`OrganizeSessionPatch`、问答会话方法 |
| `src/db/repo.native.ts` | 1008 | SQLite 实现 + 迁移 v1–v8 + FTS 索引维护 + 标签重写 + 问答会话 |
| `src/db/repo.web.ts` | 615 | localStorage 实现（只为编译校验，**不能验证真实数据流**） |
| `src/db/repo.ts` | 7 | 平台分流入口（Metro 解析 `.native.ts` / `.web.ts`） |
| `src/db/commit.ts` | 192 | **应用**：按勾选写库，合并 → 标状态的顺序，真实计数 |
| `src/db/importMd.ts` | 148 | Markdown 导入：选文件 / 读文本 / 判重 / 落库（解析全在 `util/mdParse.ts`） |

### 纯函数层（改动时最好写断言）

| 文件 | 行 | 干什么 |
|---|---|---|
| `src/util/organizePlan.ts` | 465 | **唯一业务判据**：`mergeBatchResult`、`buildTagGroups`、`finalizePlan`、`appendSummary` |
| `src/util/tokenize.ts` | 167 | 中文 bigram、`buildFtsQuery`、`cleanTag` / `normalizeTag` / `dedupeTags` |
| `src/util/resultItems.ts` | 111 | 六组结果的 key、默认勾选、`isDestructiveKey` |
| `src/util/batch.ts` | 41 | `packFragments`（条数 + 字数双上限，至少收一条）、`pendingOnly` |
| `src/util/qaNote.ts` | 74 | 纪要压缩：最近 6 轮、每答前 3 句 / 300 字、剥 Markdown |
| `src/util/text.ts` | 32 | `normText` / `containsText` / `clip` |
| `src/util/mdBuild.ts` | 103 | 导出拼接（时间轴 + 待办 + 标签索引）。纯函数，只为和 `mdParse` 做往返测试 |
| `src/util/mdParse.ts` | 285 | 导入解析：日期分节、`- HH:MM 正文 #tag`、`fragmentKey` 判重指纹、`looksBinary` |
| `src/util/date.ts` | 189 | 日 / 周 / 月键、`periodAnchor`、格式化 |
| `src/util/digest.ts` | 139 | 待补小结清单（配额 daily 6 / weekly 2 / monthly 2） |
| `src/util/keyboard.ts` | 39 | `useKeyboardHeight()`（替代 `KeyboardAvoidingView`） |

### 组件与类型

| 文件 | 行 | 干什么 |
|---|---|---|
| `src/components/FragmentDetail.tsx` | 507 | 全屏详情：左右滑、整屏内联编辑、当天小结 |
| `src/components/SummarySheet.tsx` | 794 | 小结面板：单篇 / 勾选缺口排队、新旧左右对照、替换确认、保存 |
| `src/components/UpdateSheet.tsx` | 451 | 更新弹窗：发现新版 / 下载中 / 待安装 / 失败四态 |
| `src/update/check.ts` | 161 | 查 GitHub Release、6 小时节流、跳过版本、自动检查开关 |
| `src/update/download.ts` | 166 | 下载（带进度、可取消、校验字节数）+ 拉起系统安装器 |
| `src/update/notify.ts` | 142 | 下载进度通知（LOW 渠道、sticky）。**JS 在后台被挂起，通知数字会停在切走那刻** |
| `src/util/semver.ts` | 62 | 版本号拆段比较（**不能比字符串**：`'0.10.0' < '0.9.9'`） |
| `src/components/NoteViewer.tsx` | 220 | 小结全屏阅读器：左右滑动在筛选集内切换 |
| `src/components/ResultSections.tsx` | 321 | 确认页六组结果渲染与勾选 |
| `src/components/TagPanel.tsx` | 313 | 标签管理：改名 / 合并 / 删除 |
| `src/components/ImportSheet.tsx` | 202 | 导入预览：共读到多少 / 新增多少 / 跳过多少，确认才写库 |
| `src/components/NoteBody.tsx` | 294 | 正文渲染：标题 / 列表 / 表格 / 代码块 / 分隔线 / 引用小标。**表格用 View 排，不能靠空格对齐** |
| `src/util/mdBlocks.ts` | 433 | Markdown 分块解析 + 引用标记识别（纯函数，可断言）。渲染本地看不见，能验的都在这里 |
| `src/components/IconButton.tsx` · `ScreenHeader.tsx` | 101 / 84 | 全项目唯一的图标按钮与页头；`ScreenHeader` 的左侧按钮可换成「历史」 |
| `src/components/SwipeRow.tsx` | 247 | 时间轴行的手势：右滑露出删除、左滑直接执行。**不能加 `overflow:'hidden'`**，会切断时间轴竖线 |
| `src/components/CitationSheet.tsx` | 193 | 点引用小标后从底部展开的来源面板；正文走快照，不回库查 |
| `src/components/Toast.tsx` | 55 | 复制 / 归档 / 删除成功的轻提示；不自己计时 |
| `src/components/Reasoning*.tsx` | 75 / 86 / 69 | 思维链实时流 / 折叠 / 轨迹 |
| `src/components/BacklogCard.tsx` | 87 | 整理页的「待补小结」条目 |
| `src/components/TagPill.tsx` | 64 | 标签胶囊（哈希取色） |
| `src/types.ts` | 323 | 全部领域类型（`Fragment` / `QaTurn` / `QaCitation` / `AskSession` …） |
| `src/export/markdown.ts` | 56 | 导出的 IO 部分：写文件 + 系统分享（拼接在 `util/mdBuild.ts`） |
| `src/version.ts` | 8 | 版本号常量（与 app.json 手工同步） |

---

## 5. 数据模型（SQLite v8）

```sql
fragments         id, content, created_at, source, status, tags(JSON), project, merged_into, nature
todos             id, text, due_at, done, done_at, source_fragment_id, created_at, merged_into
notes             id, type(daily|weekly|monthly|theme), title, body_md, period, created_at
settings          key, value
organize_runs     id, started_at, fragment_ids, model, result_json, applied   -- 历史表，v0.7 起不再写入
organize_sessions id, scope, pending_ids, cursor, plan_json, context_summary, finished, created_at, updated_at
ask_sessions      id, title, turns_json, archived, fragment_id, created_at, updated_at
fragment_fts      FTS5(text)  —— rowid 就是 fragments.id
```

索引：`fragments(created_at DESC)`、`todos(done)`、`todos(merged_into)`、
`idx_todos_done_at(done_at DESC)`、`idx_sessions_open(finished, updated_at DESC)`、
`idx_ask_sessions_updated(archived, updated_at DESC)`。

**v6 迁移做了三件事**：`DROP TABLE knowledge_cards`、`DROP TABLE ask_logs`、
建 `fragment_fts` 与 `organize_sessions`。

**v7 只干一件事**：`todos` 加 `done_at`，并用 `created_at` 回填已有的已完成项。
「已完成只保留最近 5 条」靠它排序 —— 没有完成时间，就只能按创建时间清，会把
刚勾掉的旧待办先删掉。注意这一步**会物理删除**超出的条目（v0.7.3 升级时一次性收敛）。

**v8 只干一件事**：建 `ask_sessions`。`turns_json` 存 `QaTurn[]`，每轮带
`citations` 快照（kind / id / label / body / url），所以历史会话重开时点引用
不依赖碎片、待办、小结还在不在。它**不写 `fragments`**：只有用户点「整理为碎片」
才落一条纪要。

前七段迁移原样保留（回滚就得重放），`PRAGMA user_version` 就是「跑过几条」。

几个容易误解的点：

- **`nature` 字段还在，但没人读**。v0.7 起不再写 `knowledge`，`db/commit.ts` 也不再写 `todo`。
  留着只为兼容旧数据，不要基于它做判断。
- **`notes.type = 'theme'` 同样只是历史遗留**，新数据只有 daily / weekly / monthly。
- **标签没有表**。`fragments.tags` 是 JSON 数组，`listTags()` 是遍历所有碎片统计出来的。
  改名 / 合并 / 删除走 `rewriteTags`，全库重写 JSON 并重建索引。
- **`notes` 的 `(type, period)` 唯一性由应用层保证**（`upsertNote` 先查后写）。
  period 可空，SQLite 的 UNIQUE 对 NULL 不去重。
- **`done_at` 为空但有 `done = 1` 的是旧数据**（v7 迁移前完成的）。清理逻辑用
  `COALESCE(done_at, created_at)` 兜底，别直接拿 `done_at` 排序，否则这些会全排到最后。
- **`organize_runs` 目前是死数据**。v0.7 的循环用 `organize_sessions`；
  `Repo.saveRun` / `markRunApplied` 还在接口里，但**已经没有任何调用点**，别以为它在记录历史。

---

## 6. AI 契约

**服务商** DeepSeek，OpenAI 兼容 `POST {baseUrl}/chat/completions`，默认模型 `deepseek-flash`。
`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用，别写。

| 功能 | 文件 | 输出 | `json` | 备注 |
|---|---|---|---|---|
| 整理（单批） | `ai/deepseek.ts` | 六类 + `batch_summary` | `true` | 流式 SSE |
| 小结 | `ai/summarize.ts` | Markdown | **`false`** | 撞额度直接抛错，不保存 |
| 问 | `ai/qa.ts` | Markdown + `[F]/[N]/[T]/[W]` 引用 | **`false`** | 撞额度标 `truncated` |

### 整理的六类

```json
{
  "tags":        [{"id": 1, "labels": ["工作","报销"], "project": "报销单"}],
  "todos":       [{"text": "提交报销单", "due": "2026-10-21", "id": 1}],
  "merge":       [{"keep_id": 3, "drop_ids": [5], "reason": "同一件事"}],
  "todo_done":   [{"todo_id": 2, "reason": "碎片里说了已经交了"}],
  "drop_todos":  [{"todo_id": 6, "reason": "从纯感想里误抽的"}],
  "merge_todos": [{"keep_id": 6, "drop_ids": [9,14], "text": null, "reason": "同一件事"}],
  "batch_summary": "这批主要是 NAS 换盘和报销，抽了 3 条待办，并了 2 条重复待办。"
}
```

七个字段**必须都出现**，没内容的用空数组。`batch_summary` ≤60 字，是跨批唯一的交接信息。

### 上下文清单与上限

| 清单 | 上限 | 为什么要给 |
|---|---|---|
| 已有标签（名字 + 次数） | 80 | 复用完全依赖「看得见已有写法」；只给前 20 个，长尾就会被造同义词 |
| 未完成待办 | 60 | `todo_done` / `merge_todos` / `drop_todos` 的 id 来源 |
| 已完成待办 | 30 | 不给，模型会把做完的事再抽一遍 |
| 本轮已抽出的待办 | 40 | 前面几批的还没写库，模型在「未完成」里看不到 |
| 前几批摘要 | 1500 字 | `appendSummary` 保留尾部，超了从头部截 |

---

## 7. 五条主流程

### 7.1 整理：起会话 → 循环 → 统一确认 → 应用

```
startSession(scope)               取 id 快照，写 organize_sessions
   ↓
runOrganize(session)              while (池子非空) { 装 40 条 → 请求 → 合并进 plan → persist }
   ↓  每批：mergeBatchResult(plan, batch, {batchIds, existingTags, todos})
   ↓  截断：AiError('truncated') 且本批 >1 条 → 对半拆开递归
   ↓  某批彻底失败：抛 BatchFailure（带已跑完的 session）
   ↓
finalizePlan(plan, existingTags)  → OrganizeReview（确认页）
   ↓
commitPlan({plan, existingTags, accepted, processedIds})  只有这一步写库
```

- **剩余量 = `pendingIds − processedIds − skippedIds`**，不是 offset。
- **`cursor` 只用于显示**，不参与切分。
- **用户点「停止」**：当前批跑完就收，已跑完的批次照常进确认页。
- **失败三选一**：重试这一批 / 跳过这一批（不标状态）/ 放弃本次（删会话）。
- **`commitPlan` 顺序**：标签 → 新待办 → 待办变更 → 待办合并 → 碎片合并 → `markStatus('tagged')`。
  标状态放最后，失败时碎片仍在原状态可重跑。

### 7.2 应用时的四条纪律（`db/commit.ts`）

1. 只写 `accepted(key)` 为真的条目。
2. 标签按**一整组同名标签**勾选；一条碎片的标签全被取消时**跳过，不写空数组**。
3. 新待办插入前先读库做 `normText` 查重（幂等：中途失败重试不会插两遍）。
4. 返回值是**真实写入条数**；被合并掉的碎片不算进「已整理」。

### 7.3 问：四路检索 → 装填 → 并行联网 → 回答

```
retrieveLocal(question, turns, contextIds)
  ├─ contextIds（左滑带入的那条，绕过 merged 过滤）  ⭐ v0.8.8
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

### 7.4 纪要：一条普通碎片（历史里主动整理）

v0.8.8 起不再在退出时弹确认。用户在历史会话的「…」里点**整理为碎片**：

`buildQaNote(turns, startedAt)` → `repo.insertFragment(content)` → `repo.markAskSessionConverted`：

```
【问答纪要】2026-10-25 21:40 · 3 轮
问1：换盘之后还要做什么
答1：先确认重建跑起来了…
```

最多 6 轮、每答前 3 句 / 300 字、剥掉 Markdown。**不另开表** —— 它要能被整理、被搜索、被再次提问。

### 7.5 小结与导出

- 小结：`SummarySheet` 取周期内全部碎片 → `summarize()` → 预览 → `upsertNote`。
  三节固定「重点 / 进展 / 待处理」，字数纯上限 150 / 300 / 500，素材预算 26k / 40k / 60k 字。
  有旧稿时左右对照；缺口可勾选排队生成、逐篇确认。**完整规格见 SPEC §6.3，这里不重复。**
- 导出：`# 碎片导出 · 日期` → `## 时间轴`（按天 `###`）→ `## 待办`（未完成 / 已完成）→ `## 标签索引`。

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
- **引用小标不能画成 `[F12]` 原文。** 用户不知道 F 是什么；渲染层只给序号，
  详情放到 `CitationSheet`。

### 8.10 时间轴手势（v0.8.8）

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

67 条清单在 [ROADMAP.md P0-1](./ROADMAP.md)，按风险排序。最要紧的七条：

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

1. **装 `fragments-v0.8.8.apk`，按 ROADMAP 那 67 条验。** 有问题先修，不要叠新功能。
   如果手机已经是 v0.8.5 以上，直接打开 App 就能收到更新提示，不用手动装。
2. 通知栏常驻的「快速记录」入口（ROADMAP P0-2）。通知库 v0.8.6 已经因为下载进度通知装好了，
   剩下是 JS 改动，见 ROADMAP 里重估过的成本。
3. 大库性能：几千条时时间轴全量读进内存会开始慢，等量真上来再动。
4. OTA（EAS Update）要不要上，等用户定 —— GitHub Release 已经在用，装包这件事不疼了。

> 「从 Markdown 导入」已在 v0.7.2 补上，回归测试是 `npm run test:md`，**改导出格式前后都要跑**。
> 发版流程见 8.8：改三处版本号 → 写 CHANGELOG → 打 tag。**没打 tag 就不会有 Release**。
