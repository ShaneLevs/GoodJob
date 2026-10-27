import { BrowserWindow } from "electron";

import { IPC } from "@shared/types";

import { BrowserPanel, DEFAULT_HOME } from "../browser/panel";
import { hardenRendererWindow } from "./security";

export interface CreateMainWindowOptions {
  isMac: boolean;
  rendererDevUrl: string | undefined;
  preloadPath: string;
  rendererFile: string;
  onClosed: () => void;
}

/** Creates the single app window and the embedded-browser panel attached to it. */
export function createMainWindow({
  isMac,
  rendererDevUrl,
  preloadPath,
  rendererFile,
  onClosed,
}: CreateMainWindowOptions): { win: BrowserWindow; panel: BrowserPanel } {
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
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  const panel = new BrowserPanel(win, (state) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.browserState, state);
  });
  // 初始标签：面板第一次打开就有一个可用的页（Agent 任务开场也只依赖它）。
  panel.createTab(DEFAULT_HOME);

  hardenRendererWindow(win);

  win.once("ready-to-show", () => win.show());

  win.on("closed", () => {
    panel.dispose();
    onClosed();
  });

  if (rendererDevUrl !== undefined) {
    void win.loadURL(rendererDevUrl);
  } else {
    void win.loadFile(rendererFile);
  }

  return { win, panel };
}
