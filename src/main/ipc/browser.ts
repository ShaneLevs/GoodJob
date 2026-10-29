import { ipcMain } from "electron";

import { IPC, type Rect } from "@shared/types";

import type { IpcDeps } from "./deps";

/**
 * 面板动作的兜底：这里抛出的异常会变成主进程的未捕获异常（弹「Uncaught Exception」），
 * 而且 IPC 永不返回——界面就卡在旧状态上，看起来像整个浏览器空掉了。
 * 面板内部的竞态（标签刚被销毁、窗口正在关）不该以那种形式表现出来。
 */
function guard<T>(label: string, action: () => T): T | undefined {
  try {
    return action();
  } catch (error) {
    console.error(`[browser] ${label} 失败:`, error instanceof Error ? error.message : error);
    return undefined;
  }
}

export function registerBrowserIpc({ getPanel }: IpcDeps): void {
  ipcMain.handle(IPC.browserNavigate, async (_event, input: string) => {
    await getPanel()?.navigate(input);
  });
  ipcMain.on(IPC.browserSetBounds, (_event, rect: Rect | null) => {
    guard("setBounds", () => getPanel()?.setBounds(rect));
  });
  ipcMain.on(IPC.browserSetVisible, (_event, visible: boolean) => {
    guard("setVisible", () => getPanel()?.setVisible(visible));
  });
  ipcMain.on(IPC.browserBack, () => guard("back", () => getPanel()?.back()));
  ipcMain.on(IPC.browserForward, () => guard("forward", () => getPanel()?.forward()));
  ipcMain.on(IPC.browserReload, () => guard("reload", () => getPanel()?.reload()));
  ipcMain.on(IPC.browserStop, () => guard("stop", () => getPanel()?.stop()));
  ipcMain.on(IPC.browserToggleDevTools, () =>
    guard("toggleDevTools", () => getPanel()?.toggleDevTools()),
  );
  ipcMain.handle(IPC.browserNewTab, (_event, url?: string) =>
    guard("newTab", () => getPanel()?.createTab(url).id) ?? "",
  );
  ipcMain.on(IPC.browserCloseTab, (_event, id: string) =>
    guard("closeTab", () => getPanel()?.closeTab(id)),
  );
  ipcMain.on(IPC.browserActivateTab, (_event, id: string) =>
    guard("activateTab", () => getPanel()?.activateTab(id)),
  );
  ipcMain.handle(IPC.browserGetState, () => getPanel()?.state() ?? null);
}
