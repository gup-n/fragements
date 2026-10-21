# 交接文档（给下一个模型）

> 写于 2026-10-21，对应版本 **v0.2.3（versionCode 6）**。
> 上一轮上下文快满了，这份文档的目的是让你**不用重读历史对话**就能接着干。
>
> **阅读顺序**：本文件（10 分钟）→ `SPEC.md` 第 6、8.1 节（AI 契约 + Android UI 红线）→ `ROADMAP.md` 剩余项。
> `README.md` 是给人看的门面，`AGENTS.md` 是速查，细节都在 `SPEC.md`。

---

## 1. 三十秒速览

一个**个人单机 Android 应用**，叫「碎片」。核心是「碎片化记录 + AI 整理」：
随手记一条 → AI 整理成标签/待办/知识卡/小结 → 用户逐条确认才写库。

| 项 | 值 |
|---|---|
| 路径 | `F:/coding/python/project/Test/fragments` |
| 包名 / 显示名 | `com.local.fragments` / 「碎片」 |
| 版本 | `0.2.3`，`versionCode 6`，`targetSdk 36` / `minSdk 24` |
| 技术栈 | React Native 0.88 + Expo SDK 58 + TypeScript，新架构，**Android 单端** |
| 存储 | expo-sqlite（native）/ localStorage（web 预览），`PRAGMA user_version = 2` |
| AI | DeepSeek，OpenAI 兼容，`https://api.deepseek.com/v1`，`deepseek-chat` |
| 规模 | 约 4700 行 TS/TSX，`OrganizeScreen.tsx` 一个文件就 1215 行 |
| 最新提交 | `97c3572 feat(v0.2.3): 重构模式` |
| 最新 APK | `fragments-v0.2.3.apk`，22 MB，MD5 `278e799c8d5420b57fc99f6107dcb7d6` |
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
npx expo export -p web --output-dir preview        # 注意目录名必须是 preview
python scripts/build_single_file.py                # 生成根目录的「碎片-界面预览.html」
```

`scripts/build_single_file.py` 把 JS bundle 和 Ionicons 字体全部内联进一个 HTML，双击就能在浏览器里看。
**注意它硬编码读 `preview/`，输出到根目录**，所以 `--output-dir` 必须写 `preview`。
代价：Web 端走 `localStorage`，数据是空的；只能看界面结构，看不到真实数据。

打包 APK（**必须先看第 7 节的坑**）：

```bash
npx expo prebuild --platform android --no-install --no-clean   # --no-clean 不能省
cd android && ./gradlew assembleRelease                        # 增量约 2~3 分钟
```

产物在 `android/app/build/outputs/apk/release/app-release.apk`。

---

## 3. 项目现在的状态

### 已完成（v0.1.0 → v0.2.3）

| 版本 | 内容 |
|---|---|
| v0.1.0 | 时间轴、输入、编辑删除、DeepSeek 整理、知识库、Markdown 导出 |
| v0.1.1 | 冷启动自动聚焦、记完滚回顶部、折叠阈值 60→100 字 |
| v0.2.0 | 回顾页（解决待办/小结数据黑洞）、APK 76→22 MB、构建 45 分钟→2 分钟 |
| v0.2.1 | 首轮真机四条反馈全修（启动闪白、键盘遮挡 ×2、状态栏重叠） |
| v0.2.2 | 多轮追问、新旧对齐（补充已有卡 / 标记待办完成）、返回键收口 |
| **v0.2.3** | **重构模式**（重新整理已整理碎片并与旧结果对照）、归档旧卡、清理待办 |

### 未完成的功能（只剩一个）

- **通知栏常驻入口** —— SPEC 唯一的未完成功能项。技术约束写在 `SPEC.md` 第 10 节末尾：
  Expo 托管流无法做通知栏内直接输入（需原生 `RemoteInput`）。折中方案是 `expo-notifications` 发 sticky 通知，点击打开 App 并聚焦输入框。
  但**需要装包 + prebuild + 重编**，而且 sticky 通知在进程被杀后的存活能力**必须真机验证，不能只看文档**。

### 从未验证过的事（重要）

**v0.2.2 和 v0.2.3 都只是编译通过，没有真机验证过。** 三条都悬着：

1. **追问会不会塌成增量** —— 模型可能只返回改动项，其余内容凭空消失。prompt 里写死了要求，但模型不一定听话。**这是最大风险点。**
2. `todo_done` / `card_update` / `archive_cards` / `drop_todos` 的实际命中率
3. 同一批碎片重构两遍，结果是否稳定（不稳定说明 `temperature: 0.2` 还得再降）

报告这两个版本「可用」之前，请先等用户真机反馈。

---

## 4. 本轮（v0.2.3）到底做了什么

### 4.1 先纠正一个理解错误（这是最重要的背景）

v0.2.2 时我**主动砍掉了用户提的「重构」**，理由写进了文档：「让模型重写全部历史内容，误点就覆盖沉淀，与永不删除原文冲突」。

用户纠正：

> 我的重构意思是针对于原文进行重新整理，重新划分标签等，并与原先的整理做比对选择保留等，可以选择归档/删除等操作，但操作要用户授权

**我把「重构」理解成了「重写知识卡正文」，实际指的是「重新整理原文 + 与旧结果比对 + 用户逐项授权」。** 两者完全不是一回事，原方案根本不重写任何已有正文，那些顾虑不成立。

教训写在 `SPEC.md` 第 10 节：用户提一个功能名时，别用自己的技术直觉替换它的语义。有歧义先问，别急着下「不做」的结论。

### 4.2 设计：一个 `mode` 参数，九项输出

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

### 4.3 四个「由代码保证」的点（别指望模型自觉）

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

### 4.4 补上一个数据黑洞

`knowledge_cards.archived` 字段一直存在，但 `listKnowledgeCards` 过滤了 `archived = 0`，**没有任何界面能看见归档的卡**。
只做归档功能不补入口 = 再造一个数据黑洞（和 v0.2.0 修的待办/小结一个性质）。

已补：`listArchivedKnowledgeCards()`（native + web 两个实现）+ 知识库页「已归档」区，可恢复或彻底删除。

**这条是项目的一个模式**：只要新增一个「让内容从列表消失」的字段/操作，就必须同时提供查看入口。历史上栽过两次。

### 4.5 界面改动

都在 `src/screens/OrganizeScreen.tsx`：

- 顶部 **segmented 切换**：整理未读 / 重构已整理
- 重构范围用 **chip**：最近整理过 / 按主题（主题 chip 显示 `主题 · 卡数`，切到按主题时自动选中第一个，否则池子是空的）
- 重构模式下标签行多一行 **「原标签：…」**，只在真变了时出现（`sameLabels()` 做集合比较，模型重排顺序不算变化）
- 新知识卡行内写 **「会归档被它取代的旧卡：<标题>」**
- 两个新区块带 `hint` 说清后果：「归档后可恢复」「真删除不能撤销，但原文还在时间轴上」

---

## 5. 代码地图

```
App.tsx                       186   路由 state + 全局 BackHandler + 数据加载
index.ts                        8   registerRootComponent
src/
  types.ts                    154   Fragment / Todo / Note / KnowledgeCard / OrganizeResult（九类）
  theme.ts                     52   颜色常量 C、圆角 R、tagColor() 稳定配色
  ai/
    config.ts                  20   读 API 配置（默认值 + repo.getSetting）
    keyStore.ts                37   API Key 存 expo-secure-store（不进 DB、不进导出）
    prompt.ts                 170   SYSTEM_PROMPT（九项）+ buildUserContent + buildRefineContent
    deepseek.ts               376   fetch + parseJsonLoose + normalizeResult（全部校验都在这）+ organize()
  db/
    types.ts                   71   Repo 接口（上下层唯一契约）
    repo.native.ts            388   SQLite 实现 + MIGRATIONS 数组
    repo.web.ts               274   localStorage 实现（仅供桌面预览，功能对齐即可）
    repo.ts                     7   类型转发壳，运行时不会命中
  screens/
    TimelineScreen.tsx        579   时间轴 + 输入 + 长文折叠 + 全屏编辑覆盖层
    OrganizeScreen.tsx       1215   ★ 最复杂：两模式 / 九类确认 / 追问 / 键盘抬升
    KnowledgeScreen.tsx       305   主题聚合 + 卡片 + 已归档区
    ReviewScreen.tsx          243   待办与小结算一页（tab）
    SettingsScreen.tsx        330   BaseURL / 模型 / Key / 连接测试 / 统计
  export/markdown.ts          140   Markdown 导出（时间轴 + 知识库附录）
  util/date.ts                 46   日期格式化
  util/keyboard.ts             39   ★ useKeyboardHeight()，见第 7 节
  components/TagPill.tsx       35   标签胶囊
scripts/
  build_single_file.py       ~100   把 web 产物打成单文件 HTML 预览（见第 2 节）
plugins/
  withBuildOptimizations.js    65   ★ Gradle 优化写回（单 ABI / caching / shrinkResources / JDK）
  withNoSplashAnimation.js    117   ★ 启动窗改纯色、去图标动画
```

**平台分流**：`import { repo } from '../db/repo'` 由 Metro 按扩展名解析，Android 拿 `repo.native.ts`，Web 拿 `repo.web.ts`。业务代码不感知实现。
**改存储层必须同时改两个实现**，否则 Web 预览会莫名其妙地挂。

---

## 6. 数据模型与 AI 契约

### 数据表（`src/db/repo.native.ts` 顶部 `MIGRATIONS`）

| 表 | 关键字段 | 备注 |
|---|---|---|
| `fragments` | `content / created_at / source / status / tags(JSON) / project / merged_into / nature` | `nature` 是 v2 加的，AI 判定的内容性质 |
| `knowledge_cards` | `topic / title / gist / body / source_ids(JSON) / archived` | **`body` 永远是碎片原文拼接，不采信模型** |
| `todos` | `text / due_at / done / source_fragment_id` | `deleteTodo` 是**真 DELETE** |
| `notes` | `type / title / body_md / period` | 小结 |
| `organize_runs` | `fragment_ids(JSON) / result_json / applied` | 每次 AI 调用的原始输出，用于排错 |
| `settings` | `key / value` | API Key **不在这里**，在 secure-store |

迁移规则：**`MIGRATIONS` 数组只追加，永不修改已发布条目**，`PRAGMA user_version` 是游标。
加字段就往数组末尾 push 一段，别动前面的。

### 九类 AI 输出

```json
{
  "tags":          [{ "id": 1, "labels": ["工作"], "project": "报销" }],
  "todos":         [{ "text": "提交报销单", "due": "2026-10-21", "id": 1 }],
  "summary":       { "body_md": "……" },
  "merge":         [{ "keep_id": 3, "drop_ids": [5], "reason": "同一件事" }],
  "knowledge":     [{ "topic": "NAS 维护", "title": "…", "gist": "- …", "source_ids": [4] }],
  "todo_done":     [{ "todo_id": 2, "reason": "…" }],
  "card_update":   [{ "card_id": 4, "add_source_ids": [12], "title": null, "gist": null, "reason": "…" }],
  "archive_cards": [{ "card_id": 7, "reason": "…" }],
  "drop_todos":    [{ "todo_id": 6, "reason": "…" }]
}
```

`knowledge` 里**没有 `body` 字段**，原文由代码从 `source_ids` 拼接。

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

### 7.4 根目录的垃圾（可以删，都已 gitignore）

`preview/` `preview2/` `.edge-tmp*/` `碎片-界面预览.html` `devserver.log` `prebuild*.log` `err.txt` —— 早期预览和调试产物，没有任何代码依赖。

---

## 8. 不可违反的约定（改任何东西之前先看）

1. **只做单机**。不引账号、后端、云同步。任何需要服务器的方案**先问用户**。
2. **AI 只出建议**。整理结果必须经用户逐条确认才写库，绝不自动改数据。
3. **永不删除用户原文**。去重只写 `merged_into`，原文保留并置灰。归档只写 `archived=1`。
4. **数据必须可迁出**。Markdown 导出是底线能力，任何新字段都要考虑导出时怎么表示。
5. **原文保真由代码保证**。知识卡 `body` 一律用碎片原文拼接，不采信模型输出。这条不能寄希望于模型听话。
6. **会「让内容消失」的操作必须默认不勾选，且必须有查看入口**。历史上栽过两次（待办/小结无出口、归档卡无入口）。
7. **改功能先改 `SPEC.md` 再改代码**。文档是这个项目唯一的设计依据，代码可以重写，文档不能落后。

---

## 9. 下一步建议（按优先级）

### P0 — 等用户真机反馈

v0.2.2 / v0.2.3 都没验证过。**在拿到反馈之前不要开始新功能**，否则问题会叠加。
重点问用户三件事（已在交付时列出）：
1. 追问后模型是否输出完整结果
2. 重构时归档/删待办是否过于激进
3. 同一批碎片重构两遍结果是否稳定

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

---

## 11. 一句话交接

**能跑、能装、代码干净、文档齐全。功能上只差一个通知栏入口，但 v0.2.2 和 v0.2.3 的真实表现还没人验证过 —— 先等用户真机反馈，别急着加新东西。**
