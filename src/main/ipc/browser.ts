import { ipcMain } from "electron";

import { IPC, type Rect } from "@shared/types";

import type { IpcDeps } from "./deps";

export function registerBrowserIpc({ getPanel }: IpcDeps): void {
  ipcMain.handle(IPC.browserNavigate, async (_event, input: string) => {
    await getPanel()?.navigate(input);
  });
  ipcMain.on(IPC.browserSetBounds, (_event, rect: Rect | null) => {
    getPanel()?.setBounds(rect);
  });
  ipcMain.on(IPC.browserSetVisible, (_event, visible: boolean) => {
    getPanel()?.setVisible(visible);
  });
  ipcMain.on(IPC.browserBack, () => getPanel()?.back());
  ipcMain.on(IPC.browserForward, () => getPanel()?.forward());
  ipcMain.on(IPC.browserReload, () => getPanel()?.reload());
  ipcMain.on(IPC.browserStop, () => getPanel()?.stop());
  ipcMain.on(IPC.browserToggleDevTools, () => getPanel()?.toggleDevTools());
  ipcMain.handle(IPC.browserNewTab, (_event, url?: string) => getPanel()?.createTab(url).id ?? "");
  ipcMain.on(IPC.browserCloseTab, (_event, id: string) => getPanel()?.closeTab(id));
  ipcMain.on(IPC.browserActivateTab, (_event, id: string) => getPanel()?.activateTab(id));
  ipcMain.handle(IPC.browserGetState, () => getPanel()?.state() ?? null);
}
