import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

import { BrowserWindow, dialog } from "electron";

import type { PdfExportPayload, PdfExportResult } from "@shared/types";

/*
 * 简历 / 定制稿 PDF 导出（P2）：
 *
 *   1. 起一个隐藏（不 show）的离屏 BrowserWindow，加载渲染入口的「导出路由」；
 *   2. 等渲染层把 `window.__goodjobRenderExport(markdown, templateId)` 注册好；
 *   3. 调它排版（内部就是 MarkdownPreview + 模板 CSS，resolve 前会等 document.fonts.ready）；
 *   4. webContents.printToPDF（A4 / printBackground / margins，@page 与分页避规在模板 CSS 里）；
 *   5. dialog.showSaveDialog 让用户挑目录，落盘后关窗。
 *
 * —— 与渲染层导出路由的约定（渲染层实现见下一期，契约先写死在这里）——
 *   - URL：dev = `${ELECTRON_RENDERER_URL}#export`；prod = loadFile(out/renderer/index.html,
 *     { hash: "export" })。main.tsx 看到 `location.hash === "#export"` 时【不挂 App】，
 *     只往 #root 里渲染 MarkdownPreview（排版复用预览管线，零新依赖）。
 *   - 渲染层注册全局函数：`window.__goodjobRenderExport(markdown: string, templateId?:
 *     string, imageUrls?: Record<string, string> | null): Promise<void>`——渲染完成、
 *     字体与图片就绪后 resolve。导出路由不需要 preload（不碰 window.goodjob），
 *     所以这个窗口故意不给 preload。
 *   - main 用 executeJavaScript 调它：被调表达式是写死的函数调用，Markdown 与模板 id
 *     只作为 JSON 字符串参数传进去，不 eval 用户内容。
 *   - 模板放渲染层 `components/document/templates/`（一个 CSS 文件一套主题，`?inline` 注入）；打印相关规则
 *     （@page、break-inside 避规、纸面去阴影）也 scoped 在模板 CSS 里，不进 globals.css。
 */

/** 等导出路由就绪的上限：dev 下首编译可能慢一点。 */
const ROUTE_READY_TIMEOUT_MS = 15_000;
/** 页边距（英寸；约 1cm），与模板 CSS 的 @page 尺寸配套。 */
const PAGE_MARGIN_INCHES = 0.39;

/** 渲染层调用约定的名字（见文件头注释）。 */
const RENDER_EXPORT_FN = "window.__goodjobRenderExport";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function exportPdf(
  parent: BrowserWindow | null,
  payload: PdfExportPayload,
): Promise<PdfExportResult | null> {
  if (payload.markdown.trim() === "") throw new Error("内容是空的，没有可导出的东西。");

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 导出路由只做纯渲染，不需要 preload 桥。
    },
  });

  try {
    await loadExportRoute(win);
    await waitForExportRoute(win);
    await win.webContents.executeJavaScript(
      `${RENDER_EXPORT_FN}(${JSON.stringify(payload.markdown)}, ${JSON.stringify(payload.templateId ?? null)}, ${JSON.stringify(payload.imageUrls ?? null)})`,
      true,
    );

    const pdf = await win.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      margins: {
        top: PAGE_MARGIN_INCHES,
        bottom: PAGE_MARGIN_INCHES,
        left: PAGE_MARGIN_INCHES,
        right: PAGE_MARGIN_INCHES,
      },
    });

    const savedTo = await askWhereToSave(parent, payload.fileName);
    if (savedTo === null) return null;
    // 用户自选目录里的成品文件：按私有文件处理（0600），与工作区数据一致。
    fs.writeFileSync(savedTo, pdf, { mode: 0o600 });
    return { savedTo };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** dev 走 Vite dev server，打包后走 bundle 里的 index.html；都带上 #export 路由。 */
async function loadExportRoute(win: BrowserWindow): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl !== undefined) {
    await win.loadURL(`${devUrl}#export`);
    return;
  }
  await win.loadFile(path.join(here, "../renderer/index.html"), { hash: "export" });
}

/** 轮询等渲染层注册好导出函数（resolve 由渲染层的轮询 Promise 完成，超时在这里兜底）。 */
async function waitForExportRoute(win: BrowserWindow): Promise<void> {
  const probe =
    `typeof ${RENDER_EXPORT_FN} === "function" ? Promise.resolve(true) : ` +
    `new Promise((resolve) => { const timer = setInterval(() => { ` +
    `if (typeof ${RENDER_EXPORT_FN} === "function") { clearInterval(timer); resolve(true); } }, 50); })`;
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error("导出路由未就绪（渲染层还没实现 #export 路由）")),
      ROUTE_READY_TIMEOUT_MS,
    );
  });
  await Promise.race([win.webContents.executeJavaScript(probe, true), timeout]);
}

/** 保存对话框：预填文件名（去掉路径分隔符防拼接），取消返回 null。 */
async function askWhereToSave(parent: BrowserWindow | null, fileName?: string): Promise<string | null> {
  const safeName = (fileName ?? "简历").replace(/[/\\]/g, "").trim();
  const options = {
    title: "导出 PDF",
    defaultPath: `${safeName === "" ? "简历" : safeName}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  };
  const picked =
    parent === null || parent.isDestroyed()
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(parent, options);
  if (picked.canceled || picked.filePath === undefined || picked.filePath === "") return null;
  return picked.filePath;
}
