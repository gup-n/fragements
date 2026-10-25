# 交接文档（给下一个模型）

> 写于 2026-10-24，**2026-10-25 重整过结构**：§4 的 500 行变更记录迁到 [CHANGELOG.md](./CHANGELOG.md)，
> 本文只留「现在的状态」和「怎么接着干」。对应版本 **v0.6.1（versionCode 16）**。
>
> **阅读顺序**：本文件（10 分钟）→ [SPEC.md](./SPEC.md) 第 6 节（AI 契约 + 流式 + 总结与问答）
> + 第 8.1 节（Android UI 红线）→ [ROADMAP.md](./ROADMAP.md) 未完成项。
> 想知道「某个设计为什么长这样」，翻 [CHANGELOG.md](./CHANGELOG.md)；`AGENTS.md` 是速查，
> `README.md` 是给人看的门面。

---

## 1. 三十秒速览

一个**个人单机 Android 应用**，叫「碎片」。核心是「碎片化记录 + AI 整理」：
随手记一条 → AI 整理成标签/待办/知识卡 → 用户逐条确认才写库。小结单独走周期总结面板。

| 项 | 值 |
|---|---|
| 路径 | `F:/coding/python/project/Test/fragments` |
| 包名 / 显示名 | `com.local.fragments` / 「碎片」 |
| 版本 | `0.6.1`，`versionCode 16`，`targetSdk 36` / `minSdk 24` |
| 技术栈 | React Native 0.88 + Expo SDK 58 + TypeScript，新架构，**Android 单端** |
| 存储 | expo-sqlite（native）/ localStorage（web 预览），`PRAGMA user_version = 5` |
| AI | DeepSeek `deepseek-flash`（V4.1-Flash），OpenAI 兼容，**流式 SSE** + 思考模式；整理/总结/问答共用 `ai/chat.ts` 请求层 |
| 规模 | 12,217 行 TS/TSX（48 个文件），最大的屏 `TimelineScreen.tsx` 1134 行 |
| 最新 APK | `fragments-v0.6.1.apk`，21.91 MiB（22,975,358 字节），MD5 `b2ff3419d73e7dd75416f80d117fafe1`（`versionCode 16` / `versionName 0.6.1` 已用 aapt2 核对） |
| 单机 / 联网 | **只做单机**。不引账号、后端、云同步。唯一网络请求是用户自己填 Key 的 DeepSeek |

**没有用导航库**。页面栈就是 `App.tsx` 里一个 `route` state（`'timeline' | 'organize' | 'settings' | 'knowledge' | 'review'`）。别引入 Expo Router。

---

## 2. 立刻能跑的命令

```bash
cd F:/coding/python/project/Test/fragments

npm run typecheck                                # tsc --noEmit，改完必跑，当前零错误
npm run build:web                                # 导出到固定的 web-preview/（约 11 秒），验证不崩
```

**项目零自动化测试**，上面两条是唯一的自动检查。没有 lint、没有单测 —— 新加逻辑靠临时断言脚本，
跑完删掉（`npx tsc xxx.ts --outDir .tmp-test` + 手写 `node` 断言，见 CHANGELOG 里 v0.5.0 那段）。

### 界面预览：**不要做**（用户 2026-10-25 明确要求）

用户原话：「不要再开预览了，我要你直接生图而不是 html 的预览，不能生图就不要做预览的步骤」。

所以：**不生成单文件 HTML、不起本地预览服务、不用 `present_files` 打开 `127.0.0.1:8731`**。
`npm run build:web` 只剩一个用途 —— 当作「Web 平台能不能编译通过」的校验，产物 `web-preview/`
不许拿给用户看。UI 改动的唯一验证手段是**用户装 APK 真机反馈**。

> 历史：v0.4.0–v0.6.0 期间一直走 `build:web` + `preview` + `present_files(http://127.0.0.1:8731)`
> 这条路，用户看不到（内置面板里只是个空数据的壳），已作废。

打包 APK（**必须先看第 7 节的坑**）：

```bash
npx expo prebuild --platform android --no-install --no-clean   # --no-clean 不能省
cd android && ./gradlew assembleRelease                        # 增量约 2~3 分钟
```

产物在 `android/app/build/outputs/apk/release/app-release.apk`。

> **用户要求（2026-10-22）：「每次自行打包给我」。** 改完代码不要只给命令、不要让用户自己打，
> 自己跑完 prebuild + gradlew，把 `fragments-v<版本>.apk` 放到根目录并报出大小与 MD5。
> 只改 JS 时 prebuild 可省；改了 `app.json` 的 version/versionCode 就必须 prebuild 才同步进 `build.gradle`。

---

## 3. 项目现在的状态

### 已完成的能力（按模块，不按版本）

| 模块 | 现在能做什么 |
|---|---|
| 记录 | 时间轴流、按日折叠（默认只展开今天）、首页搜索、**点标签 / 事项筛选**、长文折叠、全屏编辑、碎片详情页（左右翻页 + 整屏内联编辑 + 内嵌当天小结） |
| 整理 | 十类输出、多轮追问、重构模式（重新整理原文并与旧结果对照）、流式思维链、破坏性操作默认不勾选 |
| 小结 | 周期总结（日 / 周 / 月）、「N 个周期还没写小结」待补清单、排在时间轴当天最前、详情页里也能看到 |
| 知识库 | 主题聚合 + 二级方向 `subtopic`（**可手动分方向 / 整组改名**）、关键字搜索、问模型（含操作提案 / 手动联网 / 思考折叠 / 问答记录） |
| 待办 | 回顾页、勾选完成、截止日与过期标红、合并可撤回 |
| 底座 | Markdown 导出、AI 配置与连接测试、SQLite 迁移到 v5、双平台存储分流 |

逐个版本的改动、根因与决策在 **[CHANGELOG.md](./CHANGELOG.md)**，本文件不再重复。

### 未完成的功能（只剩一个）

- **通知栏常驻入口** —— SPEC 唯一的未完成功能项。技术约束写在 `SPEC.md` 第 10 节末尾：
  Expo 托管流无法做通知栏内直接输入（需原生 `RemoteInput`）。折中方案是 `expo-notifications` 发 sticky 通知，点击打开 App 并聚焦输入框。
  但**需要装包 + prebuild + 重编**，而且 sticky 通知在进程被杀后的存活能力**必须真机验证，不能只看文档**。

### 从未验证过的事（重要）

**v0.2.2 之后的每一版都只是编译 + Web 构建通过，没有真机验证过。** 六条悬着：

1. **追问会不会塌成增量** —— 模型可能只返回改动项，其余内容凭空消失。prompt 里写死了要求，但模型不一定听话。**这是最大风险点。**
2. `todo_done` / `card_update` / `archive_cards` / `drop_todos` / `merge_todos` 的实际命中率。
   尤其 `merge_todos` 是 v0.3.1 全新加的：模型能不能忍住不乱合并，只能真机看
3. 同一批碎片重构两遍，结果是否稳定（开思考后 `temperature` 不生效，只能靠 effort 档位影响）
4. 周期总结的 Markdown 渲染（`NoteBody` 的嵌套 Text 在长文本 + 折叠下的表现）
5. **`:::action` 块的输出率**（v0.5.0）：模型会不会只在被明确要求时才出提案、会不会把主题名写错。
   写错的会被校验丢掉 —— 表现是「提案一条都没出现」，不是报错。真机上要特意试一次「帮我合并 X 和 Y」
6. **`/v1/tools/search` 的真实返回结构**（v0.5.0）：`ai/search.ts` 的 `normalize` 对键名做了多重兜底
   （`results`/`data`/`items`/`hits`/`web`，`summary`/`snippet`/`content`），
   但没在真机上跑通过一次。第一次点「联网再查一次」时重点看有没有结果出来

报告任何一个版本「可用」之前，请先等用户真机反馈。

---

## 4. 最近做了什么

完整历史在 **[CHANGELOG.md](./CHANGELOG.md)**（每个版本一节，含根因、被推翻的判断、踩过的坑）。
这里只留最近三版的一句话：

| 版本 | 一句话 |
|---|---|
| **v0.6.1** | 真机反馈「方向可分，但不可移除」。移除动作从「输入框留空 + 确定」这个隐藏约定换成面板底部的显式按钮；SQL 清空字段改写成 `NULL` 字面量（`?` 绑 JS null 会静默改 0 行）；空字符串方向归一成 `NULL` |
| **v0.6.0** | 补上两个「做了但用不上」：卡片的二级方向可以手动设了（详情页 / 主题页 / 点小节头三个入口），标签可以点了筛（还带事项）。prompt 里带上已有方向并要求复用 |
| **v0.5.0** | 问答三件：`:::action` 操作提案（勾选才执行）、官方 `/v1/tools/search`（手动触发）、`ask_logs` 独立记录表（migration v5） |
| **v0.4.2** | 详情页三处真机反馈：整屏内联编辑、保存后即时刷新（`detail` 改存 id 序列）、正文下接当天小结 |

**接手时最该知道的三件事**（细节翻 CHANGELOG）：

1. **主题不是实体**，只是 `knowledge_cards.topic` 上的字符串。新建成本为零，所以 AI 天然会给每张卡开新主题。
   解法是 prompt 里带上「已有主题 + 每个主题最多 4 个卡片标题 + 已有方向」，不是靠模型自觉。
2. **`:::action` 围栏的正则必须用字符类**，不能写成非捕获组的 `(?:::{3})` ——
   `(?:` 是非捕获组的括号，紧接冒号时会吃掉一个，结果只认 `::action`。
   表现是「模型给了提案但界面一条都不显示」，零报错。
3. **详情页不能存对象快照**。v0.4.2 的碎片详情页、v0.6.0 的知识卡详情页栽的是同一件事：
   存了进入时那个对象，上层 `reload()` 之后它还是旧的，页面看起来「没变」，得关掉重进。
   一律存 id，内容实时派生，查不到才退回快照。

## 5. 代码地图

```
App.tsx                         304  路由 state + 全局 BackHandler + 数据加载（含 notes / doneIds / 示例数据）
index.ts                          8  registerRootComponent
src/
  types.ts                      308  Fragment / Todo / Note / KnowledgeCard / WebHit / AskLog / AskAction / OrganizeResult（十类，**无 summary**）+ AiConfig
  theme.ts                       52  颜色常量 C、圆角 R、tagColor() 稳定配色
  version.ts                      8  版本号常量（RN 读不到 app.json，发版时和它手工对齐）
  ai/
    config.ts                    35  读 AI 配置（默认值 + repo.getSetting）+ 已停用模型名映射
    keyStore.ts                  37  API Key 存 expo-secure-store（不进 DB、不进导出）
    prompt.ts                   237  SYSTEM_PROMPT（九项）+ buildUserContent（含【已完成待办】）+ buildRefineContent
    chat.ts                     339  ★ 请求层：四段超时 / 流式 / 非流式 / 错误映射 / testConnection（三功能共用）
    deepseek.ts                 332  整理：prompt 组装 + normalizeResult（全部校验都在这）+ organize()
    summarize.ts                226  ★ 周期总结：日/周/月 prompt、材料裁剪（前70%+后30%）、Markdown 清洗
    ask.ts                      282  ★ 知识库问答：关键词打分选卡、预算装填、引用反查、历史与网络资料注入、提案解析入口
    search.ts                   162  ★ DeepSeek 官方 `/v1/tools/search`：退避重试 + 结果收敛（**不要换成内置 web_search**）
    stream.ts                   114  ★ SSE 解析：把 reasoning_content 与 content 分开累积
  db/
    types.ts                    159  Repo 接口（上下层唯一契约）
    repo.native.ts              667  SQLite 实现 + MIGRATIONS 数组（到 v5）
    repo.web.ts                 453  localStorage 实现（仅供桌面预览，功能对齐即可）
    commit.ts                   172  ★ 把用户确认过的整理结果写进库：纯写入、无 UI、返回实际条数
    askCommit.ts                 48  ★ 执行问答里的操作提案（逐条独立事务，一条失败不回滚其他）
    repo.ts                       7  类型转发壳，运行时不会命中
  screens/
    TimelineScreen.tsx         1134  时间轴 + 输入 + 长文折叠 + 全屏编辑 + 小结混排 + 按日折叠 + 搜索
    OrganizeScreen.tsx          827  ★ 状态机 / 两模式 / 追问 / 空闲面板；结果渲染已交出去
    KnowledgeScreen.tsx         594  主题聚合 + 搜索 + 问入口 + 已归档区 + 详情/问答覆盖层
    ReviewScreen.tsx            342  待办与小结算一页（tab）+ 生成总结入口 + 「已合并」撤回区
    SettingsScreen.tsx          411  BaseURL / 模型 / Key / 思考开关与档位 / 连接测试 / 统计
  export/markdown.ts            143  Markdown 导出（时间轴 + 知识库附录）
  util/
    date.ts                     189  日期格式化 + 周期键（ISO 周）/ 区间 / 锚点
    digest.ts                    97  ★ 哪些周期还没写小结（按粒度配额排序）
    resultItems.ts              110  ★ 十类输出的字段元数据表 + 确认 key + 默认勾选策略
    askActions.ts               253  ★ `:::action` 解析 + 校验（真实主题名/卡片 id）+ key + 描述
    keyboard.ts                  39  ★ useKeyboardHeight()，见第 7 节
  components/
    FragmentDetail.tsx          505  ★ 碎片详情页：全屏阅读 + 左右翻页 + **整屏内联编辑** + 当天小结（宽度靠 onLayout 实测）
    IconButton.tsx               95  ★ 圆形图标按钮：36px 触控区、圆底、数字角标
    ScreenHeader.tsx             80  ★ 子页面统一页头：返回圆钮 + 居中标题/副标题 + 右侧动作
    TagPill.tsx                  63  标签胶囊（传 onPress 时变成可点筛选）
    NoteBody.tsx                 79  ★ 小结正文的轻量 Markdown 渲染（标题/列表/段落，不引第三方）
    ReasoningStream.tsx          85  ★ 流式实时面板：转圈 + 秒数 + 思维链滚动 + 字数
    ReasoningCollapse.tsx        59  ★ 答案落地后的「深度思考 N 秒 ›」折叠行（问答用）
    ReasoningTrace.tsx           68  ★ 生成结束后的「模型思考过程」折叠区（整理 / 周期总结用）
    ResultSections.tsx          464  ★ 结果页十类条目 + 逐条勾选
    BacklogCard.tsx              86  ★ 「N 个周期还没写小结」卡片
    SummarySheet.tsx            488  ★ 周期总结：选周期 → 生成 → 预览 → 保存/替换
    KnowledgeDetail.tsx         235  知识卡详情页（归档 / 恢复 / 删除，两次点击确认；顶部那行可改方向）
    TopicSheet.tsx              281  ★ 主题整理：勾一个改名、勾多个合并
    SubtopicSheet.tsx           380  ★ 分方向：勾几张卡统一设方向；底部「移除方向」是独立按钮；点方向小节头进来就是整组改名
    AskSheet.tsx                639  ★ 知识库问答：范围切换 / 回答 / 引用 / 联网 / 提案 / 记录
    AskActions.tsx              220  ★ 改动建议清单：默认一条不勾，勾了才写库
    AskHistory.tsx              283  ★ 问答记录：扁平 Q-A 列表，可展开 / 改问题 / 删除 / 带入本轮
scripts/
  build_web.mjs                  24  ★ 导出 Web 产物到固定的 web-preview/（先删后导）
  preview_server.mjs             69  ★ 本地静态服务，配合 present_files 做内置预览
plugins/
  withBuildOptimizations.js      65  ★ Gradle 优化写回（单 ABI / caching / shrinkResources / JDK）
  withNoSplashAnimation.js      117  ★ 启动窗改纯色、去图标动画
```

**新增一条输出的流程**（v0.3.1 起）：在 `types.ts` 的 `OrganizeResult` 加字段 →
在 `util/resultItems.ts` 的 `GROUPS` 补一行（**漏了编译不过**）→ 在 `db/commit.ts` 补写入 →
在 `components/ResultSections.tsx` 补渲染 → 在 `ai/prompt.ts` 的 JSON 模板和说明里补。五处，前两处由 tsc 兜底。

**平台分流**：`import { repo } from '../db/repo'` 由 Metro 按扩展名解析，Android 拿 `repo.native.ts`，Web 拿 `repo.web.ts`。业务代码不感知实现。
**改存储层必须同时改两个实现**，否则 Web 预览会莫名其妙地挂。

---

## 6. 数据模型与 AI 契约

### 数据表（`src/db/repo.native.ts` 顶部 `MIGRATIONS`）

| 表 | 关键字段 | 备注 |
|---|---|---|
| `fragments` | `content / created_at / source / status / tags(JSON) / project / merged_into / nature` | `nature` 是 v2 加的，AI 判定的内容性质 |
| `knowledge_cards` | `topic / subtopic / title / gist / body / source_ids(JSON) / archived` | **`body` 永远是碎片原文拼接，不采信模型** |
| `todos` | `text / due_at / done / source_fragment_id / merged_into` | `merged_into` 非空 = 被合并隐藏（v3 加的，可撤回）；`deleteTodo` 是**真 DELETE** |
| `notes` | `type / title / body_md / period` | 小结。`(type, period)` 由 `upsertNote` 保证唯一 |
| `organize_runs` | `fragment_ids(JSON) / result_json / applied` | 每次 AI 调用的原始输出，用于排错 |
| `ask_logs` | `scope / question / answer / reasoning / cited_ids(JSON) / web_json(JSON)` | v5 加的。问答记录**独立成表**，不混进 `knowledge_cards`；`scope` 是 `'all'` 或主题名 |
| `settings` | `key / value` | API Key **不在这里**，在 secure-store |

迁移规则：**`MIGRATIONS` 数组只追加，永不修改已发布条目**，`PRAGMA user_version` 是游标。
加字段就往数组末尾 push 一段，别动前面的。

### 十类 AI 输出

```json
{
  "tags":          [{ "id": 1, "labels": ["工作"], "project": "报销" }],
  "todos":         [{ "text": "提交报销单", "due": "2026-10-21", "id": 1 }],
  "merge":         [{ "keep_id": 3, "drop_ids": [5], "reason": "同一件事" }],
  "knowledge":     [{ "topic": "NAS 维护", "subtopic": "换盘", "title": "…", "gist": "- …", "source_ids": [4] }],
  "todo_done":     [{ "todo_id": 2, "reason": "…" }],
  "card_update":   [{ "card_id": 4, "add_source_ids": [12], "title": null, "gist": null, "reason": "…" }],
  "archive_cards": [{ "card_id": 7, "reason": "…" }],
  "drop_todos":    [{ "todo_id": 6, "reason": "…" }],
  "merge_todos":   [{ "keep_id": 6, "drop_ids": [9, 14], "text": "把报销单交了", "reason": "…" }],
  "merge_topics":  [{ "from": ["工具", "资讯"], "to": "AI", "reason": "…" }]
}
```

`knowledge` 里**没有 `body` 字段**，原文由代码从 `source_ids` 拼接。
**没有 `summary`** —— v0.3.1 移除了，小结只能由周期总结面板产出。别「顺手加回来」，
那正是「生成了两次小结」这个 bug 的来源。

### 多轮追问

`system → user(碎片上下文) → assistant(上一轮**原始输出**) → user(追问)`。三条硬规矩：

1. 回传的是 `organize()` 返回的 `raw` 字符串，**不是**收敛后的对象（收敛会丢模型原话）
2. prompt 里必须要求「输出**完整结果**而非增量」（`buildRefineContent` 已写死）
3. 确认状态按**内容**做 key（`K.todo/K.knowledge/K.tag/...`），绝不按数组下标——追问会重排

---

## 7. 踩过的坑（省你几个小时）

### 7.1 构建

| 坑 | 真相 |
|---|---|
| `npx expo prebuild` 不加 `--no-clean` | 会尝试**删除整个 `android/`**，本机安全删除超时；一旦成功就连 `android/app/.cxx`（12 MB CMake 缓存）一起没，下次 **45 分钟**全量重编。**一律加 `--no-clean`** |
| 手动改 `android/` | 该目录在 `.gitignore` 里，是 prebuild 生成物。所有 Gradle 属性改 `plugins/withBuildOptimizations.js`，否则重跑 prebuild 全丢、APK 弹回 76 MB |
| 版本号 | `app.json` 的 `version`/`versionCode` **和** `android/app/build.gradle` 的 `versionName`/`versionCode` 两处都要对。改 `app.json` 后必须重跑 prebuild 才生效 |
| JDK 路径 | **`D:\Program Files\Java\jdk-21`**（在 D 盘！写 C 盘会报 JAVA_HOME invalid）。Git Bash 下 `./gradlew` 靠 PATH 里的 java 即可，不必设 JAVA_HOME |
| `dist` 目录 | 覆盖已存在的 dist 会被安全删除策略拦截，`--output-dir` 换新名字。`.gitignore` 已含 `dist-*/` |

### 7.2 Android UI（三条红线，edge-to-edge 在 targetSdk 36 下是强制的）

1. **键盘遮挡**用 `useKeyboardHeight()`（`src/util/keyboard.ts`）加 `paddingBottom`。
   **`KeyboardAvoidingView` 在 RN 0.88 + edge-to-edge 下算出的位移恒为 0** ——
   它用 `frame.y + frame.height - keyboardY`，而 `keyboardY` 等于可视区底边（= 屏幕底），结果恒负 → `Math.max(...,0)` → 0。
   `Keyboard` 事件的 `endCoordinates.height` 是 `imeInsets.bottom - barInsets.bottom`，正好等于安全区预留后还需抬升的距离。
2. **全屏页/弹层用 `position:absolute` 覆盖层，不要用 `Modal`**。RN Modal 是独立 Dialog 窗口，带 `FLAG_LAYOUT_NO_LIMITS`，会画到状态栏底下，而且收不到 Activity 根视图的键盘事件。
3. **覆盖层要自己接 `BackHandler`**，否则安卓返回键直接退出 App。
   另外 `App.tsx` 有全局 handler：`route !== 'timeline'` 时回时间轴。RN 的 BackHandler 是**后进先出**，所以覆盖层的 handler 会先触发。
4. 启动窗 / `AppTheme.windowBackground` / 页面底色三者必须同色（`#FBFBF9`），否则闪白。

### 7.3 本机环境

- Node 用托管版 `C:/Users/14428/.workbuddy/binaries/node/versions/22.22.2-6`
- npm 源用 `https://registry.npmmirror.com`（官方源元数据请求要 17 s 以上）
- Android SDK `C:\Users\14428\AppData\Local\Android\Sdk`，platforms `android-36`，build-tools `35.0.0 / 36.0.0`
- `adb` 不在 PATH，用 `%ANDROID_HOME%\platform-tools\adb.exe` 全路径
- **没有模拟器、没有 AVD → 只能真机**（vivo Y78 / V2278A）
- 无头浏览器截图（Edge/Chrome `--screenshot`）在本机被策略拦截，零输出，**放弃自动截图**。想给人看界面就 `expo export -p web` 起静态服务
- 本环境的 grep 带 `--color:always`，ANSI 转义码会插进匹配结果，`grep -c "key: 'xxx'"` 会假 0。用不带引号的关键字统计

### 7.4 流式与思考过程（v0.2.4 新踩的）

| 坑 | 真相 |
|---|---|
| 用 RN 自带的 `fetch` 读流 | 它的 `response.body` **永远是 null**，`getReader()` 直接崩。必须 `import { fetch } from 'expo/fetch'`（SDK 58 的全局 fetch 其实已经是它，但别赌环境） |
| `TextDecoder` 不带 `{ stream: true }` | 一个中文字符被网络分片切成两半时，前半个会解成乱码。逐字节硬切能复现 |
| 沿用原来那个 90 秒总时长 | 思考模式下正常请求就可能超过 90 秒，会被误杀。要拆成建连/首字/空闲/硬上限四段 |
| 把 `reasoning_content` 拼进 `content` | 思维链是自然语言，混进去 JSON 必定解析失败。两个缓冲区必须分开 |
| 每个 chunk 都 `setState` | 几百次 setState 会把 JS 线程占满，界面卡住。必须节流（现在是 120ms） |
| 以为 `temperature: 0.2` 还在起作用 | 思考模式下这个参数被忽略（不报错，就是不生效）。代码只在非思考时传 |
| 以为 `deepseek-chat` 还能用 | 已于 2026-07-24 停用。`deepseek-flash` 才是现在的名字，同价 |

**已经验证过的**：`readChatStream` 在 1 字节一片的极端分片下仍能正确分离思维链与正文、正确拼回中文；
没有 `body` 时会抛 `NoStreamError` 让上层回退到非流式。`expo/fetch` 在 web 打包里也能正常解析（`expo export -p web` 通过）。

### 7.5 v0.3.0 新踩的

| 坑 | 真相 |
|---|---|
| 给 Markdown 输出留着 `json_object` | 模型会把整篇 Markdown 塞进一个 JSON 字符串，换行全变 `\n`，时间轴上糊成一行。纯文本功能必须 `json: false` |
| 用 `listFragments(500)` 取一个月的碎片 | 静默丢数据：超过 500 条就只拿到最近的，月初的记录消失且**不报错**。必须用区间的 `listFragmentsBetween` |
| 以为 `StyleSheet.absoluteFillObject` 还在 | 这个版本的 RN 类型里只有 `absoluteFill`。直接用 `position:'absolute'` + 四个 0，别跟类型较劲 |
| `useRef<ScrollView>` 想调 `scrollToEnd` | 泛型参数要的是**实例类型**：`import type { ScrollViewInstance } from 'react-native'`，不是 `ScrollView` 组件本身 |
| 知识库的 BackHandler 没有依赖数组 | 每次渲染都重新注册 → 永远排在监听器栈顶。所以它必须先判断「有没有覆盖层开着」并 `return false` 让位，否则详情页按返回直接跳回时间轴 |
| 用一次 Edit 替换跨两个函数的整段代码 | 锚点范围没核对，把 `organize()` 的请求调用和残留代码一起切掉了，编译才发现。**大段替换前后各读一次文件**，别只看 new_string |

### 7.6 v0.3.1 新踩的

| 坑 | 真相 |
|---|---|
| 判断「这个周期写过小结了吗」用 `listNotes(200)` 再自己 `find` | 笔记超过 200 条就会漏掉更早的那条，于是同一天又插一条 —— **这就是「生成两次小结」的真正来源之一**。必须用 `repo.findNote(type, period)` 让数据库去查 |
| 小结的写入路径有两处 | 整理结果页 + 周期总结面板。两条路径各写各的，就必须有 `upsertNote` 兜住「同一周期只能有一条」。更彻底的解法是砍掉一条路径（v0.3.1 砍了整理那条） |
| 「应用 N 项」直接用勾选数 | 勾了不等于写了：`card_update` 要补的原文可能全在卡里，`merge_todos` 可能只有自己。`commitResult` 返回真实写入条数，界面报它 |
| 依赖 `async` 里 `setState` 去防连点 | `setSaving(true)` 有延迟，同一帧内第二次点击拦不住。用 `useRef` 做锁 |
| 加一类输出时只改渲染 | `allKeys` / `withFreshOff` / 空结果判断三处也得改，漏一处就是「新类型默认被勾上」或者「明明有结果却显示 AI 说不用处理」。v0.3.1 把它变成了表驱动 + 编译期检查 |
| `stats().todoOpen` 忘了排除已合并 | `done = 0 AND merged_into IS NULL` 两个条件都要。少了后半个，合并越多首页数字越虚高 |
| 删除「被合并到的那条」只把别人的 `merged_into` 置空 | `status` 还留着 `merged`，那些碎片既不在时间轴（时间轴看 `mergedInto`）也不进整理池（整理池看 `status`）—— 静默消失。要一起落回 `inbox` |
| 月度/周度周期末端比日靠后 | 纯按时间倒序排「待补小结」会让月总结把日小结全挤掉。按粒度配额才是对的 |

### 7.7 根目录哪些东西是可以重新生成的

已全部 gitignore，删掉不影响代码：

| 路径 | 谁生成的 | 能不能删 |
|---|---|---|
| `web-preview/` | `npm run build:web` | 能，重跑就有 |
| `dist*/`（历史导出目录） | 早期 `expo export --output-dir` | 能，已清空 |
| `*.log`（`build-v*.log` / `prebuild*.log`） | 打包与 prebuild | 能，排错时才需要看 |
| `fragments-v*.apk` | `gradlew assembleRelease` 后复制的产物 | 能，但**留着当回退包**（见第 1 节） |
| `android/` `node_modules/` | prebuild / npm | 能删，但重装代价大（`android/` 删了要重编 45 分钟） |

---

## 8. 不可违反的约定（改任何东西之前先看）

1. **只做单机**。不引账号、后端、云同步。任何需要服务器的方案**先问用户**。
2. **AI 只出建议**。整理结果必须经用户逐条确认才写库，绝不自动改数据。
3. **永不删除用户原文**。去重只写 `merged_into`，原文保留并置灰。归档只写 `archived=1`。
4. **数据必须可迁出**。Markdown 导出是底线能力，任何新字段都要考虑导出时怎么表示。
5. **原文保真由代码保证**。知识卡 `body` 一律用碎片原文拼接，不采信模型输出。这条不能寄希望于模型听话。
6. **会「让内容消失」的操作必须默认不勾选，且必须有查看入口**。历史上栽过两次（待办/小结无出口、归档卡无入口）。
   现在有三类：`archive_cards` / `drop_todos` / `merge_todos`，登记在 `util/resultItems.ts` 的 `GROUPS` 表里。
7. **改功能先改 `SPEC.md` 再改代码**。文档是这个项目唯一的设计依据，代码可以重写，文档不能落后。
8. **思维链只用于展示，永远不参与解析**。`reasoning_content` 进的是 UI，`content` 进的是 `parseJsonLoose`；
   `raw` 只存正文，多轮追问回传的也只有它。
9. **总结与问答不动数据**。周期总结只写 `notes` 表，问答结果**不落库**。
   这两个功能不像整理那样会改碎片状态，所以可以跑得比整理更「自动」——但也仅限这两个。
10. **模型名只认 `deepseek-flash` 或 `deepseek-v4-pro`**。`deepseek-chat` / `deepseek-reasoner` 已停用，
   别在任何新代码、新文档、示例里再写这两个名字（`RETIRED_MODELS` 里那份迁移映射除外）。
11. **小结只有一个写入路径**。整理流程不产出小结（v0.3.1 砍掉的），只能由 `SummarySheet` 写，
    并且一律走 `repo.upsertNote`。任何「顺手在这里也写一条摘要」的改动都会重新打开「同一天两条小结」这个坑。
12. **「这个周期写过没有」必须用 `repo.findNote`**，不要拿 `listNotes(n)` 自己筛 —— 数据一多就静默漏。

---

## 9. 下一步建议（按优先级）

### P0 — 装机，按顺序验证

`fragments-v0.6.0.apk` 已经打好放在项目根目录（`versionCode 15`，大小与 MD5 见第 1 节速览）。

```bash
adb install -r fragments-v0.6.1.apk        # adb 在 %ANDROID_HOME%\platform-tools\，不在 PATH
```

> 签名是 debug key。若报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，说明签名对不上，得先卸载旧版 ——
> **卸载会清掉所有本地数据，先「导出 Markdown」**。

装完按这个顺序验（**前五条是 v0.4.2 / v0.5.0 新增的，从来没在真机上跑过**）：

1. **碎片详情页**：点一条长记录 → 整屏阅读 → 右上「编辑」应该是**这一页直接变成输入框**（不是中间弹窗），
   字号行高与阅读时一致 → 改完保存 → **当场就能看到新内容** → 关掉重进还在
2. **详情页里的小结**：正文下方应该有一张「当天小结」卡片；那一天没写小结时不显示
3. **问答的操作提案**：知识库 → 问「帮我看看工具和资讯这两个主题该不该合并」→
   回答下面应该出现「改动建议」区，**默认一条都不勾**；勾一条 → 执行 → 知识库立刻刷新
4. **联网**：问一个卡片里没有答案的问题 → 回答下方出现「联网再查一次」→ 点了才去搜，
   结果列成 `[W1]` 来源，并写明是「网上资料」
5. **问答记录**：右上角时钟图标 → 扁平 Q-A 列表 → 能改问题、能删、能「带入本轮」
6. **手动分方向**：知识库 → 进一个主题 → 右上分层图标 → 勾两三张卡 → 填「换盘」→ 设定 →
   **页面应该立刻分成「换盘」和「未分方向」两组**；返回主题列表，那个主题后面应该出现「1 个方向」
7. **整组改名**：点「换盘」那个小节头 → 方向名已填好 → 改成别的 → 设定 → 组名跟着变
8. **移除方向（v0.6.1 重点，上一版报过 bug）**：再点「换盘」小节头 → 底部左侧那个描边的
   **「移除方向」**按钮 → 那几张卡应该回到「未分方向」，整组消失，**卡片一张都不能少**；
   单个卡片也可以：进卡片详情 → 点顶部 `主题 › 方向 ✎` → 移除方向 → 回来应该显示「未分方向」
9. **标签筛选**：时间轴上点一个标签胶囊 → 只剩同类，**原先折叠的日期自动展开** →
   搜索框下面出现一个蓝底胶囊，点它取消；再点同一个标签也能取消
10. **老功能回归**：整理 → 应用 → 时间轴上小结仍排当天最前；知识库主题内二级方向分组只在多方向时出现

### P0 — 然后才是 v0.2.2 / v0.2.3 遗留的三问

这三问一直没真机验证过，现在又多了一层「开思考」的变量：

1. 追问后模型是否输出完整结果（**最大风险点**，模型可能只返回改动项）
2. 重构时归档/删待办是否过于激进
3. 同一批碎片重构两遍结果是否稳定 —— **注意：开思考后 `temperature` 不生效了，稳定性只能靠 effort 档位间接影响**

**在拿到这一轮反馈之前不要再叠新功能**，否则问题会混在一起分不清是谁的。

### P1 — 通知栏常驻入口

SPEC 唯一未完成功能项。做法与约束见 `SPEC.md` 第 10 节末尾和 `ROADMAP.md` P1-4。
成本：装 `expo-notifications` + prebuild（会重置 gradle.properties，但 config plugin 会自动回填）+ 重编，20~45 分钟。

### P2 — 更新分发

用户痛点是「每次改完要插线装 APK」。三档方案已调研完写在 `ROADMAP.md` P1-5，
**用户当时跳过了方案选择**，别反复追问，等他主动提。

| 方案 | 改 JS 后要不要装 APK | 前置条件 |
|---|---|---|
| 无线 adb | 要 | 手机与电脑同网（校园网 AP 隔离会挡，需手机热点） |
| GitHub Release + 应用内查更新 | 要 | public 仓库（private 无法查更新，token 不能进 APK） |
| EAS Update（OTA） | **不要** | 免费 Expo 账号；但**改不了原生代码**，加原生模块仍需重装 |

### P2 — 应用最终名称

「碎片」是占位名，用户一直没定。改动成本不低（包名 `com.local.fragments` 也在里面），要动提前问清楚。

### P3 — 其他候选

点标签筛选 / 全文搜索（碎片量大后的检索需求）。见 `ROADMAP.md` P2。

---

## 10. 我犯过、你别再犯的错

| 错误 | 教训 |
|---|---|
| 把「重构」理解成「重写知识卡正文」并主动砍掉 | 用户提功能名时，别用自己的技术直觉替换语义。**有歧义先问一句**，别急着下「不做」的结论 |
| 做归档功能时差点没补查看入口 | 新增「让内容消失」的字段时，**同时**做查看/恢复入口，否则就是数据黑洞 |
| 最初只想靠 prompt 让模型别自相矛盾 | 模型不可信的部分**必须用代码兜底**（互斥、去重、降噪），prompt 只是提高概率 |
| 用数组下标做确认状态 key | 追问会重排条目，用户取消的勾选会落到别的内容上。**用内容做 key** |
| `grep -c "key: 'xxx'"` 假 0 | 本环境 grep 带颜色，ANSI 插在中间。用不带引号的关键词 |
| 一次 Edit 跨两个函数替换，锚点没核对 | 把 `organize()` 的请求调用连同残留代码一起切掉，编译才报错。**大段替换前后各读一次文件** |
| 上一轮交付时文档滞后了 6 处 | 用户会对着代码读文档。**版本号、页面数、功能清单这类东西每次发版都要扫一遍全文**，别只改自己改过的那段 |
| 同一件事有两个入口就必然有两个 bug | 「生成两次小结」的根因不是去重没写好，是**两条写入路径**。遇到「重复数据」先问「是不是有两条路能写进来」，而不是先加去重 |
| 用 `listNotes(N)` 当作「查一条」 | 带 limit 的列表查询不能当精确查找用，数据一多就静默失败。要精确就用精确的接口 |

---

## 11. 一句话交接

**能跑、能装、代码干净、文档齐全。功能上只差通知栏入口。**
v0.6.0 补的是两处「做了但用不上」——手动分方向、标签筛选，都是纯本地改动，没有新的 AI 调用。
但和 v0.2.2 之后的每版一样，**只有 `tsc` + Web 构建验证，没有真机验证** ——
第 9 节那九条悬着的事，先等用户反馈，别急着加需要 AI 参与的新功能。

历史为什么长这样，翻 [CHANGELOG.md](./CHANGELOG.md)。
