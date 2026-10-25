# 碎片

> 随手扔一句，AI 定期帮你收拢。

个人用、单机、Android 侧载的碎片记录工具。记录时不分类、不打断，等你想整理时再让 AI 把一堆碎片归置成待办和知识卡；小结单独走周期总结，写不写由你决定。

| | |
|---|---|
| 应用名 | 碎片 |
| 包名 | `com.local.fragments`（固定，改包名等于换 App，旧数据不跟随） |
| 当前版本 | v0.6.0（versionCode 15） |
| 目标设备 | vivo Y78（V2278A），`targetSdk 36` / `minSdk 24` |
| 数据 | 本地 SQLite，无账号、无服务器、无云同步 |

## 两条设计红线

1. **记录摩擦必须极低**。打开即输入，输完即走。任何「先选分类再写」的设计都违背定位。
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

**记录**：时间轴流按日分组，默认只展开今天、往前的日期收成「日期 + 条数 + 首条摘要」，点一下展开。
顶部搜索框直接过滤碎片原文 / 标签 / 事项，并告诉你其中多少条还没整理。长文超过 100 字或含换行自动折叠。
点一条进全屏详情页，左右滑动看上一条 / 下一条，右上角「编辑」**原地整屏改**，正文下方接着这一天的当天小结。
点标签胶囊或事项名可以只看同类（和搜索框叠乘，有筛选时所有日期自动展开），再点一次取消。

**整理**：一次调用产出十类结果 —— 分类打标、提炼待办、沉淀知识卡、疑似重复、标记待办完成、补充已有知识卡、归档旧卡、删除待办、合并重复待办、归并相近主题；每条独立开关。
结果页底部可以直接追问（「待办合并成一条」「知识卡太碎了」），改到满意再应用；没改动的条目，之前取消的勾选会保留。
生成时模型一边推理一边把思维链显示在屏幕上，结果页也留了一份折叠的「模型思考过程」。

**重构**：把碎片重新过一遍 —— 重新判标签、重新沉淀知识卡，结果与原来的整理逐条对照
（标签行会写「原标签：…」，新卡会写明「会归档被它取代的旧卡」）。默认范围是**全部碎片**，
也可以只挑已整理的或按主题挑。归档可恢复、删待办是真删除、合并待办可撤回，这三类默认不勾选。

**周期总结**：AI 把某一天 / 一周 / 一个月的**全部**碎片读一遍写成一篇小结，**先预览再决定存不存**。
整理页会列出「N 个周期还没写小结」，点一条直接进生成。存下后落在时间轴对应时间点，
**排在那一天最前面**，详情页里也能看到。整理流程不产出小结 —— 那会得到「一天两条今日小结」。

**知识库**：按主题聚合，主题内还能按「二级方向」分组（卡片够多、方向明显时才分）。
卡片显示标题与要点，点开是独立详情页（大字号读原文，可归档 / 恢复 / 删除）。
**分方向**：每个主题下可以再分「二级方向」（比如「NAS 维护」下的「换盘」「备份」）。
三个入口 —— 卡片详情页顶部那行给单张设、主题页页头批量勾选、点某个方向的表头就是整组改名。
输入框留空 = 清掉方向。这是为了让「按方向分组」在老卡片上也用得上：原来只有 AI 整理新卡才会填。

顶部有**关键字搜索**（跨主题，四字段全查）和**问模型**：

- 回答只依据卡片内容，并把引用到的卡片列出来；没有就说没有
- 答不上时可以「联网再查一次」，网络资料与「我记过的」在回答里明确分开，列 `[W1]` 来源
- 想改动什么，模型不直接改库，而是给出**改动建议**（合并主题 / 主题改名 / 归档旧卡 / 重构卡片），**默认一条不勾**
- 回答出来后思维链收成一行「深度思考 12 秒 ›」，想看再点开
- 所有提问进一个独立扁平记录区，Q-A 成对、可改问题、可删除、可「带入本轮」；**不参与卡片检索**

**整理主题**：知识库页头进入，勾选多个方向相近的主题合成一个，或者给单个主题改名。
只改主题名，卡片一张都不会少；整理时 AI 也会主动提归并建议（默认不勾选）。

**待办与回顾**：待办与小结合在一个页面，tab 切换。待办支持点击完成、显示截止日（过期标红）、
已完成置灰划线；被合并掉的待办收在「已合并 N 条」里，随时能恢复。

**导出**：时间轴按天分节 + 知识库附录，走系统分享可直接存 NAS。

**尚未实现**：通知栏常驻入口。见 [ROADMAP.md](./ROADMAP.md) P0-2。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React Native 0.88 + Expo SDK 58（新架构） |
| 语言 | TypeScript 6.0 |
| 存储 | expo-sqlite（本地 SQLite，`PRAGMA user_version` 迁移到 v5） |
| 密钥 | expo-secure-store（Android Keystore） |
| AI | DeepSeek `deepseek-flash`，OpenAI 兼容协议；整理走流式 SSE + `response_format: json_object`，总结与问答走流式纯文本；联网走官方 `/v1/tools/search`（手动触发） |
| 导航 | 自实现轻量路由状态（5 个页面），不引 react-navigation |
| Web | react-native-web + localStorage，仅供桌面预览，非交付目标 |

## 目录结构

```
App.tsx                应用入口、路由状态、数据加载
index.ts               RN 入口
src/
  types.ts             领域类型（Fragment / KnowledgeCard / AskLog / OrganizeResult …）
  theme.ts             颜色、圆角、标签哈希取色
  version.ts           版本号常量（与 app.json 手工同步）
  ai/                  AI：配置、prompt、请求层、整理 / 总结 / 问答 / 搜索、SSE 解析
  db/                  Repo 接口 + SQLite / localStorage 两个实现 + 写库逻辑
  screens/             五个页面（时间轴 / 整理 / 回顾 / 知识库 / 设置）
  components/          覆盖层与可复用区块（详情页、各类 Sheet、结果条目）
  export/              Markdown 导出
  util/                纯函数：日期、待补清单、结果元数据、键盘、提案解析
plugins/               config plugin（构建优化、启动窗去动画）
scripts/               build_web.mjs（导出预览）/ preview_server.mjs（本地静态服务）
```

每个文件干什么、多少行，见 [HANDOFF.md 第 5 节](./HANDOFF.md)（那张表每次发版都会校正行数）。

## 开发

```bash
npm run typecheck           # tsc --noEmit，改完必跑（项目没有 lint、没有单测）
npm run build:web           # 导出到 web-preview/，用来验证不崩
npm run preview             # 起本地静态服务 127.0.0.1:8731，配合预览面板看界面
npx expo start              # dev server，手机 Expo Go 扫码
```

新增依赖一律用 `npx expo install <pkg>`，它会解析与当前 SDK 匹配的版本，普通 `npm install` 可能装出不兼容版本。

## 构建 APK

```bash
npx expo prebuild --platform android --no-install --no-clean   # --no-clean 不能省
cd android && ./gradlew assembleRelease                         # 增量约 2~3 分钟
```

产物：`android/app/build/outputs/apk/release/app-release.apk`（约 22 MB）

体积与速度已做过针对性优化。**配置的源头是 [`plugins/withBuildOptimizations.js`](./plugins/withBuildOptimizations.js)**，它在每次 prebuild 时把属性写进 `android/gradle.properties`：

| 配置 | 作用 |
|---|---|
| `reactNativeArchitectures=arm64-v8a` | 只打 64 位 ARM。原来打 4 种 ABI，APK 75 MB、C++ 编译量翻 4 倍 |
| `expo.gif.enabled=false` / `expo.webp.enabled=false` | 项目未使用 RN 的 `<Image>`，关掉可移除 Fresco 相关原生库 |
| `android.enableShrinkResourcesInReleaseBuilds=true` | 移除未引用资源 |
| `org.gradle.jvmargs=-Xmx4096m` + `caching` + `workers.max=8` | 本机 15.7 G 内存 / 20 线程，加大堆并限制并行度避免 GC 抖动 |
| 图标按需导入 | `import Ionicons from '@expo/vector-icons/Ionicons'`，避免把 19 套字体全打进包（3.3 MB → 0.38 MB） |

**这一步有三个必看的坑**（JDK 路径、Windows 260 字符路径限制、prebuild 会重置 android 配置），
详细说明见 [SPEC.md 第 12 节](./SPEC.md#12-本地打包-apk)。首次全量约 45 分钟。

体积对照：76 MB（v0.1.1，4 ABI）→ 22 MB（v0.2.0），减少 **71%**。

## Android 平台约束（改 UI 前先看）

`targetSdk 36` 让 RN 强制开启 edge-to-edge，`windowSoftInputMode="adjustResize"` 因此失效，输入法只是盖在窗口上。四条硬规则：

| 规则 | 原因 |
|---|---|
| 键盘遮挡用 `useKeyboardHeight()` 加 `paddingBottom` | `KeyboardAvoidingView` 在 RN 0.88 + edge-to-edge 下算出的位移恒为 0，等于没生效 |
| 全屏页 / 弹层用 `position:absolute` 覆盖层，不用 `Modal` | Modal 是独立 Dialog 窗口，带 `FLAG_LAYOUT_NO_LIMITS` 会画到状态栏下，且收不到键盘事件 |
| 覆盖层自己接 `BackHandler` | 没有 Modal 的 `onRequestClose` 兜底，返回键会直接退出 App |
| 启动窗、`AppTheme.windowBackground`、页面底色三者同色 | 任意两段不同色就会看见一次闪白 |

细节与踩坑过程见 [SPEC.md 8.1 节](./SPEC.md#81-android-适配红线v021-真机踩过后定下)。

## 数据安全

**数据只存在手机本地的 SQLite 里，卸载 App 即全部丢失。** 「设置 → 导出 Markdown」是唯一的备份出口，建议定期导出到 NAS 或其他设备。

API Key 存在 Android Keystore 加密区，不进源码、不进仓库、不上传任何服务器。

## 文档

| 文件 | 内容 |
|---|---|
| [HANDOFF.md](./HANDOFF.md) | **交接文档** —— 项目状态、代码地图、踩过的坑、下一步。换人接手先读这个 |
| [SPEC.md](./SPEC.md) | 需求与设计说明书 —— 跨会话开发的唯一依据，含数据模型、AI 契约、界面规范、构建环境 |
| [CHANGELOG.md](./CHANGELOG.md) | 每个版本改了什么、为什么、踩了什么坑 |
| [ROADMAP.md](./ROADMAP.md) | 还没做的事、明确不做的事、待决问题 |
| [AGENTS.md](./AGENTS.md) | AI 助手速查（硬规矩 + 最容易搞错的概念） |
