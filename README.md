# 碎片

> 随手扔一句，AI 定期帮你收拢。

个人用、单机、Android 侧载的碎片记录工具。记录时不分类、不打断，等你想整理时再让 AI 把一堆碎片归置成待办和知识卡；小结单独走周期总结，写不写由你决定。

- **应用名**：碎片
- **包名**：`com.local.fragments`（固定，改包名等于换 App，旧数据不跟随）
- **当前版本**：v0.5.0（versionCode 14）
- **目标设备**：vivo Y78（V2278A）

## 两条设计红线

1. **记录摩擦必须极低**。打开即输入，输完即走。任何"先选分类再写"的设计都违背定位。
2. **AI 只做收拢，不做限制**。AI 从不阻止你记录，只在你想整理时提供建议。

## 工程约定

| 约定 | 原因 |
|---|---|
| 只做单机，不引入账号 / 后端 / 云同步 | 数据在手机上，没有服务器就没有泄露面 |
| AI 结果必须逐条确认才写库 | 决不自动改用户数据 |
| 永不删除用户原文 | 去重只写 `merged_into` 标记，原文保留并置灰 |
| 数据必须能迁出 | Markdown 导出是底线能力，新增字段都要想好导出怎么表示 |
| 存储层用 `.native.ts` / `.web.ts` 分流 | 业务代码统一 `import from '../db/repo'`，由 Metro 按平台解析 |
| 改功能先改 SPEC 再改代码 | SPEC 是跨会话的唯一依据 |

## 现在能做什么

- **时间轴流**：按日分组、时间戳、竖线圆点；长文折叠（超 100 字或含换行）；冷启动自动聚焦输入框
- **极简输入**：底部单行输入框自动增高，可一键转全屏编辑（20000 字上限）
- **编辑 / 删除**：点任意碎片修改；删除需两次点击确认
- **AI 整理**：一次调用产出十类结果 —— 分类打标、提炼待办、沉淀知识卡、疑似重复、标记待办完成、补充已有知识卡、归档旧卡、删除待办、**合并重复待办**、**归并相近主题**；每条独立开关
- **看得到思考过程**：整理时模型一边推理一边把思维链显示在屏幕上，不再对着一个转圈干等；结果页还留了一份折叠的「模型思考过程」，想追问时可以先看看它当初怎么想的。设置里可以关掉思考（更快更省）或调思考强度
- **多轮追问**：结果页底部可以直接说「待办合并成一条」「知识卡太碎了」让 AI 改，改到满意再应用。没改动的条目，之前取消掉的勾选会保留
- **新旧对齐**：已有知识卡和未完成待办始终作为上下文，AI 会主动建议「把这条补进那张卡」「这事已经做完了，标掉吧」「这三条说的是同一件事，并成一条」
- **重构模式**：把碎片重新过一遍 —— 重新判标签、重新沉淀知识卡，结果与原来的整理逐条对照（标签行会写「原标签：…」，新卡会写明「会归档被它取代的旧卡」）。默认范围是**全部碎片**（未整理的也一起带上），也可以只挑已整理的或按主题挑。归档可恢复、删待办是真删除、合并待办可撤回，这三类默认不勾选（标完成待办因为不丢内容，从 v0.3.0 起默认勾选）
- **时间轴可折叠**（v0.4.0）：默认只展开今天，往前的日期收起成「日期 + 条数 + 首条摘要」，点一下展开。顶部搜索框直接过滤碎片原文 / 标签 / 事项，并告诉你其中多少条还没整理
- **碎片详情页**（v0.4.0 / v0.4.2）：点一条进全屏阅读页，左右滑动看上一条 / 下一条；右上角「编辑」**原地整屏改**（不再是中间小窗），保存后当场刷新；正文下方接这一天的当天小结。熟练用户也可以长按列表项直接进编辑
- **回顾页**：待办与小结合在一个页面，tab 切换。待办支持点击勾选完成、显示截止日（过期标红）、已完成置灰划线；被合并掉的待办收在「已合并 N 条」里，随时能恢复；小结按日期倒序，可展开全文
- **周期总结（日 / 周 / 月）**：AI 把该周期的**全部**碎片读一遍写成一篇小结，**先预览再决定存不存**。整理页会列出「N 个周期还没写小结」（今天的也在里面），点一条直接进生成；回顾页也有入口。存下后回到时间轴上对应的时间点，**排在那一天的最前面**（先看结论再看零碎）。只生成总结，不动任何碎片状态
- **整理不再自动写小结**：整理只看 60 条碎片，可能只是某个周期的一部分，在那顺手写出来的小结必然是残的。所以小结只能由周期总结面板产出，不存在「一天出现两条今日小结」
- **已完成标记**：碎片里写明「已经做完了」的事，整理时会建议标掉对应待办（默认勾选），时间轴上那条碎片会带一个「已完成」小徽章
- **知识库**：按主题聚合，主题内还能按「二级方向」分组（卡片够多、方向明显时才分，否则平铺）；卡片显示标题与要点，点开是独立的详情页（大字号读原文，可归档 / 恢复 / 删除）。顶部有**关键字搜索**（跨主题，四个字段全查）和**问模型**（默认当前主题，可切全库；回答只依据卡片内容，并列出它引用了哪几张卡）
- **整理主题**（v0.4.1）：知识库页头进入，勾选多个方向相近的主题合成一个，或者给单个主题改名。只改主题名，卡片一张都不会少；整理时 AI 也会主动提归并建议（默认不勾选）
- **问答能动手**（v0.5.0）：问「把工具和资讯合并掉」，模型不会直接改库，而是给出几条**改动建议**（合并主题 / 主题改名 / 归档旧卡 / 重构卡片），你勾哪条才执行哪条，默认一条不勾
- **联网搜索**（v0.5.0）：卡片里没有的时候，点「联网再查一次」才会去搜。网络资料和「我记过的」在回答里明确分开，并列出 [W1] 这样的来源
- **思考过程自动收起**（v0.5.0）：回答出来之后，思维链收成一行「深度思考 12 秒 ›」，想看再点开
- **问答记录**（v0.5.0）：所有提问进一个独立扁平和区，Q-A 成对、可展开全文、可改问题、可删除。它**不参与卡片检索**（不会让「全库 N 张卡」虚高），想让它进这一轮的上下文就点「带入本轮」
- **Markdown 导出**：时间轴按天分节 + 知识库附录，走系统分享可直接存 NAS
- **设置**：BaseURL / 模型 / API Key 配置与连接测试，数据统计

**尚未实现**：通知栏常驻入口（详见 [ROADMAP.md](./ROADMAP.md)）。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React Native 0.88 + Expo SDK 58（新架构） |
| 语言 | TypeScript 6.0 |
| 存储 | expo-sqlite（本地 SQLite，`PRAGMA user_version` 迁移） |
| 密钥 | expo-secure-store（Android Keystore） |
| AI | DeepSeek `deepseek-flash`，OpenAI 兼容协议；整理走流式 SSE + `response_format: json_object`，总结与问答走流式纯文本；联网走官方 `/v1/tools/search`（手动触发） |
| 导航 | 自实现轻量路由状态（5 个页面），不引 react-navigation |
| Web | react-native-web + localStorage，仅供桌面预览，非交付目标 |

## 目录结构

```
App.tsx                      应用入口、路由状态、数据加载
index.ts                     RN 入口
HANDOFF.md                   交接文档（换人/换模型接手先看这个）
SPEC.md                      需求与设计说明书（改功能先看这里）
ROADMAP.md                   开发计划
src/
  types.ts                   领域类型（Fragment / KnowledgeCard / OrganizeResult）
  theme.ts                   颜色、圆角、标签哈希取色
  version.ts                 版本号常量（与 app.json 手工同步）
  ai/
    config.ts                AI 配置读写（含思考开关与强度）
    keyStore.ts              API Key 安全存储
    prompt.ts                System Prompt 与请求内容构造
    chat.ts                  请求层：多段超时、流式/非流式、错误映射（三个功能共用）
    deepseek.ts              整理：prompt 组装 + 结果收敛（ID 校验、原文保真）
    summarize.ts             周期总结：日/周/月的 prompt、材料裁剪、Markdown 输出
    ask.ts                   知识库问答：关键词打分选卡 + 预算装填 + 引用反查
    stream.ts                SSE 解析：把思维链和正文分开累积
  db/
    types.ts                 Repo 接口定义
    repo.native.ts           SQLite 实现（Android 实际使用）
    repo.web.ts              localStorage 实现（仅桌面预览）
    commit.ts                把用户确认过的整理结果写进库（纯写入，不含 UI）
    repo.ts                  类型回退，运行时不会被 Metro 命中
  screens/
    TimelineScreen.tsx       时间轴主界面
    OrganizeScreen.tsx       整理页（状态机 + 空闲面板；结果渲染在 ResultSections）
    ReviewScreen.tsx         回顾页（待办 / 小结，tab 切换；含「已合并」撤回区）
    KnowledgeScreen.tsx      知识库
    SettingsScreen.tsx       设置与导出
  components/
    FragmentDetail.tsx       碎片详情页（全屏只读 + 左右翻页 + 长按编辑）
    IconButton.tsx           圆形图标按钮（36px 触控区 / 圆底 / 数字角标）
    ScreenHeader.tsx         子页面统一页头（返回圆钮 + 居中标题 + 右侧动作）
    TagPill.tsx              标签胶囊
    NoteBody.tsx             小结正文的轻量 Markdown 渲染（标题 / 列表 / 段落）
    ReasoningStream.tsx      流式生成时的实时面板（思维链 + 字数 + 计时）
    ReasoningTrace.tsx       生成结束后的「模型思考过程」折叠区
    ResultSections.tsx       整理结果页的十类条目与逐条勾选
    BacklogCard.tsx          「N 个周期还没写小结」卡片
    SummarySheet.tsx         周期总结生成面板（选周期 → 生成 → 预览 → 保存）
    KnowledgeDetail.tsx      知识卡详情页（归档 / 恢复 / 删除）
    TopicSheet.tsx           主题整理（勾一个改名 / 勾多个合并）
    AskSheet.tsx             知识库问答面板
  export/markdown.ts         Markdown 导出
  util/date.ts               日期分组与格式化
  util/digest.ts             哪些周期还没写小结（待补清单口径）
  util/resultItems.ts        十类输出的元数据表：确认 key / 默认勾选 / 空结果判定
  util/keyboard.ts           键盘高度 hook（Android 上替代 KeyboardAvoidingView）
plugins/
  withBuildOptimizations.js  构建优化 config plugin（prebuild 时写入 gradle.properties）
  withNoSplashAnimation.js   启动窗改纯色、去掉图标动画
scripts/
  build_web.mjs              导出 Web 产物到固定目录 web-preview/（先删后导）
  preview_server.mjs         本地静态服务，供内置浏览器预览面板访问
```

## 开发

```bash
npx expo start              # 启动 dev server，手机 Expo Go 扫码预览
npx tsc --noEmit            # 类型检查（改完必跑）
npx expo export -p web      # Web 预览构建
```

新增依赖一律用 `npx expo install <pkg>`，它会解析与当前 SDK 匹配的版本，普通 `npm install` 可能装出不兼容版本。

## 构建 APK

```bash
npx expo prebuild --platform android --no-install   # 仅改 app.json 或加原生依赖时
cd android && ./gradlew assembleRelease
```

产物：`android/app/build/outputs/apk/release/app-release.apk`（当前约 **22 MB**）

体积与速度已做过针对性优化。**配置的源头是 [`plugins/withBuildOptimizations.js`](./plugins/withBuildOptimizations.js)**，它在每次 prebuild 时把属性写进 `android/gradle.properties`：

> `/android` 在 `.gitignore` 里，是 prebuild 生成的产物。早期这些优化是手改 `gradle.properties` 的，重跑 prebuild 就会全部丢失、APK 悄悄弹回 76MB —— 所以搬进了 config plugin。

| 配置 | 作用 |
|---|---|
| `reactNativeArchitectures=arm64-v8a` | 只打 64 位 ARM。原来打 4 种 ABI，APK 75MB、C++ 编译量翻 4 倍 |
| `expo.gif.enabled=false` / `expo.webp.enabled=false` | 项目未使用 RN 的 `<Image>`，关掉可移除 Fresco 相关原生库 |
| `android.enableShrinkResourcesInReleaseBuilds=true` | 移除未引用资源 |
| `org.gradle.jvmargs=-Xmx4096m` + `caching` + `workers.max=8` | 本机 15.7G 内存 / 20 线程，加大堆并限制并行度避免 GC 抖动 |
| 图标按需导入 | `import Ionicons from '@expo/vector-icons/Ionicons'`，避免把 19 套字体全打进包（字体 3.3MB → 0.38MB） |

**这一步有三个必看的坑**（JDK 17 路径、Windows 260 字符路径限制、prebuild 会重置 android 配置），详细说明见 [SPEC.md 第 12 节](./SPEC.md#12-本地打包-apk)。改 JS 的增量构建约 2 分钟，首次全量约 45 分钟。

体积对照：76 MB（v0.1.1，4 ABI）→ 22 MB（v0.2.0），减少 **71%**。

## Android 平台约束（改 UI 前先看）

`targetSdk 36` 让 RN 强制开启 edge-to-edge，`windowSoftInputMode="adjustResize"` 因此失效，输入法只是盖在窗口上。三条硬规则：

| 规则 | 原因 |
|---|---|
| 键盘遮挡用 `useKeyboardHeight()` 加 `paddingBottom` | `KeyboardAvoidingView` 在 RN 0.88 + edge-to-edge 下算出的位移恒为 0，等于没生效 |
| 全屏页/弹层用 `position:absolute` 覆盖层，不用 `Modal` | Modal 是独立 Dialog 窗口，带 `FLAG_LAYOUT_NO_LIMITS` 会画到状态栏下，且收不到键盘事件 |
| 覆盖层自己接 `BackHandler` | 没有 Modal 的 `onRequestClose` 兜底，返回键会直接退出 App |
| 启动窗、`AppTheme.windowBackground`、页面底色三者同色 | 任意两段不同色就会看见一次闪白 |

细节与踩坑过程见 [SPEC.md 8.1 节](./SPEC.md#81-android-适配红线v021-真机踩过后定下)。

## 数据安全

**数据只存在手机本地的 SQLite 里，卸载 App 即全部丢失。** 「设置 → 导出 Markdown」是唯一的备份出口，建议定期导出到 NAS 或其他设备。

API Key 存在 Android Keystore 加密区，不进源码、不进仓库、不上传任何服务器。

## 文档

| 文件 | 内容 |
|---|---|
| [HANDOFF.md](./HANDOFF.md) | **交接文档** —— 项目状态、本轮改动、代码地图、踩过的坑、下一步。换人接手先读这个 |
| [SPEC.md](./SPEC.md) | 需求与设计说明书 —— 跨会话开发的唯一依据，含数据模型、AI 契约、界面规范、构建环境 |
| [ROADMAP.md](./ROADMAP.md) | 开发计划、优先级与待决问题 |
| [AGENTS.md](./AGENTS.md) | AI 助手速查（六条硬规矩 + 最容易搞错的概念）。已按本项目改写，不再沿用 Expo 模板内容 |
