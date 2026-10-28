/** Vite 的 `?raw`：把 Markdown 原文作为字符串打进主进程产物。 */
declare module "*.md?raw" {
  const content: string;
  export default content;
}
