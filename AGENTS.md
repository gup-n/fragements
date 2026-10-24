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
npm run build:web                                 # 导出到固定目录 web-preview/（先删后导）
npm run preview                                   # 起本地静态服务 127.0.0.1:8731
npx expo install <pkg>                            # 装依赖用它，别用 npm install

npx expo prebuild --platform android --no-install --no-clean   # --no-clean 不能省！
cd android && ./gradlew assembleRelease
```

项目**零自动化测试**，`tsc` + `export` 是唯一的自动检查。

## 给用户看界面

**`present_files(["http://127.0.0.1:8731"])`** —— 内置浏览器面板会直接打开，用户可点可操作。
服务只起一次，改完代码重跑 `npm run build:web`，浏览器刷新即可。

> 不要再生成单文件 HTML（`build_single_file.py` 已删）。用户 2026-10-24 明确说过「我看不到」。

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

## 七条硬规矩

1. **`prebuild` 必须加 `--no-clean`**。不加会尝试删除整个 `android/`，连 12 MB 的 CMake 缓存一起没，下次编译 45 分钟。
2. **不要手改 `android/`**。它是 `.gitignore` 里的 prebuild 生成物。Gradle 属性改 `plugins/withBuildOptimizations.js`。
3. **不要用 `KeyboardAvoidingView`**。RN 0.88 + edge-to-edge 下算出的位移恒为 0。用 `useKeyboardHeight()`（`src/util/keyboard.ts`）加 `paddingBottom`。
4. **不要用 `Modal`**。它带 `FLAG_LAYOUT_NO_LIMITS`，会画到状态栏下且收不到键盘事件。用 `position:absolute` 覆盖层 + 自己的 `BackHandler`。
5. **存储层改一处要改两处**。`repo.native.ts`（SQLite）和 `repo.web.ts`（localStorage）都要动，否则 Web 预览会挂。
6. **改功能先改 `SPEC.md`**。文档是唯一设计依据。
7. **主题不是实体**，只是 `knowledge_cards.topic` 上的一个字符串。改主题名要批量 `UPDATE`（`repo.retopicCards`），
   别去找 `topics` 表 —— 没有那张表。二级方向同理，是 `subtopic` 列而不是外键。
   因为新建主题的成本为零，prompt 里必须把「大方向一致就复用已有主题」写死，否则模型会给每张卡开一个新主题。

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
- **超时是四段**（建连 90s / 首字 120s / 空闲 60s / 硬上限 6min），不要改回单一总时长。
- **UI 更新要节流**（120ms），否则几百个 chunk 的 setState 会卡死。
- **模型名**：只能用 `deepseek-flash` / `deepseek-v4-pro`。`deepseek-chat`、`deepseek-reasoner` **已于 2026-07-24 停用**，
  调不通。别在示例或文档里再写这两个旧名字。

## 三个 AI 功能的分工（v0.3.0）

请求层统一在 `src/ai/chat.ts`（`requestChat(config, messages, onProgress, options)`），
四段超时、流式回退、错误映射都在那里。**新加 AI 功能不要自己写 fetch。**

| 功能 | 文件 | 输出 | `json` 选项 |
|---|---|---|---|
| 整理 | `ai/deepseek.ts` | 九类 JSON | `true`（默认） |
| 周期总结 | `ai/summarize.ts` | Markdown | **`false`** |
| 知识库问答 | `ai/ask.ts` | Markdown | **`false`** |

- **`json: false` 不能省**。开着 `response_format: json_object` 时模型会把整篇 Markdown 塞进 JSON 字符串，
  换行变 `\n`，界面上糊成一行。
- **取一段时间的碎片用 `repo.listFragmentsBetween(from, to)`**（半开区间），不要用 `listFragments(limit)` 再过滤 ——
  超过 limit 会静默丢掉最早的记录。
- 小结正文用 `<NoteBody>` 渲染（标题 / 列表 / 段落），不要直接把 `bodyMd` 丢进 `<Text>`。

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
| `README.md` | 给人看的项目说明 |
| `ROADMAP.md` | 分级开发计划与待决问题 |
