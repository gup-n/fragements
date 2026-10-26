# 给 AI 助手的速查

**先读 [`HANDOFF.md`](./HANDOFF.md)** —— 那是完整的项目交接文档（状态、代码地图、踩过的坑、下一步）。
本文件只放「读代码时立刻会踩的雷」。

---

## 这个项目不是标准的 Expo 模板

模板自带的这份 AGENTS.md 让用 Expo Router，**本项目没有用**。页面栈是 `App.tsx` 里一个 `route` state：

```ts
type Route = 'timeline' | 'organize' | 'settings' | 'review' | 'ask';
```

没有 `src/app/`、没有 `_layout.tsx`、没有 `expo-router` 依赖。**不要引入。**

## 命令

```bash
npx tsc --noEmit                                  # 改完必跑，当前零错误
npm run build:web                                 # Web 平台打一遍包再删产物，**只当编译校验，不许给用户看**
npx expo install <pkg>                            # 装依赖用它，别用 npm install

npm run test:md                                   # 导入/导出的 24 项回归断言（唯一留在仓库里的）

npx expo prebuild --platform android --no-install --no-clean   # --no-clean 不能省！
cd android && ./gradlew assembleRelease
```

除了 `test:md`，项目**没有别的自动化测试**。其它纯函数层
（`util/organizePlan.ts`、`util/tokenize.ts`、`util/qaNote.ts`）改动时，用
`npx tsc --ignoreConfig <files> --outDir .tmpassert --module commonjs --target es2020`
编译到临时目录、写几条 `assert` 跑一遍，**跑完立刻删**。

为什么导入导出是例外：**那是备份链路**。`test:md` 里有一条往返测试
（碎片 → md → 碎片），导出格式和解析规则任何一边改了，它会立刻变红。

## 给用户看界面：**不做预览**（用户 2026-10-25 明确要求）

用户原话：「不要再开预览了，我要你直接生图而不是 html 的预览，不能生图就不要做预览的步骤」。

所以：**不生成单文件 HTML、不起本地预览服务、不用 `present_files` 打开网页**。
`npm run build:web` 只剩「Web 平台能不能编译通过」这一个用途：产物打进 `.tmp-bundle/`，
同一次运行里量完体积就删掉。**UI 改动的唯一验证手段是用户装 APK 真机反馈。**

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
5. **存储层改一处要改两处**。`repo.native.ts`（SQLite）和 `repo.web.ts`（localStorage）都要动，否则 `npm run build:web` 编译校验会挂。
6. **改功能先改 `SPEC.md`**。文档是唯一设计依据。
7. **标签不是实体**，只是 `fragments.tags` 这个 JSON 数组里的字符串，没有 `tags` 表。改名 / 合并 / 删除统一走
   `repo.renameTag / mergeTags / deleteTag`（底层是 `rewriteTags`），**不要在各个页面里自己遍历碎片改 JSON**。
   仓库里唯一一份实现，就是为了不出现「界面上改了 3 条、库里只改了 2 条」。
8. **全屏详情页的「正在看哪一个」只能存 id，不能存对象快照**。存对象的话上层刷新后它还是旧的，
   页面看起来「没变」，得关掉重进。碎片详情页（v0.4.2）栽过一次。
   正确做法：存 `id` / `ids[]`，内容用 `useMemo` 从当前 props 里实时查。

## 最容易搞错的概念

- **v0.7 起没有知识库**。没有 `knowledge_cards`、没有 `topic` / `subtopic`、没有 `ask_logs`。
  **时间轴就是知识库**：碎片原文 + 标签 + 时间就是全部沉淀。别再往「卡」的方向加东西。
- **「整理」= 一批一批跑到完，最后统一确认**。不是「一次调用出十类结果」，也不是「让 AI 重写正文」。
  一次点击会跑 N 批（每批 40 条 / 16000 字），每批结果合并进同一个 `OrganizePlan`，
  **只有用户点「应用」才写库**（`db/commit.ts`）。
- **「问」的纪要是普通碎片**，不是新表。存下来的是 `buildQaNote` 生成的 Q-A 文本，
  进时间轴、能被搜索、也能被下次整理打标签。
- **会让内容消失的操作默认不勾**：合并碎片 / 删待办 / 合并待办。`todo_done`（标完成）**默认勾**。
  登记表只有一份：`src/util/resultItems.ts` 的 `GROUPS`，别在渲染代码里另写一份。
- **小结只有一个写入路径**：`SummarySheet` → `repo.upsertNote`。整理流程不产出小结。
  判断「这个周期写过没有」用 `repo.findNote`，不要拿 `listNotes(n)` 自己筛。

## 整理循环（v0.7 的核心，最容易改错）

分层是死的，别越界：

| 层 | 文件 | 职责 |
|---|---|---|
| 一次请求 | `ai/deepseek.ts` | 拼 prompt、解析 JSON、**只收敛形状**，不做业务校验 |
| 会话与循环 | `ai/organizeRun.ts` | id 快照、装箱、批循环、截断拆分、每批落库、进度 |
| 合并与校验 | `util/organizePlan.ts` | `mergeBatchResult`：**唯一一份业务判据** |
| 写库 | `db/commit.ts` | 用户确认之后才动数据库 |

- **剩余量 = 快照 − 已处理 − 已跳过**（`runOrganize`）。不要再引入 offset 游标 ——
  v0.6 的翻车点就是「游标和池子各算一次」，点多少次「继续」都是同一批。
  `organize_sessions.cursor` 只用来显示进度，**不参与切分**。
- **`batch_summary` 是跨批唯一的交接信息**。模型看不到别的批次，没有这句摘要，
  它会给同一件事起两种写法、把上一批抽过的待办再抽一遍。
  累积用 `appendSummary`，尾部保留 1500 字。
- **`plannedTodoTexts` 必须传给下一批**。前面几批抽的待办还没写库，
  模型在【未完成待办】里看不到；不给这份清单，同一件事会被每批各抽一遍。
- **校验必须用原始的 `todos` 表，不是 `effectiveTodos`**。计划里的「标完成 / 删除」还没落库，
  拿有效视图去校验 id，会把本来存在的待办判成不存在。
- **`truncated` 不是错误，是对半拆的信号**。`organizeRun.handle` 捕获 `AiError.code === 'truncated'`
  且本批 > 1 条时递归拆开重试；只剩一条还截断，才是真的报错。
- **某批彻底失败时抛 `BatchFailure`，不要让整次整理归零**。它带着已经跑完的 `session`，
  界面可以选「重试这一批 / 跳过这一批 / 放弃本次」。
- **每批跑完立刻 `persist`**。断网、退出、崩溃之后要能「继续上次」，靠的就是这一步。
- **`skipBatch` 不标记碎片状态**。跳过的是「这一次的请求」，不是这些内容；下次整理它们还在 inbox 里。
- **合并与「标已整理」的顺序不能换**。`commitPlan` 里先合并、最后 `markStatus('tagged')`；
  标状态是唯一会改变碎片状态的步骤，放最后才能在失败时留在原状态重跑。
- **报数要真**。`commitPlan` 返回的是真实写入条数：被合并掉的碎片 `markStatus` 会跳过，
  不能算进「已整理 N 条」。勾了但无事可做的项也不算。

## 标签（v0.7 重写，两个函数别混）

| 函数 | 干什么 | 用在哪 |
|---|---|---|
| `cleanTag(raw)` | 去 `#`、全角转半角、压空白、截 12 字，**保留大小写** | 存库的显示形式 |
| `normalizeTag(raw)` | 在 `cleanTag` 基础上再小写 | **只做比较键**，绝不存库 |
| `dedupeTags(list, max=3)` | 按归一化键去重，保留第一次出现的写法 | 写库与计划层共用 |

- **标签只能有一个来源**：`repo.applyTags` 走 `dedupeTags`，计划层 `mergeBatchResult` 也走它。
  各写一份的下场是「界面显示 3 个标签、库里存了 2 个」。
- 以前按 `normalizeTag` 存库，把 `NAS` 存成 `nas`、`AI` 存成 `ai`，界面上像个错别字。
  **键归键、显示归显示。**
- 把新标签对到已有写法上靠 `canonical` Map（`normalizeTag` → 已有写法）。
  模型写「nas」、库里有「NAS」，就存「NAS」。
- **一条碎片的标签全被取消时，直接跳过，不写空数组**。静默清空是那种「事后才发现、找不回来」的破坏。
- 一个碎片可能同时属于多组标签，**先合并成一条 `labels` 再写一次**；
  逐组 `applyTags` 会让后一次覆盖前一次。

## 全文检索（FTS5 + bigram）

- **中文必须 bigram**（相邻两字一组）。`unicode61` 把整句当一个词，`trigram` 对 <3 字查询不命中
  —— 「报销」「NAS」会直接搜不到，而且**没有任何报错**。`util/tokenize.ts` 里写死了这条。
- `fragment_fts` 的 `rowid` **就是 `fragments.id`**，不另建映射表。
  写入一律「先 `DELETE WHERE rowid = ?` 再 INSERT」（`indexFragment`）。
- 每次改碎片内容 / 标签 / 合并 / 删除都要同步索引。漏一处，搜索结果就会指向一条已经改过的原文。
- `ensureSearchIndex` 在启动时比条数，不一致就整库重建。设置页另有手动「重建搜索索引」。
- **FTS 失败或 0 命中时退回 `LIKE`**（`likeNeedle` 转义 `%` / `_`）。
  宁可慢一点，也不能让用户搜出空结果还不知道为什么。

## 导出与导入（v0.7.2）

导出和导入是**同一份格式的两个方向**，分开在 `util/mdBuild.ts` 和 `util/mdParse.ts`。
两边各改各的，等用户真去恢复数据时才发现对不上——那时候数据已经在文件里了。

**唯一的保障是 `npm run test:md` 那 24 项断言**。改导出格式、改解析规则，
两边必须一起改，然后让往返测试（碎片 → md → 碎片）重新绿。

四条别踩：

1. **判重指纹只能有一份**：`mdParse.fragmentKey(createdAt, content)`。
   导入层和库里现有碎片比对时调的是同一个函数。各写一份的下场是
   「明明重复了却导进来两份」，而且没人会发现。
2. **文件选择器别按 MIME 过滤**。安卓上 `.md` 的注册类型五花八门，
   按 `text/markdown` 过滤会让一部分机型根本看不到自己的文件。传通配符，
   选错文件由 `looksBinary` 兜（NUL 字节 / 大量 `\uFFFD`）。
3. **日期要真校验，不是只校验形状**。`\d{4}-\d{2}-\d{2}` 会放 `2026-13-99` 进来。
   而且格式对不上时**不能静默落到今天**——用户会完全不知道自己的日期被忽略了。
4. **块注释里别写 MIME 通配符**。那个字符串里含 `*/`，会把注释提前闭合，
   报的是一串莫名其妙的语法错。写成「传通配符」就不会中招。

## 小结的排序有两处，别只改一处（v0.7.4）

「周总结要压在日小结上面」这件事，在**两个地方**各自实现过：

| 位置 | 在哪 | 机制 |
|---|---|---|
| 时间轴分区 | `screens/TimelineScreen.tsx` | 周总结独占 `week:<period>` 分区，`order = periodAnchor + 1`（周日 23:59:00.001） |
| 回顾页列表 | `util/digest.ts` 的 `groupNotes` | 月 → 周 → 日 → 主题分组，组内才按 `createdAt DESC` |

v0.7.3 只改了时间轴，用户翻回顾页看到的还是混排 —— 同一个诉求答了一半。
**以后碰「小结怎么排」，先确认这两处都要不要改。**

两个约束：

1. `periodAnchor` 对周返回的是**周日 23:59:00.000**，不是 23:59:59.999。
   `+1ms` 落在同一天内，才不会跨到下一周的周一分区上去。
2. `groupNotes` **组内不重排**。`listNotes` 已经是 `createdAt DESC`，
   这里再排一次就等于有两套「哪条更新」的口径。

## 「问」（v0.7.1）

- **只给模型筛过的资料**，不是全库。18 条 / 单条 1200 字 / 总 36000 字，FTS 命中优先。
  上一版全库塞上下文，问题一具体就答偏。
- 检索是**四路并集**：全文、时间意图（今天/上周/最近 N 天）、标签意图、上一轮引用。
  加一条新路之前先想清楚它和已有四路的重叠。
- **联网与本地检索并行**，搜索失败只置 `webError`，本地照常答。
- `[F12]` / `[N3]` / `[T5]` / `[W1]` 四类引用。**反查只认本轮真的给过的编号**
  （`answer.includes('[F' + id + ']')`），模型编的编号不算来源。
- **`json: false` 不能省**。开着 `response_format: json_object` 会把整篇 Markdown 压成一个字符串，
  换行全变 `\n`。
- **多轮只带「问题 + 回答」，不带上一轮资料**。资料每轮重新检索；
  重复塞进去既撑爆上下文，又会让模型拿旧资料答新问题。
- **返回键由 `App` 转发**。`AskScreen` 关闭时带着「要不要存纪要」的内部状态，
  通过 `registerClose` 交给 App；`registerClose` 必须 `useCallback` 固定身份。

## 流式与思考过程（v0.2.4）

- **读流必须用 `import { fetch } from 'expo/fetch'`**。RN 自带的 fetch 没有 `response.body`。
- **`TextDecoder` 必须 `{ stream: true }`**，否则跨分片的中文会解成乱码。
- **`delta.reasoning_content`（思维链）只上屏，`delta.content` 才进解析**。两者绝不能拼进同一个缓冲区。
- **超时是四段**（建连 90s / 首字 120s / 空闲 60s / 硬上限 12min），不要改回单一总时长。
  硬上限是 12 分钟而不是 6 —— 输出额度 64K 之后，正常生成本来就要十几分钟。
- **UI 更新要节流**（120ms），否则几百个 chunk 的 setState 会卡死。
- **模型名**：只能用 `deepseek-flash` / `deepseek-v4-pro`。`deepseek-chat`、`deepseek-reasoner` **已于 2026-07-24 停用**，
  调不通。别在示例或文档里再写这两个旧名字。

## 输出额度与 `finish_reason`（v0.6.3）

- **`max_tokens` 同时限制「思考链 + 正文」，不是只管正文。** 官方额度（64K）照抄，第三方 clamp 到 8K。
  照着旧注释设 8000，思考一长正文就一个字都出不来，界面上表现为「思考到一半突然停住 + 没有内容」。
- **`finish_reason` 必须读，而且要在读 `delta` 之前读。** 它挂在最后一个 chunk 上，
  而那个 chunk 的 `delta` 是空对象 `{}` —— 任何「先看 delta，没内容就 return」的写法都会漏掉它。
- **空结果要按原因分开报**：`length` = 撞额度（重试没用，得拆批次），
  `insufficient_system_resource` = 对方资源不足（过一会儿再试）。
- **正文非空但 `finish_reason === 'length'` 更危险**：JSON 一定是残的。
  `organize` 必须在 `parseJsonLoose` **之前**拦下来（抛 `AiError('truncated')`），
  否则会误导成「不是合法 JSON，再试一次就好」。

## 思考强度（v0.6.4）

- **`reasoning_effort: high` 不是「想久一点」，是加压指令。** 官方实现是在 prompt 最前面插一段
  「Absolute maximum, no shortcuts permitted…穷举所有边界情况、写出每个被否决的假设」。
  对「打标签 / 抽待办」这种机械抽取纯属浪费。`pickEffort`：首轮且 ≤15 条用 `low`，其余用 `high`。
  `low` 不等于关闭思考 —— 官方 low = **不加任何前缀**。
- **`RequestOptions.effort` 只能对官方接口生效**。第三方网关不收 `reasoning_effort`，
  撞额度时只能建议换回官方地址或减小批次。

## SQL 里清空字段要写 `NULL` 字面量（v0.6.1）

```ts
// 对：关键字进 SQL 文本，没有注入面
db().runSync(`UPDATE fragments SET project = NULL WHERE id IN (${ph})`, ids);
// 错：靠 ? 绑 JS null，expo-sqlite 在部分版本上会当成「没给参数」或绑成字符串，
//     UPDATE 改 0 行却正常返回 → 设得上、删不掉，且零报错
db().runSync(`UPDATE fragments SET project = ? WHERE id IN (${ph})`, [null, ...ids]);
```

## 别用返回的 `changed` 判断成败

不同 SQLite 驱动对「新值和旧值相同算不算一次修改」说法不一，有的返回 0。
拿 0 当失败，就会出现「其实已经删掉了，界面却提示失败、面板还关不掉」。
写库之后一律以 `onChanged()` 重新查询的结果为准。标签改名 / 合并同理。

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
