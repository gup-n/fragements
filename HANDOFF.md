# 交接文档（给下一个模型）

> 写于 2026-10-24，对应版本 **v0.5.0（versionCode 14）**。
> 上一轮上下文快满了，这份文档的目的是让你**不用重读历史对话**就能接着干。
>
> **阅读顺序**：本文件（10 分钟）→ `SPEC.md` 第 6 节（AI 契约 + 流式与思考过程 + 周期总结与知识库问答）+ 第 8.1 节（Android UI 红线）→ `ROADMAP.md` 剩余项。
> `README.md` 是给人看的门面，`AGENTS.md` 是速查，细节都在 `SPEC.md`。

---

## 1. 三十秒速览

一个**个人单机 Android 应用**，叫「碎片」。核心是「碎片化记录 + AI 整理」：
随手记一条 → AI 整理成标签/待办/知识卡 → 用户逐条确认才写库。小结单独走周期总结面板。

| 项 | 值 |
|---|---|
| 路径 | `F:/coding/python/project/Test/fragments` |
| 包名 / 显示名 | `com.local.fragments` / 「碎片」 |
| 版本 | `0.5.0`，`versionCode 14`，`targetSdk 36` / `minSdk 24` |
| 技术栈 | React Native 0.88 + Expo SDK 58 + TypeScript，新架构，**Android 单端** |
| 存储 | expo-sqlite（native）/ localStorage（web 预览），`PRAGMA user_version = 5` |
| AI | DeepSeek `deepseek-flash`（V4.1-Flash），OpenAI 兼容，**流式 SSE** + 思考模式；整理/总结/问答共用 `ai/chat.ts` 请求层 |
| 规模 | 约 11,600 行 TS/TSX，最大的屏 `TimelineScreen.tsx` 1058 行 |
| 最新 APK | `fragments-v0.5.0.apk`，21.9 MiB（22,960,914 字节），MD5 `225fe8180f60df816ada091440fb3316`（`versionCode 14` / `versionName 0.5.0` 已用 aapt2 核对） |
| 单机 / 联网 | **只做单机**。不引账号、后端、云同步。唯一网络请求是用户自己填 Key 的 DeepSeek |

**没有用导航库**。页面栈就是 `App.tsx` 里一个 `route` state（`'timeline' | 'organize' | 'settings' | 'knowledge' | 'review'`）。别引入 Expo Router。

---

## 2. 立刻能跑的命令

```bash
cd F:/coding/python/project/Test/fragments

npx tsc --noEmit                                  # 类型检查，改完必跑，当前零错误
npx expo export -p web --output-dir dist-check     # Web 预览构建，约 11 秒，用来验证不崩
```

**项目零自动化测试**，上面两条是唯一的自动检查。

### 想给用户看界面但不想装 APK

```bash
npm run build:web        # 清空并重新导出到固定的 web-preview/
npm run preview          # 起本地静态服务（默认 8731，只绑 127.0.0.1）
```

然后**用 `present_files` 传 `http://127.0.0.1:8731`**，WorkBuddy 会在内置浏览器预览面板里打开，
用户点开就能操作 —— **不要再生成单文件 HTML**（用户看不到，v0.4.0 之后已废弃）。

- 目录名固定为 `web-preview/`，所以服务只需起一次；改完代码重新 `npm run build:web`，浏览器刷新即可
- `build_web.mjs` 会先 `rm -rf` 再导出 —— 目录已存在时 `expo export` 的覆盖行为会被安全策略拦截
- `preview_server.mjs` 是纯 Node 实现（不依赖 python），带 SPA fallback、目录穿越防护、`Cache-Control: no-store`
- 代价：Web 端走 `localStorage`，数据是空的；只能看界面结构，看不到真实数据

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

### 已完成（v0.1.0 → v0.5.0）

| 版本 | 内容 |
|---|---|
| v0.1.0 | 时间轴、输入、编辑删除、DeepSeek 整理、知识库、Markdown 导出 |
| v0.1.1 | 冷启动自动聚焦、记完滚回顶部、折叠阈值 60→100 字 |
| v0.2.0 | 回顾页（解决待办/小结数据黑洞）、APK 76→22 MB、构建 45 分钟→2 分钟 |
| v0.2.1 | 首轮真机四条反馈全修（启动闪白、键盘遮挡 ×2、状态栏重叠） |
| v0.2.2 | 多轮追问、新旧对齐（补充已有卡 / 标记待办完成）、返回键收口 |
| v0.2.3 | 重构模式（重新整理已整理碎片并与旧结果对照）、归档旧卡、清理待办 |
| v0.2.4 | **思考过程可视化**（流式 + 思维链实时显示）、**模型名迁移到 `deepseek-flash`**、超时改分段、设置页可开关思考 |
| **v0.3.0** | **周期总结**（日/周/月，进时间轴）、**知识库检索**（关键字搜索 + 问模型）、知识库详情页与大字号、待办完成标记（`todo_done` 默认勾选 + 时间轴徽章） |
| **v0.3.1** | **真机反馈五条全修**：待办可合并（软隐藏可撤回）、小结挪到时间轴顶部、整理不再产出小结（改为待补清单）、重构支持全部碎片、代码结构重整（`ResultSections` / `resultItems` / `commit`） |
| **v0.3.2** | **界面美化**：`IconButton`（36px 圆触控区）+ `ScreenHeader`（统一页头）两个基础组件，图标尺寸整体上调一档、首页图标加圆底、整理入口按未读状态变实心；五处页头收成一处，知识库把「共 N 条」挪进副标题 |
| **v0.4.0** | **时间轴三件**：按日折叠（默认只展开今天）、首页搜索（内存过滤 + 未整理计数）、碎片详情页（只读 + 左右滑 + 长按编辑） |
| **v0.4.1** | **主题治理**：卡片加 `subtopic` 二级方向、主题页按小方向分组、`merge_topics` AI 归并建议、知识库页头手动合并 / 改名 |
| **v0.4.2** | **详情页三处修复**：编辑改为整屏内联（不再弹小窗）、保存后详情页即时刷新（`detail` 改存 id 序列）、正文下方接当天小结 |
| **v0.5.0** | **问答三件**：操作提案（`:::action` 勾选执行）、DeepSeek 官方搜索（手动触发）、思考折叠成一行、问答记录（migration v5，独立扁平区，可改可删可带入） |

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

### 4.1 v0.5.0：问答加权限 + 官方搜索 + 问答记录（第三批）

用户五条需求里的最后两条。四个已确认的决策，全部按它做：
**只出建议、勾选后执行** / **手动点按钮才联网** / **存完整问答、列表只显示精简** /
**问答进独立扁平和区，默认不参与检索，可手动带进上下文**。

同轮还带了 v0.4.2 的三处修复，见 4.1.5。

#### 4.1.1 操作提案用 `:::action` 围栏，不用 JSON 模式

问答的主要产出是一篇给人读的 Markdown。开 `response_format: json_object` 会把它整篇塞进
JSON 字符串，换行全变 `\n`（`summarize` / `ask` 都踩过）。所以正文照常写，只有真要动手时，
在末尾追加一段：

```
:::action
{"kind":"merge_topics","from":["工具","资讯"],"to":"AI 与工具","reason":"都在讲 AI"}
:::
```

四种 kind：`merge_topics` / `rename_topic` / `archive_cards` / `update_card`。
**没有 delete_card** —— 卡片只能归档，归档可恢复。

`update_card` 的 `subtopic` 是 `string | null | undefined` 三态：
不传 = 不动，`null` = 清掉小方向，字符串 = 设成它。少写一态就没法把卡从小方向里拿出来。

#### 4.1.2 正则陷阱：`(?:::{3})` 只认两个冒号

`(?:` 是非捕获组的括号，后面紧跟冒号时**冒号会被吃掉一个**。
`/^\s*(?:::{3}\s*action)/` 实测匹配不上 `:::action`，只匹配 `::action`。
这个 bug 没有任何报错，表现是「模型给了提案但界面一条都不显示」。

改用字符类绕开分组：

```
/^\s*[:`]{3}\s*action\b/i     // 开块
/^\s*[:`]{3}\s*$/             // 收块
```
**别为了好看改回分组写法。**

#### 4.1.3 提案校验必须真做，不是防御性冗余

`util/askActions.ts` 拿到块之后逐条校验：主题名必须逐字存在于 `listKnowledgeTopics()`，
卡片 id 必须存在于全库。放过去的后果：

- `retopicCards` 改 0 张但返回成功 —— 看起来执行了，其实什么都没发生
- `update_card` 会改到**另一张**用户没打算改的卡上

`contextCardIds` 传的是**全库** id，不是当前主题的：用户可能让它顺手归档一张别的主题下的旧卡，
按当前主题校验会把整批判成非法。

#### 4.1.4 联网只能用 `/v1/tools/search`，**不能**用内置 `web_search`

Responses API 那个内置 `web_search` **只在 `deepseek-v4-pro` 生效**，
本项目默认的 `deepseek-flash` 下会被静默忽略 —— 不报错、只是根本没搜，
然后模型一本正经地凭记忆编。这是最危险的一种失败。

`ai/search.ts` 直接打 `POST {baseUrl}/tools/search`：
`need_content: false` 只要 `summary`（官方说 600–800 字，本来就是给模型读的，不用再 Fetch）、
`count: 8`（按成功请求计费，count 不影响价格）、`rerank_score ≥ 1.0` 过滤、
`408 / 429 / 5xx` 退避重试三次（官方不给 Retry-After）。

**返回空数组是正常结果**，不是错误 —— 要和「搜索失败」区分开：前者照常答，只是注明没搜到。

联网是**手动触发**的：答案出来之后，下方才有「联网再查一次」。自动触发会在他没注意时花掉额度，
而且把「我记过的」和「网上抄的」混在一起，边界必须由用户自己划。

#### 4.1.5 v0.4.2 的三处修复（详情页）

真机反馈三条，根因都是 v0.4.0 那个详情页：

| 反馈 | 根因 | 修法 |
|---|---|---|
| 编辑还是中间小窗口 | 详情页右上角调的是列表那个 `openEdit`，弹的是 `sheetOverlay` | 详情页**自己**有编辑态：整屏切 `TextInput`，17px/30 行高与阅读态一致，光标落在刚才读到的位置 |
| 小窗改完展开页没变，得关掉重进 | `detail` 存的是 `items` **快照**，`reload()` 之后快照还是旧的 | `detail` 只存 `{ ids, index }`，`detailItems` 由 `fragments` 实时派生（`useMemo`）。id 顺序固定，翻页不会因重排错位 |
| 展开页没有小结 | 没传 `notes` | 详情页接 `notes`，正文下方接「当天小结」卡片。`daily` 优先；当天没写才退而取锚点落在这天的周/月总结 |

编辑态还要处理两件事：`FlatList` 不渲染（否则横向滑动会翻页）、返回键先退编辑再关页面。

#### 4.1.6 问答记录独立成表（migration v5）

```
ask_logs(id, scope, question, answer, reasoning, cited_ids, web_json, created_at)
```

`scope` 是 `'all'` 或主题名。**刻意不混进 `knowledge_cards`**：
混进去会让「全库 N 张卡」虚高，检索也会捞出一堆一次性对话。
`repo` 里也**没有**「把问答当卡片检索」的方法，别加。

界面是**扁平列表**而不是按主题的气泡流：这些记录第一用途是回看，扁平列表每条自带时间和主题，
扫一眼就能定位；气泡流翻旧账要一直往上滑。

编辑只允许改**问题**。回答是当时的产物，改了就成了伪造记录。

#### 4.1.7 思考过程在答案落地后收成一行

「深度思考 12 秒 ›」。秒数是**整轮耗时**，联网那一段要扣掉 ——
DeepSeek 流式响应里没有「思考结束」这个事件，硬拆只能靠首字时间猜，估出来的数字更误导。

生成时仍然用 `ReasoningStream`（要有东西一直在动，否则用户以为卡住了），
落地后换成 `ReasoningCollapse`。`thinking` 关掉时整块不显示。

---

### 4.2 v0.4.1：知识库主题治理（第二批）

用户提的五条需求拆成三批，这是第二批。要解决的核心问题：**主题只是卡片上的一个字符串**，
模型新建一个的成本是零，于是「工具」「资讯」各占一个，而它们其实是同一类。

三个动作一起做，因为互相依赖：

1. **卡片加 `subtopic`**（migration v4）—— 主题页可以按小方向分组
2. **AI 加第十类输出 `merge_topics`** —— 整理时主动提归并建议
3. **知识库加主题整理面板**（`components/TopicSheet.tsx`）—— 用户手动合并 / 改名

#### 4.2.1 主题清单必须带卡片标题

原来 prompt 里只给 `【已有主题】NAS 维护、装机`。模型没法判断「工具」和「资讯」是同一类，
所以它从来不会建议合并 —— 不是它不听话，是**它没有依据**。

改成每个主题后面挂最多 4 个卡片标题、超出标「等 N 张」（`TOPIC_SAMPLE = 4`）。
只给个主题名就要它做归并，等于让它猜谜。

#### 4.2.2 合并和改名是同一个动作

底层只有 `repo.retopicCards(from[], to)` —— 批量 `UPDATE knowledge_cards SET topic = ?`。
`TopicSheet` 也只有一个输入框：**勾一个就是改名，勾多个就是合并**。

已归档的卡片也一起改，否则恢复之后会凭空多出一个只含归档卡的主题。

#### 4.2.3 为什么 `merge_topics` 默认不勾选

和归档卡、删待办同属「需要用户主动点一下」的一类。虽然一张卡都不会丢，
但它改的是**用户自己的组织结构**，而且合并之后回不到原来的主题名（只能手动重拆）。

`resultItems.ts` 的 `destructive` 字段字面意思是「会让内容从列表里消失」，
这一类不完全是 —— 代码注释里写明了「这里指的是需要主动确认，不是内容会丢」，
别看到字段名就以为标错了。

#### 4.2.4 `subtopic` 刻意可空

大多数主题下只有两三张卡，硬分小方向反而更碎。所以：

- AI 只在「同一主题下已经有好几张卡、且确实有明显不同的细分」时才填
- 界面只在**分组数 > 1** 时显示分组头，否则平铺
- 「未分方向」那组永远排最后

将来真要升级成 `topics` 实体表，`subtopic` 就是现成的 `parent_id` 迁移路径。

#### 4.2.5 第二批之后的第三批（已完成，见 4.1）

问答加权限（操作提案）+ DeepSeek 官方 Search + 问答记录，已在 v0.5.0 落地，实现细节在 4.1。

---

### 4.3 v0.4.0：时间轴三件（第一批，已完成）

用户提了五条需求，并要求先出方案、确认后动手。方案定完拆成三批：

| 批次 | 内容 | 状态 |
|---|---|---|
| 1 | 按日折叠 + 首页搜索 + 碎片详情页（左右滑） | **已完成（v0.4.0）** |
| 2 | 主题两级结构（`subtopic`）+ 主题管理 + 整理时 AI 归并建议 | **已完成（v0.4.1）** |
| 3 | 问答加权限（操作提案）+ DeepSeek 官方搜索 + 追问记录 | **已完成（v0.5.0）** |

#### 4.3.1 点碎片现在进的是「读」，不是「改」

之前点整行直接开编辑面板 —— 想通读一条长记录，先得到一个光标和键盘。
现在点进 `components/FragmentDetail.tsx`（全屏只读、17px/30 行高、可选中复制），
要改再点右上角；熟练用户也可以**长按列表项**直接进编辑。

**翻页序列 = 进入时的上下文序列**：时间轴进就是时间轴顺序，搜索进就是搜索结果顺序。
不要改成「永远全局时间倒序」—— 用户的心智是「我在这个列表里」。

**宽度必须实测，不能用 `useWindowDimensions`**。桌面预览把 App 关在 420px 的壳里，
窗口宽度 ≠ 这一页的宽度；用后者会让每页宽出一大截，`initialScrollIndex` 也跳错位。
`FragmentDetail` 用 `onLayout` 拿容器宽度，且**宽度为 0 时不挂 FlatList** ——
`initialScrollIndex` 依赖 `getItemLayout` 算出的偏移，宽度还是 0 时挂上去会停在第 1 页。

翻页本身用横向 `FlatList` + `windowSize={3}`，不要手写 `PanResponder` 或
自己维护 `contentOffset`：窗口化、分页吸附、惯性、回弹都是系统原生的，安卓上尤其明显。

#### 4.3.2 折叠：默认只展开今天，且不记忆

`collapsedDays` 的初值是 **null**，含义是「还没手动动过」，这时走默认规则（只展开今天）。
不直接把默认集合塞进 state，是因为「今天」会随日期变，写死一次就永远停在旧日期上。

三个必须一起处理的点：

1. **搜索时强制全展开** —— 命中的条目藏在折叠里等于没搜到
2. **刚记完一条要自动展开今天** —— 折叠一个「刚往里写了东西的日期」没有意义
3. **条数和预览必须提前算** —— 折叠时 `data` 被清空（SectionList 靠空数组才能只渲染 header），
   所以 `DisplaySection` 带上 `total` 和 `preview`，不能在 header 里读 `section.data[0]`

#### 4.3.3 搜索：内存过滤，不走库

碎片本来就全量在 props 里，压一个 SQL 查询下去反而拿不到 `tags` / `project` 的匹配。
搜索时**不显示小结** —— 否则日期头下面孤零零挂一条小结，看不出到底哪条碎片命中了。

统计行报「找到 N 条 · M 条还没整理」，直接回答用户那句「哪些想法还没被收成卡片」。

---

### 4.4 v0.3.1 → v0.3.2：真机反馈第一轮 + 界面美化

用户拿 v0.3.0 装了机，提了五条，并且明确要求「先想清楚我的表述哪里不明确，再动手」。
所以这轮先出了四个选择题把分歧收敛掉，再改代码：

| 分歧 | 用户的选择 |
|---|---|
| 小结位置 | **只改时间轴**（不动回顾页） |
| 「哪天没写小结」列哪些粒度 | **日/周/月都列** |
| 重构范围 | **新增「全部」选项，原选项保留** |
| 重复待办怎么处理 | **隐藏保留，可恢复**（不是真删） |

五条反馈对应的根因和修法：

| 反馈 | 根因 | 修法 |
|---|---|---|
| 模型对待办没办法，重复的没被合并 | 「合并」这个能力**根本不存在**（只有 `deleteTodo`）；prompt 也没要求模型主动扫已有待办清单；上下文只给前 30 条待办 | 新增 `merge_todos`（软隐藏 + 回顾页可撤回）、prompt 加【merge_todos】整段并要求每轮主动扫清单、待办上下文上限 30 → 60 |
| 小结在底部，得下滑才看到 | 时间轴比较器把总结压到当天末尾（上一轮我主动这么写的，注释还写着「压在当天末尾」） | 改成小结排当天最前 |
| 生成了两次小结 | 三条叠加：①整理结果页每次插一条「今日小结」且默认勾选；②周期总结面板也能存；③面板判断「是否已存在」用 `listNotes(200)` 再自己筛，笔记一多就漏 | **整理不再产出小结**；`upsertNote` 按 `(type, period)` 覆盖；新增 `repo.findNote` 精确查；保存加 `savingRef` 防重入 |
| 不要自动生成小结，改为列出哪天没整理 | 原流程在整理应用的循环里直接写 `notes` | 整理页新增「N 个周期还没写小结」卡片，点一条进面板预览后再决定存不存 |
| 重构只能整理已整理的内容 | `refactorPool` 只取 `status === 'tagged'`，想修正历史得先跑一轮整理 | 默认改为「全部碎片」（`mergedInto === null` 的未整理 + 已整理），原选项保留 |

#### 4.4.1 小结为什么必须从整理流程里摘出去

不只是「用户不想」。整理一次最多看 60 条碎片，可能只是某个周期的一小部分 ——
模型拿着这批碎片写出来的「今日小结」本身就是残的。而周期总结面板会读该周期的**全部**碎片
（`listFragmentsBetween`），质量根本不是一个量级。

顺手消掉的还有一个 bug 类：`summary` 一去掉，「一天整理两次就有两条今日小结」这条路径直接不存在了，
不需要靠去重逻辑去补。

现在小结只有一个入口：**周期总结面板**。整理页只负责告诉用户「哪几个周期还空着」。

#### 4.4.2 「待补小结」的口径（`src/util/digest.ts`）

| 规则 | 理由 |
|---|---|
| 只看有碎片的周期 | 空周期没什么可总结的 |
| 日**包含今天**，标 `running` | 今天的碎片已经攒了一些，想写就该能写。界面写「今天」并注明只统计到此刻 |
| 周/月只算已结束的 | 写了是半截；周期一结束它自己会重新出现，没必要先写一份残的 |
| 已有 note 的跳过 | 按 `(type, period)` 精确匹配 |
| **按粒度配额** daily 6 / weekly 2 / monthly 2 | 见下 |

配额是踩出来的：第一版纯按 `at` 倒序排，结果 `missingDigests(20条九月碎片)` 返回的全是月和周 ——
因为月/周的**周期末端**天然比日靠后，一个月总结能把十几个日小结全挤掉，而日小结才是日常真用的那个。
现在是「先按粒度占名额，剩余按时间补」。

#### 4.4.3 顺手修的两个口径问题

- `stats().todoOpen` 把已合并的待办也算成「未完成」，合并越多首页那个数字越虚高（native / web 两处都改）
- 删除某条碎片后，原来并进它的碎片只把 `merged_into` 置空、`status` 还留着 `merged` ——
  既不在时间轴显示（时间轴看 `mergedInto`），也不进整理池（整理池看 `status`），**等于凭空消失**。
  改为同时落回 `inbox`

#### 4.4.4 代码结构重整（用户明确要求「重头读代码，把混乱的逻辑优化掉」）

| 问题 | 处理 |
|---|---|
| `OrganizeScreen.tsx` 1584 行，状态机和九段结果渲染混在一起 | 结果渲染抽成 `components/ResultSections.tsx`，降到 813 行 |
| 加一类输出要在**四个地方**同步改（key 工厂 / `allKeys` / `withFreshOff` / 空结果判断），漏一个就是 bug | 抽 `util/resultItems.ts`，一张 `{[F in keyof OrganizeResult]: …}` 表；**少写一个字段直接编译不过** |
| `apply()` 和 `setPhase` / 错误提示绞在一起，没法单独验证 | 抽 `db/commit.ts`，纯写入、返回实际写入条数 |
| 整理页和周期总结面板各写了一份「思考过程折叠区」 | 抽 `components/ReasoningTrace.tsx` |
| 整理页还有一个和 `ReasoningStream` 几乎一样的 `ReasoningPanel` | 直接复用 `ReasoningStream`，删掉旧的 |

`「已写入 N 项」` 现在报的是 **`commitResult` 实际写库条数**，不是「勾选了几项」——
勾了但无事可做的条目（比如 `card_update` 要补的原文全在卡里了）不该算进去。

#### 4.4.5 这轮没做的事

- **回顾页的待办没有手动合并/删除入口**。用户的原话是「模型无法对待办进行操作」，
  所以只补了 AI 侧的能力；手动操作的界面是另一个需求，等用户提
- 通知栏入口仍然没做（SPEC 唯一未完成的功能项）

#### 4.4.6 v0.3.2：界面与图标

用户原话：「看一下 UI 能不能美化一下，让里面的图标更方便查看，界面布局更佳美观」。
拆成两件事：**图标能不能看清/点中**，和**版式是否统一**。

| 症状 | 改法 |
|---|---|
| 头部图标是「19px 细线图标 + `padding: 2`」，触控区只有 23px 左右，按偏就没反应 | 新增 `components/IconButton.tsx`：固定 36px 圆、`hitSlop` 4、按下透明度反馈，支持圆底（none/soft/accent）与数字角标 |
| 三个导航图标分不清（`albums`/`list`/`settings` 都是细线） | 换成 `library`（书本）/ `checkmark-circle`（待办）/ `settings`，并给浅灰圆底，明确「这是按钮」 |
| 「已完成」徽章里那个勾只有 9px，手机上基本看不见 | 徽章图标 9→11、文字 10→10.5；其他图标整体上调一档（页头 20→22，卡片头 11→13，来源图标 11→12.5） |
| 整理入口是浅底小胶囊，和旁边三个图标一样重 | 有未读时变**实心蓝底白字**，没有时退回浅底 —— 一眼看出「现在该不该整理」 |
| 四个子页面各写一遍页头，返回键大小/标题位置不一致 | 抽出 `components/ScreenHeader.tsx`：左返回圆钮 + 居中标题（可带副标题）+ 右侧动作区 + 底部 hairline。Organize / Review / Knowledge / Settings 和三个覆盖层（SummarySheet / KnowledgeDetail / AskSheet）全部换掉 |
| 知识库顶部「共 12 条，分布在 3 个主题」占一行正文 | 挪进页头副标题，正文少一行噪音 |
| 空状态只有两行字 | 加一个 64px 浅灰圆 + 图标，页面不至于空得像没加载出来 |
| 输入栏两个小图标没有边界 | 展开键做成 30px 圆钮，发送键 30→32 |

设计上仍然遵守 SPEC 的两条红线：**无渐变、无阴影**。层次一律靠留白、hairline 和底色深浅做。
配色没动（`theme.ts` 一个值都没改），所以不会出现「美化之后不像原来那个 App」。

> 这里踩了一下：批量改样式时用正则删 `headerTitle: { font…` 收尾，结果它一路匹配到了下一个
> **多行**样式的结束括号，把 `content` / `topicRow` / `topic` / `title` 四段一起删了，tsc 才报出来。
> **删样式块别用「从某个 key 开始贪到第一个 `},`」这种写法**，单行和多行样式混在一起时它一定吃多。

---

### 4.5 v0.3.0：四条待优化项

用户一次提了四条，我先用选择题收敛了三个设计分歧，再动手：

| 分歧 | 用户的选择 |
|---|---|
| 完成标记怎么做 | **碎片上显示「已完成」小标记**，不往 `tags` 里塞一个「已完成」标签 |
| 周期整理要不要动碎片状态 | **只生成总结**，不改任何碎片 |
| 问答范围 | **默认当前主题，可切全库** |

四条落地方式：

| 需求 | 落地 |
|---|---|
| 已完成的待办别再抽一遍 | `todo_done` 改**默认勾选**；prompt 里加【已完成待办】段；重构模式下先读这份清单 |
| 知识库字小、想点开看 | 卡片字号 14→16、要点 12→14；点卡片进**独立详情页**（20px 标题 / 15px 原文），归档·恢复·删除都在里面 |
| 知识库要能搜、能问 | 顶部关键字搜索（跨主题，主题页内自动收窄）+ 问模型（当前主题 / 全库） |
| 日/周/月内容想整理到时间轴 | 回顾页「生成总结」→ 选周期 → 流式生成 → **预览后决定存不存** → 落在该周期末尾 |

#### 4.5.1 三个必须记牢的实现点

1. **`response_format: json_object` 必须能关**。开着它，模型会把整篇 Markdown 塞进一个 JSON 字符串，
   换行全变 `\n`，落到时间轴上就是糊成一行。`chat.ts` 的 `RequestOptions.json` 默认开（整理要），
   总结和问答显式传 `json: false`。
2. **周期取数不能用 `listFragments(limit)`**。加了 `listFragmentsBetween(from, to)`，
   区间**半开** `[from, to)`。用 limit 截断的话月总结会漏掉月初的记录，而且不会报错 —— 这种错最难发现。
3. **引用反查靠标题字面命中**（`answer.includes(card.title)`），不让模型输出编号再解析。
   模型换个编号习惯（`[1]` / `【1】` / `1.`）就得改一次解析器。

#### 4.5.2 顺手做的一次重构

`deepseek.ts` 从 570 行降到 270 行。传输层（超时守卫、流式/非流式、错误映射、`testConnection`）
整体搬到新的 `ai/chat.ts`，因为总结和问答要一模一样的四段超时和错误提示，
再复制一遍必然走形。现在三个功能各管自己的 prompt 和结果收敛，只共用请求层。

> 改的时候注意：`AiError` 和 `testConnection` 现在从 `ai/chat` 导出，不再是 `ai/deepseek`。
> `OrganizeScreen` / `SettingsScreen` 的 import 已同步。

#### 4.5.3 材料预算：为什么是「前 70% + 后 30%」

一个月的碎片可能上百条，全塞进去既贵又会把模型淹掉。第一版想的是「只取前 N 条」，
但那样月末的结论（往往才是这个月真正的产出）会被整段丢掉。

现在的做法：超预算时保留**前 70% + 后 30%**，中间插一句「…（中间省略 N 条）」。
两头的语境都在，模型不会把「月初起的头」和「月末的结论」接错。单条碎片截 400 字，
避免一条长笔记吃掉整个预算。

#### 4.5.4 同周期重复生成

日小结最容易被重新生成（晚上又记了几条）。保存前会查 `(type, period)` 是否已有 note，
有就给一个**默认勾选的「替换原有小结」**，取消勾选就是另存一条。
不做这一步的话，时间轴上会并排两条同日小结，用户还得手动删。

#### 4.5.5 返回键的层级

知识库原来是「按返回直接回时间轴」，无论你在第几层。这轮补了页内层级：
搜索词 → 主题 → 回主界面，逐层退。实现上要注意 **RN 的 BackHandler 是后进先出**，
而知识库这个 handler 没有依赖数组（每次渲染都重新注册），所以它会一直排在最前面 ——
因此它里面必须显式判断 `if (detail || askOpen) return false;` 把事件让给覆盖层，
否则详情页开着的时候按返回会直接跳回时间轴。

---

### 4.6 v0.2.4：思考过程（上一轮，仍在用）

#### 4.6.1 先说那个更急的事：模型名已经死了

用户提的需求是「整理时想看到模型的思考过程」，但查文档时发现了一个更要命的问题：

> **`deepseek-chat` 和 `deepseek-reasoner` 已于 2026-07-24 15:59 UTC 永久停用**，
> 调用直接报错，没有宽限期、没有软跳转。

也就是说 **v0.2.3 那个 APK 的 AI 整理是跑不通的**。这件事和「看思考过程」恰好绑在一起：
V4 的思考模式默认开启，把模型名改对，`reasoning_content` 自然就有了。

迁移方向别搞错：两个旧别名当时都指向 **V4-Flash**（`deepseek-chat`=非思考模式，`deepseek-reasoner`=思考模式），
所以正确的新名字是 `deepseek-flash`，**价格一分不变**。换成 `deepseek-v4-pro` 是能力升级，贵约 3.1 倍，不要当成迁移目标。

代码里的迁移方式：`loadAiConfig` 读配置时用 `RETIRED_MODELS` 映射把旧名换掉（读取路径不写库，用户下次保存时自然落盘）。

#### 4.6.2 三件事一起改，因为它们互相依赖

| 改动 | 为什么非改不可 |
|---|---|
| 模型名 → `deepseek-flash` | 旧名调不通 |
| `stream: false` → 流式 SSE | **非流式必须等整轮跑完才拿得到 `reasoning_content`，那就不叫「过程」了** |
| 新增 `thinking` / `reasoning_effort` | V4 默认开思考，但得让用户能关（更快更省） |

#### 4.6.3 五个必须记牢的实现点

1. **RN 自带的 `fetch` 没有 `response.body`**，`getReader()` 直接崩。
   SDK 58 的全局 fetch 虽然已经被 `expo/fetch` 接管，代码里仍**显式 `import { fetch } from 'expo/fetch'`**，
   不赌「全局恰好是哪个实现」。
2. **`TextDecoder` 必须传 `{ stream: true }`**。不传时跨分片的半个中文字符会解成乱码。
   我用逐字节硬切的极端用例验证过（1 字节一片也能过）。
3. **超时从一个总时长拆成四段**：建连 90s / 首字 120s / 空闲 60s / 硬上限 6 分钟。
   原来那个 90 秒总时长会把正常的长思考直接掐死。
4. **`reasoning_content` 和 `content` 分开累积**，前者只上屏、绝不进 JSON 解析。
   `raw` 仍然只存正文，多轮追问回传的还是它。
5. **界面更新必须节流**（120ms）。一个思考过程能吐几百个 chunk，每块都 `setState` 会把 JS 线程占满。
   结束时再用最终值兜一次底，否则最后 120ms 的内容会看不见。

#### 4.6.4 界面长什么样

- **整理中**：一张卡片，头部是转圈 + 标题 + 已用时，中间是滚动的思维链（自动贴底），底部两个数字「思考 N 字 / 结果 M 字」
- **追问时**：同一张卡片顶在结果页上方，旧结果还在下面
- **结果页**：一个默认收起的「模型思考过程 · N 字」，点开可看全文（内部滚动，限高 260）
- **设置页**：「整理行为」分组，思考开关 + 轻/标准/深 三档

#### 4.6.5 一个必须承认的取舍

**思考模式下 `temperature` 不生效**。原来那个用来压稳定性的 `temperature: 0.2` 在开思考时等于没设。
官方文档写得很清楚（传了不报错，只是被忽略），没有替代手段。
所以 ROADMAP 里「重构两遍结果是否稳定」那个悬着的问题，在开思考的情况下**只能用 effort 档位来间接影响**。

代码里 `buildBody` 只在「没有思考」时才传 `temperature`，免得看代码的人以为自己控制住了随机性。

#### 4.6.6 为什么 thinking 参数要按模型名判断

只有 DeepSeek 的 V4 系列认 `thinking` / `reasoning_effort`。
用户如果把 Base URL 换成第三方 OpenAI 兼容服务，多传这两个字段**可能直接 400**。
所以 `isDeepSeekV4(model)` 认不出来就一个都不传，同时补上 `temperature: 0.2` 保住原来的稳定性设置。

---

### 4.7 v0.2.3：重构模式（更早一轮，但仍是核心设计）

#### 4.7.1 先纠正一个理解错误（这是最重要的背景）

v0.2.2 时我**主动砍掉了用户提的「重构」**，理由写进了文档：「让模型重写全部历史内容，误点就覆盖沉淀，与永不删除原文冲突」。

用户纠正：

> 我的重构意思是针对于原文进行重新整理，重新划分标签等，并与原先的整理做比对选择保留等，可以选择归档/删除等操作，但操作要用户授权

**我把「重构」理解成了「重写知识卡正文」，实际指的是「重新整理原文 + 与旧结果比对 + 用户逐项授权」。** 两者完全不是一回事，原方案根本不重写任何已有正文，那些顾虑不成立。

教训写在 `SPEC.md` 第 10 节：用户提一个功能名时，别用自己的技术直觉替换它的语义。有歧义先问，别急着下「不做」的结论。

#### 4.7.2 设计：一个 `mode` 参数，九项输出

`organize` / `refactor` **共用同一套 prompt 和响应结构**，只靠 `mode` 切语义：

| | `organize` | `refactor` |
|---|---|---|
| 处理对象 | `status = 'inbox'` 的碎片 | `status = 'tagged'` 的碎片 |
| 上限 | `INBOX_LIMIT = 60` | `REFACTOR_LIMIT = 40` |
| 碎片行尾 | `（已整理）` | `（已整理｜标签：设备、NAS｜项目：NAS 维护）` |
| 范围 | 只有最新 N 条未读 | 最近 40 条已整理 / 指定主题下全部 |

`OrganizeResult` 从七类扩到**九类**，新增：

```ts
archive_cards: { card_id, reason }[]   // 归档被取代的旧卡，archived=1，可恢复
drop_todos:    { todo_id, reason }[]   // 真删除待办
```

SYSTEM_PROMPT 也相应从七项改到九项。

#### 4.7.3 四个「由代码保证」的点（别指望模型自觉）

这是本轮的设计核心，改这块之前先想清楚为什么这么写：

1. **互斥保护**（`deepseek.ts` 的 `normalizeResult`）
   同一张卡不能既 `card_update` 又 `archive_cards`；同一条待办不能既 `todo_done` 又 `drop_todos`。
   先到先得，丢掉后一个。模型经常自相矛盾。

2. **破坏性操作默认不勾选**（`OrganizeScreen.tsx` 的 `withFreshOff`）
   归档卡 / 标完成待办 / 删待办三类默认全 off。追问时只把「这一轮新冒出来的」置为不勾，用户已表过态的保持原样。

3. **用户取消的授权不可绕过**（`apply()` 里的 `declinedArchive`）
   重构时新卡会按「来源碎片重叠 ≥ 50%」自动顶掉旧卡（`replacementOf`）。
   但如果用户取消了那张卡的归档建议，替代逻辑必须**跳过**它，界面文案也跟着改写成「旧卡保留，不归档」。
   这条是「操作要用户授权」在代码层的兜底，不只是界面提示。

4. **重构降噪**（`pruneRefactorResult`）
   已整理的碎片上次已经抽过待办、写过小结，再抽一遍就是纯重复数据。
   代码层按两条判据过滤待办（**文案去掉标点空白后相同** 或 **同一碎片本来就派生过待办**），并把 `summary` 置空。

#### 4.7.4 补上一个数据黑洞

`knowledge_cards.archived` 字段一直存在，但 `listKnowledgeCards` 过滤了 `archived = 0`，**没有任何界面能看见归档的卡**。
只做归档功能不补入口 = 再造一个数据黑洞（和 v0.2.0 修的待办/小结一个性质）。

已补：`listArchivedKnowledgeCards()`（native + web 两个实现）+ 知识库页「已归档」区，可恢复或彻底删除。

**这条是项目的一个模式**：只要新增一个「让内容从列表消失」的字段/操作，就必须同时提供查看入口。历史上栽过两次。

#### 4.7.5 界面改动

都在 `src/screens/OrganizeScreen.tsx`：

- 顶部 **segmented 切换**：整理未读 / 重构已整理
- 重构范围用 **chip**：最近整理过 / 按主题（主题 chip 显示 `主题 · 卡数`，切到按主题时自动选中第一个，否则池子是空的）
- 重构模式下标签行多一行 **「原标签：…」**，只在真变了时出现（`sameLabels()` 做集合比较，模型重排顺序不算变化）
- 新知识卡行内写 **「会归档被它取代的旧卡：<标题>」**
- 两个新区块带 `hint` 说清后果：「归档后可恢复」「真删除不能撤销，但原文还在时间轴上」

---

## 5. 代码地图

```
App.tsx                       288   路由 state + 全局 BackHandler + 数据加载（含 notes / doneIds / 示例数据）
index.ts                        8   registerRootComponent
src/
  types.ts                    308   Fragment / Todo / Note / KnowledgeCard / WebHit / AskLog / AskAction / OrganizeResult（十类，**无 summary**）+ AiConfig
  theme.ts                     52   颜色常量 C、圆角 R、tagColor() 稳定配色
  version.ts                   10   版本号常量（RN 读不到 app.json，发版时和它手工对齐）
  ai/
    config.ts                  35   读 AI 配置（默认值 + repo.getSetting）+ 已停用模型名映射
    keyStore.ts                37   API Key 存 expo-secure-store（不进 DB、不进导出）
    prompt.ts                   205   SYSTEM_PROMPT（九项）+ buildUserContent（含【已完成待办】）+ buildRefineContent
    chat.ts                    339   ★ 请求层：四段超时 / 流式 / 非流式 / 错误映射 / testConnection（三功能共用）
    deepseek.ts                 297   整理：prompt 组装 + normalizeResult（全部校验都在这）+ organize()
    summarize.ts                226   ★ 周期总结：日/周/月 prompt、材料裁剪（前70%+后30%）、Markdown 清洗
    ask.ts                      282   ★ 知识库问答：关键词打分选卡、预算装填、引用反查、历史与网络资料注入、提案解析入口
    search.ts                   162   ★ DeepSeek 官方 `/v1/tools/search`：退避重试 + 结果收敛（**不要换成内置 web_search**）
    stream.ts                   114   ★ SSE 解析：把 reasoning_content 与 content 分开累积
  db/
    types.ts                    146   Repo 接口（上下层唯一契约）
    repo.native.ts              653   SQLite 实现 + MIGRATIONS 数组（到 v5）
    repo.web.ts                 437   localStorage 实现（仅供桌面预览，功能对齐即可）
    commit.ts                   163   ★ 把用户确认过的整理结果写进库：纯写入、无 UI、返回实际条数
    askCommit.ts                 48   ★ 执行问答里的操作提案（逐条独立事务，一条失败不回滚其他）
    repo.ts                       7   类型转发壳，运行时不会命中
  screens/
    TimelineScreen.tsx         1058   时间轴 + 输入 + 长文折叠 + 全屏编辑 + 小结混排 + 按日折叠 + 搜索
    OrganizeScreen.tsx          813   ★ 状态机 / 两模式 / 追问 / 空闲面板；结果渲染已交出去
    KnowledgeScreen.tsx         526   主题聚合 + 搜索 + 问入口 + 已归档区 + 详情/问答覆盖层
    ReviewScreen.tsx            351   待办与小结算一页（tab）+ 生成总结入口 + 「已合并」撤回区
    SettingsScreen.tsx          418   BaseURL / 模型 / Key / 思考开关与档位 / 连接测试 / 统计
  export/markdown.ts          140   Markdown 导出（时间轴 + 知识库附录）
  util/
    date.ts                   189   日期格式化 + 周期键（ISO 周）/ 区间 / 锚点
    digest.ts                  97   ★ 哪些周期还没写小结（按粒度配额排序）
    resultItems.ts            104   ★ 十类输出的字段元数据表 + 确认 key + 默认勾选策略
    askActions.ts             253   ★ `:::action` 解析 + 校验（真实主题名/卡片 id）+ key + 描述
    keyboard.ts                39   ★ useKeyboardHeight()，见第 7 节
  components/
    FragmentDetail.tsx        505   ★ 碎片详情页：全屏阅读 + 左右翻页 + **整屏内联编辑** + 当天小结（宽度靠 onLayout 实测）
    IconButton.tsx             95   ★ 圆形图标按钮：36px 触控区、圆底、数字角标
    ScreenHeader.tsx           80   ★ 子页面统一页头：返回圆钮 + 居中标题/副标题 + 右侧动作
    TagPill.tsx                35   标签胶囊
    NoteBody.tsx               79   ★ 小结正文的轻量 Markdown 渲染（标题/列表/段落，不引第三方）
    ReasoningStream.tsx        85   ★ 流式实时面板：转圈 + 秒数 + 思维链滚动 + 字数
    ReasoningCollapse.tsx      59   ★ 答案落地后的「深度思考 N 秒 ›」折叠行（问答用）
    ReasoningTrace.tsx         66   ★ 生成结束后的「模型思考过程」折叠区（整理 / 周期总结用）
    ResultSections.tsx        439   ★ 结果页十类条目 + 逐条勾选
    BacklogCard.tsx            86   ★ 「N 个周期还没写小结」卡片
    SummarySheet.tsx          495   ★ 周期总结：选周期 → 生成 → 预览 → 保存/替换
    KnowledgeDetail.tsx       216   知识卡详情页（归档 / 恢复 / 删除，两次点击确认）
    TopicSheet.tsx            281   ★ 主题整理：勾一个改名、勾多个合并
    AskSheet.tsx              639   ★ 知识库问答：范围切换 / 回答 / 引用 / 联网 / 提案 / 记录
    AskActions.tsx            220   ★ 改动建议清单：默认一条不勾，勾了才写库
    AskHistory.tsx            283   ★ 问答记录：扁平 Q-A 列表，可展开 / 改问题 / 删除 / 带入本轮
scripts/
  build_web.mjs               ~25   ★ 导出 Web 产物到固定的 web-preview/（先删后导）
  preview_server.mjs          ~80   ★ 本地静态服务，配合 present_files 做内置预览
plugins/
  withBuildOptimizations.js    65   ★ Gradle 优化写回（单 ABI / caching / shrinkResources / JDK）
  withNoSplashAnimation.js    117   ★ 启动窗改纯色、去图标动画
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

### 7.7 根目录的垃圾（可以删，都已 gitignore）

`web-preview/` `.edge-tmp*/` `devserver.log` `prebuild*.log` `err.txt` —— 预览和调试产物，已全部 gitignore，没有任何代码依赖。

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

`fragments-v0.5.0.apk` 已经打好放在项目根目录（`versionCode 14`，大小与 MD5 见第 1 节速览）。

```bash
adb install -r fragments-v0.5.0.apk        # adb 在 %ANDROID_HOME%\platform-tools\，不在 PATH
```

> 签名是 debug key。若报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，说明签名对不上，得先卸载旧版 ——
> **卸载会清掉所有本地数据，先「导出 Markdown」**。

装完让用户按这个顺序验（**这五条就是他上一轮提的问题，一条条对回去**）：

1. **整理页**：入口下方应该出现「N 个周期还没写小结」，今天的排在第一条并写「今天」。
   点一条 → 面板直接跳到预览前那步（粒度、周期都选好了）→ 生成 → 预览 → 保存。
   **重复生成同一天，时间轴上不该出现两条**
2. **整理结果页**：确认里面**没有「今日小结」这一块了**；勾选项里若出现「合并重复待办」，默认是不勾的
3. **回顾页 → 待办**：底部应该有「已合并 N 条」，展开后每条能「恢复」
4. **时间轴**：某天有小结的话，它应该**排在那天最上面**，不是最下面
5. **整理页 → 重构已整理**：范围默认是「全部碎片」，可用条数应该等于「未整理 + 已整理」的总数

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

**能跑、能装、代码干净、文档齐全。功能上只差一个通知栏入口。v0.3.1 是对真机反馈的第一轮修正（待办可合并、小结挪位置、整理不再产出小结、重构支持全部碎片），同样只有编译和 Web 构建验证 —— 先等用户反馈，别急着加新东西。**
