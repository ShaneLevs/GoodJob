import { ipcMain } from "electron";

import { IPC } from "@shared/types";

import { registerBrowserIpc } from "./browser";
import { registerChatIpc } from "./chat";
import { registerDomainIpc } from "./domain";
import type { IpcDeps, SendToUi } from "./deps";
import { registerResumeIpc } from "./resume";
import { registerSettingsIpc } from "./settings";
import { registerUpdateIpc } from "./update";
import { registerWorkspaceIpc } from "./workspace";

export type { IpcDeps } from "./deps";

/** Registers process-wide handlers exactly once; they resolve the live window lazily. */
export function registerIpc(deps: IpcDeps): void {
  const sendToUi: SendToUi = (channel, payload) => {
    const win = deps.getWindow();
    if (win === null || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  ipcMain.handle(IPC.appInfo, () => deps.appInfo());
  registerBrowserIpc(deps);
  registerChatIpc(deps, sendToUi);
  registerResumeIpc(deps);
  registerDomainIpc(deps);
  registerSettingsIpc(deps);
  registerWorkspaceIpc(deps, sendToUi);
  registerUpdateIpc(deps);
}
