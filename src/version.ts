/**
 * 应用版本号，显示在设置页「关于」里。
 *
 * RN 运行时读不到 app.json，而 expo-constants 没装（装了就得 prebuild 重编），
 * 所以这里用常量。**发版时和 app.json 的 expo.version 一起改**，
 * 忘了改的后果只是关于页显示旧版本号，不影响功能。
 */
export const APP_VERSION = '0.7.2';
