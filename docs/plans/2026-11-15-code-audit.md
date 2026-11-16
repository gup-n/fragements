# 2026-11-15 全量代码审阅：优化清单与未完成功能

> 用户要求：「审阅全部代码，列出优化清单、未完成的功能清单，并开始逐步优化」。
> 这份文件是清单本身；落地情况写在每条的「状态」里。**动过的和没动的都要看得见**，
> 否则下一个人会以为清单上的每一条都做完了。

范围：`src/` 与 `App.tsx` 共 **128 个文件、33.6k 行**（不含 `android/` 生成目录与 `scripts/`）。

## 0. 怎么找的（可复现）

不是「读一遍凭印象列几条」，每条都有一条能重跑的判据：

| 手段 | 找到了什么 |
|---|---|
| `tsc --noEmit --noUnusedLocals` | 12 处未使用的引入/类型（其余 28 处是 `import React`，JSX 新转换下本就多余，留着） |
| 同名函数扫描（`export function X` 全库比对） | 11 组同名实现，其中 4 组是真的重复，4 组是同名不同义 |
| `grep` 空 catch / 静默失败 | 12 处，**全部带注释说明**，没有一处是忘记处理 |
| `grep` 渲染期重计算 | `useMemo` 覆盖完整；`parseBlocks` 按 text 记忆化，没有发现漏网 |
| `grep` 就地字号 / 颜色 | 字号 3 处、十六进制色 1 处（都在装饰位） |
| 文档与代码对账 | 5 处文档说「没做」而代码早已做完，或反过来 |

结论先说：**这个库的「功能完整度」比文档写的更高，「代码缺陷」比预期更少。**
主要债务在文档与代码的不同步，以及几处「同一件事写了两遍」的重复实现。

## 1. 优化清单

### P1 — 已经做完（v0.22.1）

| # | 问题 | 证据 | 做法 |
|---|---|---|---|
| 1 | 拼接口地址写了三份 | `chat.ts` / `fetchPage.ts` / `search.ts` 各有一个 `endpoint()`，只差路径 | 合成 `chat.apiUrl(base, path)`，三处调用；规则只留一处 |
| 2 | 透明度换算两份，其中一份是弱的 | `GlassBackdrop` 里的 `withAlpha` 只认六位十六进制，遇到 `#fff` 原样返回**不透明**，玻璃纱会变成一块实心板 | 保留强的那份，移到 `src/util/color.ts`，玻璃改用共享实现 |
| 3 | 显示宽度两份，口径不同 | `mdBlocks` 与 `SheetReader` 各一份 `visualLen`：emoji 在前者算 2、后者算 1，同一份内容两处列宽不一致 | 合成 `util/text.visualLen`（取并集区间） |
| 4 | web 输入框复位写了六份 | 五处 `{ outlineStyle: 'none' as any }` + `SearchBar` 一处 `as unknown as undefined` | `util/platformStyle.WEB_INPUT_RESET`，一个 `any` 换掉六处 |
| 5 | 问答材料的截断另写一份 | `qa.ts` 的本地 `clip` 与 `util/text.shortPreview` 语义几乎相同 | 改用 `shortPreview` |
| 6 | 未使用的引入与类型 | `--noUnusedLocals` 报 12 处 | 全部删除 |
| 7 | 日历里一句「去时间轴看」但去不了 | `ReviewScreen` 的当天明细 | 改成「展开其余 N 条」就地展开（最多 30 条） |
| 8 | 小结入口写死「一个月一篇」，不说有没有待补 | `util/digest.missingDigests` 早就算得出来，只是没接到界面上 | 入口副标题改 `{N} 个月还没写` |

新增守卫：`test:ui` 加了 2 条断言 —— 上面 4 条「只许有一份实现」用全库 grep 钉住，
日历展开与待补月份用源码结构钉住。`test:ui` 21 → **28 项**。

### P2 — 值得做，但要先定方向

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| 9 | `util/organizePlan.ts` 里约 250 行是标签时代的死函数 | `effectiveTodos` / `effectiveTags` / `mergeBatchResult` / `buildTagGroups` / `finalizePlan` / `appendSummary` / `plannedTodoTexts` 在 v0.18.1 拆掉标签后**无人调用**；仓库只在 `normalizePlan` / `emptyPlan` 两个入口用到它 | 只保留 `OrganizePlan` 类型 + `normalizePlan` + `emptyPlan`（旧会话的 plan 字段还要能读），其余删掉。**动之前先跑 `test:reliability`**，整理会话恢复的路径在那里 |
| 10 | `AskScreen.tsx` 2205 行是单体 | 一个文件里塞了：聊天流、历史抽屉、引用面板、草稿改稿、整理控制器接线、意图分流 | **v0.24.1 已搬走无状态部分**（`util/askText` + `components/TurnAnswer`，2205 → 1994）。剩下的聊天流/历史抽屉仍耦合页面状态，必须留在能真机点的轮次里拆 |
| 11 | 48dp 触控下限的实现有两套写法 | `IconButton`（含 `compact`）、`ChoiceChip`、各处 `minHeight: metrics.controlHeight` | 目前**不建议统一**：按钮、胶囊、列表行本来就是三种东西，硬套一个组件会把差异藏进 props |
| 12 | `R = { pill: 999 }` 只剩一个常量 | `theme.tsx:23`，全库 11 处 `R.pill` | 留着。它比散落 11 个 `999` 好 |

### P3 — 观察，不到动手的时候

| # | 问题 | 判断 |
|---|---|---|
| 13 | 时间轴进页面全量读 | 几百条无感，几千条才慢。`repo.listFragments` 已留 `limit`，界面还没分页。等数据量真上来（ROADMAP P1-4） |
| 14 | 深色主题只用 `opacity` 降噪的地方 | v0.24 已清完（只有两处用 opacity 压**文字**：日历邻月日期、问页「不联网」胶囊）。剩下的 `btnDisabled` / `off` 是禁用态，不在对比度要求里。真机观感仍待验 |
| 15 | 三个装饰字号没进 `TYPE` | 角标 10、品牌字 20（两处）。它们不进档位体系反而是对的，记在 ROADMAP 5.1 |

## 2. 未完成的功能清单（按代码对账，不按文档）

### 真的没做完

| 功能 | 现状 | 缺口 | 代价 |
|---|---|---|---|
| **大库分页** | 全量读进内存 | `SectionList` 拿到的是全部碎片；几千条时首屏要等查询 | 中：分页 + 按日窗口，界面要引入「加载更多」 |
| **小结提醒** | 待补月份只在月总结面板里列 | 没有「这个月快过完了」的主动提示 | 小-中：通知（`expo-notifications` 已在包里）或首页角标 |
| **OTA（EAS Update）** | 改 JS 后仍需装 APK | 未接 `expo-updates` | 大：装依赖 + prebuild + 重编；决策未定 |
| **微信/其他应用的文档分享接收** | 文字与图片能接住（`shareInbox`），文件走 `kind: 'other'` 时只提示「去文档页导入」 | 没有 `ACTION_SEND` 文件分支 + `saveOriginal(uri)` 接线 | 中：要原生 intent-filter 或 `expo-share-intent`，且必须真机验证微信是否露出这条路 |
| **文档：Word/PPT 本机阅读、扫描件 OCR、多轮追问回带上轮片段** | 三条都**明确决定不做**（ROADMAP P1-7 写了理由） | — | — |

### 文档说没做、代码其实做完了（v0.22.1 已改）

- **通知栏常驻「记一条」**：`src/quickRecord.ts` + 设置页开关 + 冷启动捞点击，v0.20.5 就已落地。
  ROADMAP 还整整一节写着「首版需求里就写了，一直没做」，SPEC §4.2 与「未完成」清单也各有一条。
  → 三处都已改，SPEC 勾掉，ROADMAP 删节并留一句说明。
- **文档接入检索与「问」**：v0.12.0 完成，SPEC §4.2 仍挂着。
  → 已改成「已完成」，并列出真正剩下的三件。

### 待决（不是没做完，是没定）

应用最终名称（占位「碎片」，包名也带 `fragments`）· 要不要上 OTA · vivo Y78 的实际 Android 版本。

## 3. 这一轮实际动了什么

- 9 个源文件 + 4 个断言脚本 + 6 份文档。
- 全量检查：`typecheck`、`test:md(24)`、`test:docs(16/8/47)`、`test:todos(22)`、`test:ask(83)`、
  `test:reliability(88)`、`test:appearance(45)`、`test:backup(19)`、`test:ui(28)`、`check:docs`、`build:web` 全通过。
- **没有真机**：这一轮改的是「同一件事的实现份数」和两处文案/交互，没有动布局；
  但日历的「展开其余」在长列表下的滚动位置、待补月份在跨年时的文案，只有装包才看得准。

## 4. 下一批建议（顺序即优先级）

**v0.24.0 已做**：另起的一轮把上面判为 P3 的两件做了（空屏统一成 `EmptyState`、两处 opacity 改色阶），
外加一个不在清单上的真缺陷（文档页提示条多加了底栏高度，见 CHANGELOG v0.24.0）。

1. `organizePlan.ts` 的 250 行死代码（P2-9）—— 有 `test:reliability` 兜着，风险可控，收益是「读代码的人不会再被标签时代的函数误导」。
2. 小结提醒（未完成-2）—— 判据已经在 `digest.ts` 里，只差一个入口和一个「什么时候提醒」的决定。
3. `AskScreen` 拆分（P2-10）—— 留到有设备的轮次，拆完必须逐屏点一遍。
   可以做的前置动作是**只搬纯函数**（`citeKey` / `plainPreview` / `coverageLine` / `orderedCitations`
   和 `TurnAnswer`），它们没有状态、没有 ref，搬完只有 tsc 会响。
4. 大库分页（未完成-1）—— 等碎片真的上千条再动。
