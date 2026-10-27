# 碎片 · 需求与设计说明书 (SPEC)

> 本文档是跨会话开发的**唯一设计依据**：数据模型、AI 契约、界面规范、构建环境。
> 改功能先改这里，再改代码。**版本历史不写在这里** —— 那是 [CHANGELOG.md](./CHANGELOG.md) 的事。

最后更新：2026-10-25（v0.7.2：去掉知识库与卡片，整理改为多轮循环，问答改本地全文检索，补上 Markdown 导入）

> 后续开发计划、优先级与待决问题见 [ROADMAP.md](./ROADMAP.md)；面向使用者的项目说明见 [README.md](./README.md)。

---

## 0. v0.7 重构定稿（2026-10-25）

> 这一节是 v0.7 的**唯一依据**。第 4～7、9～11 节已按 v0.7 同步改写；
> 若仍有前后不一致，以本节为准。

### 0.1 为什么推倒

卡片/主题这套结构有三个结构性问题，不是 prompt 能修的：

1. **主题只是 `knowledge_cards.topic` 上的字符串**，新建成本为零。模型天然会给每张卡
   开一个新主题，`merge_topics` 只能事后补救。
2. **卡片没有唯一约束**。判重只能靠标题字面 + 来源 Jaccard 猜，重构几轮就长出孪生卡。
3. **问答永远全库检索**。`rankCards` 给每张卡打分、按预算装填，问题一具体，
   上下文里就混进大量不相关的卡，模型反而更容易答偏。

结论：**不再维护"卡片"这一层**。整理只做标签、待办、碎片去重；问答直接在碎片原文 +
小结 + 待办上做两段式检索。

### 0.2 功能取舍

| 处理 | 内容 |
|---|---|
| 删除 | 知识库页、知识卡、主题、二级方向、主题合并、问答提案、问答记录区 |
| 删除 | 整理里的 `knowledge` / `card_update` / `archive_cards` / `merge_topics` 四类输出 |
| 删除 | `knowledge_cards` / `ask_logs` 两张表（迁移 v6 直接 DROP，用户已确认） |
| 保留 | 时间轴、记录/编辑/详情、搜索、标签/事项筛选、待办（完成/截止/合并/删除/撤回）、周期小结、Markdown 导出、AI 配置、思维链展示 |
| 新增 | 「问」全屏问答：深度思考 + 联网搜索两个开关，退出可保存会话纪要 |
| 新增 | 「标签」管理：改名 / 合并 / 删除（只改标签，不动碎片） |
| 新增 | 整理自动循环：一次跑完所有批次，最后统一确认；支持断点续跑 |
| 新增 | `fragment_fts` 全文索引（中文 bigram + 英文词）与 `organize_sessions` |

### 0.3 整理循环

**目标**：单轮只处理一小批，程序控制节奏，模型不碰数据库；跑完所有批次后统一确认。

流程：

1. 开始前把范围内的碎片 id 取成**快照**（`organize_sessions.pending_ids`）。
   不每轮重新查 —— 用户边跑边记会让 offset 漂移，快照也是断点续跑的依据。
2. 按 **40 条 / 16,000 字**装箱；一条超长碎片独占一批（至少收一条）。
3. 每轮输入：
   - 本批碎片（id / 时间 / 原文；`all` 模式额外带旧标签与旧事项）
   - 全量标签表（名字 + 使用次数）
   - 未完成待办 + 已完成待办
   - 上一轮 `batch_summary`（累积上下文，代码裁剪到 1,500 字）
4. 每轮输出**只有六类 + 一句摘要**：

```json
{
  "tags":         [{"id": 1, "labels": ["工作"], "project": "报销"}],
  "todos":        [{"text": "提交报销单", "due": "2026-10-21", "id": 1}],
  "merge":        [{"keep_id": 3, "drop_ids": [5], "reason": "同一件事"}],
  "todo_done":    [{"todo_id": 2, "reason": "碎片里说了已经交了"}],
  "drop_todos":   [{"todo_id": 6, "reason": "和另一条重复且没信息量"}],
  "merge_todos":  [{"keep_id": 6, "drop_ids": [9], "text": null, "reason": "同一件事"}],
  "batch_summary": "这一批主要是 NAS 换盘和报销，新增标签 2 个。"
}
```

5. 程序逐条校验：id 必须在本批/本轮清单里；日期必须合法；同一条待办不能既标完成又删除；
   同一条待办不能出现在两条合并建议里。校验失败**不静默丢**，计入 `rejected`。
6. 标签收敛：先按「小写 + 去 # + 去空格 + 全半角归一」精确匹配已有标签；
   能复用就复用，匹配不上才算新标签。新标签在确认页单独标「新」。
7. 计划累积：程序把每批结果合并进 `OrganizePlan`，并按 `normText` 去重待办；
   下一轮把「已有待办 + 计划中的新待办 - 已标完成/已删除/已合并」作为待办清单给模型。
8. 失败处理：某批 `truncated` 时把这一批对半拆再试；其他错误重试一次；
   仍失败则停下，给「重试这一批 / 跳过这一批 / 放弃本次」。跳过不标记碎片状态。
9. 跑完出确认页，按类别汇总：
   - **标签**：按标签名分组（`工作 32 条` / `NAS 12 条`），新标签标「新」；可整组勾选
   - **新待办**：逐条勾选
   - **待办变更**：标完成默认勾；删除、合并默认不勾
   - **碎片合并**：默认不勾
   - 顶部「全选安全项 / 全不选」；底部「应用 N 项」
10. 点「应用」才写库。顺序：标签 → 新待办 → 待办变更 → 碎片合并 → 整批标 `tagged`
    （最后一步失败时，碎片仍留在原状态，可重跑）。返回**真实写入条数**。

**断点续跑**：每批结束把 `cursor` / `plan_json` / `context_summary` 写回
`organize_sessions`。重进整理页若存在未完成会话，顶部显示「上次整理到 96/240，继续 / 放弃」。

**为什么不做真 tool calls**：DeepSeek 支持 Tool Calls，但这里模型不需要决定"取哪批碎片"——
范围、装箱、游标都是确定的。真 tool calls 只会多出流式 `tool_calls` 解析、模型忘调/死循环/
参数错三层故障，收益为零。循环的"agent 感"由程序编排 + 每轮摘要接力实现。

**范围**：
- `inbox`：只处理 `status = 'inbox'` 的碎片（默认）
- `all`：`merged_into IS NULL` 的全部碎片，重新判标签、重新看待办；
  不重复建卡（已经没有卡），也不重复抽已经存在的待办。

### 0.4 问答（「问」）

**定位**：像 DeepSeek 手机 App 的 chat 页，但事实来源优先是**你自己的记录**。

检索（全在本地，无向量模型）：

1. `fragment_fts` 是 FTS5 虚拟表，`rowid = fragments.id`，索引文本由代码生成：
   中文按**二元组**（`换盘前` → `换盘 盘前`）＋ 英文/数字按词 ＋ 标签 ＋ 事项。
   用 bigram 而不是 trigram：中文两字词（换盘、报销、装机）太常见，trigram 搜不到。
2. `buildFtsQuery` 把问题切成同样粒度的 token，用 OR 拼成 MATCH；
   BM25 排序取前 40 条。FTS 报错或 0 命中时退回 `LIKE`。
3. 二次筛选：
   - 时间意图（今天/昨天/最近/本周/上周/这个月/上个月）→ 并上 `listFragmentsBetween`
   - 标签意图（问题里出现已有标签名）→ 并上该标签下的碎片
   - 上一轮引用过的碎片 id → 并入本轮，保证「那第二条呢」接得上
4. 装填预算：碎片 15～20 条（每条最多 1,200 字，总预算 36,000 字）、
   相关小结最多 6 篇、全部未完成待办、最近完成待办 20 条、标签表。
5. 联网开关打开 → 与本地检索**并行**搜一次（8 条）。搜索失败只提示「联网没搜成」，
   本地回答照常给。网络资料标 `[W1]`，绝不能混成本地记录。
6. 深度思考开关控制这一场的 `thinking`；开 = `high`，关 = 不发思考参数。
7. 回答规则：优先碎片原文，其次小结；都没有就直说「你的记录里没有」；
   引用写 `[F12]` / `[N3]` / `[T5]` / `[W1]`，编号必须来自本轮资料。
8. 截断要标：`finish_reason === 'length'` 时在回答下方给橙色说明。

**会话纪要**：退出（返回键或关闭）时若已有问答，弹「保留这次问答？」。
选「保存为碎片」→ 把 Q/A 压成精简版（每答 1–3 句 + 结论，最多 300 字/条，
最多保留最近 6 轮），以 `【问答纪要】日期` 开头写入 `fragments`，`status = inbox`，
时间戳用会话开始时间。下次整理会把它当一条普通碎片处理。

**入口**：时间轴页头原来的「知识库」图标改为「问」（chatbubble）。

### 0.5 标签与小结

**标签**：

- 整理时模型只能「复用已有标签」或「新建」；新建标签在确认页单独列出来。
- 代码做精确归一（`trim` / 去 `#` / 合并空白 / 全半角 / 英文小写）后匹配已有标签。
- 标签页：列出全部标签与次数，支持改名、合并、删除。实现上只改
  `fragments.tags` 这个 JSON 数组，不新增 `tags` 表，也不动碎片正文。
- 「事项 / project」字段保留，和时间轴筛选一起用。

**小结**：日 / 周 / 月三档，保留「生成 → 预览 → 保存/替换」流程与待补清单。

格式固定为「一句话 + 3 个固定小节」，每条 `- **关键词**：一句话`：

| 粒度 | 小节 | 字数 |
|---|---|---|
| 日 | 一句话 / 做了什么 / 想明白的 / 悬着的 | 150–250 |
| 周 | 一句话 / 主线 / 推进 / 结论 / 悬着 | 300–500 |
| 月 | 一句话 / 主线 / 结果 / 结论 / 停下来的 | 500–700 |

约束：不写开场白、不写"根据材料"、不推测动机、不补充背景、不嵌套列表/表格/代码块。
素材只给碎片 + 待办完成情况，不再给知识卡。月度素材预算放宽到 60,000 字（不再省 token）。

### 0.6 数据迁移 v6

```sql
DROP TABLE IF EXISTS knowledge_cards;
DROP TABLE IF EXISTS ask_logs;

CREATE VIRTUAL TABLE IF NOT EXISTS fragment_fts USING fts5(text, tokenize = 'unicode61');

CREATE TABLE IF NOT EXISTS organize_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scope           TEXT    NOT NULL,              -- inbox | all
  pending_ids     TEXT    NOT NULL DEFAULT '[]', -- 快照
  cursor          INTEGER NOT NULL DEFAULT 0,
  plan_json       TEXT    NOT NULL DEFAULT '{}',
  context_summary TEXT    NOT NULL DEFAULT '',
  finished        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

- 迁移只追加，`PRAGMA user_version = 6`。
- `init()` 里检查 `fragment_fts` 行数与 `fragments` 行数，不一致就按 200 条一页回填；
  设置页提供「重建搜索索引」兜底。
- 索引维护放在 repo 写方法里（insert / update / applyTags / delete），不靠 SQL 触发器 ——
  bigram 分词在 JS 里做，SQLite 触发器算不出来。

### 0.7 明确不做

- 不做向量检索 / embedding：手机端内存、电量、包体都不划算；个人笔记量级 FTS5 足够。
- 不做完整 wiki（`topics` + `claims` + 页面）：会重新引入"页面身份/主题去重"这个坑。
- 不做真 tool calls agent：理由见 0.3。
- 不做云端同步 / 账号：定位不变。
- 不做卡片正文编辑器：卡片已经不存在。

### 0.8 验收要点（真机）

1. 整理 100+ 条：点一次「开始」能自动跑到结束，进度条按批推进；中途返回/被杀，再进来有「继续上次」。
2. 跑完确认页：标签按名字分组，新标签有「新」标记；「全选安全项」不会勾上碎片合并/删待办/合并待办。
3. 应用后：时间轴标签真的变了；待办真的进了回顾页；合并的碎片在时间轴置灰且能查看。
4. 同一批跑两遍「全部重过」：不应新增重复待办；标签不应裂成同义的一堆。
5. 问「我上次换 NAS 盘是怎么做的」：能引用到具体碎片（`[F..]`），点来源能打开原文。
6. 问一个本地没有的问题：不开联网时明确说没有；开联网时给出 `[W1]` 来源。
7. 退出问答复选「保存为碎片」：时间轴出现一条「问答纪要」，下次整理能处理它。
8. 日/周/月小结：第一行是「一句话」；正文读起来像事后补记的记录，不像报告——没有「值得注意的是」「总的来说」，
   没有「取得显著进展」这类没有事实支撑的评价，也不是每条一样长的整齐排比。
   回顾页里周总结排在日小结上面；时间轴上它压在本周所有日分区之上。

---

## 1. 产品定位

一个**个人、单机、只给自己用**的碎片记录工具。

核心价值不是"做笔记"，而是：**随手扔一句 → AI 定期帮你收拢**。

两条设计红线：

1. **记录摩擦必须极低**。打开即输入，输完即消失。任何"先选分类再写"的设计都违背定位。
2. **AI 只做收拢，不做限制**。AI 从不阻止你记录，只在你想整理时提供建议。

### 内容分流（v1.1 新增）

碎片的内容寿命差别极大：「带 U 盘给小李」三天后是噪音，「RAID5 换盘先确认热备」三年后还救人。混在一条时间轴里，后者会被前者淹没。

因此整理时按性质分流，**但记录时完全不分类**——判断放在 AI 读过内容之后，不放在用户身上：

| 去向 | 内容特征 | 寿命 | 检索方式 |
|---|---|---|---|
| 待办 | 有明确动作 | 小时～天 | 按状态 |
| 标签 / 事项 | 可复用的线索（「NAS」「报销」） | 年 | 按标签、按项目 |
| 时间轴 | 事件、琐事、结论的原文 | 长期 | 全文检索 + 时间 |

**v0.7 起没有第三个实体。** v1.1 曾想把「可复用的结论」沉淀成独立的知识卡，
实践证明那一层只是原文的另一个视图，还带来主题裂开、孪生卡、全库检索三个问题
（见 §0.1）。现在结论留在原文里，用标签和项目做索引，用「问」做检索。

## 2. 目标设备与平台

| 项 | 值 |
|---|---|
| 设备 | vivo Y78（V2278A） |
| 内核 | 5.10.198-android12-9-g49a61efabeee-dirty |
| Android 版本 | 需在手机「设置 → 关于手机」确认；内核串含 `android12` 仅表示内核分支名，不代表系统版本。V2278A 实际出货多为 Android 13 |
| 适配策略 | 代码统一按 `Platform.Version >= 33` 运行时判断，不写死版本 |

**通知权限**：Android 13 (API 33) 起 `POST_NOTIFICATIONS` 需运行时申请。实现中判断 `Platform.Version >= 33` 后才请求，低版本直接静默通过。

## 3. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | React Native + Expo SDK 58 | 复用已有 TypeScript/React 经验；prebuild 后直接出 APK 装机，不依赖 Expo Go |
| 语言 | TypeScript | — |
| 存储 | expo-sqlite（本地 SQLite，迁移到 v6）+ FTS5 全文索引 | 结构化查询、索引、事务；中文用 bigram 分词才能搜两个字 |
| 密钥 | expo-secure-store（Android Keystore 加密） | API Key 不落明文 |
| 文件导出 | expo-file-system + expo-sharing | 生成 md 后走系统分享，可直接存 NAS |
| 导航 | 自实现轻量页面栈（5 个页面：时间轴 / 整理 / 回顾 / 问 / 设置） | 不引入 react-navigation，减少依赖与配置成本 |
| Web | react-native-web + localStorage 驱动 | **只用来跑编译校验**（`npm run build:web` 打一遍包即删），不做交付、不做界面预览 |

**包名**：`com.local.fragments`（固定）
> 改包名 = 系统视为另一个 App，旧数据不会跟随。若将来要改，先「导出 Markdown」再迁移。

## 4. 功能范围

### 4.1 已实现

**记录**

- 应用内极简输入（打开即写），输入框自动增高，可一键转全屏编辑
- 时间轴按日分组、按日折叠（默认只展开今天），长文超 3 行折叠；周总结独占周级分区，固定在该周最上方
- 首页搜索（原文 / 标签 / 事项，内存过滤）+ 标签胶囊筛选，两者叠乘
- 碎片详情页：左右滑动切换、整屏内联编辑、正文下方接当天小结
- 碎片编辑 / 删除

**整理（v0.7 重做）**

- 一次点击，**程序控节奏分批跑到完**：每批 40 条 / 16,000 字，批间用 `batch_summary` 接力（§0.3）
- 实时显示批次进度与思维链，可随时「停止」（当前批跑完即收）
- 每批跑完落库，杀进程 / 断网 / 退出后可「继续上次」
- 某批失败时三选一：重试这一批 / 跳过这一批（不标状态）/ 放弃本次
- 撞输出额度时**对半拆批重试**，拆到只剩一条才报错
- 跑完出**一张确认页**：六类结果（标签 / 待办 / 合并碎片 / 标完成 / 删待办 / 合并待办）
- 标签按**同名分组**审阅（「工作 32 条」），新标签单独标出，与已有标签很像的默认不勾
- 会删内容的操作默认不勾：合并碎片 / 删待办 / 合并待办；`todo_done` 默认勾
- 点「应用」才写库，回报真实写入条数

**问（v0.7.1 新增）**

- 聊天式问答，答案只依据检索到的碎片 / 小结 / 待办，引用写 `[F12]` / `[N3]` / `[T5]` / `[W1]`
- 本地四路检索（全文 / 时间意图 / 标签意图 / 上一轮引用）+ 预算装填（§0.4）
- **深度思考**与**联网搜索**两个独立开关，对齐 DeepSeek 手机 App chat 页
- 联网与本地检索并行；搜索失败只提示，不影响本地回答
- 退出时询问是否保留纪要；存下来的是**一条普通碎片**（最近 6 轮、每答前 3 句）
- 回答撞额度时标 `truncated` 并提示

**小结**

- 日 / 周 / 月三种粒度，先预览再决定存不存
- 格式「一句话 + 短小节」；每条是完整书面句子（不用「关键词：短句」），正式、客观、无 AI 套话；字数 150–250 / 300–500 / 500–700
- 正文「压形状」靠 prompt 的四组约束：事实边界 / 文体 / 禁止清单 / 格式；主旨是「像本人事后补记的工作日志」，不是汇报也不是随笔
- **两处列表都按粒度分组，不按时间混排**：
  - 时间轴：周总结独占 `week:<period>` 分区，`order = 周末 + 1ms`，压在该周所有日分区之上（v0.7.3）
  - 回顾页「小结」：月 → 周 → 日 → 主题，组内才按生成时间倒序（`util/digest.ts` 的 `groupNotes`，v0.7.4）
- 待补小结清单（`util/digest.ts`）列在整理页，点一条直接进生成
- 同周期重复生成时给默认勾选的「替换原有小结」，走 `repo.upsertNote`

**标签与待办**

- 标签管理页（回顾页第三个 tab）：改名 / 合并 / 删除，一个输入框搞定改名与合并
- 整理时模型先看已有标签表再决定新建；代码层再按归一化键收敛一次
- 待办：点击完成、截止日（过期标红）、已完成置灰划线、被合并的可逐条恢复；**已完成只保留最近 5 条**，超出部分物理清理（v0.7.3 起，用户明确要求）

**外观（v0.8.0）**

- 浅色 / 深色 / 跟随系统，默认跟随系统，存在 `settings` 的 `ui_theme`，即时生效不用重启
- 启动屏跟着系统深色走，不会先闪一下白（见 §8 启动屏）
- 状态栏文字明暗跟随

**其它**

- Markdown 导出：时间轴 + 待办 + 标签索引
- Markdown 导入：选文件 → 预览（新增 / 跳过）→ 确认后才写库，见第 7 节
- 设置页：API 配置、连接测试、外观、索引健康度、数据统计、导出导入
- 本地全文索引（FTS5 + bigram），启动时自动校验条数并回填

**索引可验证（v0.8.0）**

「重建搜索索引」以前只会回一句「已重建 N 条」，而且那句话渲染在页面上方的 AI 卡片里，
人在底部点按钮根本看不见 —— 等于没有反馈。现在：

- `searchIndexStats()`：fts 条数 vs 碎片条数，不等就说明有碎片漏了
- `selfTestSearch(5)`：抽最近 5 条，用正文第 3–8 个字往回搜，看能不能搜回自己
- 设置页常驻显示「索引完整 · 132 条全部可搜」+「抽样自检：5 条全部搜回」
- 重建后的反馈写在索引框里（不是页面顶部），条数有变化时额外标出「原来 N 条」

### 4.2 属于范围但还没做

- **通知栏常驻入口**。技术约束见第 10 节末尾，排期见 [ROADMAP.md](./ROADMAP.md) P0-2。

### 4.3 明确不做

桌面小组件 · 语音转文字 · 定时自动整理 · NAS 自动备份 · 多端同步 · 密码锁 · 图片/链接附件 ·
**知识卡 / 主题 / 卡片详情页**（v0.7 已整层删除）· 向量检索 / embedding · 真 tool calls 的整理 agent

架构上为这些预留：`fragments.source` 字段可扩展、`repo` 接口隔离存储实现。

> 「不做知识卡」是 v0.7 的结论，不是暂缓。主题只是免费新建的字符串、卡片没有唯一约束、
> 卡片正文又只是原文的另一个视图 —— 这套结构靠 prompt 修不好，详见 CHANGELOG v0.7.0。

## 5. 数据模型

```sql
-- 碎片本体（v1.1 起加 nature，v0.7 起该字段不再写、也不再读）
CREATE TABLE fragments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  content     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,                 -- 毫秒时间戳
  source      TEXT    NOT NULL DEFAULT 'app',   -- app | notif | share
  status      TEXT    NOT NULL DEFAULT 'inbox', -- inbox | tagged | merged
  tags        TEXT    NOT NULL DEFAULT '[]',    -- JSON 字符串数组（保留显示大小写）
  project     TEXT,
  merged_into INTEGER,                          -- 被合并到哪条（不删除原文）
  nature      TEXT
);

-- 待办
CREATE TABLE todos (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  text               TEXT    NOT NULL,
  due_at             TEXT,        -- YYYY-MM-DD，可空
  done               INTEGER NOT NULL DEFAULT 0,
  done_at            INTEGER,     -- 标记完成的时间；v7 起用于「只保留最近 5 条」
  source_fragment_id INTEGER,
  created_at         INTEGER NOT NULL,
  merged_into        INTEGER      -- 被合并到哪条；非空表示隐藏（可撤回）
);

-- AI 汇总产出的成稿
CREATE TABLE notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL,     -- daily | weekly | monthly（theme 是历史遗留）
  title      TEXT,
  body_md    TEXT    NOT NULL,
  period     TEXT,                 -- 2026-10-20 / 2026-W43 / 2026-10 ；theme 为空
  created_at INTEGER NOT NULL
);

-- 键值配置
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- 历史表（v0.7 起不再写入；表保留，不为删而删）
CREATE TABLE organize_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,
  fragment_ids TEXT    NOT NULL,
  model        TEXT,
  result_json  TEXT,
  applied      INTEGER NOT NULL DEFAULT 0
);

-- 整理会话（v6）。一轮整理可能跑很多批、跨很多次进入，进度靠它续
CREATE TABLE organize_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scope           TEXT    NOT NULL,          -- inbox | all
  pending_ids     TEXT    NOT NULL DEFAULT '[]',  -- 开始那一刻的 id 快照
  cursor          INTEGER NOT NULL DEFAULT 0,     -- 只用于显示进度，不参与切分
  plan_json       TEXT    NOT NULL DEFAULT '{}',  -- 累积的 OrganizePlan
  context_summary TEXT    NOT NULL DEFAULT '',    -- 各批 batch_summary 拼起来
  finished        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- 全文索引（v6）。rowid 就是 fragments.id，不另建映射表
CREATE VIRTUAL TABLE fragment_fts USING fts5(text, tokenize = 'unicode61');
```

索引：`fragments(created_at DESC)`、`todos(done)`、`todos(done_at DESC)`、`todos(merged_into)`、
`organize_sessions(finished, updated_at DESC)`。

迁移机制：`PRAGMA user_version` 记录已执行到第几条，`MIGRATIONS` 数组只追加不修改。**当前到 v7。**
v6 做三件事：`DROP TABLE knowledge_cards`、`DROP TABLE ask_logs`、建 `fragment_fts` 与 `organize_sessions`。
v7 给 `todos` 加 `done_at`，用 `created_at` 回填旧完成项，并物理清理超过 5 条的旧完成项。

**几条刻意的结构决定：**

| 决定 | 原因 |
|---|---|
| **没有 `tags` 表** | 标签只是 `fragments.tags` 里的字符串，`listTags()` 遍历统计。改名/合并/删除走唯一的 `rewriteTags` |
| **没有 `knowledge_cards`** | 卡片正文只是原文的另一个视图，不产生新信息；时间轴就是知识库 |
| **纪要写进 `fragments`** | 它要能被整理、被搜索、被再次提问；另开表等于再挖一个数据黑洞 |
| **`fragment_fts.rowid = fragments.id`** | 免掉一张映射表；写入一律先 `DELETE WHERE rowid = ?` 再 INSERT |
| **`notes` 的唯一性由应用层保证** | `(type, period)` 没有 UNIQUE 约束 —— period 可空，SQLite 对 NULL 不去重 |
| **`nature` 保留但不使用** | 兼容旧数据；不要基于它做任何判断 |
| **已完成待办只留 5 条（v0.7.3）** | 用户明确要求物理清理；这是「永不删除」红线的唯一例外，只针对待办，碎片原文仍不删 |

## 6. AI 接口契约

**服务商**：DeepSeek
**协议**：OpenAI 兼容 `POST {baseUrl}/chat/completions`
**默认 BaseURL**：`https://api.deepseek.com/v1`
**默认模型**：`deepseek-flash`（DeepSeek-V4.1-Flash）
**结构化输出**：`response_format: { type: "json_object" }`（只有整理开）
**思考模式**：默认开启（`thinking: { type: "enabled" }`），强度按批次决定

> `deepseek-chat` 与 `deepseek-reasoner` 已于 **2026-07-24** 永久停用。
> 当前可用：`deepseek-flash`、`deepseek-v4-pro`。`deepseek-v4-flash` 是旧名，等价于 `deepseek-flash`。

### 6.1 请求层：`src/ai/chat.ts`

所有 AI 功能共用 `requestChat(config, messages, onProgress, options)`。
**新加功能不要自己写 fetch。**

| 约定 | 值 / 做法 |
|---|---|
| 传输 | 流式 SSE；`response.body` 为 null 时自动退回 `stream:false` 重试一次 |
| 超时 | **四段**：建连 90s / 首字 120s / 空闲 60s / 硬上限 12min。不要改回单一总时长 |
| 思维链 | `delta.reasoning_content` **只上屏**，绝不进解析缓冲区 |
| 正文 | `delta.content` 累积，结束后才解析 |
| `finish_reason` | **在读 `delta` 之前读**（最后一个 chunk 的 delta 是空对象） |
| `max_tokens` | **同时限制思考链 + 正文**。官方 64K，第三方 clamp 8K |
| 思考强度 | `pickEffort`：首轮且 ≤15 条用 `low`（= 不加前缀），其余用 `high` |
| `json` 选项 | 整理 `true`；小结与问答必须 `false` |
| 第三方网关 | 不收 `reasoning_effort`，撞额度只能建议换回官方地址或减小批次 |

**`finish_reason` 的处理分三种**：

| 情况 | 处理 |
|---|---|
| 正文为空 + `length` | 抛 `AiError('truncated')`，文案点明「撞输出上限」 |
| 正文为空 + `insufficient_system_resource` | 报「对方资源不足，过一会儿再试」 |
| 正文非空 + `length` | 整理必须**在解析前**拦下（JSON 一定是残的）；小结直接抛错不保存；问答标 `truncated` |

### 6.2 整理：六类 + 一句摘要

契约全文见 **§0.3**，这里只列不可动摇的部分。

单批输出（七个字段必须都出现，没内容用空数组）：

```json
{
  "tags":          [{ "id": 1, "labels": ["工作", "报销"], "project": "报销单" }],
  "todos":         [{ "text": "提交报销单", "due": "2026-10-21", "id": 1 }],
  "merge":         [{ "keep_id": 3, "drop_ids": [5], "reason": "同一件事" }],
  "todo_done":     [{ "todo_id": 2, "reason": "碎片里说了已经交了" }],
  "drop_todos":    [{ "todo_id": 6, "reason": "从纯感想里误抽的" }],
  "merge_todos":   [{ "keep_id": 6, "drop_ids": [9, 14], "text": null, "reason": "同一件事" }],
  "batch_summary": "这批主要是 NAS 换盘和报销，抽了 3 条待办，并了 2 条重复待办。"
}
```

**上下文清单与上限**（`ai/prompt.ts`）：

| 清单 | 上限 | 作用 |
|---|---|---|
| 已有标签（名字 + 使用次数） | 80 | 复用已有写法，不造近义词 |
| 未完成待办 | 60 | 三类待办操作的 id 来源 |
| 已完成待办 | 30 | 防止把做完的事再抽一遍 |
| 本轮已抽出的待办 | 40 | 前面批次抽的还没写库，不给就会重复抽 |
| 前几批摘要 | 1,500 字 | `appendSummary` 保留尾部 |

**校验与合并只有一份实现**：`util/organizePlan.ts` 的 `mergeBatchResult`。它负责：

- id 必须属于本批（待办操作则必须存在于**原始**待办表）
- 日期必须真实存在（`validDate`，不只校验形状）
- 待办按 `normText` 跨批去重
- `merge` 按 `keep_id` 合并 `drop_ids`
- `todo_done` / `drop_todos` / `merge_todos` 互斥，真删与合并冲突时先到先得
- 标签按 `normalizeTag` 收敛到已有写法

**五条铁律**：

1. **AI 只出建议，不改数据。** 没走到 `commitPlan`，用户的数据一个字都不变。
2. **去重永不删除。** `merge` 只写 `merged_into`，原文永久保留、界面上置灰但可查看。
3. **ID 必须校验。** 模型返回的 id 不在允许集合内，整项丢弃并计入 `rejected`。
4. **破坏性操作默认不勾。** 合并碎片 / 删待办 / 合并待办；`todo_done` 例外（默认勾）。
   登记表只有一份：`util/resultItems.ts` 的 `GROUPS` + `isDestructiveKey`。
5. **显示与写入共用同一个函数。** 分组用 `buildTagGroups`，写库时**重新算一遍**而不是接收界面传来的分组；
   各写一份的下场是「界面说改 A，实际改 B」。

### 6.3 小结

| 项 | 约定 |
|---|---|
| 输入 | 某周期**全部**碎片（`listFragmentsBetween`，半开区间）+ 待办 |
| 输出 | Markdown，`json: false` |
| 小节 | 日「一句话 / 做了什么 / 想明白的 / 悬着的」；周「一句话 / 主线 / 推进 / 结论 / 悬着的」；月「一句话 / 主线 / 结果 / 结论 / 停下来的」 |
| 格式 | 只用 `## ` 小标题 + `- ` 列表；不要表格、代码块、嵌套列表 |
| 文体 | 事实/判断/计划分开写；一条一个意思；句长随内容变；不用空泛评价与固定套话（v0.8.1） |
| 字数 | 日 150–250 / 周 300–500 / 月 500–700 |
| 素材预算 | 26,000 / 40,000 / 60,000 字；超了保留前 70% + 后 30% |
| 单条截断 | 400 字，换行压成 ` / ` |
| 落位 | `periodAnchor`：日 = 当天 23:59、周 = 周日 23:59、月 = 月末 23:59 |
| 保存 | 一律 `repo.upsertNote`；同周期已有则给默认勾选的「替换」 |

**撞额度直接抛错、不保存** —— 半篇小结以「完整」的身份留在时间轴上，比报错难查得多。

### 6.4 问

契约全文见 **§0.4**，这里是实现约束。

| 项 | 值 |
|---|---|
| 检索 | 四路并集：FTS（40 条）/ 时间意图 / 标签意图 / 上一轮引用 |
| 装填 | 最多 18 条碎片，单条 1,200 字，总 36,000 字；FTS 命中优先 |
| 小结 | 按 token 命中取前 6 篇；**没命中就不给** |
| 待办 | 40 条未完成 + 20 条已完成 |
| 多轮 | 最多 8 轮，**只带问题 + 回答**，不带上一轮资料 |
| 联网 | 与本地检索并行；失败只置 `webError`，本地照常答 |
| 引用 | `[F id]` / `[N id]` / `[T id]` / `[W 序号]`；反查只认本轮给过的编号 |
| 输出 | Markdown，`json: false` |
| 截断 | 标 `truncated`，界面提示，不重试 |

**三条纪律**：只给筛过的资料；网络资料与本地记录必须分开标；检索失败不阻断回答。

### 6.5 问答纪要

退出「问」时若选择保存，`util/qaNote.ts` 的 `buildQaNote` 生成文本并 `insertFragment`：

- 标题行：`【问答纪要】YYYY-MM-DD HH:mm · N 轮`，时间用**会话开始时间**
- 最多保留最近 6 轮；每条答案取前 3 句、最多 300 字
- 剥掉 Markdown 外壳（`##` / `**` / 列表符），压成单行
- 空问题或空答案的轮次不写入

## 7. 导出与导入

### 7.1 导出

导出为**单个文件** `fragments-YYYY-MM-DD.md`：

```markdown
# 碎片导出 · 2026-10-25

共 23 条，覆盖 4 天。

---

## 时间轴

### 2026-10-25 周六

- 09:12 报销单还没提交，明天上午弄完 #工作 #财务
- 11:40 老张说 NAS 4 号盘有异响 #设备

### 2026-10-24 周五

- 21:30 ……

---

## 待办

### 未完成（3）

- [ ] 提交报销单 · 2026-10-26
- [ ] 给 NAS 换新风扇

### 已完成（1）

- [x] 换 4 号盘

---

## 标签索引

- #工作（12 条）
- #设备（5 条）
```

- 标签写成 `#tag`，Obsidian / 任意 Markdown 工具都能识别
- 不做任何专有格式，删掉 App 也读得懂
- **v0.7 起没有知识库附录**；被合并的碎片按 `merged_into` 折叠，不导出重复内容

拼接在 `util/mdBuild.ts`（纯函数），IO 在 `export/markdown.ts`。
拆开是为了能和导入做**往返测试**（碎片 → md → 碎片），见 7.2 末尾。

### 7.2 导入（v0.7.2）

设置 → 数据 → 从 Markdown 导入。**选文件不写库**，先出一张预览：
共读到多少条、时间跨度、会导入多少、跳过多少，确认了才落库。

**认什么**

| 写法 | 处理 |
|---|---|
| `### 2026-10-25 周六` / `## 2026-10-25 复盘` | 日期分节，后面跟不跟文字都行 |
| `- 21:40 正文 #标签` | 标准条目 |
| `- 正文` | 没写时间，接在**前一条之后一分钟**，保持文件顺序 |
| `* 正文` / `+ 正文` | 同上（手写笔记常见） |
| `2026年10月25日` | 认 |
| 完全没有日期的文件 | 全部记到今天，并在预览里报数 |

**跳过什么**

- `## 待办` / `## 标签索引` 整段 —— 待办不导入，那是另一个实体
- `- [ ] xxx` 这种勾选框行
- 行尾带「（已合并）」的条目 —— 内容已经在另一条里了
- `2026-13-99` 这类**不存在的日期**：报出来，但内容落到今天（宁可日期不准也不丢内容）
- 未来日期**照收**：挪到今天会把内容混进今天的记录，排在时间轴最上面至少一眼能看见

**判重**

`util/mdParse.ts` 的 `fragmentKey(createdAt, content)` = `天 | HH:MM | 归一化正文`
（`normText` 去掉标点空白并小写）。导入层拿它和库里同区间的碎片比对，
文件内部重复也只进一条。**同一个文件导两遍不会翻倍。**

指纹函数必须两边共用一份。各写一份的下场是「明明重复了却导进来两份」。

**会丢什么**（导出格式里本来就没写）

- `status` / `project` / `merged_into`：按「有标签=已整理、没标签=待整理」推断
- 多行正文被压成一行：导出时换行就替换成空格了，这是导出层的既成事实

**看不见但会拦下来的**

选错文件（二进制、GBK 编码）由 `looksBinary` 拦在最前面：
NUL 字节，或前 4000 字里超过一成是 `\uFFFD`，都会提示「另存为 UTF-8 再试」，
而不是让用户对着一个空结果发呆。

**为什么文件选择器不按 MIME 过滤**

安卓上 `.md` 的类型注册五花八门（`text/markdown`、`text/x-markdown`、
`application/octet-stream` 都有），按类型过滤会让一部分机型**根本看不到自己的文件**。
传通配符 + `looksBinary` 兜底，比「选不到」好。

## 8. 界面规范

| 项 | 值 |
|---|---|
| 风格 | 极简、无渐变无阴影；深浅两套配色 |
| 主背景 | 浅 `#FBFBF9` / 深 `#121211` |
| 卡片 | 浅 `#FFFFFF` 描边 `#ECECE7` / 深 `#1C1C1A` 描边 `#2C2C29` |
| 主文字 | 浅 `#1B1B19` / 深 `#EDEDE9` |
| 次要文字 | 浅 `#6E6E68`、`#A6A69F` / 深 `#B3B3AC`、`#85857E` |
| 强调色 | 浅 `#185FA5` / 深 `#5B9BD8`（深色底上要提亮才够对比） |
| 正文字号 | 15px，行高 1.5 |
| 圆角 | 卡片 12px，按钮 8px，胶囊 999px |

### 8.0 主题（v0.8.0）

三档：浅色 / 深色 / 跟随系统，默认跟随系统，存在 `settings` 表的 `ui_theme` 键。

**两套调色板字段完全一致**（`Palette` 接口），组件只认字段名。深色不是把浅色取反：

- `page` 用 `#121211` 不用纯黑：纯黑配白字太刺，OLED 上纯黑与近黑之间切换还会有拖影
- `card` 抬到 `#1C1C1A`，靠 8 级亮度差代替浅色下「白卡片浮在纸面上」的层次
- 彩色底一律压到 20% 明度，字取同色系高明度版本，标签仍靠色相区分
- `onAccent` 是实心按钮上的文字色。浅色下白字，深色下 `#0B2033` —— 深色的 `accent`
  是 `#5B9BD8`，压白字只有 2.5:1
- `scrim` 是弹层遮罩。`rgba(0,0,0,0.32)` 在近黑页面上等于没有，深色下 0.62

### 写法：颜色不能在模块加载时定下来

`StyleSheet.create` 在**模块加载那一刻**就把色值固化进注册表，之后换主题旧表不会变。
所以任何带颜色的样式都必须写成工厂：

```ts
const makeStyles = (c: Palette) => StyleSheet.create({ ... });

export function Foo() {
  const { c, styles } = useThemedStyles(makeStyles);
  ...
}
```

`useThemedStyles` 内部按调色板 memo，切主题时重算一次，平时一帧都不重算。
**JSX 里内联的颜色（`<Ionicons color={...}>`、`placeholderTextColor`）也走 `c`**，
不能写死；模块级常量数组里若含颜色，得改成函数（拿不到 `c`）。

唯一可以硬编码的是「与背景无关的绝对色」—— 目前只剩一个：开关旋钮的 `#FFFFFF`。

### 启动屏

深色下点开 App 不能闪白。`plugins/withNoSplashAnimation.js` 除了把启动窗对齐成页面色，
还会写一份 `values-night/colors.xml`（`#121211`）。`AppTheme` 的 parent 是
`Theme.AppCompat.DayNight.NoActionBar`，同一个 `@color` 引用会自动解析到 night 那份。

**`userInterfaceStyle: "automatic"` 依赖 `expo-system-ui`**，不装的话 Android 侧这个
开关不生效（prebuild 会明确警告）。

### 应用图标（v0.8.0）

深蓝底（`#185FA5`），一块圆角方板右下角缺一块，缺的那块落在旁边 ——
「整块的东西碎开了，每一片都还在」。生成脚本 `scripts/make-icon.cjs`，不依赖图形库
（Pillow 装不上、sharp 没有）：形状用 SDF 描述、抗锯齿靠 `clamp(0.5 - d, 0, 1)`、
PNG 用 Node 自带 zlib 手写 chunk。

| 资源 | 用途 | 图形占比 |
|---|---|---|
| `icon.png` | iOS / 旧版 Android，满幅底色 | 0.74 |
| `android-icon-foreground.png` | 自适应图标前景，透明底 | 0.62（系统只保证中心 66% 可见） |
| `android-icon-background.png` | 纯色兜底 | — |
| `android-icon-monochrome.png` | Android 13+ 主题图标，取 alpha 染色 | 0.62 |
| `favicon.png` | 网页标签页，128px | 0.82 |

构图不手算：先在设计画布（1400 见方）上画，再按实际不透明区域的包围盒裁剪、居中、缩放。
手算过一次，错位之后重心明显偏下。

### 图标与页头（v0.3.2 定）

图标以前是「一枚 19px 的 Ionicons 加 hitSlop」，肉眼看不出是可点按钮、按偏一点就没反应，
四个子页面还各自写了一遍页头导致标题位置不一致。现在统一成两件东西：

| 规范 | 值 | 理由 |
|---|---|---|
| 图标按钮触控区 | **36px 圆**（`components/IconButton.tsx`） | Material 建议 48px，但一排要放三四个图标；36 是版面与易点的折中，配合 `hitSlop` 后实际可点区更大 |
| 图标直径 | 首页工具 **20px**、页头返回 **22px**、正文配图 **11–13px** | 整体比 v0.3.1 上调一档。原来「已完成」徽章里那个 9px 的勾在手机上基本看不见 |
| 图标底色 | 首页三个导航图标用 `hairSoft` 圆底，返回键同 | 给图标一个明确的按钮轮廓，比纯细线图标好找 |
| 主次 | 整理入口按未读状态变实心/浅底 | 有未读时实心强调，没有时退成浅底，一眼看出「现在该不该整理」 |
| 页头 | 统一用 `components/ScreenHeader.tsx` | 左返回圆钮 + 居中标题（可带副标题）+ 右侧动作区，底部一条 hairline。改一处全站生效 |

副标题用来说明「这一页现在是什么状态」（如 `3 个主题 · 12 张卡`），能挪到副标题的信息就别在正文里再写一行提示。

主界面结构（从上到下）：

```
┌──────────────────────────────┐
│ 碎片          (库)(回顾)(设置) 整理 3 │  头部（图标带浅灰圆底）
├──────────────────────────────┤
│ 今天 · 10月20日          7 条 │  日期分组（sticky）
│  09:12 │ 报销单还没提交…       │
│  11:40 │ 老张说 NAS…          │
│ 昨天 · 10月19日          3 条 │
│  21:30 │ …                    │
├──────────────────────────────┤
│ [ 随手记一条…      ⤢ ] (↑)   │  底部输入（发送钮 32px 圆）
└──────────────────────────────┘
```

**小结排当天最前**（v0.3.1 改）。时间轴同一个日期分组里，先把这一天的结论摆出来，再往下是零碎记录 ——
反过来（小结压在当天末尾）的话，得先划过一整天的碎片才看得见结论，用户的原话是「查看时往下滑才能看到」。
落位靠 `periodAnchor(period)`，日 = 当天 23:59、周 = 周日 23:59、月 = 月末 23:59，所以周/月总结会出现在它覆盖的最后一天。

### 8.1 Android 适配红线（v0.2.1 真机踩过后定下）

**① edge-to-edge 是强制的，不能当它不存在**

app 的 `targetSdk` 是 36，RN 0.88 的 `updateEdgeToEdgeFeatureFlag()` 对 targetSdk ≥ 35 的应用
无条件走 `Window.Companion.enableEdgeToEdge()` → `setDecorFitsSystemWindows(false)`。
`AndroidManifest` 里的 `windowSoftInputMode="adjustResize"` 因此**不再缩放窗口**，
输入法只是盖在窗口上面。由此推出两条硬规则：

- **不要用 `KeyboardAvoidingView` 处理键盘。** 它按 `frame.y + frame.height - keyboardY` 算位移，
  而 `keyboardY` 取的是「可视区域底边」（edge-to-edge 下即屏幕底），算出来恒为负、被
  `Math.max(..., 0)` 夹成 0，在 Android 上完全不生效 —— 这正是 v0.2.0 输入栏被键盘整个盖住的原因。
- **要抬多少，直接用 `useKeyboardHeight()`**（`src/util/keyboard.ts`）。它读
  `Keyboard` 的 `endCoordinates.height`，RN 的 Android 实现是
  `imeInsets.bottom - barInsets.bottom`，即「扣掉导航栏的纯键盘高度」。
  因为 `SafeAreaView` 已经把底部安全区让出来了，这个值**就是**还要额外抬升的距离，不用再减 inset。

**② 全屏页面不要用 `Modal`**

RN 的 Modal 在 Android 上是独立 Dialog 窗口，且会加 `FLAG_LAYOUT_NO_LIMITS`，
于是窗口内容直接画到状态栏底下 —— 这就是「长记录」页顶部和通知栏重合的原因；
Dialog 窗口也拿不到 Activity 根视图的键盘事件，躲不开输入法。
**全屏页/弹层一律用 `position:absolute` 的覆盖层**，留在同一棵 React 树里，
安全区由外层 `SafeAreaView` 负责。代价是要自己接 `BackHandler` 处理返回键。

**③ 启动窗要和页面同色**

启动过程有三段底色：系统启动窗（Android 12+，带图标动画）→ `AppTheme.windowBackground`
→ RN 挂载后的 `C.page`。任意两段不同色就会看见一次闪白。
`plugins/withNoSplashAnimation.js` 把三段统一成 `#FBFBF9` 并把启动窗图标换成透明 drawable，
做到「点开就是底色，界面直接画出来」。

**④ 返回键必须在 App 层收口**

页面栈是 `App.tsx` 里的一个 `route` 状态，没有用导航库。这意味着**返回键默认行为是把 Activity 结束掉**——
用户在整理/回顾/问/设置页按返回，会直接退出 App 而不是回到主界面。

规则：`route !== 'timeline'` 时吞掉返回键并切回时间轴，只有已经在时间轴时才把返回键交还给系统。
覆盖层（长文输入）的 `BackHandler` 注册得更晚，优先级更高，所以开着覆盖层时先关覆盖层。

## 9. 代码结构与分层

文件级清单（含行数）只在 [HANDOFF.md 第 4 节](./HANDOFF.md) 维护 —— 那里是给接手的人看的，
这里只说**结构本身**。

```
screens/      五个页面，各自持有本页状态
   ↓
components/   覆盖层与可复用区块（详情页、结果确认、标签面板、小结面板）
   ↓
ai/  db/      能力层：AI 请求与数据读写
   ↓
util/         纯函数：整理计划、分词、日期、结果元数据、纪要、装箱
```

**几条被刻意固定下来的结构决定：**

| 决定 | 原因 |
|---|---|
| **没有全局 store**，`App.tsx` 只有一个 `route` state，数据由 `App` 加载后 props 下发 | 单机五页面的规模，上 Redux/Zustand 只会多一层要同步的状态 |
| **没有导航库** | 同上。页面栈就是一个联合类型的 state |
| **`db/types.ts` 的 `Repo` 接口是唯一契约**，上层只认接口 | 才能让 SQLite 与 localStorage 两个实现互换而不动业务代码 |
| **存储层按平台扩展名分流**，业务代码统一 `import { repo } from '../db/repo'` | Metro 打包时按 `.native.ts` / `.web.ts` 解析；`repo.ts` 只给 tsc 用，运行时不命中 |
| **AI 层不碰数据库**（唯一例外：`ai/config.ts` 读 `settings` 取配置） | 碎片、待办、标签都由调用方查好传进去，AI 层才能纯函数式地拼 prompt、做收敛 |
| **业务判据只在 `util/organizePlan.ts`** | `ai/deepseek.ts` 只收敛形状，`db/commit.ts` 只按勾选写入。合并规则写两处必然漂移 |
| **整理 = 会话 + 循环 + 计划**，三层分工 | `organizeRun` 管进度、`organizePlan` 管判据、`commit` 管落库。谁都能单独测 |

**一个新增 AI 输出类型的完整改动面**（六处，前三处由 tsc 兜底）：

`types.ts` 的 `BatchResult` 加字段 → `ai/prompt.ts` 补 JSON 模板与说明 →
`util/organizePlan.ts` 的 `mergeBatchResult` 补校验与合并 →
`util/resultItems.ts` 补 `K.*` 与 `GROUPS` 分组 → `db/commit.ts` 补写入 →
`components/ResultSections.tsx` 补渲染。

**新增一类「会让内容消失」的操作**，必须同时在 `resultItems.ts` 的 `GROUPS` 里标 `destructive`
并在 `commit.ts` 里用 `accepted(K.*)` 守住。**只在界面上把默认值设成 false 不算数。**

## 10. 开发进度

**逐版本的改动、根因与被推翻的判断，全部在 [CHANGELOG.md](./CHANGELOG.md)。** 本节只记当前状态和已知限制。

### 已完成

- [x] 时间轴记录（按日折叠 / 首页搜索 / 长文折叠 / 全屏编辑 / 详情页翻页 + 整屏内联编辑）
- [x] **整理 v0.7**：多批循环、跨批摘要接力、断点续跑、停止、失败三选一、统一确认、真实计数
- [x] **标签**：先查已有表再新建、键与显示分离、管理页改名 / 合并 / 删除
- [x] **周期总结**（日 / 周 / 月）+ 待补清单；格式改为「一句话 + 短小节」
- [x] **「问」v0.7.1**：本地四路检索、深度思考 / 联网两个开关、引用、退出存纪要
- [x] 待办：回顾页、完成标记、合并可撤回
- [x] Markdown 导出（时间轴 + 待办 + 标签索引）与**导入**（判重 + 预览确认）、AI 配置与连接测试
- [x] SQLite 迁移到 v6、FTS5 索引与重建入口
- [x] Web 平台编译校验（`npm run build:web` 打一遍包确认能过，产物跑完即删，**不做界面预览**）

### 未完成

- [ ] **通知栏常驻入口**（技术约束见本节末尾）
- [ ] **真机回归**：ROADMAP P0-1 列了 23 条，v0.7 的重做基本没验过

### 已知限制

- **整理会重发上下文。** 每批都要带标签表 + 待办清单 + 摘要，批次越多输入 token 越高。
  砍批次省不了钱，砍的只是「单轮峰值」和「失败只废一轮」。
- **FTS 索引体积约为原文的 2 倍**（bigram 的代价）。几千条无感，十万条要重新考虑。
- **「问」的纪要只有 6 轮、每答前 3 句。** 这是有意的取舍：纪要是线索，不是全量存档。
- **Web 端用 localStorage，与 Android 的 SQLite 是两套数据**，**不能用来验证真实数据流** ——
  它唯一的作用是让 `tsc` 之外的打包错误暴露出来。
- **整理会话没有历史列表。** 只有「最近一个未完成的」能续跑；放弃即删。

### 待办：通知栏入口的实现约束

Expo 托管工作流下无法做通知栏内的「直接输入」（需要原生 `RemoteInput`）。
v1 折中方案：用 `expo-notifications` 发一条 **sticky** 常驻通知，点击后打开 App 并自动聚焦底部输入框。

- 需要装 `expo-notifications` 并加 config plugin
- Android 13+ 运行时申请 `POST_NOTIFICATIONS`，代码里用 `Platform.Version >= 33` 判断
- sticky 通知在进程被杀后的存活能力**必须真机验证**，不能只看文档
- 若要真正的「通知栏内输入」，需转 development build 并自写原生模块，成本高，暂缓

## 11. 已知待确认

1. vivo Y78 实际 Android 版本（影响通知权限分支，代码已做运行时判断，不阻塞开发）
2. 应用最终名称（当前显示名占位为「碎片」，只影响桌面图标文字）

## 12. 本地打包 APK

### 实际可用的构建环境（2026-10-20 实测）

| 项 | 实际值 | 备注 |
|---|---|---|
| Android SDK | `C:\Users\14428\AppData\Local\Android\Sdk` | `ANDROID_HOME` 已配置 |
| platforms | android-36 | |
| build-tools | 37.0.0 | |
| NDK | `27.1.12297006` | 已装，能编 RN 的 C++ |
| CMake | `3.22.1` | 已装 |
| Gradle | 9.4.1 | wrapper 走腾讯云镜像 |
| adb | `%ANDROID_HOME%\platform-tools\adb.exe` | 未加 PATH |

### 构建时三个必须处理的坑

**坑 1：JDK 版本**
Expo 插件要求 Java 17 toolchain，但系统 `JAVA_HOME` 指向的 `C:\Program Files\Java\jdk-21` 是**无效路径**（实际 JDK 21 在 `D:\Program Files\Java\jdk-21`）。

处理方式：构建时 `unset JAVA_HOME`（靠 PATH 里的 java 跑 Gradle），并在 `plugins/withBuildOptimizations.js` 里指定 17 的安装位置（会写进 `android/gradle.properties`）：

```properties
org.gradle.java.installations.paths=C:/Users/14428/.jdks/jdk-17.0.20.1+1
org.gradle.java.installations.auto-download=false
```

JDK 换了机器或换目录时，可用环境变量 `FRAGMENTS_JDK17` 覆盖，不必改代码。

**坑 2：Windows MAX_PATH 260（致命，必看）**
`ninja 1.10.2` 不声明 `longPathAware`，导致 CMake 编译 `react-native-safe-area-context` 时报：

```
ninja: error: ... Filename longer than 260 characters
```

该路径实测 **365 字符**，且 `LongPathsEnabled=1` 对旧 ninja **无效**。
**「把项目挪到短路径」是无效解法** —— 实算即使项目在 `F:\a` 仍为 276 字符。

唯一有效解法：把 `%ANDROID_HOME%\cmake\3.22.1\bin\ninja.exe` 换成 **1.12.1**（声明了 longPathAware）。

```bash
curl -sL -o ninja-win.zip "https://ghfast.top/https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-win.zip"
unzip -q ninja-win.zip
NT="C:/Users/14428/AppData/Local/Android/Sdk/cmake/3.22.1/bin"
cp "$NT/ninja.exe" "$NT/ninja.exe.1.10.2.bak"
cp ninja.exe "$NT/ninja.exe"
```

**坑 3：`expo prebuild` 会重置 `android/`（已自动化，但要加 `--no-clean`）**
`/android` 在 `.gitignore` 里，是 prebuild 生成的产物。重跑 prebuild 会重新生成整个目录，手改的 `gradle.properties` 全部冲掉 —— 单 ABI、shrinkResources、关 GIF/WebP 这些优化一旦丢失，APK 会无声反弹回 76MB。

**现在这些属性写在 config plugin 里，每次 prebuild 自动写回**（`app.json` 的 `plugins` 数组末尾）：

- [`plugins/withBuildOptimizations.js`](./plugins/withBuildOptimizations.js) —— 体积与构建优化
- [`plugins/withNoSplashAnimation.js`](./plugins/withNoSplashAnimation.js) —— 启动窗纯色、去图标动画

要加新的 Gradle 属性或改原生资源，改插件，不要再手改 `android/` 下的文件。

**必须带 `--no-clean`**：不带这个参数时 Expo CLI 会把 `android/` 整个当作可丢弃的生成物去删除，
本机的安全删除（`genie-trash`）会超时失败并把 prebuild 打断：

```
× Failed to delete android code: [safe-delete] ... ETIMEDOUT
```

而且它一旦真删成功，`android/app/.cxx` 的 CMake 缓存会一起没，下一次就是 45 分钟全量重编。

验证插件是否生效（不生成文件、不动 android/）：

```bash
npx expo config --type introspect | grep -A2 reactNativeArchitectures
```

### 体积与速度实测

| 阶段 | APK | 说明 |
|---|---|---|
| v0.1.1 初始 | 76 MB | 4 ABI（arm64-v8a / armeabi-v7a / x86 / x86_64） |
| 单 ABI | 23.9 MB | 只留 arm64-v8a |
| 字体按需 + 关 GIF/WebP + shrinkResources | **22 MB** | 累计 **-71%** |

构建耗时：全量约 45 分钟（含 C++ 编译）；改 JS 后增量 **约 2 分钟**（`org.gradle.caching` + 321/332 任务命中 up-to-date）。

> 仍未解决的：`expo:generateInlineModules` 每次构建都跑，连带 `expo-modules-core:buildCMakeRelWithDebInfo` 的 C++ 编译无法命中缓存，约占总耗时一半。暂未找到安全的关闭方式。

### 打包命令

```bash
cd F:\coding\python\project\Test\fragments
# 仅改了 app.json / config plugin / 新装原生依赖时才需要；
# --no-clean 不能省，否则会尝试删除整个 android/ 目录
npx expo prebuild --platform android --no-install --no-clean
cd android
unset JAVA_HOME
export ANDROID_HOME="C:/Users/14428/AppData/Local/Android/Sdk"
./gradlew assembleRelease --console=plain > build.log 2>&1
```

**不要把输出管道给 `tail`**，`tail` 会缓冲到进程结束，全程看不到任何进度。写日志文件再 `tail -f`。

### 耗时参考

| 场景 | 耗时 |
|---|---|
| 首次全量（含下载 2.4G 依赖 + C++ 全编） | 约 45 分钟 |
| 改 JS 后的增量 | **4 分钟左右** |

产物：`android/app/build/outputs/apk/release/app-release.apk`

### 签名说明

`android/app/build.gradle` 里 `release` 用的是 `signingConfigs.debug`（Expo 模板默认）。也就是说：

- APK **能装、能用**，但签名是通用 debug key
- 个人自用没问题；**将来若要覆盖升级**，必须一直用同一个 keystore，否则系统会拒绝安装新版本
- 真要正经发布，得自己 `keytool` 生成 keystore 并改 signingConfig

### 装机

1. 手机开「开发者选项 → USB 调试」，USB 连线，`adb devices` 确认能识别，然后 `adb install -r app-release.apk`
2. 或者把 APK 拷进手机，用文件管理器点开安装（需允许「安装未知来源应用」）

### 装不上时对照

| 现象 | 原因 |
|---|---|
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 手机上已有同包名但签名不同的版本，先卸载 |
| `INSTALL_PARSE_FAILED_NO_CERTIFICATES` | APK 未签名，检查 buildTypes.release 是否配了 signingConfig |
| 应用打开闪退 | 先 `adb logcat | grep ReactNative` 看具体报错 |
