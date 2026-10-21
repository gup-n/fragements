/**
 * 类型解析用的回退入口。
 * 运行时 Metro 会优先解析 repo.native.ts / repo.web.ts，本文件只在
 * 无法确定平台（如 tsc 类型检查）时被采用。业务代码请统一 import '../db/repo'。
 */
export { repo } from './repo.native';
export type { Repo } from './types';
