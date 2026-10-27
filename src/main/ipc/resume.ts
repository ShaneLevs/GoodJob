import { ipcMain } from "electron";

import { IPC, type ResumeDocTarget } from "@shared/types";

import type { IpcDeps } from "./deps";

export function registerResumeIpc({ resumes }: IpcDeps): void {
  ipcMain.handle(IPC.resumeList, () => resumes.list());
  ipcMain.handle(IPC.resumeCreate, (_event, name: string) => resumes.create(name));
  ipcMain.handle(IPC.resumeRename, (_event, id: string, name: string) => resumes.rename(id, name));
  ipcMain.handle(IPC.resumeDelete, (_event, id: string) => resumes.remove(id));
  ipcMain.handle(IPC.resumeSelect, (_event, id: string) => resumes.select(id));
  ipcMain.handle(IPC.resumeRead, (_event, target: ResumeDocTarget) => resumes.read(target));
  ipcMain.handle(IPC.resumeSave, (_event, target: ResumeDocTarget, content: string) =>
    resumes.save(target, content),
  );
  ipcMain.handle(IPC.resumePhoto, (_event, relPath: string) => resumes.readPhotoDataUrl(relPath));
  ipcMain.handle(IPC.resumeTailoredList, () => resumes.listTailored());

  // 话术（scripts/<jobId>.md + 定稿 sidecar）：与岗位 1:1，话术管理 UI 直接读写。
  ipcMain.handle(IPC.resumeScriptList, () => resumes.listScripts());
  ipcMain.handle(IPC.resumeScriptRead, (_event, jobId: string) => resumes.readScript(jobId));
  ipcMain.handle(IPC.resumeScriptSave, (_event, jobId: string, content: string) =>
    resumes.writeScript(jobId, content),
  );
  ipcMain.handle(IPC.resumeScriptFinalize, (_event, jobId: string) =>
    resumes.finalizeScript(jobId),
  );
  ipcMain.handle(IPC.resumeIntegrityReports, (_event, resumeId: string) =>
    resumes.listIntegrityReports(resumeId),
  );
}
