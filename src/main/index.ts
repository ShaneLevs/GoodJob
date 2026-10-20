import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

import { IPC } from "@shared/types";

import { BrowserPanel } from "./browser";
import { ChatService } from "./chat-service";
import { ModelsStore } from "./models-store";
import { PreferencesStore } from "./preferences-store";
import { WorkspacesStore } from "./workspaces-store";
import { registerIpc } from "./ipc";
import { hardenRendererSession, hardenRendererWindow } from "./security";

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
let chatService: ChatService | null = null;
let modelsStore: ModelsStore | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: "#ffffff",
    title: "GoodJob",
    // The sidebar owns the traffic lights, WorkBuddy-style.
    ...(isMac
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } }
      : {}),
    webPreferences: {
      preload: path.join(here, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow = win;

  const panel = new BrowserPanel(win, (state) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.browserState, state);
  });
  browserPanel = panel;

  hardenRendererWindow(win);

  win.once("ready-to-show", () => win.show());

  win.on("closed", () => {
    panel.dispose();
    browserPanel = null;
    mainWindow = null;
  });

  if (rendererDevUrl !== undefined) {
    void win.loadURL(rendererDevUrl);
  } else {
    void win.loadFile(path.join(here, "../renderer/index.html"));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    hardenRendererSession(isDev);

    // 工作区必须先建：一个工作区就是一个文件夹，模型配置也挂在它下面。
    const workspaces = new WorkspacesStore();
    const preferences = new PreferencesStore();
    modelsStore = new ModelsStore(workspaces.currentPaths);
    const models = modelsStore;
    chatService = new ChatService(models);
    const chat = chatService;

    registerIpc({
      getWindow: () => mainWindow,
      getPanel: () => browserPanel,
      chat,
      models,
      preferences,
      workspaces,
      appInfo: () => ({
        platform: process.platform,
        version: app.getVersion(),
        dataDir: workspaces.root.root,
        workspaceDir: workspaces.currentPaths.dir,
      }),
    });

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });

  app.on("before-quit", () => {
    chatService?.abortAll();
    browserPanel?.dispose();
  });
}
