/*
 * Vite 静态资源：字体等文件 import 进来是打包后的 URL。
 * 这个文件必须保持无 import/export（全局脚本），通配模块声明才生效。
 */

declare module "*.ttf" {
  const url: string;
  export default url;
}

declare module "*.otf" {
  const url: string;
  export default url;
}

declare module "*.svg" {
  const url: string;
  export default url;
}

/** Vite 的 `?inline`：文件经过处理（含 url() 重写）后以字符串返回。 */
declare module "*.css?inline" {
  const css: string;
  export default css;
}
