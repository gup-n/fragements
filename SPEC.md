# 碎片 · 需求与设计说明书 (SPEC)

> 本文档是跨会话开发的**唯一设计依据**：数据模型、AI 契约、界面规范、构建环境。
> 改功能先改这里，再改代码。**版本历史不写在这里** —— 那是 [CHANGELOG.md](./CHANGELOG.md) 的事。

最后更新：2026-11-03（v0.12 文档工作区开发规格）

## 文档工作区 v0.12：本轮已批准的开发规格

用户于 2026-11-03 授权按推荐方向直接开发，并提交现有 GitHub 仓库构建 APK。本轮已实现并随 v0.12.0 发布；下面写的是**已实现的行为契约**，不是待办。仅文档相关内容以本节覆盖旧的一期限制，其余契约不变。

- **导入只保存本机原件与元数据**，不强制读取全文、建索引或调用云解析。无网络、无 AI Key／MinerU Token 也能保存；云解析格式及容量不作为本地导入门槛。
- **应用内只读**：PDF 原版式／缩放，Excel（xlsx/xls）工作表与单元格视图，Markdown 排版及原文、TXT 原文；各阅读器提供本地查找、真实命中计数、前后定位。Word 本地增强后置，既有原件打开和主动云解析保留。
- PDF 没有文本层时可读页面，但不伪报可查；OCR／复杂版面解析继续用用户主动确认的 MinerU。每次云请求（含重试、换通道）明确接收方、文件、通道与限制；浏览／查找／选文档不暗中上传。
- 保存状态、可用正文及内容版本、可问索引分离。按需提取产生正文、来源定位与版本；文档专用切片及 FTS5+bigram 是可重建投影，不写 fragment_fts，不引知识卡／向量模型／服务端。
- 列表多选和阅读器均有可见“问”入口。首版最多同时选择 8 份，问页明确显示范围；仅所选文档可作为本地来源，不混入笔记／其它文档，文档会话默认关闭联网。空／非法范围不得回退全库。
- 会话锁定文档集合，换集合新建会话。历史存范围及引用快照；旧会话默认 records，新数据无效则明确报错。D 引用映射本轮真实 documentId／内容版本／切片／定位，快照保存本轮实际发送的片段，不编原页码。
- 每次问答有完整输入预算（资料＋历史＋问题＋提示词），多文档公平装填；局部检索不得冒充全文通读。超出处理能力保留原件、明确限制，不静默截断为完整结果。
- 应用级任务防重、取消与代次校验覆盖解析和写回；离页不重复上传，删除／取消后迟到结果不覆盖新状态，重试失败保留旧可读正文。
- SQLite 只追加 v10 迁移，保留旧 id／原件路径／正文／会话；迁移事务化并保留迁移前数据库恢复点。现有 Markdown 导出不含文档，不能声称它是完整文档备份。
- 文档内容按不可信资料处理；不执行宏、PDF 脚本、文档指令或自动外链。导入／浏览／查找在本地，用户发送提问才将选定片段交给配置的 AI 服务；这与 MinerU 原件上传分别告知。
- 采用主／子 Agent 分工：主 Agent 独占共享类型、Repo／迁移、路由与集成；子 Agent 按不重叠模块实现。GitHub CI 构建 APK，测试不调用项目付费 AI，不上传用户文件，不本地打包。

实施接口与写入边界见 [本轮协作契约](./docs/plans/2026-11-03-documents-contracts.md)。

> 从 v0.7.2 起又改了几轮，本节以下凡是标了 `（vX.Y.Z）` 的地方都是后续修订。
> **没标年份的段落默认是 v0.7 定的**，读的时候留意版本标注。

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
| 保留 | 时间轴、记录/编辑/详情、搜索、标签/事项筛选、待办（完成/截止/子项/合并/删除/撤回）、月度总结、**知识文档（整理产出）**、Markdown 导出、AI 配置、思维链展示 |
| 新增 | 「问」全屏问答：深度思考 + 联网搜索两个开关，退出可保存会话纪要 |
| 新增 | 「标签」管理：改名 / 合并 / 删除（只改标签，不动碎片） |
| 新增 | 整理自动循环：一次跑完所有批次，最后统一确认；支持断点续跑 |
| 新增 | `fragment_fts` 全文索引（中文 bigram + 英文词）与 `organize_sessions` |

### 0.3 整理与写入（v0.16 重写）

**目标**：把一批碎片读成一篇文档，**先给用户看，改完才写库**。原碎片不动。

1. 材料：从某条碎片进来就只整理那一条；否则取最近的一批（40 条 / 16,000 字，
   用 `packFragments` 而不是 slice —— 一条超长碎片会把整批挤掉）。
   超长时保留前 70% + 后 30%，并在草稿卡上如实写「中间省略了一部分」。
2. 一次请求，输出四个字段：

```json
{
  "title": "群晖换盘",
  "body_md": "## 结论\n4 块 8T，RAID5 重建 30 小时完成。",
  "todos": [{"text": "旧盘跑一次 SMART 长检", "due": null}],
  "note": "覆盖换盘全过程，2 条待办"
}
```

3. 收敛（`util/knowledgeDoc.normalizeDraft`）：空文字待办丢掉；`due` 必须是真实日期
   （`2026-02-31` 会被 `Date` 滚到 3 月 3 日，所以解析回来要和输入比对）；标题超 24 字截断。
4. 草稿落在对话流里，可编辑、可预览（走真正的 Markdown 渲染器）。
   草稿开着时用户说的每一句都是「改哪里」，走 `reviseDraft`，**只改点到的地方**。
5. 写入（`documents/knowledge.ts`）：先插一条 `parsing` 记录，再 `replaceDocumentContent`
   写正文 + 切片 + FTS（同一事务）。写失败删掉空壳。权限位两个：写文档 / 新增待办。

**为什么不再分批**：分批存在的理由是「单轮输出量可控」。现在输出是一篇文章而不是六类 JSON，
一次 40 条碎片的输出量本来就在额度内；再分批反而会让一篇文档被拆成几段互不相干的结论。

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
| 存储 | expo-sqlite（本地 SQLite，迁移到 v10）+ FTS5 全文索引 | 结构化查询、索引、事务；中文用 bigram 分词才能搜两个字 |
| 密钥 | expo-secure-store（Android Keystore 加密） | API Key 不落明文 |
| 文件导出 | expo-file-system + expo-sharing | 生成 md 后走系统分享，可直接存到电脑或网盘 |
| 导航 | 自实现轻量页面栈（5 个页面：时间轴 / 回顾 / 问 / 设置 / 文档；v0.16 删掉整理页） | 不引入 react-navigation，减少依赖与配置成本 |
| 本地阅读与提取 | PDF.js（legacy build，WebView 内跑）+ SheetJS 只读 | 原生 PDF 组件没有文本层，搜不了也提取不出带页码的文字，这是选 WebView 的唯一理由。资源全部内联进 `assets/pdfjs/reader.html`（`file://` 下 ESM 会被 CORS 拦） |
| 文档解析 | MinerU 两条通道：轻量 Agent 接口（免 Token，≤10 MB / 20 页）+ 精准 `/api/v4`（Token，≤200 MB / 200 页，每天 1000 页） | 手机端跑不了版面分析模型。轻量免 Token 且不耗额度，先用它；精准接口换 20 倍体积和旧版 Office 格式。它返回 zip，用 `fflate` 只解 `full.md`（全解会内存雪崩） |
| Web | react-native-web + localStorage 驱动 | **只用来跑编译校验**（`npm run build:web` 打一遍包即删），不做交付、不做界面预览 |

**包名**：`com.local.fragments`（固定）
> 改包名 = 系统视为另一个 App，旧数据不会跟随。若将来要改，先「导出 Markdown」再迁移。

## 4. 功能范围

### 4.1 已实现

**记录**

- 应用内极简输入（打开即写），输入框自动增高，可一键转全屏编辑
- 时间轴按日分组、按日折叠（默认只展开今天），长文超 3 行折叠；月总结固定在该月最上方
- 首页搜索（原文 / 标签 / 事项，内存过滤）+ 标签胶囊筛选，两者叠乘
- **搜索命中可见（v0.10.0）**：命中文字描底色；每条标「N 处」；详情页「第 i / N 处」逐处跳转，
  按段落实测位置滚动，不按字符比例估算
- 碎片详情页：左右滑动切换、整屏内联编辑、正文下方接所属月份的月总结
- 碎片编辑 / 删除
- **时间轴手势（v0.8.8）**：长按复制正文；左滑露出「删除」（二次确认）；右滑直接进「问」并带上这条碎片

**文档工作区（v0.12 重做）**

四个能力分开，对应四种状态，界面上要能分辨：

| 能力 | 门槛 | 状态 | 不成立时 |
|---|---|---|---|
| 导入保存原件 | 无 | `stored` | 只有复制失败/空间不足才失败 |
| 应用内阅读 | 格式支持且不超本地上限 | 只读视图 | 用外部应用打开 |
| 有正文 | 本地提取成功，或用户确认后的 MinerU | `local` / `done` | `failed`，可重试 |
| 能问 | `isDocumentReady()` 为真 | 可勾选 | 列进「待准备」，不静默丢 |

- **导入只保存**：选文件 → 复制进私有目录（核验真实字节数、同名去冲突）→ `state: 'stored'`。
  不读正文、不调 MinerU、不发任何请求。飞行模式与无 Token 都能保存成功。
- **云解析要单独确认**，每次都要（含重试、换通道）：文件名 / 大小 / mineru.net / 轻量还是精准。
  浏览、查找、勾选文档都不许顺手触发。
- **应用内只读**：PDF 原版式与文本层（同一份 PDF.js 同时供渲染、查找、提取）、
  Excel 工作表与单元格、Markdown 排版与原文、TXT 原文、云解析正文的 Markdown 快照。
  Word 本地增强后置，保留外部打开与云解析。
- **先能读，再能查**：PDF 打开不等全篇文字索引，先画第一页；查找在索引完成前
  是「正在索引文字…」而不是「没有」。`hasText` 因此是三态（`true` / `false` / `null`=还没查），
  **不许把 `null` 显示成 `false`**。
- **长文本一律分块渲染**：txt / md / 云解析快照共用同一套分块 + 虚拟列表，
  不把整篇一次布局。分块不得切断代码围栏与表格，且拼回去不许少字。
- **文内查找**：阅读器内搜索框，「第 i / N 处」+ 上下跳，命中描底色。
  确定性字面匹配（`util/highlight.ts`），**不用 FTS 的结果冒充命中总数**；超 99 处显示「99+」。
- **多选去问**：列表可见多选按钮 + 底部「问这 N 份文档」，上限 8（`MAX_ASK_DOCUMENTS`）；
  阅读器另有「问这份」。未就绪的列出待准备项，由用户选择准备/移除/取消。
- **问答范围是契约**：`QaScope` 二选一（全库记录 / 指定文档），空集合报错不回落全库。
  文档模式只查 `document_chunks_fts`，不碰碎片/小结/待办检索，默认关联网。
- **引用带真实位置**：D 引用存 `documentId` + `contentRevision` + `chunkId` + `locator`，
  显示成「《方案.pdf》第 3 页」；没有定位信息只标「正文第 N 段」，**不反推页码**。
- **一次问答一个总预算**：资料 + 历史 + 问题 + 提示词一起算；读不全时 `truncated` +
  `documentCoverage` 如实报覆盖，不拿 topK 结果说「读完了全文」。
- **本地上限**（`LOCAL_READER_LIMITS`）：PDF 48 MiB / 300 页、Excel 12 MiB / 10 万单元格、
  纯文本 4 MiB、正文 200 万字、单片 4000 字、最多 4000 片。超限明确提示，
  **原件保留、外部应用仍可打开**，不静默截断。
- 文档切片**不进 `fragment_fts`**：时间轴搜索不能被文档段落污染。

**整理（v0.16 重做：并进「问」）**

- **没有独立入口**：整理碎片 / 整理待办 / 写月小结 / 提问，都在「问」里用一句话发起，
  由 `util/askIntent.routeAsk` 判定（顺序：月小结 → 待办 → 碎片整理 → 问答）
- 空态三张提示框，点一下等于发一句对应的话（`TASK_SEED`）
- 产出是一篇 Markdown 文档 + 可选待办，**原碎片一个字不动**（不打标签、不合并、不改状态）
- 草稿可编辑 / 可预览；可以继续说一句让它改（只改点到的地方）
- 写入前有两个权限位：写文档 / 新增待办；两个都关掉就明确报错
- 写进文档区走 `replaceDocumentContent`，正文、切片、FTS 一次写完，所以写完就能被「问」检索到
- 历史会话记 `document_id` + `source_ids`：可跳转、可重新整理（用当初那批碎片）、可删除

**问（v0.7.1 新增，v0.8.8 加重构）**

- 聊天式问答，答案只依据检索到的碎片 / 小结 / 待办，模型仍输出 `[F12]` / `[N3]` / `[T5]` / `[W1]`
- **引用小标**：正文里的编号渲染成可点小标，点开底部面板看当时的引用原文；代码里的编号不算
- 本地四路检索（全文 / 时间意图 / 标签意图 / 上一轮引用）+ **右滑带入的上下文碎片** + 预算装填（§0.4）
- **深度思考**与**联网搜索**两个独立开关，对齐 DeepSeek 手机 App chat 页
- **思维链答完不消失**：收成可展开的「深度思考 · N 字」，最新一轮默认展开，随会话持久化
- 联网与本地检索并行；搜索失败只提示，不影响本地回答
- **历史会话**：每轮答完自动落库，不弹退出确认；历史里可归档 / 整理成文档 / 重新整理 / 删除
- 「整理成文档」把这场会话的问答当材料，草稿在对话里审阅，通过后才写进文档区；
  删除会话**不删文档**（文档已经是独立的一篇东西）
- 回答撞额度时标 `truncated` 并提示

**小结**

- 只有月度总结一种（v0.15 起），先预览再决定存不存
- **输出是一张按天的「日期 \| 事件」表 + 3–6 条重要事件与进展**（v0.16）。
  同一天多件事并成一行；事件列 ≤40 字；省略实现细节，但数字/型号/命令/报错原文原样保留。
  完整规则见 **§6.3**
- 位置很明确：
  - 时间轴：月总结落在该月**最后一天**的分区里，排在那天所有碎片之前
    （`periodAnchor` 对月份给的是月末 23:59，不额外造月级分区）
  - 回顾页「小结」：不再有粒度筛选（只剩一种时筛选只是多一次点击），
    列表仍走 `util/digest.ts` 的 `groupNotes`，为了兼容库里可能残留的「主题总结」
- 点任一篇进全屏阅读器（`components/NoteViewer.tsx`），左右滑动范围 = 当前列表
- 卡片只显示前 4 行 + 字数，没有展开/收起 —— 展开交给阅读器（v0.8.3）
- 缺口清单（`util/digest.ts` 的 `missingDigests`）在月小结面板里，点一条直接进生成。
  只算**已经结束**的月份，且只认 `type = 'monthly'` 的已有小结 ——
  旧日小结（period 形如 `2026-10-15`）不许把 `2026-10` 这个月的缺口填掉
- 同月重复生成时给默认勾选的「替换原有总结」，走 `repo.upsertNote`

**标签与待办**

- 标签管理页（回顾页第三个 tab）：改名 / 合并 / 删除，一个输入框搞定改名与合并
- 整理时模型先看已有标签表再决定新建；代码层再按归一化键收敛一次
- 待办（v0.15 重做）：
  - **两层子项**。子项是真的一条待办，能独立勾选、改日期、被合并；只有两层，
    不做无限嵌套（三级缩进在手机上分不清，且自动完成的传递会出中间态）
  - **勾选级联**：勾父项连同全部子项；取消父项连同全部子项；子项全勾完父项自动完成；
    取消任一子项父项退回。判定只在 `util/todoTree.planToggle` 一处
  - **可自建**：新建顶层待办，或给已有待办加子项。以前只能由 AI 整理产生
  - **可编辑**：改文字与到期日（今天 / 明天 / 清除三个快捷）
  - **可合并**：多选几条合成一条，被合并的可在「已合并」里逐条恢复
  - 点击完成、截止日（过期标红）、已完成置灰划线；**已完成只保留最近 5 条**，
    超出部分物理清理（v0.7.3 起，用户明确要求）
  - 删除待办时子项 `parent_id` 置空升为顶层，**不跟着删**

**外观（v0.8.0）**

- 浅色 / 深色 / 跟随系统，默认跟随系统，存在 `settings` 的 `ui_theme`，即时生效不用重启
- 启动屏跟着系统深色走，不会先闪一下白（见 §8 启动屏）
- 状态栏文字明暗跟随

**其它**

- Markdown 导出：时间轴 + 待办 + 标签索引
- Markdown 导入：选文件 → 预览（新增 / 跳过）→ 确认后才写库，见第 7 节
- 设置页：API 配置、连接测试、外观、索引健康度、数据统计、导出导入
- 本地全文索引（FTS5 + bigram），启动时自动校验条数并回填

**正文渲染（v0.8.7）**

| 块 | 支持 | 备注 |
|---|---|---|
| 标题 / 列表 / 段落 | ✅ | 小结的固定形态 |
| 表格 | ✅ | 用 View 排，列宽按内容估权重（夹在 3~18）；不做横向滚动 |
| 代码块 | ✅ | 等宽字体 + 浅底，保留原始换行 |
| 分隔线 | ✅ | `---` / `***` / `___` |
| 行内 | `**加粗**` / `` `代码` `` | 两者互斥，同一个正则扫 |
| 链接 | ❌ | 按原样显示。做成点不动的假链接更糟 |

**卡片预览（`numberOfLines`）走单 Text 路径**，表格降级成一行 `a · b · c`。

**碎片正文也走这一套（v0.8.9）**：时间轴行和碎片详情都用 `NoteBody` 渲染，
`##` 标题 / `- ` 列表 / 表格 / 代码块 / 加粗 / 行内代码都能认。详情页传
`variant="reading"`（正文 17/30，标题和代码放大）和 `selectable`（保留长按选字）。
会话转出来的碎片因此不会满屏 `##` 和 `[F12]`。

**应用内更新（v0.8.4）**

| 项 | 约定 |
|---|---|
| 来源 | `releases/latest`。**不能用 Actions artifact** —— 下载要登录，手机端 403 |
| 比较 | 按 `.` 拆段逐段比数字（`util/semver.ts`）。解析不了一律判相同，宁可漏报 |
| 自动检查 | 启动后 3 秒，6 小时节流，可关；失败静默 |
| 手动检查 | 设置 → 关于 → 检查更新，`force` 绕过节流，结果要给出具体原因 |
| 下载 | `File.createDownloadTask` 的 `onProgress`，可取消 |
| 下载源（v0.11.0 调整顺序） | **多源回退**：自定义地址（设置 → 关于 → 下载地址，拼 `{base}/{apkName}`）→ GitHub 官方直连 → 内置加速镜像（只留 ghproxy 一个，拼 `{proxy}{apkUrl}`）兜底。官方排在镜像前是实测结论：镜像时快时慢，而卡住的连接既不报错也不出字节。候选构建在 `update/mirror.ts` 的 `buildCandidates` |
| 切源判据（v0.11.0） | 巡检每 3s 读一次 `bytesWritten`：**15s 没有新字节**（停滞）就掐掉换源；跑满 60s 且平均 < 25 KB/s 且进度未过 30%（低速）也换，**但仅当后面还有源**（掐最后一个只会变成全失败）。判据必须是「字节数有没有变」，不能看回调有没有来 —— 卡死的连接照样按频率回调。掐源文案里**不能出现 abort/cancel**，上层拿这两个词判断用户取消 |
| 进度节流（v0.11.0） | `setProgress` 至少间隔 250ms；`written === 0`（换源归零）与跑满 100% 两点必须立即生效，否则进度条会停在 99%。不节流时进度条自己就卡 |
| 进度 | 显示「当前源 i/N · 已下载 / 总大小 · 速度」。速度两次采样至少隔 300ms，再做指数移动平均（新值占 30%）—— 回调一秒几十次，直接求差会剧烈跳 |
| 通知 | `expo-notifications`，LOW 渠道 + sticky。**没有前台服务**：切后台后传输继续但 JS 挂起，`onProgress` 不再回调，通知数字停在切走那一刻。要实时只能写原生 ForegroundService（不做） |
| 通知失败 | 一律静默：没授权、渠道被禁、发不出去都不能影响下载 |
| 校验 | 下载完比对 `file.info().size` 与 asset.size，差 >1 KB 判失败 |
| 安装 | `getContentUriAsync`（legacy）+ `IntentLauncher`。Android 7+ 不能传 `file://` |
| 权限 | `REQUEST_INSTALL_PACKAGES`。缺授权时把「重试」换成「去授权」 |
| 跳过 | 勾了「不再提示 x.y.z」就等到下个版本 |

**索引自检的口径（v0.8.5 收紧）**

`selfTestSearch` 返回 `{ checked, hit, viaDuplicate, misses }`：

| 字段 | 含义 |
|---|---|
| `checked` | 能自检的条数。检索词分词后为空的（纯标点/emoji）**不计入** |
| `hit` | 搜回自己，或搜回内容相同的另一条 |
| `viaDuplicate` | 其中「搜回内容相同的另一条」的数量，不算索引问题 |
| `misses` | 真搜不回：`{ id, needle, foundIds }`，**有值才说明索引可能坏了** |

判定步骤：每条约取两段（第 4–9 字、第 9–14 字），任一段能定位到自己就通过；
limit 50（高频词在小库上也可能命中很多条）；内容完全相同的另一条也算通过。

只有 `misses` 非空才把状态图标改成异常，并在下面一行给出碎片 id 与检索词。

**索引可验证（v0.8.0）**

「重建搜索索引」以前只会回一句「已重建 N 条」，而且那句话渲染在页面上方的 AI 卡片里，
人在底部点按钮根本看不见 —— 等于没有反馈。现在：

- `searchIndexStats()`：fts 条数 vs 碎片条数，不等就说明有碎片漏了
- `selfTestSearch(5)`：抽最近 5 条，用正文第 3–8 个字往回搜，看能不能搜回自己
- 设置页常驻显示「索引完整 · 132 条全部可搜」+「抽样自检：5 条全部搜回」
- 重建后的反馈写在索引框里（不是页面顶部），条数有变化时额外标出「原来 N 条」

### 4.2 属于范围但还没做

- **通知栏常驻入口**。技术约束见第 10 节末尾，排期见 [ROADMAP.md](./ROADMAP.md) P0-2。
- **文档接入搜索与「问」**（v0.10.0 只做了阅读库）。索引口径还没定：整篇进 FTS 会让结果全是同一篇，
  按段切才能把引用落到位置。见 [ROADMAP.md](./ROADMAP.md) P1-7。

### 4.3 明确不做

桌面小组件 · 语音转文字 · 定时自动整理 · 自建服务器自动备份 · 多端同步 · 密码锁 ·
图片/链接附件（v0.10.0 起支持整份文档上传，但图文混排里的图片不落地）·
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

-- 「问」的历史会话（v8）。turns_json 存原始问答 + 引用快照；
-- 它不参与检索、不进时间轴，只有「整理为碎片」才写 fragments
CREATE TABLE ask_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,             -- 第一条问题，截 32 字
  turns_json  TEXT    NOT NULL DEFAULT '[]',-- QaTurn[]
  archived    INTEGER NOT NULL DEFAULT 0,
  fragment_id INTEGER,                      -- 已整理成哪条碎片；null = 还没整理
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_ask_sessions_updated ON ask_sessions(archived, updated_at DESC);

-- 文档库（v9 建表；v10 加内容版本与来源）。原文件不进库，只存路径；正文单独一列，列表查询不取它
CREATE TABLE documents (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,             -- 原文件名，含扩展名
  ext              TEXT    NOT NULL DEFAULT '',  -- 小写扩展名，不含点
  size             INTEGER NOT NULL DEFAULT 0,   -- 原文件字节数
  file_uri         TEXT,                         -- App 私有目录里的原文件；失败/被删时为 null
  body_md          TEXT    NOT NULL DEFAULT '',  -- 提取出来的规范正文（不是展示用的 AST）
  pages            INTEGER,                      -- 页数；提取过程没拿到就是 NULL
  char_count       INTEGER NOT NULL DEFAULT 0,   -- body_md.length，供列表显示与就绪判定
  state            TEXT    NOT NULL DEFAULT 'stored', -- stored | local | parsing | done | failed
  error            TEXT,
  -- v10：正文版本与索引版本分开存。indexed_revision < content_revision 表示
  -- 「正文换了、索引还没跟上」，这时可读但不可问
  content_revision INTEGER NOT NULL DEFAULT 0,
  indexed_revision INTEGER NOT NULL DEFAULT 0,
  chunk_count      INTEGER NOT NULL DEFAULT 0,
  content_source   TEXT,                         -- text | markdown | pdf | excel | mineru | legacy
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_documents_updated ON documents(updated_at DESC);

-- v10：文档切片。可重建的搜索投影，独立于 fragment_fts
CREATE TABLE document_chunks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id      INTEGER NOT NULL,
  content_revision INTEGER NOT NULL,  -- 属于哪一版正文；与 documents 当前版本不等即视为过期
  ordinal          INTEGER NOT NULL,
  text             TEXT    NOT NULL,
  locator_json     TEXT    NOT NULL DEFAULT '{}'  -- DocumentLocator：页码 / sheet+单元格 / 行号
);
CREATE INDEX idx_document_chunks_doc ON document_chunks(document_id, content_revision, ordinal);
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(text, tokenize = 'unicode61');
```

索引：`fragments(created_at DESC)`、`todos(done)`、`todos(done_at DESC)`、`todos(merged_into)`、
`organize_sessions(finished, updated_at DESC)`、`ask_sessions(archived, updated_at DESC)`、
`documents(updated_at DESC)`、`document_chunks(document_id, content_revision, ordinal)`。

迁移机制：`PRAGMA user_version` 记录已执行到第几条，`MIGRATIONS` 数组只追加不修改。**当前到 v10。**
v6 做三件事：`DROP TABLE knowledge_cards`、`DROP TABLE ask_logs`、建 `fragment_fts` 与 `organize_sessions`。
v7 给 `todos` 加 `done_at`，用 `created_at` 回填旧完成项，并物理清理超过 5 条的旧完成项。
v8 建 `ask_sessions`：会话正文与引用快照一起存，历史重开不依赖当时的检索结果。
v9 建 `documents`：文档列表与解析结果。
v10 把文档做成工作区：`documents` 加 `content_revision` / `indexed_revision` / `chunk_count` / `content_source`，
建 `document_chunks` 与 `document_chunks_fts`，`ask_sessions` 加 `scope_json`。

**v10 为什么不给旧文档自动建索引**：建索引要跑分词、切片、写 FTS，属于用户点「准备资料」的动作。
借迁移之名做掉，等于用户升级完发现几十篇文档同时开始吃 CPU，而且不知道是谁在动。
旧文档 `content_revision` 保持 0，语义就是「有正文但没建索引」——可读、不可问，直到用户主动准备。

**文档切片为什么不进 `fragment_fts`**：一条碎片和一段 PDF 段落混在同一个索引里，
时间轴的全库搜索会被文档内容污染（搜「报销」时冒出一堆 PDF 段落）。
两个索引各管一件事，问答的文档模式只查 `document_chunks_fts`。


**几条刻意的结构决定：**

| 决定 | 原因 |
|---|---|
| **没有 `tags` 表** | 标签只是 `fragments.tags` 里的字符串，`listTags()` 遍历统计。改名/合并/删除走唯一的 `rewriteTags` |
| **没有 `knowledge_cards`** | 卡片正文只是原文的另一个视图，不产生新信息；时间轴就是知识库 |
| **会话单独放 `ask_sessions`，纪要才写 `fragments`** | 聊天记录每轮都变，写进时间轴会把「知识库」变成聊天日志；用户点「整理为碎片」才沉淀。会话本身要能重开，所以也要持久化 |
| **引用快照跟着会话存** | 碎片可删、小结会被覆盖、待办会合并；只存 id 的话，历史会话里点引用只能得到空面板 |
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

只有**月总结**一种（v0.15 起；日、周的预算 / 提示词 / 入口一起删了）。

| 项 | 约定 |
|---|---|
| 输入 | 该月**全部**碎片（`listFragmentsBetween`，半开区间）+ 待办 |
| 输出 | Markdown，`json: false` |
| 小节 | `## 事件一览`（表格）+ `## 重要事件与进展`（列表），v0.16 起 |
| 表格 | 表头固定 `\| 日期 \| 事件 \|`；**一天一行**，同日多件用「；」并在一行；事件列 ≤40 字；日期 `11-03` |
| 细节取舍 | 省略实现部位（「优化装机脚本」就够）；但数字、型号、命令、报错原文**原样保留** |
| 第二段 | 只写 3–6 件要紧事，`- **事件名**：进展或结论`；不重复表格里已经说清的 |
| 格式 | 除表格外只用 `- ` 列表；不要代码块、嵌套列表 |
| 文体 | 精简优先；不用第一人称；事实/计划/尝试分开（v0.8.2） |
| 字数 | **纯上限** 650 字（含表格）。写不到也行，几十字合法 |
| 素材预算 | 60,000 字；超了保留前 70% + 后 30% |
| 单条截断 | 400 字，换行压成 ` / ` |
| 落位 | `periodAnchor` 对月份给月末 23:59，所以总结落在该月最后一天、排在那天碎片之前 |
| 保存 | 一律 `repo.upsertNote`；同月已有则给默认勾选的「替换」 |
| 对照 | 有旧小结时左右并排（左灰右白），各标字数，顶上一行给字数差（v0.8.3） |
| 批量 | 勾选「还没写的月份」排队生成，逐篇预览、逐篇确认；跳过随时可以（v0.8.3） |

**撞额度直接抛错、不保存** —— 半篇小结以「完整」的身份留在时间轴上，比报错难查得多。

### 6.4 问

契约全文见 **§0.4**，这里是实现约束。

| 项 | 值 |
|---|---|
| 检索 | 四路并集：FTS（40 条）/ 时间意图 / 标签意图 / 上一轮引用；右滑带入的上下文碎片优先 |
| 装填 | 最多 18 条碎片，单条 1,200 字，总 36,000 字；FTS 命中优先 |
| 小结 | 按 token 命中取前 6 篇；**没命中就不给** |
| 待办 | 40 条未完成 + 20 条已完成 |
| 多轮 | 最多 8 轮，**只带问题 + 回答**，不带上一轮资料 |
| 联网 | 与本地检索并行；失败只置 `webError`，本地照常答 |
| 引用 | `[F id]` / `[N id]` / `[T id]` / `[W 序号]`；反查只认本轮给过的编号 |
| 引用展示 | 解析成 `Seg.cite`，按正文首次出现顺序编号；点开 `CitationSheet` 看快照；代码里的编号不解析 |
| 输出 | Markdown，`json: false` |
| 截断 | 标 `truncated`，界面提示，不重试 |

**三条纪律**：只给筛过的资料；网络资料与本地记录必须分开标；检索失败不阻断回答。

### 6.5 问答纪要（整理为碎片）

v0.8.8 起不再在退出时询问；用户在历史会话的「…」菜单里主动点**整理为碎片**。
v0.8.9 起主路径是 **AI 提炼**，不是直接保存：

- `ai/qaSummary.ts` 调一次 `requestChat`（`json:false`），system prompt 要求：
  保留结论 / 关键步骤 / 数字型号 / 待办取舍，删寒暄与引用编号，输出 300-800 字 Markdown；
- 输入总预算 48,000 字，单条回答最多 4,000 字；超预算优先保留最近轮次，并返回
  `omittedTurns`，预览页如实提示；
- `util/qaNote.ts` 的 `buildQaFragment` 负责确定性包装：
  `## 问答纪要 · YYYY-MM-DD HH:mm · N 轮` + AI 精要 + 「参考来源」清单（去引用标记）；
- **先预览后写库**：`AskScreen` 的预览页显示完整碎片，用户点「存为碎片」才 `insertFragment`；
- **兜底**：AI 失败（没 Key / 网络 / 截断）时提供「重试」和「保存全文」；
  「保存全文」走 `buildQaNote`，保留全部轮次和完整答案，不截断；
- 空问题或空答案的轮次不写入；整场都空时不调模型、不写库
- 写成功后把 `ask_sessions.fragment_id` 记上，界面显示「已整理为碎片」，避免重复生成

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

### 8.2 时间轴手势与问页历史（v0.8.8）

**时间轴一行只保留三个动作，各有明确方向：**

| 手势 | 结果 | 为什么 |
|---|---|---|
| 长按 | 复制正文 + 轻提示 | 「拿走这句话」比「就地改」高频；编辑仍在详情页整屏做 |
| 左滑 | 露出红色「删除」，点它再弹二次确认 | 滑动误触率高，不能一步删掉 |
| 右滑 | 直接进入「问」，并带上这条碎片作为上下文 | 从「看到一条」到「问问它」只用一步 |
| 点击 | 进详情页 | 读是主路径 |

`components/SwipeRow.tsx` 用 `PanResponder + Animated`，不引 gesture-handler。
三个硬约束：

- 只在 `|dx| > 8` 且横向明显大于纵向时接管，否则列表滚不动。
- 内容层必须有页面底色，否则关闭状态下能看见底下的红色按钮。
- **不能给容器加 `overflow:'hidden'`**：时间轴竖线靠 `bottom:-8` 伸到下一行，裁了会变成虚线。

**问页头部（v0.8.8）：**

```
┌──────────────────────────────┐
│ (时间)      问       (+)(×)  │  左：历史会话；右：新建 / 关闭
├──────────────────────────────┤
│ ...聊天...                   │
└──────────────────────────────┘
```

- 左上角不再是返回，点它 / 左滑屏幕打开历史会话。
- 右上角「+」开新会话，「×」退出；退出不再问「要不要留纪要」。
- 安卓返回键由 `App` 转发到 `AskScreen.attemptClose`，按层关闭：
  AI 整理预览 → 引用面板 → 删除确认 → 会话操作 → 历史列表 → 页面。

**深度思考面板（v0.8.9）**：每轮答案上方一块 `ReasoningFold`，
标题行「深度思考 · N 字」+ 展开箭头，正文 `selectable`、最高 280px 可滚。
刚答完那一轮默认展开；历史轮次默认收起。流式期间仍显示 `ReasoningStream` 实时面板，
答完切换到折叠块。

**历史会话页**：全屏覆盖层，按 今天 / 昨天 / 更早 分组，归档的单独沉底。
每条右侧「…」是看得见的入口，里面三项：归档 / 取消归档、整理为碎片（AI 提炼）、删除会话。
删除有二次确认；归档不动 `updated_at`，否则归档一下就会跳到列表最前。

**AI 整理预览页（v0.8.9）**：全屏覆盖层，`ScreenHeader` 标题「整理为碎片」。
三态：

- **生成中**：转圈 + 「正在提炼这场会话的要点…」+ 已用秒数 / 已收到字数；
- **失败**：错误原因 + 「重试」「保存全文」「取消」；
- **预览**：`NoteBody` 展示最终碎片（标题 + 精要 + 来源），底部「重新生成」「存为碎片」。

关闭预览等于放弃这次生成；`summaryGenRef` 让迟到的请求结果不再回写界面。
点「存为碎片」才 `insertFragment`，写成功后回历史列表并弹「已存为一条整理后的碎片」。

### 8.3 搜索命中与文档（v0.10.0，文档在 v0.11.0 扩了精准通道）

**搜索命中**

```
┌ 搜索框 ──────────────────────────┐
│ 找到 5 条 · 12 处                 │
├──────────────────────────────────┤
│ 11:40  老张说 [NAS] 4号盘有异响   │
│        [设备] [NAS]      3 处     │  ← 徽标在 meta 行末尾
└──────────────────────────────────┘
```

- 命中文字描底色（`c.amberBg`），**不改字色**：深色主题的正文是浅灰，改色会变成深色压深色。
- 计数与高亮共用 `util/highlight.ts` 的 `findHits`。两套实现会出现「徽标 3 处、正文描 2 段」。
- 统计行三种说法：`找到 N 条 · K 处`（有正文命中）/ `找到 N 条 · 正文无命中`（只命中标签或事项）/
  `没有匹配的碎片`。**不要在有条目时报「0 处」**。
- 详情页顶部第二行「第 i / N 处」+ 上/下按钮；跳转按 `NoteBody.onBlockLayout` 实测的块 y 滚，
  块含表格与代码块。禁用态降透明度，不隐藏。
- 换页（`current` 变）时命中下标归零。`numberOfLines` 预览分支不参与测量。

**文档**

入口在页头「问」的左边（`documents-outline`）。页头动作固定为
`[文档][问][回顾][设置]` + `整理`；窗口宽度 <380 时隐藏品牌副标题。

```
┌──────────────────────────────┐
│ ‹  文档                      │
├──────────────────────────────┤
│        [ 上传文档 ]           │
│  PDF/Word/PPT/图片 → Markdown │
├──────────────────────────────┤
│ 方案.pdf   PDF · 2.1 MB  ✕   │
│ 已解析 18,240 字 · 今天 14:20 │
└──────────────────────────────┘
```

- 上传前有确认卡：文件名、大小、**走哪条通道**（轻量 / 精准，带各自上限）、
  **「会上传到 mineru.net」**、取消 / 开始解析。这段说明是产品要求，不是可选文案。
- 原文件复制进 `Paths.document/documents/`，选择器给的临时 URI 不作长期引用。
- txt / md 本地读文本（`state: 'local'`）；其余走 MinerU，`state` 走 `parsing → done | failed`。
- 两条通道，按 `planForDoc(ext, size, hasToken)` 选：

  | 通道 | 端点 | 上限 | 认的格式 |
  |---|---|---|---|
  | 轻量 | `POST /api/v1/agent/parse/file` → `PUT` → 轮询 → `markdown_url` | 10 MB / 20 页，免 Token | pdf、图片、docx、pptx、xlsx |
  | 精准 | `POST /api/v4/file-urls/batch` → `PUT` → 轮询 `extract-results/batch` → 下 zip | 200 MB / 200 页，要 Token，每天 1000 页 | 上面全部 + doc、ppt、xls |

- 两条通道的上传**都不带 `Content-Type`**，否则预签名校验失败。
- 精准接口返回 zip，用 `unzipSync(buf, { filter })` **只解 `full.md`**：包里还有 `layout.json`、
  `*_content_list.json` 和抽出的图片，大文档全解会 OOM。
- 分派判据只有一份 `util/docSupport.ts`，页面里不允许再写「这个后缀算不算文本」之类的判断。
- 失败保留记录与原文件，阅读器给「重新解析」；重试时有 Token 就 `preferPro`。
  删除是记录 + 原文件一起删，删除要二次确认。
- 一期**不写 `fragment_fts`、不进「问」**。

## 9. 代码结构与分层

文件级清单（含行数）只在 [HANDOFF.md 第 4 节](./HANDOFF.md) 维护 —— 那里是给接手的人看的，
这里只说**结构本身**。

```
screens/      五个页面，各自持有本页状态
   ↓
components/   覆盖层与可复用区块（详情页、结果确认、标签面板、小结面板、
              滑动行 SwipeRow、引用面板 CitationSheet、思维链折叠 ReasoningFold、轻提示 Toast）
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
- [x] **月度总结**（v0.15 起只有月）+ 待补清单；**按天的「日期 | 事件」表 + 3–6 条重要事件与进展**、650 字上限、新旧对照、缺口排队生成
- [x] **「问」v0.7.1 / v0.8.8**：本地四路检索、深度思考 / 联网两个开关、引用小标、
      右滑带入上下文、历史会话（归档 / 整理为碎片 / 删除）
- [x] 待办（v0.15 重做）：回顾页、完成标记、**两层子项与勾选级联**、新建 / 编辑 / 多选合并（可撤回）
- [x] **整理并进「问」**（v0.16）：一句话发起整理碎片 / 整理待办 / 写月小结；产出先审阅可改，通过才写文档；知识文档带摘要与全文检索
- [x] Markdown 导出（时间轴 + 待办 + 标签索引）与**导入**（判重 + 预览确认）、AI 配置与连接测试
- [x] SQLite 迁移到 v9（`todos.done_at` / `ask_sessions` / `documents`）、FTS5 索引与重建入口
- [x] **搜索命中**（v0.10.0）：正文描底色、每条「N 处」、详情页逐处跳转（段落实测 y）
- [x] **文档库**（v0.10.0）：上传 / 原文件留存 / MinerU 轻量解析 / 阅读 / 重新解析 / 删除
- [x] **精准解析通道**（v0.11.0）：Token、200 MB / 200 页、doc/ppt/xls；支持矩阵收敛到 `util/docSupport.ts`
- [x] **下载不再干等**（v0.11.0）：官方直连优先、停滞 15s / 低速 60s 自动切源、进度 250ms 节流
- [x] **更新公告精简**（v0.10.0）：弹窗只留摘要 + GitHub 链接，设置页加仓库与更新记录入口
- [x] Web 平台编译校验（`npm run build:web` 打一遍包确认能过，产物跑完即删，**不做界面预览**）

### 未完成

- [ ] **通知栏常驻入口**（技术约束见本节末尾）
- [ ] **真机回归**：ROADMAP P0-1 列了 71 条（另有 v0.10.0 的 10 条分组），v0.7 的重做与 v0.8.8 的新交互基本没验过
- [ ] **文档接入检索与「问」**（见 4.2 与 ROADMAP P1-7）

### 已知限制

- **整理会重发上下文。** 每批都要带标签表 + 待办清单 + 摘要，批次越多输入 token 越高。
  砍批次省不了钱，砍的只是「单轮峰值」和「失败只废一轮」。
- **FTS 索引体积约为原文的 2 倍**（bigram 的代价）。几千条无感，十万条要重新考虑。
- **「整理为碎片」每次调用一次模型提炼。** 主路径用 AI 把会话压成 300-800 字精要，
  预览确认后才写库；AI 失败 / 没配 Key 时退回「保存全文」（完整转录，不截断）。
  多一次 AI 请求 = 多花一点 token，换来的是碎片不臃肿、不把聊天记录原样堆进时间轴。
- **「问」的历史会话存完整问答 + 引用快照，长会话会占空间。** 目前没有自动清理，
  只在用户主动删除会话时释放；个人量级可接受。
- **Web 端用 localStorage，与 Android 的 SQLite 是两套数据**，**不能用来验证真实数据流** ——
  它唯一的作用是让 `tsc` 之外的打包错误暴露出来。
- **整理会话没有历史列表。** 只有「最近一个未完成的」能续跑；放弃即删。
- **文档解析会把文件发到外网**（mineru.net），轻量通道限制 10 MB / 20 页、精准通道 200 MB / 200 页。
  这是全项目唯一离开手机的内容；txt / md 不上传。解析任务不做后台持久化 ——
  离开页面仍在跑，**杀掉 App 就得重新解析**（记录与原文件都还在）。
- **精准通道的 Token 存在 `settings` 表里，不是 secure-store。** 它和 AI 的 API Key 不同：
  两者都能花钱，但 MinerU Token 只消耗每日页数、不能转账。真要加密再迁也不迟。
- **页数在本地看不出来。** 判断「会不会超 20 页」要解 PDF，所以只能在服务端返回 -30003 之后再引导用户填 Token。
  这也是重试一律 `preferPro` 的原因。

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
