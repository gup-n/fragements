# 碎片

[![android](https://github.com/gup-n/fragements/actions/workflows/android.yml/badge.svg)](https://github.com/gup-n/fragements/actions/workflows/android.yml)

> 随手扔一句，AI 分批帮你收拢，想不起来的时候还能问它。

个人用、单机、Android 侧载的碎片记录工具。记录时不分类、不打断；整理时 AI 一批一批地过，
全部跑完再统一确认；想找东西时直接问，答不上可以开联网。

| | |
|---|---|
| 应用名 | 碎片 |
| 包名 | `com.local.fragments`（固定，改包名等于换 App，旧数据不跟随） |
| 当前版本 | v0.8.6（versionCode 33） |
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
| 破坏性操作默认不勾选 | 勾了才会删待办 / 合并待办 / 合并碎片（标完成例外） |
| 数据必须能迁出，**也能迁回** | Markdown 是底线能力。只导出不导入等于没有备份，两边都要能跑 |
| 存储层用 `.native.ts` / `.web.ts` 分流 | 业务代码统一 `import from '../db/repo'`，由 Metro 按平台解析 |
| 改功能先改 SPEC 再改代码 | SPEC 是跨会话的唯一依据 |

## 现在能做什么

**外观**：浅色 / 深色 / 跟随系统，设置页第一项，改完立刻生效。默认跟随系统 ——
系统切深色界面跟着切，不用重启。启动屏也会跟着系统走，深色下点开不会先闪一下白。

**记录**：时间轴流按日分组，默认只展开今天、往前的日期收成「日期 + 条数 + 首条摘要」，点一下展开。
顶部搜索框直接过滤碎片原文 / 标签 / 事项，并告诉你其中多少条还没整理。长文超过 100 字或含换行自动折叠。
点一条进全屏详情页，左右滑动看上一条 / 下一条，右上角「编辑」**原地整屏改**，正文下方接着这一天的当天小结。
点标签胶囊或事项名可以只看同类（和搜索框叠乘，有筛选时所有日期自动展开），再点一次取消。

**整理（v0.7 重做）**：一次点击，AI **一批一批自动跑完**，每批 40 条 / 16000 字，
中途会显示「第 3 / 7 批」和实时思维链，可以随时「停止」。
每批跑完立刻存进会话，退出或断网后重进能「继续上次」。
模型每批只输出六类 + 一句摘要：打标签、抽待办、合并碎片、标完成待办、删待办、合并待办。
全部跑完才出**一张确认页**：标签按名字分组（新标签单独标出、和已有标签很像的默认不勾），
会删内容的操作默认都不勾。点「应用」才写库，并回报真实写入条数。

**问（v0.7.1 新增）**：像聊天一样问自己的记录。回答只依据检索到的碎片 / 小结 / 待办，
引用写 `[F12]` 这种编号，点开能看原文。两个开关跟 DeepSeek 手机 App 一样：
**深度思考**（提高推理强度）、**联网搜索**（本地查不到就上网，与本地检索并行，失败不影响本地回答）。
退出时问一句「要不要留下纪要」——存下来的是一条**普通碎片**，进时间轴、能被整理、也能被再次检索。
纪要只保留最近 6 轮、每答前 3 句，是线索不是全文。

**小结**：日 / 周 / 月三种粒度，AI 把该周期**全部**碎片读一遍写成 Markdown，**先预览再决定存不存**。
三节固定为「重点 / 进展 / 待处理」，没有内容的整节省略；字数是**上限**不是目标
（日 150 / 周 300 / 月 500），写得比上限短是正常的。

能做的操作：

- **筛选**：回顾 → 小结顶部切 全部 / 日 / 周 / 月，只有「全部」会把三种混在一起
- **滑动读**：点开任意一篇进全屏阅读器，左右滑动在**当前筛选出来的那批**之间切换
- **对照**：重新生成一个有旧稿的周期，预览页左旧右新并排，各标字数
- **批量**：勾选「还没写的 N 个周期」排队跑，每篇仍然单独预览、单独确认

存下后落在时间轴对应时间点：日/月小结排在那一天最前面，**周总结独占周级分区、固定在该周最上方**。

**标签与待办**：整理时模型先看已有标签表再决定新建，代码层再按归一化键收敛一次，
不会长出「NAS / nas / 群晖」三个同义标签。回顾页第三个 tab 是标签管理，
可以改名、合并、删除（一个输入框：输新名字是改名，输入已有标签名是合并）。
待办支持点击完成、显示截止日（过期标红）、已完成置灰划线；被合并掉的收在「已合并 N 条」里，随时能恢复。已完成待办只保留最近 5 条，更早的会被清理。

**导出 / 导入**：导出是一个 .md 文件（时间轴按天分节 + 待办清单 + 标签索引），
走系统分享可直接存 NAS。导入反过来：**先预览再写库**——共读到多少条、跨哪几天、
会导入多少、跳过多少重复，看清了才点确认。同一个文件导两遍不会翻倍（按「天 + 分钟 + 正文」判重）。

**索引可见**：设置页常驻显示搜索索引的健康度 —— 「索引完整 · 132 条全部可搜」
加一行抽样自检（抽最近 5 条，用正文中的一段往回搜，看能不能搜回自己）。
只有当明明记过、却搜不出来时才需要点「重建」；重建后的结果就写在那个框里。

**更新**：启动 3 秒后自动查一次 GitHub Release，有新版本弹窗提示；设置里可以关掉自动检查，
也可以随时手动点「检查更新」。下载带进度条（已下载 / 总大小），下完交给系统安装器。
支持「不再提示这个版本」——勾了之后要等下一个版本才会再问。

> 更新源是 **GitHub Release**，不是 Actions 的 artifact —— 后者下载要登录。
> 发版流程因此变成：`git tag v0.8.4 && git push --tags`，CI 自动建 Release 并挂 APK。

**尚未实现**：通知栏常驻入口。见 [ROADMAP.md](./ROADMAP.md) P0-2。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React Native 0.88 + Expo SDK 58（新架构） |
| 语言 | TypeScript 6.0 |
| 存储 | expo-sqlite（本地 SQLite，`PRAGMA user_version` 迁移到 v7） |
| 自更新 | `expo-file-system`（下载任务）+ `expo-intent-launcher`（拉起系统安装器） |
| 检索 | SQLite FTS5 + **bigram 分词**（中文两字就能命中；`trigram` 对 <3 字查询不命中，别换） |
| 密钥 | expo-secure-store（Android Keystore） |
| AI | DeepSeek `deepseek-flash`，OpenAI 兼容协议；整理走流式 SSE + `response_format: json_object`，小结与问答走流式纯文本；联网走官方 `/v1/tools/search` |
| 导航 | 自实现轻量路由状态（5 个页面），不引 react-navigation |
| Web | react-native-web + localStorage，**只用来跑编译校验**（`npm run build:web`），不是交付目标，也不做界面预览 |

## 目录结构

```
App.tsx                应用入口、路由状态、数据加载
index.ts               RN 入口
src/
  types.ts             领域类型（Fragment / Todo / Note / OrganizePlan / QaTurn …）
  theme.tsx            两套调色板 + ThemeProvider + useThemedStyles + 标签哈希取色
  version.ts           版本号常量（与 app.json 手工同步）
  ai/                  配置、prompt、请求层、整理循环 / 单批整理 / 问答 / 小结 / 搜索、SSE 解析
  db/                  Repo 接口 + SQLite / localStorage 两个实现 + 写库逻辑 + Markdown 导入
  screens/             五个页面（时间轴 / 整理 / 回顾 / 问 / 设置）
  components/          覆盖层与可复用区块（碎片详情、结果确认、标签面板、小结面板、小结阅读器）
  export/              Markdown 导出的 IO 部分（拼接在 util/mdBuild.ts）
  util/                纯函数：日期、整理计划合并与校验、结果元数据、分词、键盘、纪要、待补清单、Markdown 拼装与解析
plugins/               config plugin（构建优化、启动窗去动画）
scripts/               build_web.mjs（Web 编译校验，产物跑完即删）
                      assert_md.cjs（导入导出往返断言，npm run test:md）
                      make-icon.cjs（生成全部图标，SDF 自绘不依赖图形库）
```

每个文件干什么、多少行，见 [HANDOFF.md 第 4 节](./HANDOFF.md)（那张表每次发版都会校正行数）。

## 开发

```bash
npm run typecheck           # tsc --noEmit，改完必跑（项目没有 lint、没有单测）
npm run build:web           # Web 平台打一遍包，量完体积就删 —— 只当编译校验，不产出预览
npx expo start              # dev server，手机 Expo Go 扫码
```

> **不做界面预览**（用户 2026-10-25 明确要求）。`build:web` 的产物落在 `.tmp-bundle/`
> 并在同一次运行里删掉，根目录不会留下能起静态服务的东西；UI 只靠装 APK 真机反馈验证。

新增依赖用 `npm install <pkg>@<与 SDK 匹配的版本> --registry=https://registry.npmmirror.com`。
`npx expo install` 在这台机器上曾卡 9 分钟无输出（其实已经装好了），所以不用它；
版本号自己核对 `npm view <pkg> versions`，装完确认 `package.json` 里记上了 —— npm 超时被杀时可能只解包、不写清单。

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

### 自动构建（GitHub Actions）

推到 `master` 或打 `v*` tag 会触发 [`.github/workflows/android.yml`](./.github/workflows/android.yml)：
装依赖 → `tsc --noEmit` → `npm run test:md` → prebuild → `assembleRelease`，
产物是名为 `fragments-apk` 的 artifact，挂在这次运行页面底部（保留 30 天）。

实测一次约 **8 分钟**（Gradle 缓存命中后更快）。`release` 沿用 debug 签名，
所以不需要任何 secret —— 仓库是公开的，签名密钥不该进 CI。

改 workflow 时有两个坑：

- **别加 `android-actions/setup-android`。** ubuntu-latest 镜像自带 SDK
  （`/usr/local/lib/android/sdk`），它再去装一遍会和预装目录抢，v0.8.3 第一次 CI
  就挂在这一步。
- **Gradle 缓存要放在 prebuild 之后。** `gradle-wrapper.properties` 是 prebuild
  生成的，提前取 `hashFiles` 永远是空字符串，等于每次换一把新锁。

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

**数据只存在手机本地的 SQLite 里，卸载 App 即全部丢失。** 备份出口是
「设置 → 数据 → 导出 Markdown」，建议定期导出到 NAS 或其他设备；换手机或重装后，
用同一个入口下方的「从 Markdown 导入」往回装。

导出格式里不含 `status` / `project` / 合并关系，导回来按「有标签=已整理」推断；
多行正文在导出时就已经压成一行了。这两点是有损的，知道比不知道好。

API Key 存在 Android Keystore 加密区，不进源码、不进仓库、不上传任何服务器。

## 文档

| 文件 | 内容 |
|---|---|
| [HANDOFF.md](./HANDOFF.md) | **交接文档** —— 项目状态、代码地图、踩过的坑、下一步。换人接手先读这个 |
| [SPEC.md](./SPEC.md) | 需求与设计说明书 —— 跨会话开发的唯一依据，含数据模型、AI 契约、界面规范、构建环境 |
| [CHANGELOG.md](./CHANGELOG.md) | 每个版本改了什么、**为什么**、踩了什么坑 |
| [ROADMAP.md](./ROADMAP.md) | 还没做的事、明确不做的事、待决问题 |
| [AGENTS.md](./AGENTS.md) | AI 助手速查（硬规矩 + 最容易搞错的概念） |
| [TEXTS.md](./TEXTS.md) | 三处模型提示词全文 + 全部界面文案的位置索引。**改文风先看它** |

前五份是正式文档，各答一问：是什么 / 应该怎样 / 现在怎样 / 为什么 / 接下来。
`TEXTS.md` 是查阅用的附录，改提示词时对着它找位置。
