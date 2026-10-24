import { dialog, ipcMain, type BrowserWindow } from "electron";

import {
  IPC,
  type AppearanceSettings,
  type ChatSendPayload,
  type ConversationKey,
  type ModelSelection,
  type ModelsDraft,
  type Rect,
  type ResumeDocTarget,
  type WireMessage,
} from "@shared/types";

import type { AgentRuntime } from "./agent-runtime";
import type { BrowserPanel } from "./browser";
import type { ConversationsStore } from "./conversations-store";
import type { MemoryStore } from "./memory";
import type { ModelsStore } from "./models-store";
import type { PreferencesStore } from "./preferences-store";
import type { ResumeStore } from "./resume-store";
import { extractResumeText } from "./resume-store";
import type { WorkspacesStore } from "./workspaces-store";

export interface IpcDeps {
  getWindow: () => BrowserWindow | null;
  getPanel: () => BrowserPanel | null;
  runtime: AgentRuntime;
  conversations: ConversationsStore;
  resumes: ResumeStore;
  memory: MemoryStore;
  models: ModelsStore;
  preferences: PreferencesStore;
  workspaces: WorkspacesStore;
  appInfo: () => { platform: string; version: string; dataDir: string; workspaceDir: string };
}

/** Registers process-wide handlers exactly once; they resolve the live window lazily. */
export function registerIpc(deps: IpcDeps): void {
  const {
    getWindow,
    getPanel,
    runtime,
    conversations,
    resumes,
    memory,
    models,
    preferences,
    workspaces,
    appInfo,
  } = deps;

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

  ipcMain.handle(IPC.chatSend, async (_event, payload: ChatSendPayload) => {
    // Fire and forget：chunk 流走 IPC.chatChunk，UI 保持响应。
    void runtime.send(payload, (event) => sendToUi(IPC.chatChunk, event));
  });
  ipcMain.on(IPC.chatAbort, (_event, key: ConversationKey) => runtime.abort(key));

  ipcMain.handle(IPC.conversationsGet, (_event, key: ConversationKey) => {
    const doc = conversations.get(key);
    return { key, messages: doc.messages, updatedAt: doc.updatedAt };
  });
  ipcMain.handle(IPC.conversationsSync, (_event, key: ConversationKey, messages: WireMessage[]) => {
    conversations.updateMessages(key, messages);
  });

  ipcMain.handle(IPC.resumeList, () => resumes.list());
  ipcMain.handle(IPC.resumeCreate, (_event, name: string) => resumes.create(name));
  ipcMain.handle(IPC.resumeRename, (_event, id: string, name: string) => resumes.rename(id, name));
  ipcMain.handle(IPC.resumeDelete, (_event, id: string) => resumes.remove(id));
  ipcMain.handle(IPC.resumeSelect, (_event, id: string) => resumes.select(id));
  ipcMain.handle(IPC.resumeRead, (_event, target: ResumeDocTarget) => resumes.read(target));
  ipcMain.handle(IPC.resumeSave, (_event, target: ResumeDocTarget, content: string) =>
    resumes.save(target, content),
  );
  ipcMain.handle(IPC.resumeTailoredList, () => resumes.listTailored());

  ipcMain.handle(IPC.resumeImport, async () => {
    const win = getWindow();
    const options = {
      title: "选择旧简历文件",
      filters: [
        { name: "简历文件", extensions: ["pdf", "docx", "md", "txt"] },
        { name: "所有文件", extensions: ["*"] },
      ],
      properties: ["openFile" as const],
    };
    const picked =
      win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options);
    const filePath = picked.filePaths[0];
    if (picked.canceled || filePath === undefined) return null;

    try {
      const text = await extractResumeText(filePath);
      const fileName = filePath.split(/[\\/]/).pop() ?? "简历";
      return { fileName, text };
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法解析该文件";
      throw new Error(`解析「${filePath}」失败：${message}`);
    }
  });

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
    runtime.abortAll();
    const state = workspaces.switchTo(id);
    // 一切数据跟着工作区走：切完换文件重读，并广播给渲染层刷新。
    const paths = workspaces.currentPaths;
    models.useWorkspace(paths);
    conversations.useWorkspace(paths);
    resumes.useWorkspace(paths);
    memory.useWorkspace(paths);
    sendToUi(IPC.workspaceChanged, state);
    return state;
  });
}
