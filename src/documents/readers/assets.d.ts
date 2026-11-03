/** 资源模块的默认导出就是 Metro 分配的资源 id（数字）。 */
declare module '*.html' {
  const asset: number;
  export default asset;
}
