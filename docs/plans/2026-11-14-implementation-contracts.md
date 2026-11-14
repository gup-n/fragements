# 2026-11-14 实施契约（方案 A 已批准）

用户回复「开始」，本文件细化获批范围内的普通实现边界，不授权推送、发布、数据库关键结构变更或真实数据操作。

## 共享契约（Lead 所有）

### Theme

保持从 `src/theme.tsx` 导入，旧调用可继续工作。Lead 将提供：

- `ThemeMode = 'light' | 'dark' | 'system'`（不变）。
- `ThemeStyle = 'default' | 'ink'`，`normalizeThemeStyle`、`THEME_STYLE_LABEL`。
- `useTheme()` 增加 `style`, `setStyle`, `metrics`, `reduceMotion`, `saveError`，保留 `mode/dark/c/setMode`。
- `useThemedStyles(factory)` 支持 `(c: Palette, metrics: ThemeMetrics)`，返回 `{c, styles, metrics}`；原来的单参数工厂兼容。
- `ThemeMetrics` 字段：`cardRadius`, `buttonRadius`, `strokeWidth`, `controlHeight`（48）, `pagePadding`。
- Palette 保留旧字段，增加 `onDanger`, `mediaBackground`, `mediaForeground`, `mediaScrim`, `controlThumb`, `selection`, `focus`。
- 颜色注册/亮度与风格解析放纯模块 `src/util/appearance.ts`，根主题模块 re-export；所有色表字段完整。主题不改路由、不 remount 页面。
- `saveError` 为 null 或外观保存失败提示；App 的两个 setter 单独持久化旧 `ui_theme` / 新 `ui_style`，最终一次选择获胜。

### Composer

`src/types.ts` 新增 `PendingFragmentImage {key:string;uri:string}`。
Timeline 原来的 `draft:string` / `onDraftChange` 不变，额外 props：

- `pendingImages: PendingFragmentImage[]`
- `onPendingImagesChange: React.Dispatch<React.SetStateAction<PendingFragmentImage[]>>`
- `nextImageKey: () => string`，由 App 返回本生命周期唯一 `p数字`。
- `onAdd(text, images?)` 返回 `Promise<void | string>`；有字符串表示已经保存、但有非致命刷新提示。UI 仍清空已提交草稿，显示该提示，不能诱导重新发布。

Timeline 不再自持 pending 数组/序号。正文、图片同时归 App 生命周期；异步选图/发送期间不得让新输入被旧回调误清空。

### Repo（已先写入接口，Lead 实现两端）

- `listAllFragments(): Promise<Fragment[]>`：不受500上限限制，按 createdAt DESC/id DESC；供完整时间轴与导出。
- `insertFragment` 的 images 项增加可选 `key`。Repo 在同一事务内插入所有图片、把待发标记换成真 id、建 FTS，成功才返回；App 不再在 commit 后补写标记。
- `insertFragmentImages(fragmentId, images): Promise<FragmentImage[]>`：一批图片与FTS原子加入，返回新图片；不存在的碎片/超9张必须失败，不能留部分记录。
- `commitDraft(input: DraftCommitInput): Promise<DraftCommitReceipt>`，类型已在 `src/db/types.ts`。输入只包含用户允许/选择的目标；调用方用 `contentFromText` 生成文档内容，Repo 不依赖阅读器。
- `DraftCommitInput`：`draftId`, `documents:[{key,title,excerpt,content}]`, `todos:[{key,text,dueAt,children:[{key,text,dueAt}]}]`, `sourceIds:number[]`, `sessionId:number|null`。
- `DraftCommitReceipt`：`documents:[{key,id,name}]`, `todos:[{key,id}]`，是该草稿至今全部已写入项（含前次调用）。key 是本地稳定身份，不是数组下标。
- 现有 settings 表以 `draft.commit.<draftId>` 存提交凭据。新文档/正文/切片/FTS、父子待办、凭据、来源标记、存在的历史会话关系原子提交。不更新旧条目正文，不因重复同key复制。
- 凭据异常必须失败，不能当成没有凭据重插。已写项被用户后来删除时也不偷偷重建。无写入目标应由调用方阻止，Repo 亦拒绝空计划。

### 搜索投影

Lead 在 `src/util/fragmentText.ts` 提供 `fragmentSearchText(f)`：去图片标记的正文 + 图片文字 + 事项；没有 tags。UI 的过滤/命中应使用可见内容并为OCR命中提供可见预览，不能出现“搜到但找不到原因”。Native/Web 搜索与索引由Lead同步。

## 写入范围

1. **Lead**：App、theme、util/appearance、全局 types、db/types/repo/importMd、fragmentText/tokenize/mdBuild/mdParse、export、规格/包脚本/项目记录、最终资源生成与Git提交。
2. **UI 子 Agent**：TimelineScreen、SettingsScreen、ReviewScreen；IconButton、ScreenHeader、TodoPanel、TodoEditor、SummarySheet、UpdateSheet、ImportSheet、CitationSheet、Toast、SwipeRow、ReasoningFold/Stream/Trace、AgentError；新增必要的小型纯UI组件。不能改Lead/其它Agent所有文件。
3. **逻辑子 Agent**：AskScreen、components/KnowledgeDraft、DraftDocPage、src/ai/knowledge、util/knowledgeDoc、askIntent、batch；新增 `src/organize/` 控制/持久化模块。负责草稿稳定ID/授权、历史/session-source、原来源重试、全量id快照与草稿持久化恢复，接入commitDraft，并对Ask做本期必要UI/墨水适配。
4. **阅读器子 Agent**：DocsScreen、DocViewer、FragmentDetail、NoteBody、NoteViewer、src/documents/readers/（含PDF产品模板）。只改模板/协议源，不生成 `assets/pdfjs/reader.html`；Lead 最后生成，避免资源冲突。
5. **测试子 Agent**：新增 `scripts/assert_reliability.cjs` / `scripts/assert_appearance.cjs` / `scripts/test_loader.cjs`。不改现有断言、不改package、不改生产代码、不运行与其他任务冲突的编译。新增断言最终由Lead统一执行。

## 共同规则

- 先 get/claim 任务；完成时报告文件、行为、验证和未覆盖点。多人同仓库，不切分支、不commit、不push、不装依赖。
- 普通小重构可自主完成；要改共享接口先向Lead说明，不自行改契约。
- 新草稿持久化使用现有settings键，不新建表；旧游标不代表保存成功。恢复只显示/恢复本地状态，不自动重发AI。已取消选择不能被改稿恢复；有无法匹配的新项时保守不预勾并明确提示。
- 保持不自动上传、显式权限、云解析逐次确认；不用Modal、KeyboardAvoidingView、导航库。
- 所有源码修改必须有可检验结果，不降低旧测试。无设备/无图像能力时明确未真机/视觉验证，不生成HTML预览或本地APK。
