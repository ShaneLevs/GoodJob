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
