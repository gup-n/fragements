/**
 * 构建优化配置插件
 *
 * 为什么需要它：`/android` 在 .gitignore 里，是 `expo prebuild` 生成的产物。
 * 之前所有体积/速度优化都是手改 android/gradle.properties，一旦重跑 prebuild
 * 或换机器克隆，这些改动全部丢失 —— APK 会悄悄弹回 76MB。
 *
 * 这个插件在每次 prebuild 时把这些属性重新写进去，让优化跟着代码走。
 * 修改这里之后需要重新 `npx expo prebuild --platform android` 才生效。
 */
const { withGradleProperties } = require('expo/config-plugins');

/**
 * 本项目专属的 gradle.properties 覆盖项。
 * 模板自带且已满足要求的属性（useAndroidX / newArchEnabled / hermesEnabled /
 * enableMinifyInReleaseBuilds 等）不在这里重复，避免和上游默认值打架。
 */
const PROPERTIES = {
  // 本机 20 核；堆给足但 worker 限到 8，开太多反而抢内存触发 GC 抖动
  'org.gradle.jvmargs': '-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8',
  'org.gradle.parallel': 'true',
  // 跨构建复用任务输出：改 JS 后重编省掉大量重复工作
  'org.gradle.caching': 'true',
  'org.gradle.workers.max': '8',

  // 裁掉没有被任何代码/资源引用的文件，配合 R8 一起压体积
  'android.enableShrinkResourcesInReleaseBuilds': 'true',

  // 只构建 arm64-v8a。原 4 种 ABI 让 APK 膨胀到 76MB，C++ 编译量也翻 4 倍。
  // 目标设备 vivo Y78 是 64 位 ARM。如需兼容 32 位老机改成 "arm64-v8a,armeabi-v7a"。
  reactNativeArchitectures: 'arm64-v8a',

  // GIF / WebP 会额外引入 Fresco 的 animated-gif、webpsupport 原生库。
  // 本项目从未使用 RN 的 <Image>（界面全由 View/Text/图标字体构成），直接关掉。
  'expo.gif.enabled': 'false',
  'expo.webp.enabled': 'false',
  'expo.webp.animated': 'false',

  // 配合 ninja 的 longPathAware 才能绕开 Windows 260 字符限制（详见 SPEC 第 12 节）
  'expo.inlineModules.watchedDirectories': '[]',
};

/** 本机 JDK 21 不满足 Expo 插件的 Java 17 工具链要求，单独放了一份 JDK 17 */
const JDK17_PATH = process.env.FRAGMENTS_JDK17 || 'C:/Users/14428/.jdks/jdk-17.0.20.1+1';

function setProperty(properties, key, value) {
  const existing = properties.find((item) => item.type === 'property' && item.key === key);
  if (existing) {
    existing.value = value;
  } else {
    properties.push({ type: 'property', key, value });
  }
}

module.exports = function withBuildOptimizations(config) {
  return withGradleProperties(config, (cfg) => {
    const properties = cfg.modResults;
    for (const [key, value] of Object.entries(PROPERTIES)) {
      setProperty(properties, key, value);
    }
    setProperty(properties, 'org.gradle.java.installations.paths', JDK17_PATH);
    setProperty(properties, 'org.gradle.java.installations.auto-download', 'false');
    return cfg;
  });
};
