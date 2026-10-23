import { contextBridge, ipcRenderer } from "electron";

import type {
  AppearanceSettings,
  AppInfo,
  BrowserState,
  ChatEvent,
  ChatMessage,
  GoodjobApi,
  ModelSelection,
  ModelsConfig,
  ModelsDraft,
  Rect,
  WorkspacesState,
} from "@shared/types";
import { IPC } from "@shared/types";

/** Wraps `ipcRenderer.on` so the renderer gets a plain unsubscribe function. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: GoodjobApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  },
  browser: {
    setBounds: (rect: Rect | null) => ipcRenderer.send(IPC.browserSetBounds, rect),
    setVisible: (visible: boolean) => ipcRenderer.send(IPC.browserSetVisible, visible),
    navigate: (url: string) => ipcRenderer.invoke(IPC.browserNavigate, url) as Promise<void>,
    back: () => ipcRenderer.send(IPC.browserBack),
    forward: () => ipcRenderer.send(IPC.browserForward),
    reload: () => ipcRenderer.send(IPC.browserReload),
    stop: () => ipcRenderer.send(IPC.browserStop),
    toggleDevTools: () => ipcRenderer.send(IPC.browserToggleDevTools),
    onState: (listener: (state: BrowserState) => void) => subscribe(IPC.browserState, listener),
  },
  chat: {
    send: (id: string, messages: ChatMessage[]) =>
      ipcRenderer.invoke(IPC.chatSend, id, messages) as Promise<void>,
    abort: (id: string) => ipcRenderer.send(IPC.chatAbort, id),
    onEvent: (listener: (event: ChatEvent) => void) => subscribe(IPC.chatEvent, listener),
  },
  models: {
    get: () => ipcRenderer.invoke(IPC.modelsGet) as Promise<ModelsConfig>,
    save: (draft: ModelsDraft) =>
      ipcRenderer.invoke(IPC.modelsSave, draft) as Promise<ModelsConfig>,
    selectDefault: (selection: ModelSelection | null) =>
      ipcRenderer.invoke(IPC.modelsSelect, selection) as Promise<ModelsConfig>,
  },
  appearance: {
    get: () => ipcRenderer.invoke(IPC.appearanceGet) as Promise<AppearanceSettings>,
    save: (patch: Partial<AppearanceSettings>) =>
      ipcRenderer.invoke(IPC.appearanceSave, patch) as Promise<AppearanceSettings>,
  },
  workspace: {
    get: () => ipcRenderer.invoke(IPC.workspaceGet) as Promise<WorkspacesState>,
    switchTo: (id: string) =>
      ipcRenderer.invoke(IPC.workspaceSwitch, id) as Promise<WorkspacesState>,
    onChanged: (listener: (state: WorkspacesState) => void) =>
      subscribe(IPC.workspaceChanged, listener),
  },
};

contextBridge.exposeInMainWorld("goodjob", api);
