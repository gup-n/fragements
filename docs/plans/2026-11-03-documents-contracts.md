# v0.12 文档工作区协作契约

2026-11-03：用户已授权按推荐方案开发并推送 GitHub CI APK。产品边界以 [SPEC.md](<../../SPEC.md>) 顶部本轮规格为准。本文件是并行实现接口，不是新的产品规范。

## 所有者与写入边界

- Lead：共享 [types.ts](<../../src/types.ts>)、[db/types.ts](<../../src/db/types.ts>)、native/web Repo、App、package/lock、CI、共享 mdBlocks/NoteBody/highlight、正式文档与版本。
- document-audit（生命周期子任务）：DocsScreen、DocViewer、db/docFiles、util/docSupport、ai/mineru、新建 src/documents/jobs.ts；可写 scripts/assert_document_jobs.cjs。不要改 reader 子目录或共享接口。
- reader-runtime（阅读器子任务）：新建 src/documents/readers/**、assets/pdfjs/**、scripts/prepare_pdf.mjs、scripts/assert_readers.cjs；不要改 package/lock/App/types/其它子任务的文件。
- qa-audit（问答子任务）：ai/qa、screens/AskScreen、components/CitationSheet、util/qaNote、ai/qaSummary、新建 ai/documentRetrieval.ts 与 scripts/assert_document_qa.cjs；不要改共享 mdBlocks/NoteBody/types/Repo。
- 主 Agent 最后统一审查 diff、测试、更新文档并 commit/push/tag；子 Agent 不提交、不推送、不修改依赖，不运行生产/付费 AI 或上传用户文件。

## 共享领域接口（由 Lead 实现）

所有类型导出于 `src/types.ts`：

```ts
type QaScope = { kind: 'records' } | { kind: 'documents'; documentIds: number[] };
const MAX_ASK_DOCUMENTS = 8;
interface DocumentLocator {
  kind: 'text' | 'markdown' | 'pdf' | 'sheet';
  page?: number; sheet?: string; cellRange?: string;
  rowStart?: number; rowEnd?: number; lineStart?: number; lineEnd?: number; section?: string;
}
type DocumentContentSource = 'text' | 'markdown' | 'pdf' | 'excel' | 'mineru' | 'legacy';
interface DocumentChunkInput { text: string; locator: DocumentLocator; }
interface DocumentContentInput { bodyMd: string; chunks: DocumentChunkInput[]; source: DocumentContentSource; pages: number | null; }
interface DocumentChunk extends DocumentChunkInput { id: number; documentId: number; contentRevision: number; ordinal: number; }
```

DocumentMeta 增加 contentRevision/indexedRevision/chunkCount/contentSource；DocState 增加 stored。旧正文、id、URI 不丢。QaCitation.kind 增加 D；D 用 documentId/contentRevision/chunkId/locator 稳定定位，id 只是本轮 D1 等别名。QaTurn 增加可选 truncated/documentCoverage；AskSession.scope 必填。QaOutcome.scope 必填，可选 documentCoverage/inputTruncated。DocumentCoverage 字段为 documentId/name/includedChunks/totalChunks/usedChars/totalChars。

Lead 提供 `src/documents/formats.ts`：

- `documentFormat(ext): 'pdf'|'excel'|'markdown'|'text'|'other'`
- `supportsLocalDocument(ext): boolean`
- `isDocumentReady(doc: DocumentMeta): boolean`：有效版本＋当前索引＋非空正文/切片，parsing 期间不可新问。
- `locatorLabel(locator): string`；无位置不猜原页码。
- `LOCAL_READER_LIMITS`：初始 PDF 48 MiB/300页、Excel 12 MiB/100000实际单元格、纯文本4 MiB、规范正文2000000字、单片4000字、最多4000片。超出时原件仍保存/可外部打开，必须明确提示，不静默切掉数据。

Lead 提供 `src/util/qaScope.ts`：

- `normalizeQaScope(value: unknown, allowLegacyMissing = false): QaScope`：默认拒绝缺失/非法/空文档集合；仅旧会话加载显式允许缺字段变 records。
- `qaScopeKey(scope): string`；用于会话范围比较。

Repo 增加：

```ts
replaceDocumentContent(id: number, content: DocumentContentInput, expectedRevision: number): Promise<boolean>;
listDocumentChunks(documentId: number): Promise<DocumentChunk[]>;
searchDocumentChunks(query: string, documentIds: number[], limit?: number): Promise<DocumentChunk[]>;
```

replace 是正文、版本、切片、FTS 的原子更新；已删除或版本变了返回 false。普通 updateDocument 只用于状态/错误，写正文应改用 replace。空 documentIds 返回空，任何降级同样限定白名单。list/search 仅返回就绪当前版本。saveAskSession 输入增加必填 scope。旧正文没有切片时由本地“准备资料”从缓存正文建立 legacy/原文本来源切片，不得因此自动云解析。

## 阅读器与本地提取（reader-runtime 实现）

统一入口 `src/documents/readers/index.ts`（或同名 .tsx）：

```ts
interface LocalExtractOptions { signal?: AbortSignal; onProgress?: (text: string) => void; }
function DocumentReader(props: { document: Document }): React.ReactElement;
function DocumentRuntime(): React.ReactElement | null;
function extractLocalDocument(document: Document, options?: LocalExtractOptions): Promise<DocumentContentInput>;
function contentFromText(text: string, source?: DocumentContentSource): DocumentContentInput;
```

- DocumentReader 自带阅读器内的查找框/命中计数/前后跳转；只做本地阅读，不自动入库或远程处理。可复用已有正文；TXT/MD 未准备时允许在本地读取后显示，属于用户打开动作，不是上传强制解析。
- DocumentRuntime 由 Lead 常驻挂在 App 下，承接必要的 PDF 本地提取 WebView 队列，不能依附文档页生命周期。原生组件必须有 Web 编译兜底。
- PDF 首选本地 PDF.js+WebView 方案，实际阅读与提取共用离线资源。禁止第三方在线查看器、远程脚本、自动外链；不执行文档脚本。不把巨大文件整份 base64 经过 RN bridge，优先私有本地 URI＋受限文件访问；字体/CMaps/worker 等离线资源与中文文本层要处理。
- 依赖由 Lead 安装：react-native-webview 14.0.1（SDK58 bundledNativeModules 指定）、expo-asset ~58.0.17（若需要）、固定 pdfjs-dist 版本、SheetJS 官方 tarball固定版本。发现需要其它构建工具先告知 Lead。
- Excel 读取 workbook 的工作表/单元格，使用只读表格视图；不做公式重算/宏/外链。大 !ref 稀疏区不能无限迭代。宽表不能丢列。
- contentFromText 必须基于完整文本，不用会裁列/去引用的现有 mdBlocks AST；切片不漏末尾，位置为真实行/章节。PDF chunk.page、Excel sheet/cellRange 来自解析结果；legacy/MinerU 纯 Markdown 只给正文位置，不猜原文件位置。
- 扫描 PDF：可显示，但提取无文字时明确不可问，需要用户另点云解析；空 TXT 是可正常阅读的空文本。

## 文档流程（document-audit 实现）

- DocsScreen 新增 `onAsk: (documentIds: number[]) => void`；DocViewer 也提供可见单篇问入口。
- 导入调用文件保存＋insertDocument({state:'stored'}) 后结束，不触发 readPlainText/parseDocFile/prepare。核验副本真实大小，同名去冲突。
- jobs.ts 提供 `prepareDocumentLocal(id): Promise<void>`、`cancelDocumentJob(id): void`、`getDocumentJob(id)` 与订阅或 hook（最终具体事件类型自行实现并回报）。由任务服务唯一执行内容写回，使用 runId/AbortSignal/expectedRevision；组件只订阅，退出不重复上传。
- 云解析入口确认文件／mineru.net／轻量或精准后，调用服务的显式 cloud prepare；重试也先确认。不允许选中文档或去问自动转云。
- 多选尚未就绪时显示哪些待准备，可显式“在本地准备”；全部就绪才 onAsk，不偷偷丢文件。最多8份。
- 删除先停止任务，文件清理失败如实反馈并可重试；已解析正文及原件不因解析失败被清掉。取消不能声称撤回已经上传的字节。

## 问答（qa-audit 实现）

- AskScreen 新增 `initialScope?: QaScope`，默认 records；历史加载以保存的 scope 为准，新开会话需明确当前范围，不能隐式带旧临时选择。
- askQuestion 接收 `scope?: QaScope`，无 scope 的旧调用仅默认 records；传入 documents 的非法集合必须报错。文档模式不调用任何碎片/小结/待办检索。
- 不在问答层自动提取/上传。重新核对所选 doc 状态和版本；不存在/未就绪列明错误。选8份不能只读取第1份。
- 精确问检索先保证每篇有相关命中的文件有预算，再补相关片段；全文概括有单独覆盖策略；读取不全就如实标部分片段。
- 文档模式默认不开联网；首版可以直接禁用联网以保证来源范围，记录模式保持原能力。
- 统一整个输入（system＋资料＋问答历史＋当前问题）的预算；保存 truncated，展示遗漏覆盖。
- D 快照正文必须等于本轮实际发送片段；编号验证复用 collectCitations（Lead扩展D），排除代码；旧来源只在当前范围/版本下回带。
- 需要引用打开原件可在 CitationSheet 读取当前 documentId 后走已有 openOriginal，原件已删除/版本变化要如实提示，快照始终可读。

## Lead 共享渲染改造

mdBlocks 的引用类型扩展D；NoteBody 新增可选 `literalCitations?: boolean`，文档普通字符串不当引用且不消失；宽表不静默裁列。Reader 若用 NoteBody 必传 literalCitations。默认问答引用语义继续保留，代码块/行内代码不计入引用。

## 验证与集成

子 Agent 各写命名独立的断言脚本/纯函数，提出编译入口；不并发运行会写同一临时目录的 tsc。Lead 最后接 package scripts，运行 typecheck、test:md、新文档专项、check:docs、build:web并按原脚本清理产物；再推送CI构建。没有真机的地方必须标明未验，不以删除断言或降低条件造通过。
