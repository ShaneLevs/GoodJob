import { ipcMain } from "electron";

import {
  IPC,
  type CompanyPatch,
  type InterviewCreateInput,
  type JobPatch,
  type PipelineDraft,
} from "@shared/types";

import type { IpcDeps } from "./deps";

export function registerDomainIpc(deps: IpcDeps): void {
  const { companies, jobs, pipeline, interviews, runtime, conversations } = deps;

  // —— 领域实体 CRUD（P2）：校验在 store 里做，错误经 invoke 拒绝带回渲染层 ——

  ipcMain.handle(IPC.companiesList, () => companies.list());
  ipcMain.handle(IPC.companiesCreate, (_event, patch: CompanyPatch) => companies.create(patch));
  ipcMain.handle(IPC.companiesUpdate, (_event, id: string, patch: CompanyPatch) =>
    companies.update(id, patch),
  );
  ipcMain.handle(IPC.companiesDelete, (_event, id: string) => {
    companies.remove(id);
  });

  ipcMain.handle(IPC.jobsList, () => jobs.list());
  ipcMain.handle(IPC.jobsCreate, (_event, patch: JobPatch) => jobs.create(patch));
  ipcMain.handle(IPC.jobsUpdate, (_event, id: string, patch: JobPatch) => jobs.update(id, patch));
  ipcMain.handle(IPC.jobsAdvance, (_event, id: string, stage: string, note?: string) =>
    jobs.advance(id, stage, note ?? ""),
  );
  ipcMain.handle(IPC.jobsDelete, (_event, id: string) => {
    jobs.remove(id);
  });

  // 流水线：设置区 UI（下一期）从这里读写；读取永远给可用配置（缺省时是默认流水线）。
  ipcMain.handle(IPC.pipelineGet, () => pipeline.get());
  ipcMain.handle(IPC.pipelineSave, (_event, draft: PipelineDraft) => pipeline.save(draft));

  // —— 模拟面试（P3 M1）：记录增删在这里；轮次与总评由面试官 Agent 经工具写回 ——
  ipcMain.handle(IPC.interviewsList, () => interviews.list());
  ipcMain.handle(IPC.interviewsCreate, (_event, input: InterviewCreateInput) =>
    interviews.create(input),
  );
  ipcMain.handle(IPC.interviewsRemove, (_event, id: string) => {
    // 会话里的 run 可能还在跑：先停再删，连 interview:<id> 的所有对话一起清。
    runtime.abort(`interview:${id}`);
    interviews.remove(id);
    conversations.removeScope(`interview:${id}`);
  });
}
