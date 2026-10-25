# 给 AI 助手的速查

**先读 [`HANDOFF.md`](./HANDOFF.md)** —— 那是完整的项目交接文档（状态、代码地图、踩过的坑、下一步）。
本文件只放「读代码时立刻会踩的雷」。

---

## 这个项目不是标准的 Expo 模板

模板自带的这份 AGENTS.md 让用 Expo Router，**本项目没有用**。页面栈是 `App.tsx` 里一个 `route` state：

```ts
type Route = 'timeline' | 'organize' | 'settings' | 'knowledge' | 'review';
```

没有 `src/app/`、没有 `_layout.tsx`、没有 `expo-router` 依赖。**不要引入。**

## 命令

```bash
npx tsc --noEmit                                  # 改完必跑，当前零错误
npm run build:web                                 # 导出到 web-preview/，**只当编译校验，不许给用户看**
npx expo install <pkg>                            # 装依赖用它，别用 npm install

npx expo prebuild --platform android --no-install --no-clean   # --no-clean 不能省！
cd android && ./gradlew assembleRelease
```

项目**零自动化测试**，`tsc` + `export` 是唯一的自动检查。

## 给用户看界面：**不做预览**（用户 2026-10-25 明确要求）

用户原话：「不要再开预览了，我要你直接生图而不是 html 的预览，不能生图就不要做预览的步骤」。

所以：**不生成单文件 HTML、不起本地预览服务、不用 `present_files` 打开网页**。
`npm run build:web` 只剩「Web 平台能不能编译通过」这一个用途，产物不许拿给用户看。
**UI 改动的唯一验证手段是用户装 APK 真机反馈。**

> 历史：v0.4.0–v0.6.2 期间走过 `build:web` + `preview` + `present_files(http://127.0.0.1:8731)`，
> 用户根本看不到（内置面板里只是个空数据的壳），这条路作废。

## 改完必须自己打包

用户要求（2026-10-22 明确交代：「每次自行打包给我」）：**每次改完代码，自己把 APK 打出来，不要把命令丢给用户自己跑。**

```bash
cd F:/coding/python/project/Test/fragments
npx expo prebuild --platform android --no-install --no-clean   # app.json 改了才需要
cd android && unset JAVA_HOME && export ANDROID_HOME="C:/Users/14428/AppData/Local/Android/Sdk"
./gradlew assembleRelease --console=plain > build-vXXX.log 2>&1   # 别管道给 tail，会缓冲看不到进度
```

产物在 `android/app/build/outputs/apk/release/app-release.apk`，
复制成 `fragments-v<版本>.apk` 放项目根目录，把大小和 MD5 一并报给用户。增量约 2–3 分钟。

## 八条硬规矩

1. **`prebuild` 必须加 `--no-clean`**。不加会尝试删除整个 `android/`，连 12 MB 的 CMake 缓存一起没，下次编译 45 分钟。
2. **不要手改 `android/`**。它是 `.gitignore` 里的 prebuild 生成物。Gradle 属性改 `plugins/withBuildOptimizations.js`。
3. **不要用 `KeyboardAvoidingView`**。RN 0.88 + edge-to-edge 下算出的位移恒为 0。用 `useKeyboardHeight()`（`src/util/keyboard.ts`）加 `paddingBottom`。
4. **不要用 `Modal`**。它带 `FLAG_LAYOUT_NO_LIMITS`，会画到状态栏下且收不到键盘事件。用 `position:absolute` 覆盖层 + 自己的 `BackHandler`。
5. **存储层改一处要改两处**。`repo.native.ts`（SQLite）和 `repo.web.ts`（localStorage）都要动，否则 Web 预览会挂。
6. **改功能先改 `SPEC.md`**。文档是唯一设计依据。
7. **主题不是实体**，只是 `knowledge_cards.topic` 上的一个字符串。改主题名要批量 `UPDATE`（`repo.retopicCards`），
   别去找 `topics` 表 —— 没有那张表。二级方向同理，是 `subtopic` 列而不是外键。
   因为新建主题的成本为零，prompt 里必须把「大方向一致就复用已有主题」写死，否则模型会给每张卡开一个新主题。
8. **全屏详情的「正在看哪一个」只能存 id，不能存对象快照**。存对象的话上层刷新后它还是旧的，
   页面看起来「没变」，得关掉重进。碎片详情页（v0.4.2）、知识卡详情页（v0.6.0）各栽过一次。
   正确做法：存 `id` / `ids[]`，内容用 `useMemo` 从当前 props 里实时查，查不到才退回快照
   （从问答里点开的卡可能不在当前列表范围内）。

## 最容易搞错的概念

- **「重构」= 针对原文重新整理**（重新判标签、重新提炼知识卡），再与旧结果比对、由用户逐项授权。
  **不是**「让 AI 重写知识卡正文」。
- **`knowledge` 的 `body` 字段永远由代码从 `source_ids` 拼接原文**，不采信模型输出。
- **「会让内容消失」的三类操作（归档卡 / 删待办 / 合并待办）默认不勾选**，且用户取消的授权代码层面也不能绕过。
  `todo_done`（标完成待办）从 v0.3.0 起**默认勾选** —— 用户要求「做完的自动标掉」，且标完成不丢内容。
  这三类登记在 `src/util/resultItems.ts` 的 `GROUPS` 表里，别在渲染代码里另写一份。
- **整理不产出小结**（v0.3.1 起）。小结只能由 `SummarySheet` 写，且必须走 `repo.upsertNote`。
  判断「这个周期写过没有」用 `repo.findNote`，不要拿 `listNotes(n)` 自己筛 —— 数据一多就静默漏。
- **周期总结 ≠ 重构**。总结只写 `notes` 表、不动碎片；重构是重新整理原文并与旧结果对照。

## 流式与思考过程（v0.2.4）

- **读流必须用 `import { fetch } from 'expo/fetch'`**。RN 自带的 fetch 没有 `response.body`。
- **`TextDecoder` 必须 `{ stream: true }`**，否则跨分片的中文会解成乱码。
- **`delta.reasoning_content`（思维链）只上屏，`delta.content`（JSON）才进解析**。两者绝不能拼进同一个缓冲区。
- **超时是四段**（建连 90s / 首字 120s / 空闲 60s / 硬上限 12min），不要改回单一总时长。
  硬上限是 12 分钟而不是 6 —— 输出额度 64K 之后，正常生成本来就要十几分钟。
- **UI 更新要节流**（120ms），否则几百个 chunk 的 setState 会卡死。
- **模型名**：只能用 `deepseek-flash` / `deepseek-v4-pro`。`deepseek-chat`、`deepseek-reasoner` **已于 2026-07-24 停用**，
  调不通。别在示例或文档里再写这两个旧名字。

## 输出额度与 `finish_reason`（v0.6.3）

- **`max_tokens` 同时限制「思考链 + 正文」，不是只管正文。** 老版 `deepseek-reasoner` 的规则是
  「思维链另算」，V4 系列已经改成单次输出总长度。代码注释里曾经写着「思考链不计入这个额度」，
  照着那行注释设了 8000，结果思考一长正文就一个字都出不来，界面上表现为
  **「思考到一半突然停住 + 模型没有返回内容」**。现在官方额度（64K）照抄，第三方 clamp 到 8K。
- **`finish_reason` 必须读，而且要在读 `delta` 之前读。** 它挂在最后一个 chunk 上，
  而那个 chunk 的 `delta` 是空对象 `{}` —— 任何「先看 delta，没内容就 return」的写法都会漏掉它。
- **空结果要按原因分开报**：`length` = 撞额度（重试没用，得调小思考强度或拆批次），
  `insufficient_system_resource` = 对方资源不足（过一会儿再试）。两者报同一句
  「模型没有返回内容」的话，用户只会反复重试同一个必然失败的操作。
- **正文非空但 `finishReason === 'length'` 更危险**：JSON 一定是残的。
  `organize` 必须在 `parseJsonLoose` **之前**拦下来，否则会误导成「不是合法 JSON，再试一次就好」。
- 参数语义（尤其是「看起来没变」的）**必须回官方文档核对**，不能凭记忆、也不能信旧注释。

## 思考强度与单批装载量（v0.6.4）

- **`reasoning_effort: high` 不是「想久一点」，是加压指令。** 官方实现是在 prompt 最前面插一段
  「Absolute maximum, no shortcuts permitted…穷举所有边界情况、写出每个被否决的假设」。
  对「打标签 / 抽待办」这种机械抽取纯属浪费，思考链能从 3K 涨到 15K，而额度是思考链和正文共用的。
  所以 `deepseek.ts` 的 `pickEffort` 会分档：**首轮且 ≤15 条用 `low`**，重构 / 追问 / 碎片多时用 `high`。
  `low` 不等于关闭思考 —— 官方 low = **不加任何前缀**。
- **`RequestOptions.effort` 只能对官方接口生效。** `buildBody` 里那两行在 `if (native)` 里面，
  第三方网关根本不收 `reasoning_effort`，所以对它们「调低思考」无效，撞额度时只能建议换回官方地址。
- **单批上限有两道**（`util/batch.ts` 的 `packFragments`）：条数（整理 30 / 重构 20）与
  字数（12,000 / 16,000 字）。**装箱必须至少收一条**，否则一条超长碎片会让批次永远为空，
  那个用户就永远整理不了它。
- **砍条数不是为了省 token。** 每轮都要重发 system + 全量清单，输入 token 反而上升。
  买的是「单轮峰值只占额度 8%」和「失败只废一轮」。跟用户解释时别把它说成省钱。

## 分批游标与去重（v0.6.5）

- **凡是有「继续处理下一批」的地方，必须有游标，而且要验证第二次的输入变了没有。**
  v0.6.4 加了「继续整理剩下的 N 条」，但批次永远从池子头部装填：
  重构**不改变碎片状态**（它们本来就 `tagged`），池子一个字都没变，点多少次都是同一批。
  现在两层兜底：`util/batch.ts` 的 `pendingOnly(pool, doneIds)` + `commitResult({ batchFragmentIds })`
  把整批标成 `tagged`。
- **`commitResult` 的 `batchFragmentIds` 不能省。** 只标「AI 给了标签且用户勾选」的那几条时，
  模型没抽到标签的仍留在 inbox，下一批又从 inbox 头部取，于是还是它们打头。
  标 `tagged` 只表示「不再算未读」，内容一个字都不动。
- **降噪要覆盖这个流程所有会新增的东西，不是想到哪类做哪类。**
  `pruneRefactorResult` 曾经只过滤重复待办、不管知识卡，于是重构几次之后知识库里全是近义标题的孪生卡。
  现在统一在 `util/dedupe.ts` 的 `pruneResult` 里做，判据三条（同主题前提下）：
  标题归一化后相同 / 短标题被长标题完整包含且 ≥6 字 / 来源碎片 Jaccard ≥ 0.7。
  **重复的不删内容**：跟已有卡重复的转成 `card_update` 补来源，跟同批重复的合并 `source_ids`。
- **6 字门槛不能去掉。** 否则「换盘」会把整个主题下的卡都吃掉。
- **`pruneResult` 里 `existing` 数组的下标必须和 `opts.cards` 对齐**，
  所以新卡**不能**往里 push —— 同批重复交给 `knowledge` 那条判据，否则会取到 `undefined`。

## 三个 AI 功能的分工（v0.3.0）

请求层统一在 `src/ai/chat.ts`（`requestChat(config, messages, onProgress, options)`），
四段超时、流式回退、错误映射都在那里。**新加 AI 功能不要自己写 fetch。**

| 功能 | 文件 | 输出 | `json` 选项 |
|---|---|---|---|
| 整理 | `ai/deepseek.ts` | 十类 JSON | `true`（默认） |
| 周期总结 | `ai/summarize.ts` | Markdown | **`false`** |
| 知识库问答 | `ai/ask.ts` | Markdown | **`false`** |

- **`json: false` 不能省**。开着 `response_format: json_object` 时模型会把整篇 Markdown 塞进 JSON 字符串，
  换行变 `\n`，界面上糊成一行。
- **取一段时间的碎片用 `repo.listFragmentsBetween(from, to)`**（半开区间），不要用 `listFragments(limit)` 再过滤 ——
  超过 limit 会静默丢掉最早的记录。
- 小结正文用 `<NoteBody>` 渲染（标题 / 列表 / 段落），不要直接把 `bodyMd` 丢进 `<Text>`。

## 问答的操作提案与联网（v0.5.0）

- **提案靠 `:::action` 围栏**，不能开 `json_object`（整篇 Markdown 会被压成一坨字符串）。
  解析在 `util/askActions.ts`，执行在 `db/askCommit.ts`。
- **解析必须用字符类写围栏正则**（把「冒号」和「反引号」一起放进方括号，重复三次）：

  ```
  /^\s*[:`]{3}\s*action\b/i      // 开块
  /^\s*[:`]{3}\s*$/              // 收块
  ```

  **不要写成 `(?:::{3})`** —— `(?:` 是非捕获组括号，会吃掉一个冒号，结果只认 `::action`。
  失败时完全没有报错，表现只是「模型给了提案但界面一条都不显示」。
- **提案必须校验**（主题名逐字存在于 `listKnowledgeTopics()`、卡片 id 存在于全库），
  否则 `retopicCards` 改 0 张还报成功，`update_card` 会改到另一张卡上。
- **联网只能用 `/v1/tools/search`**（`ai/search.ts`）。Responses API 的内置 `web_search`
  **只在 `deepseek-v4-pro` 生效**，`deepseek-flash` 下静默忽略 —— 不报错、只是没搜，然后模型凭记忆编。
- **问答记录独立成表 `ask_logs`**，不混进 `knowledge_cards`；也不提供「把问答当卡片检索」的方法。
- **问答的多轮和整理的多轮不是一回事**（v0.6.5）。整理是把 `raw` 当 `assistant` 回传；
  问答是整场会话：`system(规则) → user(卡片清单 + 第1问) → assistant(第1答) → … → user(当前问题)`。
  卡片清单**只放第一条 user**，网络资料**只挂当前轮**，`turns` 只在退出面板时清掉。
- **`update_card` 支持 `body`**（v0.6.5）。以前只能改主题/方向/标题/要点，用户说「把这条结论改掉」时模型无处可写。
- **提案被校验丢掉要回执**（`parseAskActions` 的 `rejected`）。静默丢弃在体验上和「它没有权限」无法区分。

## 二级方向的两种写法（v0.6.0）

| 方法 | 按什么匹配 | 用在哪 |
|---|---|---|
| `repo.setCardSubtopic(ids, to)` | **卡片 id** | 手动分方向（详情页 / 主题页 / 点方向小节头） |
| `repo.resubtopicCards(topic, from[], to)` | **方向组** | 按组改名 |

两者不能互相替代：老卡片的 `subtopic` 全是 `null`，用组操作选不中任何一组，等于没有入口。
这正是 v0.4.1 之后「按方向分组在已有数据上看不到效果」的原因 —— **不是功能没写，是没有入口**。

另外：`KnowledgeScreen` 里返回键的订阅变量**不能叫 `sub`**。它和分方向面板的 `sub` state 重名时，
闭包里永远拿到订阅对象（恒为真）→ 每次 `return false` → 安卓返回键彻底失效。
**这类重名 tsc 不会报**，因为两者都是合法值。

## SQL 里清空字段要写 `NULL` 字面量（v0.6.1）

```ts
// 对：关键字进 SQL 文本，没有注入面
db().runSync(`UPDATE knowledge_cards SET subtopic = NULL WHERE id IN (${ph})`, ids);
// 错：靠 ? 绑 JS null，expo-sqlite 在部分版本上会当成「没给参数」或绑成字符串，
//     UPDATE 改 0 行却正常返回 → 设得上、删不掉，且零报错
db().runSync(`UPDATE knowledge_cards SET subtopic = ? WHERE id IN (${ph})`, [null, ...ids]);
```

`setCardSubtopic` / `resubtopicCards` / `updateKnowledgeCard` 三处都按这个写法。
空字符串一并归一成 `NULL`，否则会多出一个「名字是空」的分组。

## 别用返回的 `changed` 判断成败

不同 SQLite 驱动对「新值和旧值相同算不算一次修改」说法不一，有的返回 0。
拿 0 当失败，就会出现「其实已经删掉了，界面却提示失败、面板还关不掉」。
写库之后一律以 `onChanged()` 重新查询的结果为准。

## Expo 会发破坏性变更，别信训练数据

动 Expo / RN API 之前：

1. 看 `package.json` 里 `expo` 的主版本（当前 **SDK 58**）
2. 查对应版本文档：`https://docs.expo.dev/versions/v58.0.0/`
3. 其他问题查 https://docs.expo.dev/llms.txt

不要凭记忆回答 Expo API。

## 文档地图

| 文件 | 用途 |
|---|---|
| `HANDOFF.md` | **交接文档，先读这个** |
| `SPEC.md` | 需求与设计唯一依据（数据模型、AI 契约、Android 红线、构建环境） |
| `README.md` | 给人看的项目说明与构建指引 |
| `ROADMAP.md` | 还没做的事、明确不做的事、待决问题 |
| `CHANGELOG.md` | 每个版本改了什么、为什么、踩了什么坑。**想知道「为什么写成这样」来这查，别猜** |
