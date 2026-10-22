# 碎片 · 需求与设计说明书 (SPEC)

> 本文档是跨会话开发的唯一依据。每完成一个功能，同步更新「开发进度」一节。

最后更新：2026-10-21

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

### 4.1 首版（v1）范围内

- 应用内极简输入（打开即写）
- 长文本承载：输入框自动增高，可一键转全屏编辑；时间轴内超 3 行折叠，点开看全文
- 时间轴流主界面（按日分组、时间戳、整行文本）
- 碎片编辑 / 删除
- AI 整理：分类打标、汇总成日报、提炼待办、关联去重、**沉淀知识卡**（一次调用产出九类，见第 6 节；首版为五类，后四类是 v0.2.2–v0.2.3 陆续加的）
- 整理结果的逐条接受 / 忽略
- **知识库**：按主题聚合，卡片展示 AI 要点，可展开原文，可移出
- 通知栏常驻入口
- Markdown 导出（时间轴 + 知识库附录）
- 设置页：API 配置、数据统计

### 4.2 首版明确不做

桌面小组件 · 语音转文字 · 定时自动整理 · NAS 自动备份 · 多端同步 · 密码锁 · 图片/链接附件 · 全文搜索（数据量小，暂不需要）· 知识卡正文编辑器（v1 只读 + 移出，不做富文本）

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
  type       TEXT    NOT NULL,     -- daily | weekly | theme
  title      TEXT,
  body_md    TEXT    NOT NULL,
  period     TEXT,                 -- 如 2026-10-20
  created_at INTEGER NOT NULL
);

-- 待办
CREATE TABLE todos (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  text               TEXT    NOT NULL,
  due_at             TEXT,        -- YYYY-MM-DD，可空
  done               INTEGER NOT NULL DEFAULT 0,
  source_fragment_id INTEGER,
  created_at         INTEGER NOT NULL
);

-- 键值配置
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

索引：`fragments(created_at DESC)`、`todos(done)`、`knowledge_cards(topic)`。

迁移机制：`PRAGMA user_version` 记录已执行到第几条，`MIGRATIONS` 数组只追加不修改。当前到 v2。

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

【已有主题】NAS 维护、装机

【已有知识卡】（能补充它们就用 card_update，不要重复建同主题的卡）
[3] NAS 维护 | RAID5 换盘前先确认热备盘位

【未完成待办】（本轮碎片表明某条已经做完，就用 todo_done）
[5] 提交报销单 · 2026-10-21
```

三段上下文各自解决一件事：

| 上下文 | 让模型能做什么 |
|---|---|
| 已有主题 | 复用主题名，不长出「NAS」「nas」「群晖」三个同义主题 |
| 已有知识卡 | 用 `card_update` 把新碎片补进老卡，或用 `archive_cards` 归档被取代的旧卡 |
| 未完成待办 | 用 `todo_done` 标掉「已经做完」的，用 `drop_todos` 清掉「本就不该存在」的 |

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

并在开头明确要求它独立判断（`不要因为标签已经存在就照抄`）。重构范围两种：

- **最近整理过**：取最新的 40 条已整理碎片（`REFACTOR_LIMIT`）
- **按主题**：取某主题下全部知识卡的 `source_ids` 反查出来的碎片

### 响应（严格 JSON）

```json
{
  "tags":          [{ "id": 1, "labels": ["工作", "财务"], "project": "报销" }],
  "todos":         [{ "text": "提交报销单", "due": "2026-10-21", "id": 1 }],
  "summary":       { "body_md": "今天 7 条，主要围绕…" },
  "merge":         [{ "keep_id": 3, "drop_ids": [5, 9], "reason": "同一件事" }],
  "knowledge":     [
    {
      "topic": "NAS 维护",
      "title": "RAID5 换盘前先确认热备盘位",
      "gist": "- 降级后先看存储池状态确认故障盘\n- 热备会自动顶上，别急着拔",
      "source_ids": [4]
    }
  ],
  "todo_done":     [{ "todo_id": 5, "reason": "碎片里写了已经交了" }],
  "card_update":   [{ "card_id": 3, "add_source_ids": [7], "title": null, "gist": null, "reason": "同属 RAID 换盘" }],
  "archive_cards": [{ "card_id": 9, "reason": "内容已被新卡完整覆盖" }],
  "drop_todos":    [{ "todo_id": 11, "reason": "和另一条重复" }]
}
```

注意 `knowledge` 里**没有 body 字段**——原文由代码直接从 `source_ids` 对应的碎片拼接，不经过模型。

后四类（`todo_done` / `card_update` / `archive_cards` / `drop_todos`）是 v0.2.2–0.2.3 陆续加的，
共同点是把「旧数据」也纳入一次整理：以前只看新碎片，现在能补老卡、标老待办、清旧卡。

### 流式输出与思考过程（v0.2.4）

**为什么改流式**：原来是 `stream: false`，整理一次只显示一个 spinner 加一句「通常需要 5–15 秒」。
开启思考模式后这个时间会明显变长，用户完全看不到进展，既不知道是不是卡住了，也无从判断 AI 为什么这么归类。
改成流式之后，思维链可以边生成边显示，「看到模型的思考过程」这个需求就落在这里。

**传输格式**：SSE。每行 `data: <json>`，以 `data: [DONE]` 结束。两种 delta：

| 字段 | 内容 | 用途 |
|---|---|---|
| `delta.reasoning_content` | 思维链，模型在给出答案前的推理 | **只显示**，不参与任何解析 |
| `delta.content` | 最终答案，即第 6 节的九类 JSON | 拼完再 `parseJsonLoose` + `normalizeResult` |

**四条硬规矩**：

1. **reasoning 绝不参与 JSON 解析**。它是自然语言推理，混进 `content` 会直接毁掉解析。
   两个缓冲区必须分开累积。
2. **`reasoning_content` 不回传给下一轮**。官方文档明确：请求不带 `tools` 时它会被忽略、也不拼进上下文。
   本项目不用 tool calls，所以多轮追问只回传 `content`（也就是现有的 `raw`）。
3. **UI 更新必须节流**。一个思考过程能吐几百个 chunk，每来一块就 `setState` 会让 JS 线程卡死。
   `OrganizeScreen` 里用 ref 累积 + 120ms 节流上屏，结束时强制 flush 一次。
4. **超时分两段，不是总时长**。建连 90 秒；连上之后每收到一块数据就重置一次空闲计时器（45 秒），
   再加一个 6 分钟的硬上限兜底。**不要沿用原来的 90 秒总时长**，思考模式下正常请求也可能超过它。

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
6. **三类破坏性操作默认不勾选**：`todo_done`（标完成）、`archive_cards`（归档卡）、`drop_todos`（真删待办）。
   它们的共同点是「做完了内容就从列表里消失」，用户很难察觉误操作，必须由用户主动点一下。
7. **归档必须可恢复且有入口**。`archive_cards` 只写 `archived = 1`，知识库页有「已归档」区可以恢复或彻底删除。
   **没有查看入口的归档 = 数据黑洞**，这条在做归档功能时被单独检查过一遍。
8. **互斥保护由代码做**。同一张卡不能既 `card_update` 又 `archive_cards`，同一条待办不能既 `todo_done` 又 `drop_todos`——
   `normalizeResult` 里按「先到先得」丢掉后一个，不指望模型自洽。
9. **用户取消的授权不能被代码绕过**。重构模式下新卡会按「来源碎片重叠 ≥ 50%」自动顶掉旧卡，
   但如果用户明确取消了那张卡的归档建议，替代逻辑也必须跳过它（`declinedArchive`）。
   「操作要用户授权」得由代码保证，不能只在界面上提示一句。
10. **重构不重复抽待办、不重复写小结**。重构的碎片上次整理时已经抽过待办、写过当日小结，
    再抽一遍就是纯重复。`pruneRefactorResult` 在代码层按「文案相同」或「同一碎片已派生过待办」两条判据过滤掉，
    并把 `summary` 置空。

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

主界面结构（从上到下）：

```
┌─────────────────────────┐
│ 碎片              整理 ⚙ │  头部
├─────────────────────────┤
│ 今天 · 10月20日     7 条 │  日期分组（sticky）
│  09:12 │ 报销单还没提交…  │
│  11:40 │ 老张说 NAS…     │
│ 昨天 · 10月19日     3 条 │
│  21:30 │ …              │
├─────────────────────────┤
│ [ 随手记一条…      ] ↑  │  底部输入
└─────────────────────────┘
```

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

## 9. 目录结构

```
fragments/
├── App.tsx                  根组件与页面栈
├── SPEC.md
├── app.json
├── src/
│   ├── theme.ts             颜色/字号/圆角常量
│   ├── types.ts             领域类型
│   ├── util/
│   │   ├── date.ts          日期分组、时间格式化
│   │   └── keyboard.ts      键盘高度 hook（替代失效的 KeyboardAvoidingView）
│   ├── db/
│   │   ├── types.ts         Repo 接口
│   │   ├── repo.native.ts   SQLite 实现
│   │   ├── repo.web.ts      localStorage 实现（仅供桌面预览）
│   │   └── repo.ts          类型回退，勿直接引用逻辑
│   ├── ai/
│   │   ├── prompt.ts        System prompt 与请求体构造
│   │   ├── deepseek.ts      客户端、错误映射、结果收敛
│   │   ├── config.ts        读写 AI 配置
│   │   └── keyStore.ts      API Key 安全存储
│   ├── export/
│   │   └── markdown.ts      按天分节的 Markdown 导出
│   ├── components/
│   │   └── TagPill.tsx      标签胶囊
│   └── screens/
│       ├── TimelineScreen.tsx
│       ├── OrganizeScreen.tsx
│       ├── ReviewScreen.tsx  待办 / 小结回顾
│       ├── KnowledgeScreen.tsx
│       └── SettingsScreen.tsx
├── plugins/
│   ├── withBuildOptimizations.js  构建优化 config plugin
│   └── withNoSplashAnimation.js   启动窗改纯色、去图标动画
```

**平台分流说明**：`import { repo } from '../db/repo'` 在打包时由 Metro 按平台扩展名解析，Android 拿到 `repo.native.ts`（SQLite），Web 拿到 `repo.web.ts`（localStorage）。`repo.ts` 只用于 tsc 类型解析，运行时不会命中。

## 10. 开发进度

- [x] 需求定稿
- [x] Expo 工程骨架（SDK 58 / RN 0.88 / React 19.3）
- [x] SQLite 数据层（迁移 v2：`fragments.nature` + `knowledge_cards`）
- [x] 时间轴主界面与输入（含长文折叠、全屏编辑）
- [x] DeepSeek 接入与整理页（五类输出，段落顺序：待办 → 知识 → 小结 → 分类 → 重复）
- [x] 知识库页（主题聚合 / 卡片要点 / 展开原文 / 移出）
- [x] Markdown 导出（时间轴 + 知识库附录）
- [x] Web 端预览构建通过
- [x] 打包 APK（v0.1.0，`com.local.fragments`，debug 签名，4 个 ABI 共 76MB）
- [x] 体验优化 v0.1.1：冷启动自动聚焦输入框、记完自动滚回顶部、长文折叠阈值 60→100 字
- [x] 回顾页 v0.2.0：待办 + 小结合并一页（tab 切换），补齐 `listTodos` / `listNotes` 的界面出口
- [x] 体积与构建优化 v0.2.0：APK 75.4→21.9 MB，单 ABI + 字体按需导入 + 关 GIF/WebP + Gradle 调优
- [x] 真机问题修复 v0.2.1：启动动画去掉、输入栏被键盘遮挡、长记录页与状态栏重合、长文输入同样被遮挡
- [x] 整理增强 v0.2.2：多轮追问、补充已有知识卡、标记待办完成、返回键收口
- [x] 重构模式 v0.2.3：重新整理已整理碎片并与旧结果对照、归档旧卡（可恢复）、清理重复待办
- [x] 思考过程 v0.2.4：改流式输出，整理时实时显示模型思维链，结果页可回看；模型名迁移到 `deepseek-flash`（旧名已停用）
- [ ] 通知栏常驻入口
- [ ] 真机联调（vivo Y78 / V2278A）—— 部分已开始，v0.2.1 就是首轮真机反馈驱动的

### 整理增强记录（v0.2.2 → v0.2.3）

三条需求，最终收敛成一个模式开关 + 一个追问框。

| 需求 | 落地方式 |
|---|---|
| 对整理结果不满意，想多次提问 | 结果页底部常驻追问输入框，多轮 chat，回传上一轮原始输出 |
| 只处理未整理碎片，新旧无法关联 | 已有知识卡 + 未完成待办**始终**作为上下文 → 能提「补进老卡」「标完成」 |
| 已整理的也要能重新整理，并与原先比对 | **重构模式**：重新过一遍已整理碎片，结果与旧标签/旧知识卡逐条对照 |

**「重构」的准确定义**（这一条最初被理解错了，用户纠正后才定下来）：
重构**不是**「让 AI 重写知识卡正文」，而是**针对原文重新整理**——重新划分标签、重新提炼知识卡，
然后与原先的整理结果做比对，由用户逐项决定保留哪些，可选归档/删除，**但每一步都要用户授权**。

所以重构只输出「建议」，不直接改数据：

| 新增输出 | 作用 | 默认勾选 |
|---|---|---|
| `archive_cards` | 建议归档被取代的旧卡（可恢复） | 否 |
| `drop_todos` | 建议删掉重复/过时的待办（真删除） | 否 |

界面上的对照呈现：
- 标签行在重构模式下多一行「原标签：…」，只在真的变了时才出现
- 新知识卡如果会顶掉某张旧卡，行内直接写「会归档被它取代的旧卡：<旧标题>」

**为什么这样比「整体重写」安全**：模型每次只产出建议，写入是逐条的、可见的、可拒的。
旧卡走 `archived = 1` 而不是 `DELETE`，原文碎片一个字都不动，
与「永不删除用户原文」这条底线不冲突。

### 思考过程与流式改造记录（v0.2.4）

起因：整理时只有一个 spinner 加「通常需要 5–15 秒」，用户既不知道有没有卡住，也看不到 AI 为什么这么归类。
要「看到模型的思考过程」就绕不开流式 —— 非流式必须等整轮结束才拿得到 `reasoning_content`，那就不叫过程了。

三件事绑在一起做，因为它们互相依赖：

| 改动 | 原因 |
|---|---|
| 模型名 `deepseek-chat` → `deepseek-flash` | 旧名 2026-07-24 已永久停用，调不通。两个旧别名本来都指向 V4-Flash，迁过去价格不变 |
| `stream: false` → 流式 + SSE 解析 | 思维链必须边生成边显示 |
| 新增 `thinking` / `reasoning_effort` 配置 | V4 默认就开思考，但要让用户能关掉（更快更省） |

**关键实现点**（踩过才知道）：

1. **RN 自带的 `fetch` 没有 `response.body`**，`getReader()` 直接崩。
   SDK 56 起 Android/iOS 的全局 fetch 已被 `expo/fetch` 接管，但代码里仍**显式 `import { fetch } from 'expo/fetch'`**，
   不依赖「全局恰好是哪个实现」这种环境细节。
2. **`TextDecoder` 必须用 `{ stream: true }`**，否则跨分片的半个中文字符会被解成乱码。
   已用逐字节切片的极端用例验证过。
3. **超时从一个总时长拆成四段**：建连 90s / 首字 120s / 空闲 60s / 硬上限 6 分钟。
   原来那个 90 秒总时长会把正常的长思考直接掐死。
4. **回退只在「拿不到流」时发生**。已经开始收数据再断的不重试 —— 重试等于重复扣一次费。
5. **`reasoning_content` 不进 `raw`**。`raw` 仍是纯正文，追问回传的还是它；
   官方文档明确请求不带 `tools` 时 `reasoning_content` 会被忽略，多传无益。

**已知取舍**：思考模式下 `temperature` 不生效，所以原来用来压稳定性的 `temperature: 0.2` 在开思考时失效。
没有替代手段，只能靠「降低 effort」或「关掉思考」来换速度。这一条写进代码注释，免得后来者以为自己控制住了。

### 真机问题修复记录（v0.2.1）


首轮真机反馈四条，全部是 Android 特有行为，不是写错代码：

| 现象 | 根因 | 处理 |
|---|---|---|
| 启动有动画/闪一下 | 启动窗图标带动画；启动窗白色与页面 `#FBFBF9` 有色差 | `plugins/withNoSplashAnimation.js`：三段底色统一 + 透明图标 |
| 输入栏被输入法整个盖住 | edge-to-edge 下 `adjustResize` 失效，而 `KeyboardAvoidingView` 在 RN 0.88 里计算结果恒为 0 | 新增 `useKeyboardHeight()`，直接给输入区加 `paddingBottom` |
| 长记录页顶部与通知栏重合 | 用了 `Modal`，Dialog 窗口带 `FLAG_LAYOUT_NO_LIMITS`，画到了状态栏下 | 改为同树内的 `position:absolute` 覆盖层 |
| 长文输入同样被遮挡 | 同上，Modal 窗口收不到 Activity 根视图的键盘事件 | 覆盖层 + 同一个 `useKeyboardHeight()` |

顺带修掉：覆盖层需要自己接 `BackHandler`，否则安卓返回键会直接退出 App（Modal 时代由 `onRequestClose` 兜住）。

### 体验优化记录（v0.1.1）

| 改动 | 动机 |
|---|---|
| 冷启动自动聚焦输入框 | 记录工具打开就该能打字，「先点一下输入框」是最大的一步多余摩擦。用模块级 `autoFocusedOnce` 标记，保证只在冷启动聚焦一次，从设置页/知识库返回时不重复弹键盘 |
| 记完自动滚回顶部 | 列表滚在下方时新记的条目在顶部，用户会误以为「记了没生效」。用 `SectionList.scrollToLocation` 延迟 140ms 执行并 try/catch 兜底 |
| 折叠阈值 60 → 100 字 | 60 字在手机上才三行，稍微记详细点就被折起来，触发得太频繁 |

### 已知限制

- 知识卡 `body` 直接取原文，长碎片会产生很长的卡。目前可接受（保真优先），若以后觉得碍眼，可加"摘要视图"而不改数据。
- 知识卡正文只读，只能整体移出。想改内容得回原始碎片改，再重新整理。

### 待办：通知栏入口的实现约束

Expo 托管工作流下无法做通知栏内的「直接输入」（需要原生 `RemoteInput`）。
v1 折中方案：用 `expo-notifications` 发一条 **sticky** 常驻通知，点击后打开 App 并自动聚焦底部输入框。
- 需要装 `expo-notifications` 并加 config plugin
- Android 13+ 运行时申请 `POST_NOTIFICATIONS`，代码里用 `Platform.Version >= 33` 判断
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
