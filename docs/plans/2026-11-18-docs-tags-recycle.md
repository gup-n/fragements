# 文档分类 / 标签 / 审批 / 回收站 / 批量工作流（2026-11-18 用户提出）

> **状态（2026-11-18 晚）：已按本稿实现，v0.28.0。**
> 三项待定当日定了：**自动入库 / 标签平铺 / 回收站恢复支持多选**。
> 实现时有三处偏离本稿，理由见文末「九、实现记录」——那三处都是「同一件事只能有一份判据」。

用户原话拆成六块：

1. **文档分类**：个人能新建原始文档（默认分类「草稿」），格式同时间轴（可插图片）
2. **AI 优化 + 审批**：优化/精简后由用户审批，通过则**新建一篇**入库并打标签，不改原稿
3. **标签**：一个文档多个标签（多对多）；AI 可以新建标签，但新建标签也要审批
4. **回收站**：文档 / 碎片 / 问的历史删除都先进回收站，30 天后彻底删；回收站是设置里一个模块
5. **AI 对文档的四种操作**：优化建新篇、打标签、重新整理重打标签、批量工作流（一篇篇过）
6. **用户权限最高**：建文档 / 建标签 / 编辑任意文档（含已入库）/ 删文档 / 关键词搜文档 / 批量删·批量改标签·批量整理

这一版的设计先把**数据与状态**定下来。界面是后面的事 —— 没有表结构，任何界面都是错的。

## 一、现在是什么样

| 已有的 | 在哪 | 缺什么 |
|---|---|---|
| 文档原件 + 抽取正文 + 切片 | `documents` / `document_chunks` | 没有「用户自己写的文档」这种来源 |
| 文档状态 `stored / parsing / ready / failed` | `DocumentMeta.status` | 没有「草稿 / 已入库 / 已归档」这层语义 |
| 文档问答 | `documents/qa` | — |
| 碎片删除是物理删 | `repo.deleteFragment` | 没有回收站 |
| 问的会话删除是物理删 | `repo.deleteAskSession`（或等价） | 没有回收站 |
| 待办/小结已合并/已归档 | `merged_into` | — |

关键判断：**不要新建一套「文档」表**。用户写的文档就是 `documents` 里的一行，
只是 `source = 'authored'`、`origin_id = null`，正文存在现有的 `document_content` 里。
理由：搜索、阅读器、切片、问答、导出全都已经按 `documents` 写好了，
另起一套等于把这些能力复制一遍（v0.23 刚因为「同一件事两份实现」删掉 465 行）。

## 二、表结构（一次迁移 v17）

```sql
-- 1. 文档来源与分类
ALTER TABLE documents ADD COLUMN source   TEXT NOT NULL DEFAULT 'upload'; -- upload | authored | derived
ALTER TABLE documents ADD COLUMN origin_id INTEGER;                        -- derived 指向被优化的那篇
ALTER TABLE documents ADD COLUMN stage    TEXT NOT NULL DEFAULT 'library';  -- draft | library | archived

-- 2. 标签（多对多）。标签是「文档的」概念，碎片的旧标签模块已下线，不要复活
CREATE TABLE doc_tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,          -- 展示名，trim 后唯一
  created_at INTEGER NOT NULL,
  -- pending = AI 新建、等用户批；approved = 可挂；rejected 只留审计
  state      TEXT NOT NULL DEFAULT 'approved'
);
CREATE TABLE doc_tag_links (
  document_id INTEGER NOT NULL,
  tag_id      INTEGER NOT NULL,
  PRIMARY KEY (document_id, tag_id)
);

-- 3. 回收站：一张表管三种东西
CREATE TABLE trash (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,      -- fragment | document | ask_session
  ref_id     INTEGER NOT NULL,   -- 原表 id
  payload    TEXT NOT NULL,      -- 删除那一刻的整行 JSON（含它自己的子行 id 列表）
  deleted_at INTEGER NOT NULL,
  -- 30 天后由启动时的清理任务物理删除；这里只记时间，不记「还剩几天」
  UNIQUE (kind, ref_id)
);

-- 4. AI 提案：审批的唯一入口
CREATE TABLE doc_proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,     -- optimize | tag | retag | batch
  document_id INTEGER,           -- batch 时为 null，明细在 payload
  payload     TEXT NOT NULL,     -- 建议正文 / 建议标签 / 每篇的动作清单
  state       TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER
);
```

三条硬约束：

- **标签名唯一**（`UNIQUE(name)`）：同名两个标签是最常见的脏数据，用户没法分辨。
- **回收站存整行 JSON**，不是只存 id：原行删掉之后 `payload` 是唯一还能恢复的东西；
  配图/原件的文件名也要在里面，恢复时按名字找回文件（找不到就如实说缺哪几个）。
- **提案表不存「应用结果」**：通过后真正写进 `documents` / `doc_tags`，
  提案只留审计。否则「这篇文档是哪个提案生成的」会有两套答案。

## 三、删除一律先进回收站

| 对象 | 现在的行为 | 改成 |
|---|---|---|
| 碎片 | 物理删 + 删配图文件 | 写 `trash(kind='fragment')`，行留在原表**不动**（加 `deleted_at` 更省事，见下） |
| 文档 | 物理删 + 删原件 | 同上 |
| 问的会话 | 物理删 | 同上 |

更省的做法：**不搬行，只加 `deleted_at`**。`trash` 表退化成「索引 + 审计」，
恢复就是 `deleted_at = NULL`，彻底删除才真删行与文件。这样：

- 所有 `WHERE` 都得补 `deleted_at IS NULL` —— 这是这次改动**唯一**的系统性风险，
  用断言钉住：`repo` 里每个列表查询都必须带这个条件（`test:recycle` 一条条查源码）。
- 30 天清理：启动时跑一次 `DELETE ... WHERE deleted_at < now - 30d`，顺带删文件。

> 决策点：`payload` 方案 vs `deleted_at` 方案。**建议 `deleted_at`** ——
> 碎片被删之后问答/导出不该还能看到它，`deleted_at` 让「看不见」只有一处判据；
> `payload` 方案容易在恢复时把关联的图片行、切片行漏掉。

## 四、AI 的四种操作，统一走「提案」

| 操作 | 提案 kind | 通过后发生什么 |
|---|---|---|
| 优化 / 精简个人文档 | `optimize` | **新建**一篇 `source='derived'`、`origin_id=原稿`、`stage='library'`，原稿一个字不动 |
| 给文档打标签 | `tag` | 写 `doc_tag_links`；提案里 `newTags: []` 的标签先建 `state='pending'`，通过后置 `approved` |
| 重新整理已入库文档 | `retag` | 生成新正文 + 新标签 → 仍是**新建 + 归档旧的**（`stage='archived'`），历史可查 |
| 批量工作流 | `batch` | 按选定顺序逐篇生成子提案，**一篇篇审批**，不一次全落库 |

「不改原稿」这条要贯穿到底：`optimize` 与 `retag` 都只产出新行。
用户想改原稿就自己编辑（用户权限最高），不借 AI 的手。

## 五、界面落点（先定位置，再谈样式）

- **文档页**：顶部两个入口 `＋ 新建`、`导入`；列表按 `stage` 分三段（草稿 / 文档库 / 归档）；
  右上角搜索框（关键词搜标题 + 正文，走现有 FTS）；长按进多选，多选后底部工具条
  `改标签 / 整理 / 删除`。
- **标签**：文档详情里一排标签芯片，`＋` 可建新标签（重名直接提示）；
  AI 新建的标签显示「待确认」角标，点开可批可拒。
- **审批**：全覆盖层（同月总结面板的形状），左「原文」右「建议」，底部
  `存为新文档 / 只存标签 / 放弃`。**放弃不写库**。
- **回收站**：设置 → 数据 → 回收站。列三类东西，每行 `恢复` 与 `彻底删除`，
  顶部一句「30 天后自动清空」。空白时说明「删除的碎片、文档、问答会话会先到这里」。

## 六、分几步做（每步都能独立发版）

1. **v0.28 回收站**（只做删除与恢复，不做 AI）—— 它先落地，后面所有删除都受益。
2. **v0.29 个人文档 + 草稿分类**：`source='authored'`、新建/编辑/插图、`stage='draft'`。
3. **v0.30 标签 + 文档多选批量**（改标签 / 删除）。
4. **v0.31 AI 提案与审批**（optimize + tag），先不分批。
5. **v0.32 批量工作流**（一篇篇过）。

## 七、三件事已定（2026-11-18）

1. **草稿转正 = 自动入库**。用户定了自动，与本稿的建议相反，按用户的来。
   读法：文档立刻进库，「草稿」是它出生时挂的标签（`DEFAULT_DOC_TAG`），
   **不是**另一块存放区 —— 所以 `stage` 里没有 `draft`，免得留一个没人写的枚举值。
2. **标签平铺**。不做 `parent_id`，不叫「分类」。
3. **回收站支持多选恢复**。一次误操作通常是十条一起删的，逐条恢复要点十次。
   恢复完停在原地（列表刷新、勾选清空），不做「跳到刚恢复的那条」——
   跨三类对象的跳转落点没法统一。

## 八、和现有铁律的关系

- **永不物理删原文**：回收站把这条从「碎片」扩到「文档与问答会话」，30 天后才真删。
- **破坏性操作默认不勾选**：批量删除、批量改标签都必须显式勾选，且先给条数。
- **AI 只出建议**：提案表是这条规矩的落点，任何 AI 产出在 `pending` 之前不许写业务表。

## 九、实现记录（v0.28 落地时与本稿的三处偏离）

1. **没有 `trash` 表，只有三列 `deleted_at`。**
   本稿内部就给了两个方案，最终选了「不搬行」。`payload` 存整行 JSON 的方案要额外维护
   图片行 / 切片行 / FTS 行的搬回，漏一行就是一条「看起来恢复了、其实没有图」的碎片。
   加一列之后「看不见」只有一处判据，恢复就是置空。代价是每条查询都要带过滤，
   由 `scripts/assert_recycle.cjs` 逐条扫源码钉住。
2. **没有 `source` 列，`origin` 扩到 `authored`。**
   本稿提的 `source = upload | authored | derived` 与已有的 `origin = file | knowledge`
   是同一个问题的两个答案（`knowledge` 就等于 `derived`）。两列并存之后
   「这不是原件」要判两次，迟早只判一边。派生关系用 `origin_id` 表达就够了。
3. **AI 提的新标签不在审批前建行。**
   本稿说「先建 `state='pending'`，通过后置 approved」。落地时改成：审批通过才建标签，
   `pending` 只作为读取时的过滤条件保留 —— 这样 AI 在用户点头前一个字都写不进业务表，
   与「AI 只出建议」这条铁律完全对齐，也少一轮「拒了要不要删那行」的清理。
