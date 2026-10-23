import { ipcMain, type BrowserWindow } from "electron";

import {
  IPC,
  type AppearanceSettings,
  type ChatMessage,
  type ModelSelection,
  type ModelsDraft,
  type Rect,
} from "@shared/types";

import type { BrowserPanel } from "./browser";
import type { ChatService } from "./chat-service";
import type { ModelsStore } from "./models-store";
import type { PreferencesStore } from "./preferences-store";
import type { WorkspacesStore } from "./workspaces-store";

export interface IpcDeps {
  getWindow: () => BrowserWindow | null;
  getPanel: () => BrowserPanel | null;
  chat: ChatService;
  models: ModelsStore;
  preferences: PreferencesStore;
  workspaces: WorkspacesStore;
  appInfo: () => { platform: string; version: string; dataDir: string; workspaceDir: string };
}

/** Registers process-wide handlers exactly once; they resolve the live window lazily. */
export function registerIpc(deps: IpcDeps): void {
  const { getWindow, getPanel, chat, models, preferences, workspaces, appInfo } = deps;

  const sendToUi = (channel: string, payload: unknown): void => {
    const win = getWindow();
    if (win === null || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  ipcMain.handle(IPC.appInfo, () => appInfo());

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

  ipcMain.handle(IPC.chatSend, async (_event, id: string, messages: ChatMessage[]) => {
    // Fire and forget: tokens arrive on IPC.chatEvent so the UI stays responsive.
    void chat.send(id, messages, (event) => sendToUi(IPC.chatEvent, event));
  });
  ipcMain.on(IPC.chatAbort, (_event, id: string) => chat.abort(id));

  ipcMain.handle(IPC.modelsGet, () => models.toPublic());
  ipcMain.handle(IPC.modelsSave, (_event, draft: ModelsDraft) => models.save(draft));
  ipcMain.handle(IPC.modelsSelect, (_event, selection: ModelSelection | null) =>
    models.selectDefault(selection),
  );

  ipcMain.handle(IPC.appearanceGet, () => preferences.appearance);
  ipcMain.handle(IPC.appearanceSave, (_event, patch: Partial<AppearanceSettings>) =>
    preferences.saveAppearance(patch),
  );

  ipcMain.handle(IPC.workspaceGet, () => workspaces.state());
  ipcMain.handle(IPC.workspaceSwitch, (_event, id: string) => {
    const state = workspaces.switchTo(id);
    // 模型配置跟着工作区走，切完立刻换文件重读，并广播给渲染层刷新。
    models.useWorkspace(workspaces.currentPaths);
    sendToUi(IPC.workspaceChanged, state);
    return state;
  });
}
