import { contextBridge, ipcRenderer } from "electron";

import type {
  AppearanceSettings,
  AppInfo,
  BrowserState,
  ChatSendPayload,
  ChatStreamEvent,
  ConversationKey,
  ConversationState,
  GoodjobApi,
  ImportedResume,
  ModelSelection,
  ModelsConfig,
  ModelsDraft,
  Rect,
  ResumeDoc,
  ResumeDocTarget,
  ResumeFileEvent,
  ResumeListState,
  TailoredDoc,
  WireMessage,
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
    send: (payload: ChatSendPayload) =>
      ipcRenderer.invoke(IPC.chatSend, payload) as Promise<void>,
    abort: (key: ConversationKey) => ipcRenderer.send(IPC.chatAbort, key),
    onChunk: (listener: (event: ChatStreamEvent) => void) =>
      subscribe(IPC.chatChunk, listener),
  },
  conversations: {
    get: (key: ConversationKey) =>
      ipcRenderer.invoke(IPC.conversationsGet, key) as Promise<ConversationState>,
    sync: (key: ConversationKey, messages: WireMessage[]) =>
      ipcRenderer.invoke(IPC.conversationsSync, key, messages) as Promise<void>,
  },
  resume: {
    list: () => ipcRenderer.invoke(IPC.resumeList) as Promise<ResumeListState>,
    create: (name: string) =>
      ipcRenderer.invoke(IPC.resumeCreate, name) as Promise<ResumeListState>,
    rename: (id: string, name: string) =>
      ipcRenderer.invoke(IPC.resumeRename, id, name) as Promise<ResumeListState>,
    remove: (id: string) =>
      ipcRenderer.invoke(IPC.resumeDelete, id) as Promise<ResumeListState>,
    select: (id: string) =>
      ipcRenderer.invoke(IPC.resumeSelect, id) as Promise<ResumeListState>,
    read: (target: ResumeDocTarget) =>
      ipcRenderer.invoke(IPC.resumeRead, target) as Promise<ResumeDoc | null>,
    save: (target: ResumeDocTarget, content: string) =>
      ipcRenderer.invoke(IPC.resumeSave, target, content) as Promise<ResumeDoc | null>,
    listTailored: () => ipcRenderer.invoke(IPC.resumeTailoredList) as Promise<TailoredDoc[]>,
    importFile: () => ipcRenderer.invoke(IPC.resumeImport) as Promise<ImportedResume | null>,
    onFileChanged: (listener: (event: ResumeFileEvent) => void) =>
      subscribe(IPC.resumeFileChanged, listener),
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
