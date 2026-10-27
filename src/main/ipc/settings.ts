import { ipcMain } from "electron";

import {
  IPC,
  type AppearanceSettings,
  type BrowserAgentSettingsDraft,
  type DigestKind,
  type ModelSelection,
  type ModelsDraft,
  type NotificationDraft,
  type NotifyTestRequest,
  type PdfExportPayload,
  type TaskType,
} from "@shared/types";

import { exportPdf } from "../services/pdf-export";
import type { IpcDeps } from "./deps";

export function registerSettingsIpc(deps: IpcDeps): void {
  const { tasks, notify, notifyStore, browser, browserSettings, models, preferences, getWindow } =
    deps;

  // —— 后台任务：状态事件主动推，重跑 / 发起用 invoke 拿即时回执 ——
  ipcMain.handle(IPC.tasksList, () => tasks.list());
  ipcMain.handle(IPC.tasksRun, (_event, type: TaskType, target: string) => tasks.run(type, target));
  ipcMain.handle(IPC.tasksRerun, (_event, taskId: string) => tasks.rerun(taskId));

  // —— PDF 导出：隐藏窗口走渲染层 #export 路由（约定见 pdf-export.ts 文件头）——
  ipcMain.handle(IPC.pdfExport, (_event, payload: PdfExportPayload) =>
    exportPdf(getWindow(), payload),
  );

  // —— 通知（P3 M3）：配置 / 连通性测试 / 手动日报。密码只在 main 解密，不回渲染层 ——
  ipcMain.handle(IPC.notifyGet, () => notifyStore.toPublic());
  ipcMain.handle(IPC.notifySave, (_event, draft: NotificationDraft) => notifyStore.save(draft));
  ipcMain.handle(IPC.notifyTest, (_event, request: NotifyTestRequest) =>
    notify.testConnection(request),
  );
  ipcMain.handle(IPC.notifyDigestRun, (_event, kind: DigestKind) => deps.runtime.runDigest(kind));

  // —— 浏览器自动化（P4）：中止 + 设置（审计日志仍逐条写 logs/agent.log）——
  ipcMain.on(IPC.agentAbort, () => browser.abort());
  ipcMain.handle(IPC.agentSettingsGet, () => browserSettings.toPublic());
  ipcMain.handle(IPC.agentSettingsSave, (_event, draft: BrowserAgentSettingsDraft) =>
    browserSettings.save(draft),
  );

  ipcMain.handle(IPC.modelsGet, () => models.toPublic());
  ipcMain.handle(IPC.modelsSave, (_event, draft: ModelsDraft) => models.save(draft));
  ipcMain.handle(IPC.modelsSelect, (_event, selection: ModelSelection | null) =>
    models.selectDefault(selection),
  );

  ipcMain.handle(IPC.appearanceGet, () => preferences.appearance);
  ipcMain.handle(IPC.appearanceSave, (_event, patch: Partial<AppearanceSettings>) =>
    preferences.saveAppearance(patch),
  );
}
