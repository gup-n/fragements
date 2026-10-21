/**
 * 去掉启动动画
 *
 * 默认启动过程有三段视觉变化，在手机上看着像「闪一下 + 图标动一下」：
 *
 *   1. Android 12+ 强制显示系统启动窗，图标默认取 app 图标，带系统自带的缩放/淡入动画
 *   2. 启动窗的底色来自模板默认的白色，而 App 页面底色是 #FBFBF9，差一点点 → 明显一闪
 *   3. MainActivity.onCreate 里 setTheme(AppTheme) 之后、RN 挂载之前，露出的是
 *      AppTheme 的 windowBackground（同样是白色）
 *
 * 处理办法：三段全部对齐成页面底色，同时把启动窗图标换成透明 drawable。
 * 结果是「点开就是空白页底色 → 界面直接画出来」，中间没有任何可见动画。
 *
 * 注意：Android 12+ 的系统启动窗本身无法关闭（OS 强制），
 * 只能把它做成一块纯色，做到肉眼看不出来。
 */
const fs = require('fs');
const path = require('path');
const { withAndroidColors, withAndroidStyles, withDangerousMod } = require('expo/config-plugins');

/** 必须与 src/theme.ts 的 C.page 一致，否则启动窗和页面色之间会出现一道色差 */
const PAGE_COLOR = '#FBFBF9';

/** API 31+ 的启动窗图标：透明形状，等于「不显示图标」 */
const SPLASH_BLANK_DRAWABLE = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
  <solid android:color="@android:color/transparent" />
</shape>
`;

/**
 * API 31+ 的启动窗走系统 SplashScreen API，读的是 windowSplashScreen* 系列属性，
 * 和低版本的 windowBackground 不是一回事，所以要单独来一份 values-v31。
 * 同名的 style 在 values-v31 里会整体覆盖 values 里的定义，因此父样式和
 * windowBackground 都要重复写一遍。
 */
const V31_STYLES = `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <style name="Theme.App.SplashScreen" parent="AppTheme">
    <item name="android:windowBackground">@color/splashscreen_background</item>
    <item name="android:windowSplashScreenBackground">@color/splashscreen_background</item>
    <item name="android:windowSplashScreenAnimatedIcon">@drawable/splash_blank</item>
    <item name="android:windowSplashScreenIconBackgroundColor">@color/splashscreen_background</item>
    <item name="android:windowSplashScreenAnimationDuration">0</item>
  </style>
</resources>
`;

function setColor(resources, name, value) {
  const list = resources.color ?? [];
  const found = list.find((item) => item.$?.name === name);
  if (found) {
    found._ = value;
  } else {
    list.push({ $: { name }, _: value });
  }
  resources.color = list;
}

function getStyle(resources, name, parent) {
  const list = resources.style ?? [];
  let found = list.find((item) => item.$?.name === name);
  if (!found) {
    found = { $: { name, parent }, item: [] };
    list.push(found);
  }
  if (!found.item) found.item = [];
  resources.style = list;
  return found;
}

function setStyleItem(style, itemName, value) {
  const found = style.item.find((item) => item.$?.name === itemName);
  if (found) {
    found._ = value;
  } else {
    style.item.push({ $: { name: itemName }, _: value });
  }
}

module.exports = function withNoSplashAnimation(config) {
  const withColors = withAndroidColors(config, (cfg) => {
    setColor(cfg.modResults.resources, 'splashscreen_background', PAGE_COLOR);
    return cfg;
  });

  const withStyles = withAndroidStyles(withColors, (cfg) => {
    const resources = cfg.modResults.resources;

    // AppTheme 的 windowBackground：启动窗撤掉后到 RN 挂载之间露出的就是它
    const appTheme = getStyle(resources, 'AppTheme', 'Theme.AppCompat.DayNight.NoActionBar');
    setStyleItem(appTheme, 'android:windowBackground', '@color/splashscreen_background');

    // 启动窗本体：从「居中绘制 splashscreen_logo 位图」改成纯色，
    // 位图不再被引用，shrinkResources 会顺手把它从 APK 里删掉
    const splash = getStyle(resources, 'Theme.App.SplashScreen', 'AppTheme');
    setStyleItem(splash, 'android:windowBackground', '@color/splashscreen_background');
    return cfg;
  });

  return withDangerousMod(withStyles, [
    'android',
    async (cfg) => {
      const resDir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');

      const drawableDir = path.join(resDir, 'drawable');
      fs.mkdirSync(drawableDir, { recursive: true });
      fs.writeFileSync(path.join(drawableDir, 'splash_blank.xml'), SPLASH_BLANK_DRAWABLE);

      const v31Dir = path.join(resDir, 'values-v31');
      fs.mkdirSync(v31Dir, { recursive: true });
      fs.writeFileSync(path.join(v31Dir, 'styles.xml'), V31_STYLES);

      return cfg;
    },
  ]);
};
