# 文档分类 / 标签 / 审批 / 回收站 / 批量工作流（2026-11-18 用户提出）

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

## 七、还没定的三件事

1. **草稿转正**：写完的草稿是「自动入库」还是「显式点入库」？建议显式 ——
   草稿区就是没想清楚的地方，自动入库会让库里堆半成品。
2. **标签层级**：现在只做平铺。用户提「多个分类」，如果真要「分类/子分类」，
   那是另一张表（`parent_id`），且和「标签」是两个概念，混在一起会两头不讨好。
3. **回收站要不要跨对象批量恢复**：现在建议逐条恢复 —— 一次恢复 20 条碎片，
   恢复完界面该停在哪都没想好。

## 八、和现有铁律的关系

- **永不物理删原文**：回收站把这条从「碎片」扩到「文档与问答会话」，30 天后才真删。
- **破坏性操作默认不勾选**：批量删除、批量改标签都必须显式勾选，且先给条数。
- **AI 只出建议**：提案表是这条规矩的落点，任何 AI 产出在 `pending` 之前不许写业务表。
