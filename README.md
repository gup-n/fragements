# 碎片

> 随手扔一句，AI 定期帮你收拢。

个人用、单机、Android 侧载的碎片记录工具。记录时不分类、不打断，等你想整理时再让 AI 把一堆碎片归置成待办、知识卡和今日小结。

- **应用名**：碎片
- **包名**：`com.local.fragments`（固定，改包名等于换 App，旧数据不跟随）
- **当前版本**：v0.1.1（versionCode 2）
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
- **AI 整理**：一次调用产出五类结果 —— 分类打标、提炼待办、沉淀知识卡、今日小结、疑似重复；每条独立开关
- **知识库**：按主题聚合，卡片显示 AI 要点，可展开原文，可整体移出
- **Markdown 导出**：时间轴按天分节 + 知识库附录，走系统分享可直接存 NAS
- **设置**：BaseURL / 模型 / API Key 配置与连接测试，数据统计

**尚未实现（重要）**：

- **待办与小结没有查看入口** —— AI 提炼的待办、今日小结会正常写入数据库，但界面上暂时没有任何地方能看到。整理页确认完就"石沉大海"了。这是当前最优先要补的缺口，见 [ROADMAP P0-1](./ROADMAP.md)
- 通知栏常驻入口

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React Native 0.88 + Expo SDK 58（新架构） |
| 语言 | TypeScript 6.0 |
| 存储 | expo-sqlite（本地 SQLite，`PRAGMA user_version` 迁移） |
| 密钥 | expo-secure-store（Android Keystore） |
| AI | DeepSeek，OpenAI 兼容协议，`response_format: json_object` |
| 导航 | 自实现轻量路由状态（4 个页面），不引 react-navigation |
| Web | react-native-web + localStorage，仅供桌面预览，非交付目标 |

## 目录结构

```
App.tsx                      应用入口、路由状态、数据加载
index.ts                     RN 入口
SPEC.md                      需求与设计说明书（改功能先看这里）
ROADMAP.md                   开发计划
src/
  types.ts                   领域类型（Fragment / KnowledgeCard / OrganizeResult）
  theme.ts                   颜色、圆角、标签哈希取色
  ai/
    config.ts                AI 配置读写
    keyStore.ts              API Key 安全存储
    prompt.ts                System Prompt 与请求内容构造
    deepseek.ts              DeepSeek 客户端 + 结果收敛（ID 校验、原文保真）
  db/
    types.ts                 Repo 接口定义
    repo.native.ts           SQLite 实现（Android 实际使用）
    repo.web.ts              localStorage 实现（仅桌面预览）
    repo.ts                  类型回退，运行时不会被 Metro 命中
  screens/
    TimelineScreen.tsx       时间轴主界面
    OrganizeScreen.tsx       整理页（逐条确认）
    KnowledgeScreen.tsx      知识库
    SettingsScreen.tsx       设置与导出
  components/TagPill.tsx     标签胶囊
  export/markdown.ts         Markdown 导出
  util/date.ts               日期分组与格式化
scripts/build_single_file.py 把 Web 产物打成自包含单文件（仅作预览用）
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

产物：`android/app/build/outputs/apk/release/app-release.apk`

**这一步有两个必看的坑**（JDK 路径、Windows 260 字符路径限制），详细说明见 [SPEC.md 第 12 节](./SPEC.md#12-本地打包-apk)。改 JS 的增量构建约 1.5 分钟，首次全量约 45 分钟。

## 数据安全

**数据只存在手机本地的 SQLite 里，卸载 App 即全部丢失。** 「设置 → 导出 Markdown」是唯一的备份出口，建议定期导出到 NAS 或其他设备。

API Key 存在 Android Keystore 加密区，不进源码、不进仓库、不上传任何服务器。

## 文档

| 文件 | 内容 |
|---|---|
| [SPEC.md](./SPEC.md) | 需求与设计说明书 —— 跨会话开发的唯一依据，含数据模型、AI 契约、界面规范、构建环境 |
| [ROADMAP.md](./ROADMAP.md) | 开发计划、优先级与待决问题 |
| [AGENTS.md](./AGENTS.md) | Expo 官方模板自带的 AI 编码指引（通用规则，与本项目实际路由方案有出入，以 SPEC 为准） |
