import { ipcMain, shell } from "electron";

import { IPC } from "@shared/types";

import type { IpcDeps } from "./deps";

/**
 * 关于页 + 自动更新。
 *
 * 外部链接只接受 https：渲染层拿到的是窄接口，不能借 openExternal 调起任意
 * file:// 或自定义协议。更新状态从 UpdateService 单向推送，check/download 只回快照。
 */
export function registerUpdateIpc({ updates }: IpcDeps): void {
  ipcMain.handle(IPC.updateGet, () => updates.getState());
  ipcMain.handle(IPC.updateCheck, () => updates.check());
  ipcMain.handle(IPC.updateDownload, () => updates.download());
  ipcMain.handle(IPC.updateSetAutoCheck, (_event, enabled: boolean) =>
    updates.setAutoCheck(enabled === true),
  );
  ipcMain.on(IPC.updateInstall, () => updates.install());

  ipcMain.handle(IPC.appOpenExternal, async (_event, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("打不开这个链接。");
    }
    if (parsed.protocol !== "https:") throw new Error("只允许打开 https 链接。");
    await shell.openExternal(parsed.toString());
  });
}
