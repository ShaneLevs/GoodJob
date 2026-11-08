import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { app, BrowserWindow, nativeImage } from "electron";

import { createAppContext, type AppContext } from "./app/context";
import { hardenRendererSession } from "./app/security";
import { createMainWindow } from "./app/window";
import { resolveCdpPort } from "./browser/automation/cli";
import type { BrowserPanel } from "./browser/panel";
import { registerIpc } from "./ipc";

const here = path.dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL;
const isMac = process.platform === "darwin";

// Test/dev isolation. Relocating userData gives the instance its own single-instance
// lock and Chromium profile, so a test run never fights with the real app.
const instanceHome = process.env.GOODJOB_HOME;
if (instanceHome !== undefined && instanceHome.trim() !== "") {
  app.setPath("userData", path.join(instanceHome, "electron-profile"));
}

// Data files are only ever readable by the current user.
process.umask(0o077);

let mainWindow: BrowserWindow | null = null;
let browserPanel: BrowserPanel | null = null;
let context: AppContext | null = null;

function createWindow(): void {
  const { win, panel } = createMainWindow({
    isMac,
    rendererDevUrl,
    preloadPath: path.join(here, "../preload/index.cjs"),
    rendererFile: path.join(here, "../renderer/index.html"),
    onClosed: () => {
      browserPanel = null;
      mainWindow = null;
    },
  });
  mainWindow = win;
  browserPanel = panel;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  /*
   * CDP 端口（BROWSER-AGENT §2）必须在 ready 之前写进 remote-debugging-port。
   * Electron 的 ESM 主进程入口会等这里的 top-level await settle 才触发 ready
   * （实测 appendSwitch 生效），所以模块顶层 await 一次即可；命令行已带
   * --remote-debugging-port（测试脚本 / 手动调试）时直接沿用。
   */
  const cdpPort = await resolveCdpPort();

  app.whenReady().then(() => {
    hardenRendererSession(isDev);

    // 打包后的图标来自 bundle 里的 icns；dev 下 Dock 还是 Electron 默认图标，手动换上。
    if (isMac && isDev) {
      const iconPath = path.join(here, "../../build/icon.png");
      if (existsSync(iconPath)) app.dock?.setIcon(nativeImage.createFromPath(iconPath));
    }

    const appContext = createAppContext({
      cdpPort,
      getWindow: () => mainWindow,
      getPanel: () => browserPanel,
    });
    context = appContext;

    registerIpc({
      getWindow: () => mainWindow,
      getPanel: () => browserPanel,
      ...appContext,
      appInfo: () => ({
        platform: process.platform,
        version: app.getVersion(),
        dataDir: appContext.workspaces.root.root,
        workspaceDir: appContext.workspaces.currentPaths.dir,
      }),
    });

    // 分钟级调度（确认门窗口推进 + 日报 / 周报到点）：应用活着就跑。
    appContext.notify.start();

    createWindow();

    // 自动检查更新：按偏好延迟启动（打包产物才生效），不阻塞首屏。
    appContext.updates.start();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });

  app.on("before-quit", () => {
    context?.runtime.abortAll();
    // 浏览器任务：杀命令进程 + 收 agent-browser daemon（close 失败按 pid 兜底）。
    context?.browser.cleanup();
    // 后台任务不做断点续跑：退出即停（结果都已落库，重启后可重跑）。
    context?.tasks.stopAll();
    // 通知调度与 IMAP 长连接同样退出即停；等待中的确认门按取消处理。
    context?.notify.stopAll();
    browserPanel?.dispose();
  });
}
