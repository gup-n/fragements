# 碎片 · 需求与设计说明书 (SPEC)

> 本文档是跨会话开发的唯一依据。每完成一个功能，同步更新「开发进度」一节。

最后更新：2026-10-21

> 后续开发计划、优先级与待决问题见 [ROADMAP.md](./ROADMAP.md)；面向使用者的项目说明见 [README.md](./README.md)。

---

## 1. 产品定位

一个**个人、单机、只给自己用**的碎片记录工具。

核心价值不是"做笔记"，而是：**随手扔一句 → AI 定期帮你收拢**。

两条设计红线：

1. **记录摩擦必须极低**。打开即输入，输完即消失。任何"先选分类再写"的设计都违背定位。
2. **AI 只做收拢，不做限制**。AI 从不阻止你记录，只在你想整理时提供建议。

### 内容分流（v1.1 新增）

碎片的内容寿命差别极大：「带 U 盘给小李」三天后是噪音，「RAID5 换盘先确认热备」三年后还救人。混在一条时间轴里，后者会被前者淹没。

因此整理时按性质分流到三个去处，**但记录时完全不分类**——判断放在 AI 读过内容之后，不放在用户身上：

| 去向 | 内容特征 | 寿命 | 检索方式 |
|---|---|---|---|
| 待办 | 有明确动作 | 小时～天 | 按状态 |
| 知识卡 | 可复用的方法、事实、结论、坑 | 年 | 按主题 |
| 时间轴 | 事件、琐事、情绪 | 周 | 按时间 |

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
| 框架 | React Native + Expo SDK 58 | 复用已有 TypeScript/React 经验；Expo Go 扫码即可在真机预览 |
| 语言 | TypeScript | — |
| 存储 | expo-sqlite（本地 SQLite） | 结构化查询、索引、事务；导出方便 |
| 密钥 | expo-secure-store（Android Keystore 加密） | API Key 不落明文 |
| 文件导出 | expo-file-system + expo-sharing | 生成 md 后走系统分享，可直接存 NAS |
| 导航 | 自实现轻量页面栈（3 个页面） | 不引入 react-navigation，减少依赖与配置成本 |
| Web | react-native-web + localStorage 驱动 | 便于桌面浏览器预览与调试，不作为交付目标 |

**包名**：`com.local.fragments`（固定）
> 改包名 = 系统视为另一个 App，旧数据不会跟随。若将来要改，先「导出 Markdown」再迁移。

## 4. 功能范围

### 4.1 首版（v1）范围内

- 应用内极简输入（打开即写）
- 长文本承载：输入框自动增高，可一键转全屏编辑；时间轴内超 3 行折叠，点开看全文
- 时间轴流主界面（按日分组、时间戳、整行文本）
- 碎片编辑 / 删除
- AI 整理：分类打标、汇总成日报、提炼待办、关联去重、**沉淀知识卡**（**一次调用产出五类**）
- 整理结果的逐条接受 / 忽略
- **知识库**：按主题聚合，卡片展示 AI 要点，可展开原文，可移出
- 通知栏常驻入口
- Markdown 导出（时间轴 + 知识库附录）
- 设置页：API 配置、数据统计

### 4.2 首版明确不做

桌面小组件 · 语音转文字 · 定时自动整理 · NAS 自动备份 · 多端同步 · 密码锁 · 图片/链接附件 · 全文搜索（数据量小，暂不需要）· 知识卡正文编辑器（v1 只读 + 移出，不做富文本）

架构上为这些预留：`fragments.source` 字段可扩展、`repo` 接口隔离存储实现。

## 5. 数据模型

```sql
-- 碎片本体
CREATE TABLE fragments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  content     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,              -- 毫秒时间戳
  source      TEXT    NOT NULL DEFAULT 'app', -- app | notif | share
  status      TEXT    NOT NULL DEFAULT 'inbox', -- inbox | tagged | merged
  tags        TEXT    NOT NULL DEFAULT '[]',  -- JSON 字符串数组
  project     TEXT,                           -- AI 推断的项目/主题
  merged_into INTEGER,                        -- 被合并到哪条（不删除原文）
  nature      TEXT                            -- v1.1: todo | knowledge | event，AI 判定
);

-- 知识卡（v1.1）
CREATE TABLE knowledge_cards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  topic      TEXT    NOT NULL,   -- 主题，AI 优先复用已有主题
  title      TEXT    NOT NULL,   -- 一句话结论，8-15 字
  gist       TEXT    NOT NULL,   -- AI 提炼的 2-4 条要点，索引层
  body       TEXT    NOT NULL,   -- 原始碎片原文，保真层
  source_ids TEXT    NOT NULL,   -- JSON 数组，来源碎片 id
  created_at INTEGER NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0
);

-- 每次 AI 整理的调用记录（便于回溯与成本核算）
CREATE TABLE organize_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,
  fragment_ids TEXT    NOT NULL,   -- JSON 数组
  model        TEXT,
  result_json  TEXT,
  applied      INTEGER NOT NULL DEFAULT 0
);

-- AI 汇总产出的成稿
CREATE TABLE notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL,     -- daily | weekly | theme
  title      TEXT,
  body_md    TEXT    NOT NULL,
  period     TEXT,                 -- 如 2026-10-20
  created_at INTEGER NOT NULL
);

-- 待办
CREATE TABLE todos (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  text               TEXT    NOT NULL,
  due_at             TEXT,        -- YYYY-MM-DD，可空
  done               INTEGER NOT NULL DEFAULT 0,
  source_fragment_id INTEGER,
  created_at         INTEGER NOT NULL
);

-- 键值配置
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

索引：`fragments(created_at DESC)`、`todos(done)`、`knowledge_cards(topic)`。

迁移机制：`PRAGMA user_version` 记录已执行到第几条，`MIGRATIONS` 数组只追加不修改。当前到 v2。

## 6. AI 接口契约

**服务商**：DeepSeek
**协议**：OpenAI 兼容 `POST {baseUrl}/chat/completions`
**默认 BaseURL**：`https://api.deepseek.com/v1`
**默认模型**：`deepseek-chat`
**结构化输出**：`response_format: { type: "json_object" }`

### 请求

System prompt 约定角色与输出格式；User 消息传紧凑的碎片列表，末尾附上已有主题（让模型优先复用，避免长出「NAS」「nas」「群晖」三个同义主题）：

```
[1] 09:12 报销单还没提交，明天上午弄完
[2] 11:40 老张说 NAS 4 号盘有异响

【已有主题】NAS 维护、装机
```

### 响应（严格 JSON）

```json
{
  "tags":      [{ "id": 1, "labels": ["工作", "财务"], "project": "报销" }],
  "todos":     [{ "text": "提交报销单", "due": "2026-10-21", "id": 1 }],
  "summary":   { "body_md": "今天 7 条，主要围绕…" },
  "merge":     [{ "keep_id": 3, "drop_ids": [5, 9], "reason": "同一件事" }],
  "knowledge": [
    {
      "topic": "NAS 维护",
      "title": "RAID5 换盘前先确认热备盘位",
      "gist": "- 降级后先看存储池状态确认故障盘\n- 热备会自动顶上，别急着拔",
      "source_ids": [4]
    }
  ]
}
```

注意 `knowledge` 里**没有 body 字段**——原文由代码直接从 `source_ids` 对应的碎片拼接，不经过模型。

### 四条铁律

1. **AI 只出建议，不改数据**。所有结果先落为待确认态，用户逐条接受后才写入。
2. **去重永不删除**。`merge` 只写 `merged_into`，原文永久保留，界面上置灰但可查看。
3. **ID 必须校验**。模型返回的 `id` 若不在本次输入集合内，直接丢弃该项。
4. **原文保真由代码保证**。知识卡的 `body` 不采信模型输出，一律用来源碎片原文拼接。「AI 写索引，原话必留」这条不能寄希望于模型听话。

## 7. 导出格式

导出为**单个文件** `fragments-YYYY-MM-DD.md`，内部按天分节：

```markdown
# 碎片导出 · 2026-10-20

共 23 条，覆盖 4 天。

---

## 2026-10-20 周二

- 09:12 报销单还没提交，明天上午弄完 #工作 #财务
- 11:40 老张说 NAS 4 号盘有异响 #设备

---

## 2026-10-19 周一

- 21:30 ……
```

- 标签写成 `#tag`，Obsidian / 任意 Markdown 工具都能识别
- 不做任何专有格式，删掉 App 也读得懂
- **知识库以附录形式追加在同一文件末尾**，按主题分组，每张卡先给要点、再用 `>` 引用给原文：

```markdown
## 知识库

### NAS 维护

#### RAID5 换盘前先确认热备盘位

- 降级后先看存储池状态确认故障盘
- 热备会自动顶上，别急着拔

原文：

> 今天换 NAS 那块盘算是搞明白了一件事……
```

## 8. 界面规范

| 项 | 值 |
|---|---|
| 风格 | 浅色、极简、无渐变无阴影 |
| 主背景 | `#FBFBF9` |
| 卡片 | `#FFFFFF`，0.5px 描边 `#ECECE7` |
| 主文字 | `#1B1B19` |
| 次要文字 | `#6E6E68`，辅助 `#A6A69F` |
| 强调色 | `#185FA5`（蓝） |
| 正文字号 | 15px，行高 1.5 |
| 圆角 | 卡片 12px，按钮 8px，胶囊 999px |

主界面结构（从上到下）：

```
┌─────────────────────────┐
│ 碎片              整理 ⚙ │  头部
├─────────────────────────┤
│ 今天 · 10月20日     7 条 │  日期分组（sticky）
│  09:12 │ 报销单还没提交…  │
│  11:40 │ 老张说 NAS…     │
│ 昨天 · 10月19日     3 条 │
│  21:30 │ …              │
├─────────────────────────┤
│ [ 随手记一条…      ] ↑  │  底部输入
└─────────────────────────┘
```

## 9. 目录结构

```
fragments/
├── App.tsx                  根组件与页面栈
├── SPEC.md
├── app.json
├── src/
│   ├── theme.ts             颜色/字号/圆角常量
│   ├── types.ts             领域类型
│   ├── util/
│   │   └── date.ts          日期分组、时间格式化
│   ├── db/
│   │   ├── types.ts         Repo 接口
│   │   ├── repo.native.ts   SQLite 实现
│   │   ├── repo.web.ts      localStorage 实现（仅供桌面预览）
│   │   └── repo.ts          类型回退，勿直接引用逻辑
│   ├── ai/
│   │   ├── prompt.ts        System prompt 与请求体构造
│   │   ├── deepseek.ts      客户端、错误映射、结果收敛
│   │   ├── config.ts        读写 AI 配置
│   │   └── keyStore.ts      API Key 安全存储
│   ├── export/
│   │   └── markdown.ts      按天分节的 Markdown 导出
│   ├── components/
│   │   └── TagPill.tsx      标签胶囊
│   └── screens/
│       ├── TimelineScreen.tsx
│       ├── OrganizeScreen.tsx
│       ├── KnowledgeScreen.tsx
│       └── SettingsScreen.tsx
```

**平台分流说明**：`import { repo } from '../db/repo'` 在打包时由 Metro 按平台扩展名解析，Android 拿到 `repo.native.ts`（SQLite），Web 拿到 `repo.web.ts`（localStorage）。`repo.ts` 只用于 tsc 类型解析，运行时不会命中。

## 10. 开发进度

- [x] 需求定稿
- [x] Expo 工程骨架（SDK 58 / RN 0.88 / React 19.3）
- [x] SQLite 数据层（迁移 v2：`fragments.nature` + `knowledge_cards`）
- [x] 时间轴主界面与输入（含长文折叠、全屏编辑）
- [x] DeepSeek 接入与整理页（五类输出，段落顺序：待办 → 知识 → 小结 → 分类 → 重复）
- [x] 知识库页（主题聚合 / 卡片要点 / 展开原文 / 移出）
- [x] Markdown 导出（时间轴 + 知识库附录）
- [x] Web 端预览构建通过
- [x] 打包 APK（v0.1.0，`com.local.fragments`，debug 签名，4 个 ABI 共 76MB）
- [x] 体验优化 v0.1.1：冷启动自动聚焦输入框、记完自动滚回顶部、长文折叠阈值 60→100 字
- [ ] **待办页 / 小结页（P0：数据已入库但全项目无 `listTodos`/`listNotes` 调用，用户看不到）**
- [ ] 通知栏常驻入口
- [ ] 真机联调（vivo Y78 / V2278A）

### 体验优化记录（v0.1.1）

| 改动 | 动机 |
|---|---|
| 冷启动自动聚焦输入框 | 记录工具打开就该能打字，「先点一下输入框」是最大的一步多余摩擦。用模块级 `autoFocusedOnce` 标记，保证只在冷启动聚焦一次，从设置页/知识库返回时不重复弹键盘 |
| 记完自动滚回顶部 | 列表滚在下方时新记的条目在顶部，用户会误以为「记了没生效」。用 `SectionList.scrollToLocation` 延迟 140ms 执行并 try/catch 兜底 |
| 折叠阈值 60 → 100 字 | 60 字在手机上才三行，稍微记详细点就被折起来，触发得太频繁 |

### 已知限制

- 知识卡 `body` 直接取原文，长碎片会产生很长的卡。目前可接受（保真优先），若以后觉得碍眼，可加"摘要视图"而不改数据。
- 知识卡正文只读，只能整体移出。想改内容得回原始碎片改，再重新整理。

### 待办：通知栏入口的实现约束

Expo 托管工作流下无法做通知栏内的「直接输入」（需要原生 `RemoteInput`）。
v1 折中方案：用 `expo-notifications` 发一条 **sticky** 常驻通知，点击后打开 App 并自动聚焦底部输入框。
- 需要装 `expo-notifications` 并加 config plugin
- Android 13+ 运行时申请 `POST_NOTIFICATIONS`，代码里用 `Platform.Version >= 33` 判断
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

### 构建时两个必须处理的坑

**坑 1：JDK 版本**
Expo 插件要求 Java 17 toolchain，但系统 `JAVA_HOME` 指向的 `C:\Program Files\Java\jdk-21` 是**无效路径**（实际 JDK 21 在 `D:\Program Files\Java\jdk-21`）。

处理方式：构建时 `unset JAVA_HOME`（靠 PATH 里的 java 跑 Gradle），并在 `android/gradle.properties` 里指定 17 的安装位置：

```properties
org.gradle.java.installations.paths=C:/Users/14428/.jdks/jdk-17.0.20.1+1
org.gradle.java.installations.auto-download=false
```

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

**坑 3：`expo prebuild` 会重置配置**
重跑 prebuild 会重新生成 `android/`，把上面的 `gradle.properties` 两行冲掉。prebuild 之后必须补回。

### 打包命令

```bash
cd F:\coding\python\project\Test\fragments
npx expo prebuild --platform android --no-install   # 仅在改了 app.json / 新装原生依赖时需要
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
