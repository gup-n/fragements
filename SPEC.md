# 碎片 · 需求与设计说明书 (SPEC)

> 本文档是跨会话开发的**唯一设计依据**：数据模型、AI 契约、界面规范、构建环境。
> 改功能先改这里，再改代码。**版本历史不写在这里** —— 那是 [CHANGELOG.md](./CHANGELOG.md) 的事。

最后更新：2026-10-25（v0.6.2：问答范围可以选任意主题）

> 后续开发计划、优先级与待决问题见 [ROADMAP.md](./ROADMAP.md)；面向使用者的项目说明见 [README.md](./README.md)。

---

## 1. 产品定位

一个**个人、单机、只给自己用**的碎片记录工具。

核心价值不是"做笔记"，而是：**随手扔一句 → AI 定期帮你收拢**。

两条设计红线：

1. **记录摩擦必须极低**。打开即输入，输完即消失。任何"先选分类再写"的设计都违背定位。
2. **AI 只做收拢，不做限制**。AI 从不阻止你记录，只在你想整理时提供建议。

### 内容分流（v1.1 新增）

碎片的内容寿命差别极大：「带 U 盘给小李」三天后是噪音，「RAID5 换盘先确认热备」三年后还救人。混在一条时间轴里，后者会被前者淹没。

因此整理时按性质分流到三个去处，**但记录时完全不分类**——判断放在 AI 读过内容之后，不放在用户身上：

| 去向 | 内容特征 | 寿命 | 检索方式 |
|---|---|---|---|
| 待办 | 有明确动作 | 小时～天 | 按状态 |
| 知识卡 | 可复用的方法、事实、结论、坑 | 年 | 按主题 |
| 时间轴 | 事件、琐事、情绪 | 周 | 按时间 |

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
| 框架 | React Native + Expo SDK 58 | 复用已有 TypeScript/React 经验；Expo Go 扫码即可在真机预览 |
| 语言 | TypeScript | — |
| 存储 | expo-sqlite（本地 SQLite） | 结构化查询、索引、事务；导出方便 |
| 密钥 | expo-secure-store（Android Keystore 加密） | API Key 不落明文 |
| 文件导出 | expo-file-system + expo-sharing | 生成 md 后走系统分享，可直接存 NAS |
| 导航 | 自实现轻量页面栈（5 个页面：时间轴 / 整理 / 知识库 / 回顾 / 设置） | 不引入 react-navigation，减少依赖与配置成本 |
| Web | react-native-web + localStorage 驱动 | 便于桌面浏览器预览与调试，不作为交付目标 |

**包名**：`com.local.fragments`（固定）
> 改包名 = 系统视为另一个 App，旧数据不会跟随。若将来要改，先「导出 Markdown」再迁移。

## 4. 功能范围

### 4.1 已实现（范围内的都做完了，只剩 4.2 那一项）

- 应用内极简输入（打开即写）
- 长文本承载：输入框自动增高，可一键转全屏编辑；时间轴内超 3 行折叠，点开看全文
- 时间轴流主界面（按日分组、时间戳、整行文本）
- **按日折叠**（v0.4.0）：默认只展开今天，其余日期收起成「日期 + 条数 + 第一条前一行」。搜索时强制全展开
- **首页搜索**（v0.4.0）：查碎片原文 / 标签 / 事项，在内存里过滤，并报「其中 N 条还没整理」
- **标签筛选**（v0.6.0）：点时间轴上的标签胶囊只看同类，再点一次取消；事项名同理。与搜索框是叠乘关系，有筛选时强制展开所有日期
- **碎片详情页**（v0.4.0 / v0.4.2）：点一条进全屏阅读页，左右滑动看上一条 / 下一条。右上角「编辑」**原地整屏改**，保存后当场刷新；正文下方接这一天的当天小结。长按列表项可直接进编辑
- 碎片编辑 / 删除
- AI 整理：分类打标、提炼待办、关联去重、沉淀知识卡、**操作已有待办（标完成 / 删除 / 合并）**、**归并相近主题**（一次调用产出十类，见第 6 节）
- 整理结果的逐条接受 / 忽略
- **知识库**：按主题聚合，主题内可再按「二级方向」分组；卡片展示标题与要点，点开是独立详情页（大字号原文 + 归档 / 恢复 / 删除）
- **手动分方向**（v0.6.0）：卡片详情页顶部、主题页页头、方向小节头三个入口，可以给单张卡设方向、批量设、或整组改名
- **移除方向**（v0.6.1）：面板底部有独立的「移除方向」按钮，勾了卡就能点，不必先清空输入框。清掉之后卡片回到「未分方向」组，方向组随之消失。**卡片本身不受影响**，只丢分类
  > 这条踩过坑：v0.6.0 把移除藏成「输入框留空 + 点确定」，真机上没人发现。**破坏性或非常规动作必须做成看得见的按钮**
- **主题整理**（v0.4.1）：知识库页头进入，勾选多个主题合并成一个，或给单个主题改名。只改主题名，卡片一张都不会少
- **知识库检索**（v0.3.0）：关键字搜索（标题 / 要点 / 原文 / 主题四字段，跨主题，在主题页内自动收窄）、问模型（范围可选「全库」或任意主题，胶囊一行横滚；从某个主题页进来时默认就是那个主题）
- **问答可动手**（v0.5.0）：模型只能提「操作提案」（合并主题 / 主题改名 / 归档旧卡 / 重构单卡），用户勾选后才写库，默认一条不勾
- **联网搜索**（v0.5.0）：卡片里没有时**手动**点「联网再查一次」，走 DeepSeek 官方 `/v1/tools/search`；网络资料与知识库卡片在回答里明确区分
- **问答记录**（v0.5.0）：独立扁平和区，Q-A 成对、可改问题 / 删除 / 带入本轮；默认不参与检索也不进上下文
- **思考折叠**（v0.5.0）：问答回答落地后，思维链收成一行「深度思考 N 秒 ›」
- **周期总结**（v0.3.0）：按日 / 周 / 月把该周期全部碎片读一遍写成 Markdown 小结，预览后保存，落在时间轴对应时间点
- **待补小结清单**（v0.3.1）：整理页列出哪些周期还没有小结，点一条进去生成。整理本身**不再产出小结**
- Markdown 导出（时间轴 + 知识库附录）
- 设置页：API 配置、数据统计

### 4.2 属于范围但还没做

- **通知栏常驻入口**。技术约束与折中方案见第 10 节末尾，排期见 [ROADMAP.md](./ROADMAP.md) P0-2。

### 4.3 明确不做

桌面小组件 · 语音转文字 · 定时自动整理 · NAS 自动备份 · 多端同步 · 密码锁 · 图片/链接附件 · 知识卡正文编辑器（只读 + 归档/删除，不做富文本）· 向量检索（卡片数百张量级，关键词打分够用）

架构上为这些预留：`fragments.source` 字段可扩展、`repo` 接口隔离存储实现。

## 5. 数据模型

```sql
-- 碎片本体
CREATE TABLE fragments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  content     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,              -- 毫秒时间戳
  source      TEXT    NOT NULL DEFAULT 'app', -- app | notif | share
  status      TEXT    NOT NULL DEFAULT 'inbox', -- inbox | tagged | merged
  tags        TEXT    NOT NULL DEFAULT '[]',  -- JSON 字符串数组
  project     TEXT,                           -- AI 推断的项目/主题
  merged_into INTEGER,                        -- 被合并到哪条（不删除原文）
  nature      TEXT                            -- v1.1: todo | knowledge | event，AI 判定
);

-- 知识卡（v1.1）
CREATE TABLE knowledge_cards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  topic      TEXT    NOT NULL,   -- 主题，AI 优先复用已有主题
  subtopic   TEXT,               -- v4：二级方向，可空。大多数主题用不上
  title      TEXT    NOT NULL,   -- 一句话结论，8-15 字
  gist       TEXT    NOT NULL,   -- AI 提炼的 2-4 条要点，索引层
  body       TEXT    NOT NULL,   -- 原始碎片原文，保真层
  source_ids TEXT    NOT NULL,   -- JSON 数组，来源碎片 id
  created_at INTEGER NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0
);

-- 每次 AI 整理的调用记录（便于回溯与成本核算）
CREATE TABLE organize_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,
  fragment_ids TEXT    NOT NULL,   -- JSON 数组
  model        TEXT,
  result_json  TEXT,
  applied      INTEGER NOT NULL DEFAULT 0
);

-- AI 汇总产出的成稿
CREATE TABLE notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL,     -- daily | weekly | monthly | theme
  title      TEXT,
  body_md    TEXT    NOT NULL,
  period     TEXT,                 -- 2026-10-20 / 2026-W43 / 2026-10；theme 为空
  created_at INTEGER NOT NULL
);

-- 待办
CREATE TABLE todos (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  text               TEXT    NOT NULL,
  due_at             TEXT,        -- YYYY-MM-DD，可空
  done               INTEGER NOT NULL DEFAULT 0,
  source_fragment_id INTEGER,
  created_at         INTEGER NOT NULL,
  merged_into        INTEGER      -- v3：被合并到哪条。非空表示已隐藏（可撤回）
);

-- 键值配置
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 问答记录（v5）。刻意独立于 knowledge_cards：
-- 问答是「提问的痕迹」，卡片是「沉淀的结论」，混在一起会让卡片数虚高、检索捞出一堆一次性对话
CREATE TABLE ask_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT    NOT NULL,   -- 'all' 或主题名
  question   TEXT    NOT NULL,
  answer     TEXT    NOT NULL,
  reasoning  TEXT    NOT NULL DEFAULT '',  -- 思维链，只用于回看，永不进上下文
  cited_ids  TEXT    NOT NULL DEFAULT '[]',-- JSON 数组，引用到的卡片 id
  web_json   TEXT    NOT NULL DEFAULT '[]',-- JSON 数组，这一轮搜到的网络资料
  created_at INTEGER NOT NULL
);
```

索引：`fragments(created_at DESC)`、`todos(done)`、`todos(merged_into)`、`knowledge_cards(topic)`、`knowledge_cards(topic, subtopic)`、`ask_logs(scope, created_at DESC)`。

迁移机制：`PRAGMA user_version` 记录已执行到第几条，`MIGRATIONS` 数组只追加不修改。当前到 v5。

**主题不是实体**，只是卡片上的一个字符串（`GROUP BY topic` 出来的）。这是刻意的：
十一二张卡的量级不值得建 `topics` 表和外键。代价是不能改名、不能合并 ——
v0.4.1 用 `retopicCards(from[], to)` 批量 `UPDATE` 补上了这个能力，
将来真要升级成实体表，`subtopic` 正好是 `parent_id` 的现成迁移路径。

`notes` 的 `(type, period)` 由应用层保证唯一（`upsertNote` 先查后写），没有数据库唯一约束 ——
period 可空，SQLite 的 UNIQUE 对 NULL 不去重，加了也拦不住。

## 6. AI 接口契约

**服务商**：DeepSeek
**协议**：OpenAI 兼容 `POST {baseUrl}/chat/completions`
**默认 BaseURL**：`https://api.deepseek.com/v1`
**默认模型**：`deepseek-flash`（DeepSeek-V4.1-Flash）
**结构化输出**：`response_format: { type: "json_object" }`
**思考模式**：默认开启（`thinking: { type: "enabled" }` + `reasoning_effort: "high"`）

> **模型名变更（v0.2.4，必看）**：`deepseek-chat` 与 `deepseek-reasoner` 已于 **2026-07-24 15:59 UTC 永久停用**，
> 调用直接报错，没有宽限期也没有软跳转。旧的两个别名本来都对应 V4-Flash 的非思考 / 思考模式，
> 所以迁移到 `deepseek-flash` 是**价格不变**的。
> 当前可选：`deepseek-flash`（便宜，思考/非思考都支持）、`deepseek-v4-pro`（约 3.1 倍价，能力更强）。
> `deepseek-v4-flash` 作为旧名仍被接受，等价于 `deepseek-flash`。
>

### 请求

System prompt 约定角色与输出格式；User 消息传紧凑的碎片列表，后面依次附上已有主题、已有知识卡、未完成待办：

```
[1] 09:12 报销单还没提交，明天上午弄完
[2] 11:40 老张说 NAS 4 号盘有异响
[7] 21:30 换完盘重建跑完了（已整理）

【已有主题】（大方向一致的应当合并；不要为一张卡单开一个主题）
- NAS 维护（RAID5 换盘前先确认热备盘位 / SHR 和 RAID5 区别 等 3 张）
- 装机（Ventoy 升级后要重新校验启动）

【已有知识卡】（能补充它们就用 card_update，不要重复建同主题的卡）
[3] NAS 维护 | RAID5 换盘前先确认热备盘位

【未完成待办】（某条做完了用 todo_done；说重复的用 merge_todos / drop_todos）
[5] 提交报销单 · 2026-10-21
```

四段上下文各自解决一件事：

| 上下文 | 让模型能做什么 |
|---|---|
| 已有主题（带卡片标题） | 复用主题名，不长出「NAS」「nas」「群晖」三个同义主题；**判断哪几个主题讲的是同一类事，用 `merge_topics` 并起来** |
| 已有知识卡 | 用 `card_update` 把新碎片补进老卡，或用 `archive_cards` 归档被取代的旧卡 |
| 未完成待办 | 用 `todo_done` 标掉「已经做完」的，用 `merge_todos` 并掉重复的，用 `drop_todos` 清掉「本就不该存在」的 |

> 主题清单**必须带卡片标题**，只给主题名时模型没有任何依据判断「工具」和「资讯」其实是同一类，
> `merge_topics` 就退化成猜谜。每个主题最多列 4 个标题，多出来的标「等 N 张」。

### 两种模式

同一个 prompt、同一个响应结构，靠 `mode` 切换语义：

| 模式 | 处理对象 | 区别 |
|---|---|---|
| `organize`（整理未读） | `status = inbox` 的碎片 | 正常整理。已有知识卡/待办只作上下文，不重审旧原文 |
| `refactor`（重构已整理） | `status = tagged` 的碎片 | 重新判标签、重新沉淀知识卡，结果与旧整理逐条对照 |

`refactor` 模式下，碎片行尾会带上旧结果，模型才知道「哪里变了」：

```
[7] 21:30 换完盘重建跑完了（已整理｜标签：设备、NAS｜项目：NAS 维护）
```

并在开头明确要求它独立判断（`不要因为标签已经存在就照抄`）。重构范围三种（v0.3.1 新增「全部碎片」）：

- **全部碎片**（默认）：`mergedInto === null` 的全部碎片，未整理的和已整理的一起过一遍。
  v0.3.0 之前只能重构已整理的，等于每次想修正历史都得先跑一轮整理，白花一次调用。
- **只重构已整理**：只取 `status = tagged` 的
- **按主题**：取某主题下全部知识卡的 `source_ids` 反查出来的碎片

单次上限 `REFACTOR_LIMIT = 40` —— 重构的碎片原文比未读碎片长得多，多了 token 会爆。
超出部分在界面上明说「还有 N 条这次没带上」，不做静默截断。

### 响应（严格 JSON）

```json
{
  "tags":          [{ "id": 1, "labels": ["工作", "财务"], "project": "报销" }],
  "todos":         [{ "text": "提交报销单", "due": "2026-10-21", "id": 1 }],
  "merge":         [{ "keep_id": 3, "drop_ids": [5, 9], "reason": "同一件事" }],
  "knowledge":     [
    {
      "topic": "NAS 维护",
      "subtopic": "换盘",
      "title": "RAID5 换盘前先确认热备盘位",
      "gist": "- 降级后先看存储池状态确认故障盘\n- 热备会自动顶上，别急着拔",
      "source_ids": [4]
    }
  ],
  "todo_done":     [{ "todo_id": 5, "reason": "碎片里写了已经交了" }],
  "card_update":   [{ "card_id": 3, "add_source_ids": [7], "title": null, "gist": null, "reason": "同属 RAID 换盘" }],
  "archive_cards": [{ "card_id": 9, "reason": "内容已被新卡完整覆盖" }],
  "drop_todos":    [{ "todo_id": 11, "reason": "和另一条重复" }],
  "merge_todos":   [{ "keep_id": 11, "drop_ids": [12, 15], "text": "把报销单交了", "reason": "三条说的是同一件事" }],
  "merge_topics":  [{ "from": ["工具", "资讯"], "to": "AI", "reason": "两个主题下都是 AI 相关的结论" }]
}
```

注意 `knowledge` 里**没有 body 字段**——原文由代码直接从 `source_ids` 对应的碎片拼接，不经过模型。
`subtopic` 是**可选**的二级方向，跟主题同名或为空时一律收敛成 null —— 那样的小方向没有区分作用。

**没有 `summary`**（v0.3.1 移除）。整理只看 60 条碎片，可能只是某个周期的一小部分，
在这里顺手写小结必然写残；更要紧的是它每次都会插一条「今日小结」，
一天整理两次就有两条，这正是用户报的那个「生成了两次小结」。小结只剩一个入口：周期总结面板。

后六类（`todo_done` / `card_update` / `archive_cards` / `drop_todos` / `merge_todos` / `merge_topics`）是 v0.2.2–v0.4.1 陆续加的，
共同点是把「旧数据」也纳入一次整理：以前只看新碎片，现在能补老卡、标老待办、清旧卡、并重复待办、并相近主题。

`merge_topics` 的收敛规则（`normalizeResult`）：

- `from` 里的每个主题都必须真实存在于本次上下文，且至少两个 —— **改名不是它的职责**，改名由用户手动做
- `to` 非空、最长 20 字，可以是 `from` 之一（并到其中一个），也可以是新名字
- 一个主题只能被一条建议吃掉：两条建议都提到「工具」时，后面那条整条丢弃，
  否则先并完再并，结果取决于执行顺序

### 流式输出与思考过程（v0.2.4）

**为什么改流式**：原来是 `stream: false`，整理一次只显示一个 spinner 加一句「通常需要 5–15 秒」。
开启思考模式后这个时间会明显变长，用户完全看不到进展，既不知道是不是卡住了，也无从判断 AI 为什么这么归类。
改成流式之后，思维链可以边生成边显示，「看到模型的思考过程」这个需求就落在这里。

**传输格式**：SSE。每行 `data: <json>`，以 `data: [DONE]` 结束。两种 delta：

| 字段 | 内容 | 用途 |
|---|---|---|
| `delta.reasoning_content` | 思维链，模型在给出答案前的推理 | **只显示**，不参与任何解析 |
| `delta.content` | 最终答案，即第 6 节的十类 JSON | 拼完再 `parseJsonLoose` + `normalizeResult` |

**四条硬规矩**：

1. **reasoning 绝不参与 JSON 解析**。它是自然语言推理，混进 `content` 会直接毁掉解析。
   两个缓冲区必须分开累积。
2. **`reasoning_content` 不回传给下一轮**。官方文档明确：请求不带 `tools` 时它会被忽略、也不拼进上下文。
   本项目不用 tool calls，所以多轮追问只回传 `content`（也就是现有的 `raw`）。
3. **UI 更新必须节流**。一个思考过程能吐几百个 chunk，每来一块就 `setState` 会让 JS 线程卡死。
   `OrganizeScreen` 里用 ref 累积 + 120ms 节流上屏，结束时强制 flush 一次。
4. **超时分四段，不是总时长**：建连 90 秒 / 响应头回来到首字 120 秒 / 数据流动中块间静默 60 秒 / 硬上限 12 分钟。
   每收到一块数据就重置空闲计时器。**不要沿用原来的 90 秒总时长**，思考模式下正常请求也可能超过它。
   硬上限之所以是 12 分钟而不是更短：输出额度 64K 之后，正常一轮生成本来就要十几分钟，
   设短了会在正常生成途中掐断。真卡住由 60 秒空闲超时兜。
5. **输出额度 `max_tokens` 同时限制「思考链 + 正文」**（V4 系列语义，与老版 `deepseek-reasoner` 不同）。
   默认 64K，第三方兼容服务压到 8K。额度被撞满时 `finish_reason` 为 `length`，
   必须按「截断」报错，不能报成「模型没有返回内容」。

**降级**：如果 `response.body` 为 null（该平台的 fetch 不支持流），自动用 `stream: false` 重试一次。
已经开始接收数据之后才断的，不重试，直接报错 —— 重试等于重复扣费。

**参数冲突**：thinking 模式下 `temperature` / `presence_penalty` / `frequency_penalty` 不生效
（传了不报错，但被忽略）。所以代码只在 `thinking: disabled` 时才传 `temperature: 0.2`，
免得看代码的人以为自己控制住了随机性。

### 多轮追问

结果页底部有一个输入框，用户可以继续提要求（「待办合并成一条」「知识卡太碎了」）。
实现就是标准 chat 多轮，把上一轮**原始输出**原样作为 `assistant` 消息回传：

```
system:    SYSTEM_PROMPT
user:      buildUserContent(...)
assistant: <上一轮的模型原始输出>
user:      buildRefineContent("待办合并成一条")
```

三点必须守住：

1. **回传原始输出，不是收敛后的对象**。收敛过程会丢掉模型的原话，模型看到被改写过的自己会跑偏。
2. **要求输出完整结果而非增量**。否则模型只返回改动项，用户还没确认的内容会凭空消失。
3. **确认状态用内容做 key，不用下标**。追问会重排条目，下标一动，用户取消掉的勾选就落到别的内容上。

### 四条铁律

1. **AI 只出建议，不改数据**。所有结果先落为待确认态，用户逐条接受后才写入。
2. **去重永不删除**。`merge` 只写 `merged_into`，原文永久保留，界面上置灰但可查看。
3. **ID 必须校验**。模型返回的 `id` 若不在本次输入集合内，直接丢弃该项。
4. **原文保真由代码保证**。知识卡的 `body` 不采信模型输出，一律用来源碎片原文拼接。「AI 写索引，原话必留」这条不能寄希望于模型听话。

补充几条后续版本新增的约束：

5. **`card_update` 只追加不覆盖**。新原文接在旧 body 后面，卡片已有的正文一个字都不动；已在 `source_ids` 里的碎片不重复追加。
6. **会让内容消失的三类操作默认不勾选**：`archive_cards`（归档卡）、`drop_todos`（真删待办）、
   `merge_todos`（合并待办，被并的那几条会隐藏）。
   它们的共同点是「一勾就看不见了」，用户很难察觉误操作，必须由用户主动点一下。
   `todo_done` 从 v0.3.0 起改成**默认勾选** —— 用户明确要求「已经做完的自动标掉」，
   而且标完成只是让待办进回顾页的已完成区，内容没丢，点一下就能撤回。
   这三类的清单集中登记在 `src/util/resultItems.ts` 的 `GROUPS` 表里，不在渲染代码里散着写。
7. **归档必须可恢复且有入口**。`archive_cards` 只写 `archived = 1`，知识库页有「已归档」区可以恢复或彻底删除。
   **没有查看入口的归档 = 数据黑洞**，这条在做归档功能时被单独检查过一遍。
8. **互斥保护由代码做**。同一张卡不能既 `card_update` 又 `archive_cards`，同一条待办不能既 `todo_done` 又 `drop_todos`——
   `normalizeResult` 里按「先到先得」丢掉后一个，不指望模型自洽。
9. **用户取消的授权不能被代码绕过**。重构模式下新卡会按「来源碎片重叠 ≥ 50%」自动顶掉旧卡，
   但如果用户明确取消了那张卡的归档建议，替代逻辑也必须跳过它（`declinedArchive`）。
   「操作要用户授权」得由代码保证，不能只在界面上提示一句。
10. **重构不重复抽待办**。重构的碎片上次整理时已经抽过待办，再抽一遍就是纯重复。
    `pruneRefactorResult` 在代码层按「文案相同」或「同一碎片已派生过待办」两条判据过滤掉。
11. **合并是隐藏不是删除**。`merge_todos` 只写 `todos.merged_into`，被并掉的条目仍然留在表里，
    回顾页有「已合并」入口可以逐条恢复。`stats().todoOpen` 必须排除它们，否则合并越多首页数字越虚高。

### 周期总结与知识库问答（v0.3.0）

这两个功能与「整理」**共用请求层**（`src/ai/chat.ts`），差别只在 prompt 和结果收敛：

| | 整理 | 周期总结 | 知识库问答 |
|---|---|---|---|
| 输入 | 未读碎片 + 已有卡/待办 | 某周期全部碎片 | 提问 + 相关卡片 |
| 输出 | 十类 JSON | Markdown 正文 | Markdown 回答 |
| `response_format` | `json_object` | **关闭** | **关闭** |
| 落库 | 用户逐条确认后写入 | 用户预览后写 `notes` | **不落库** |

**为什么必须关掉 `json_object`**：开着它，模型会把整篇 Markdown 塞进一个 JSON 字符串里，
换行全变成 `\n`，落到时间轴上就是糊成一行的长文本。`chat.ts` 的 `RequestOptions.json` 就是为这个存在的，
默认开（整理要），这两个功能显式传 `json: false`。

#### 周期总结

- 周期键：日 `2026-10-22` / 周 `2026-W43`（ISO 规则，周一起点、周四定年份）/ 月 `2026-10`
- 取数走 `listFragmentsBetween(from, to)`，**区间半开** `[from, to)`。
  不能用 `listFragments(limit)` 截断 —— 月总结会漏掉月初的记录
- 材料预算 26000 字：超了保留「前 70% + 后 30%」，中间插一句「…（中间省略 N 条）」。
  只取前 N 条会丢掉月末的结论，保住两头更接近人回看的方式
- 单条碎片截 400 字，原文里的换行压成 ` / `；同时附上该周期标完成的待办、至今未完成的待办、该周期沉淀的知识卡标题
- 输出固定为 `## 小标题` + `- 列表`；篇幅：日 150–300 字 / 周 350–600 字 / 月 500–900 字
- 时间轴落位靠 `periodAnchor(period)`：日 = 当天 23:59、周 = 周日 23:59、月 = 月末 23:59。
  这样总结排在周期末尾，而不是「生成它的那天」
- 同周期重复生成：检测到已有 `(type, period)` 的 note 时，保存前给一个默认勾选的「替换原有小结」，
  避免时间轴上并排两条同日小结。检测走 `repo.findNote(type, period)` 精确查，
  **不能拿 `listNotes(200)` 再自己筛** —— 笔记一多就会漏掉更早的那条，于是同一天又插一条出来
- 保存一律走 `repo.upsertNote`，按 `(type, period)` 覆盖
- **只生成总结，不动碎片状态**（不改 `status` / 不标待办 / 不归档卡），这是这个功能敢默认放开的理由

#### 待补小结清单（v0.3.1）

整理页的整理入口下方会列「N 个周期还没写小结」，点一条直接打开周期总结面板并预选好粒度与周期。
判定逻辑在 `src/util/digest.ts` 的 `missingDigests()`：

| 规则 | 说明 |
|---|---|
| 只看有碎片的周期 | 空周期没什么可总结的 |
| 日小结**包含今天** | 今天的碎片已经攒了一些，想写就该能写。这类标 `running`，界面写「今天」并注明只统计到此刻 |
| 周/月只算已结束的 | 本周/本月写了是半截，周期一结束就会重新出现，没必要先写一份残的 |
| 已有小结的跳过 | 按 `type|period` 精确匹配 |
| 按粒度配额排 | daily 6 / weekly 2 / monthly 2 先占名额，剩余按时间补，最后统一按时间倒序 |

配额是为了解决一个具体问题：月/周的周期末端天然比日靠后，纯按时间倒序会让一个月总结把一堆日小结全挤掉，
而日小结才是日常真正常用的那个。`total` 报真实缺口数，界面区分「共 N 个」和「列前 M 条」。

#### 主题与二级方向（v0.4.1）

主题只是卡片上的一个字符串，不是实体。两级结构靠两列实现：`topic` + 可空的 `subtopic`。

| 场景 | 处理 |
|---|---|
| 主题下只有两三张卡 | `subtopic` 保持 null，界面平铺，不显示分组头 —— 硬加一层「未分方向」是噪音 |
| 主题下有多个明确细分 | AI 填 `subtopic`，主题页按它分组；「未分方向」那组永远排最后 |
| 主题之间方向相近 | AI 出 `merge_topics` 建议（默认不勾选）；用户也可以在知识库页头手动合并 |
| 已有卡片要补方向 | 手动入口三处：详情页顶部、主题页页头（批量）、方向小节头（整组改名）。走 `repo.setCardSubtopic(ids, to)` |

**`setCardSubtopic` 和 `resubtopicCards` 不能互相替代**：前者按卡片 id 精确指定，
后者按「方向组」匹配。老卡片的 `subtopic` 全是 `null`，用组操作选不中任何一组，
等于没有入口 —— 这正是 v0.4.1 之后「分组功能在已有数据上看不到效果」的原因。

整理时 prompt 会把每个主题已有的方向一起给模型（`〔方向：换盘 / 备份〕`），
并要求优先复用现成说法，否则每轮都会新起一个近义词，分组反而更碎。

主题整理面板（`components/TopicSheet.tsx`）只有一个输入框：**勾一个就是改名，勾多个就是合并** ——
底层是同一个动作 `repo.retopicCards(from[], to)`，批量 `UPDATE knowledge_cards SET topic = ?`。
已归档的卡片也一起改，否则恢复之后会凭空多出一个只含归档卡的主题。

卡片一张都不会少，但合并之后回不到原来的主题名（只能手动重拆），
所以 AI 的归并建议和归档卡、删待办同属「默认不勾选、需要用户主动点一下」的一类。

#### 知识库问答

- **没有向量检索**。卡片是数百张的量级，用关键词打分：提问拆成英文整词 + 中文二元组，
  命中标题 ×8、主题 ×4、子主题 ×4、要点 ×3、原文 ×1，按分数排序后按 26000 字预算装填，单卡原文截 1200 字
- prompt 三条约束：只依据卡片回答（没有就直说没有）、引用时把卡片标题原样写进句子并用「」括起来、
  卡片互相矛盾时把矛盾摆出来不替用户裁决
- **引用反查靠标题字面命中**（`answer.includes(card.title)`），比让模型输出编号再解析稳得多，
  也不受模型改编号习惯的影响
- 范围默认「当前主题」，可一键切「全库」
- **回答本身不是知识库内容**。v0.5.0 起会写进 `ask_logs`（问答记录），但那张表**独立于 `knowledge_cards`**，
  不参与卡片计数、也不参与关键词打分 —— 否则「全库 N 张卡」会虚高，检索还会捞出一堆一次性对话

##### 操作提案（v0.5.0）

模型只有建议权。用户明确要求动知识库时，回答末尾追加：

```
:::action
{"kind":"merge_topics","from":["工具","资讯"],"to":"AI 与工具","reason":"都在讲 AI"}
:::
```

| kind | 载荷 | 说明 |
|---|---|---|
| `merge_topics` | `from`（≥2 个已存在主题）/ `to` | 合并主题 |
| `rename_topic` | `from`（已存在）/ `to` | 主题改名 |
| `archive_cards` | `ids`（已存在卡片） | 只归档，可恢复；**没有 delete_card** |
| `update_card` | `id` + 任意 `topic` / `subtopic` / `title` / `gist` | 重构单卡，只改给出的字段 |

- `subtopic` 三态：不传 = 不动、`null` = 清掉小方向、字符串 = 设成它
- 开 `json_object` 会把整篇 Markdown 压成一坨字符串，所以正文照常写、提案单独围栏
- **校验是真的做**（`util/askActions.ts`）：主题名必须逐字存在于 `listKnowledgeTopics()`，
  卡片 id 必须存在于**全库**。放过去的后果一个是「改 0 张却报成功」，一个是「改到另一张卡上」
- 界面默认**一条都不勾**（`AskActions.tsx`），勾了才执行；每条独立事务，一条失败不回滚其他

##### 联网搜索（v0.5.0）

- 走 DeepSeek 官方 `POST {baseUrl}/tools/search`，**不用 Responses API 的内置 `web_search`** ——
  后者只在 `deepseek-v4-pro` 生效，`deepseek-flash` 下静默忽略（不报错、只是没搜），是最危险的失败方式
- 参数：`need_content: false`（只要 `summary`，官方说 600–800 字本就是给模型读的）、
  `count: 8`（按成功请求计费，count 不影响价格）、`rerank_score ≥ 1.0` 过滤
- `408 / 429 / 5xx` 退避重试三次（官方不给 Retry-After）；返回空数组是**正常结果**，与「搜索失败」要分开
- **手动触发**：答案出来后才有「联网再查一次」。自动搜会花掉用户没注意的额度，
  而且把「我记过的」和「网上抄的」混在一起，边界必须由用户自己划
- 网络资料在 prompt 里单独成段，并明确要求回答里写「网上资料显示…」+ `[W1]` 编号，不能冒充知识库结论

##### 问答记录与上下文（v0.5.0）

- 表 `ask_logs`：`scope` 是 `'all'` 或主题名，存完整 Q-A + 思维链 + 引用卡片 id + 联网结果快照
- 界面是**扁平列表**（不按主题分会话气泡），每条自带时间与主题；列表只显示精简，点开看全文
- **默认不参与检索，也不自动带进上下文**。要带就点「带入本轮」，或「带入最近 3 轮」
- 只允许改**问题**（回答是当时的产物，改了就是伪造记录），可删除

## 7. 导出格式

导出为**单个文件** `fragments-YYYY-MM-DD.md`，内部按天分节：

```markdown
# 碎片导出 · 2026-10-20

共 23 条，覆盖 4 天。

---

## 2026-10-20 周二

- 09:12 报销单还没提交，明天上午弄完 #工作 #财务
- 11:40 老张说 NAS 4 号盘有异响 #设备

---

## 2026-10-19 周一

- 21:30 ……
```

- 标签写成 `#tag`，Obsidian / 任意 Markdown 工具都能识别
- 不做任何专有格式，删掉 App 也读得懂
- **知识库以附录形式追加在同一文件末尾**，按主题分组，每张卡先给要点、再用 `>` 引用给原文：

```markdown
## 知识库

### NAS 维护

#### RAID5 换盘前先确认热备盘位

- 降级后先看存储池状态确认故障盘
- 热备会自动顶上，别急着拔

原文：

> 今天换 NAS 那块盘算是搞明白了一件事……
```

## 8. 界面规范

| 项 | 值 |
|---|---|
| 风格 | 浅色、极简、无渐变无阴影 |
| 主背景 | `#FBFBF9` |
| 卡片 | `#FFFFFF`，0.5px 描边 `#ECECE7` |
| 主文字 | `#1B1B19` |
| 次要文字 | `#6E6E68`，辅助 `#A6A69F` |
| 强调色 | `#185FA5`（蓝） |
| 正文字号 | 15px，行高 1.5 |
| 圆角 | 卡片 12px，按钮 8px，胶囊 999px |

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
用户在设置/知识库/整理页按返回，会直接退出 App 而不是回到主界面。

规则：`route !== 'timeline'` 时吞掉返回键并切回时间轴，只有已经在时间轴时才把返回键交还给系统。
覆盖层（长文输入）的 `BackHandler` 注册得更晚，优先级更高，所以开着覆盖层时先关覆盖层。

## 9. 代码结构与分层

文件级清单（含行数）只在 [HANDOFF.md 第 5 节](./HANDOFF.md) 维护 ——— 那里是给接手的人看的，
这里只说**结构本身**。

```
screens/      五个页面，各自持有本页状态
   ↓
components/   覆盖层与可复用区块（详情页、各类 Sheet、结果条目）
   ↓
ai/  db/      能力层：AI 请求与数据读写
   ↓
util/         纯函数：日期、结果元数据、键盘、提案解析
```

**几条被刻意固定下来的结构决定：**

| 决定 | 原因 |
|---|---|
| **没有全局 store**，`App.tsx` 只有一个 `route` state，数据由 `App` 加载后 props 下发 | 单机五页面的规模，上 Redux/Zustand 只会多一层要同步的状态 |
| **没有导航库** | 同上。页面栈就是一个联合类型的 state |
| **`db/types.ts` 的 `Repo` 接口是唯一契约**，上层只认接口 | 才能让 SQLite 与 localStorage 两个实现互换而不动业务代码 |
| **存储层按平台扩展名分流**，业务代码统一 `import { repo } from '../db/repo'` | Metro 打包时按 `.native.ts` / `.web.ts` 解析；`repo.ts` 只给 tsc 用，运行时不命中 |
| **AI 层不碰数据库**（唯一例外：`ai/config.ts` 读 `settings` 取配置） | 卡片、碎片、待办都由调用方查好传进去，AI 层才能纯函数式地拼 prompt、做收敛 |
| **业务逻辑不写在组件里**：`db/commit.ts` 负责写库、`util/resultItems.ts` 负责元数据 | 三处（渲染 / 勾选状态 / 空结果判定）曾各写一份，加一类输出要改三个地方 |

**一个新增 AI 输出类型的完整改动面**（五处，前两处由 tsc 兜底）：

`types.ts` 的 `OrganizeResult` 加字段 → `util/resultItems.ts` 的 `GROUPS` 补一行 →
`db/commit.ts` 补写入 → `components/ResultSections.tsx` 补渲染 → `ai/prompt.ts` 补 JSON 模板与说明。

## 10. 开发进度

**逐版本的改动、根因与被推翻的判断，全部在 [CHANGELOG.md](./CHANGELOG.md)。** 本节只记当前状态和已知限制。

### 已完成

- [x] 时间轴记录（按日折叠 / 首页搜索 / 长文折叠 / 全屏编辑 / 碎片详情页左右翻页 + 整屏内联编辑）
- [x] DeepSeek 整理：十类输出、多轮追问、重构模式、流式思维链
- [x] 周期总结（日 / 周 / 月）+ 待补清单，小结只此一个写入路径
- [x] 知识库：主题聚合 + 二级方向（含手动分方向）、关键字搜索、问模型（操作提案 / 手动联网 / 思考折叠 / 问答记录）
- [x] 标签筛选：点胶囊只看同类，与搜索叠乘
- [x] 待办：回顾页、完成标记、合并可撤回
- [x] Markdown 导出、AI 配置与连接测试、SQLite 迁移到 v5
- [x] Web 端预览构建（仅供看界面，数据是空的）

### 未完成

- [ ] **通知栏常驻入口**（技术约束见本节末尾）
- [ ] **真机联调**：v0.2.2 之后的每一版都只有 `tsc` + Web 构建验证

### 已知限制

- 知识卡 `body` 直接取原文，长碎片会产生很长的卡。目前可接受（保真优先），若以后觉得碍眼，可加「摘要视图」而不改数据。
- 知识卡正文只读，只能整体移出。想改内容得回原始碎片改，再重新整理。
- Web 端用 localStorage，与 Android 的 SQLite 是两套数据，不能用来验证真实数据流。

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
