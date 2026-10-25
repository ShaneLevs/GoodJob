import { dialog, ipcMain, type BrowserWindow } from "electron";

import {
  IPC,
  type AppearanceSettings,
  type ApplicationPatch,
  type BrowserAgentSettingsDraft,
  type ChatSendPayload,
  type CompanyPatch,
  type ConversationKey,
  type DigestKind,
  type InterviewCreateInput,
  type JobPatch,
  type ModelSelection,
  type ModelsDraft,
  type NotificationDraft,
  type NotifyTestRequest,
  type PdfExportPayload,
  type PipelineDraft,
  type Rect,
  type ResumeDocTarget,
  type TaskType,
  type WireMessage,
} from "@shared/types";

import type { AgentRuntime } from "./agent-runtime";
import type { BrowserAgentService } from "./agent/runner";
import type { BrowserAgentSettingsStore } from "./agent/settings-store";
import type { BrowserPanel } from "./browser";
import type { ConversationsStore } from "./conversations-store";
import type { ApplicationsStore, CompaniesStore, JobsStore, PipelineStore } from "./domain-store";
import type { InterviewsStore } from "./interviews-store";
import type { MemoryStore } from "./memory";
import type { ModelsStore } from "./models-store";
import type { NotifyStore } from "./notify-store";
import type { NotifyService } from "./notify-service";
import type { PreferencesStore } from "./preferences-store";
import { exportPdf } from "./pdf-export";
import type { ResumeStore } from "./resume-store";
import type { TaskManager } from "./tasks";
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
  companies: CompaniesStore;
  jobs: JobsStore;
  applications: ApplicationsStore;
  pipeline: PipelineStore;
  interviews: InterviewsStore;
  tasks: TaskManager;
  notify: NotifyService;
  notifyStore: NotifyStore;
  /** 浏览器自动化（P4）：审计日志 / 中止 / 重放 + 设置读写。 */
  browser: BrowserAgentService;
  browserSettings: BrowserAgentSettingsStore;
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
    companies,
    jobs,
    applications,
    pipeline,
    interviews,
    tasks,
    notify,
    notifyStore,
    browser,
    browserSettings,
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

  // 上传 = 原样落盘到当前简历文件夹的 upload/，不做任何解析；
  // 内容由 Agent 通过 resume_upload_list / resume_upload_read 工具按需读取。
  ipcMain.handle(IPC.resumeUpload, async () => {
    const win = getWindow();
    const options = {
      title: "上传参考文件",
      filters: [{ name: "可读取的文档", extensions: ["pdf", "docx", "md", "markdown", "txt", "csv"] }],
      properties: ["openFile" as const, "multiSelections" as const],
    };
    const picked =
      win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options);
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return picked.filePaths.map((filePath) => resumes.uploadFile(filePath));
  });

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
  ipcMain.handle(IPC.jobsDelete, (_event, id: string) => {
    jobs.remove(id);
  });

  ipcMain.handle(IPC.applicationsList, () => applications.list());
  ipcMain.handle(IPC.applicationsCreate, (_event, patch: ApplicationPatch) =>
    applications.create(patch),
  );
  ipcMain.handle(IPC.applicationsUpdate, (_event, id: string, patch: ApplicationPatch) =>
    applications.update(id, patch),
  );
  ipcMain.handle(IPC.applicationsDelete, (_event, id: string) => {
    applications.remove(id);
  });

  // 流水线：设置区 UI（下一期）从这里读写；读取永远给可用配置（缺省时是默认流水线）。
  ipcMain.handle(IPC.pipelineGet, () => pipeline.get());
  ipcMain.handle(IPC.pipelineSave, (_event, draft: PipelineDraft) => pipeline.save(draft));

  // —— 后台任务：状态事件主动推，重跑 / 发起用 invoke 拿即时回执 ——

  ipcMain.handle(IPC.tasksList, () => tasks.list());
  ipcMain.handle(IPC.tasksRun, (_event, type: TaskType, target: string) => tasks.run(type, target));
  ipcMain.handle(IPC.tasksRerun, (_event, taskId: string) => tasks.rerun(taskId));

  // —— PDF 导出：隐藏窗口走渲染层 #export 路由（约定见 pdf-export.ts 文件头）——
  ipcMain.handle(IPC.pdfExport, (_event, payload: PdfExportPayload) =>
    exportPdf(getWindow(), payload),
  );

  // —— 模拟面试（P3 M1）：记录增删在这里；轮次与总评由面试官 Agent 经工具写回 ——
  ipcMain.handle(IPC.interviewsList, () => interviews.list());
  ipcMain.handle(IPC.interviewsCreate, (_event, input: InterviewCreateInput) =>
    interviews.create(input),
  );
  ipcMain.handle(IPC.interviewsRemove, (_event, id: string) => {
    // 会话里的 run 可能还在跑：先停再删，连 interview:<id> 会话文件一起清。
    runtime.abort(`interview:${id}`);
    interviews.remove(id);
    conversations.remove(`interview:${id}` as ConversationKey);
  });

  // —— 通知（P3 M3）：配置 / 连通性测试 / 手动日报。密码只在 main 解密，不回渲染层 ——
  ipcMain.handle(IPC.notifyGet, () => notifyStore.toPublic());
  ipcMain.handle(IPC.notifySave, (_event, draft: NotificationDraft) => notifyStore.save(draft));
  ipcMain.handle(IPC.notifyTest, (_event, request: NotifyTestRequest) =>
    notify.testConnection(request),
  );
  ipcMain.handle(IPC.notifyDigestRun, (_event, kind: DigestKind) => runtime.runDigest(kind));

  // —— 浏览器自动化（P4）：审计日志 / 中止 / 单步重放（main 只重放非提交类步骤）——
  ipcMain.handle(IPC.agentLogList, () => browser.listSteps());
  ipcMain.on(IPC.agentAbort, () => browser.abort());
  ipcMain.handle(IPC.agentReplayStep, async (_event, stepId: string) => {
    await browser.replayStep(stepId);
  });
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

  ipcMain.handle(IPC.workspaceGet, () => workspaces.state());
  ipcMain.handle(IPC.workspaceSwitch, (_event, id: string) => {
    runtime.abortAll();
    // 浏览器任务跟着停：tab 锁与审计缓冲都随工作区清掉（日志文件留在原工作区）。
    browser.onWorkspaceSwitch();
    // 后台任务也停掉：注册表只在内存里，结果都在各工作区的实体文件里。
    tasks.stopAll();
    // 通知服务跟着换工作区：停掉调度与 IMAP 长连接（等待中的确认门按取消处理），
    // notify-store 换文件重读——服务持引用，自动看到新工作区的配置。
    notify.stopAll();
    const state = workspaces.switchTo(id);
    // 一切数据跟着工作区走：切完换文件重读，并广播给渲染层刷新。
    const paths = workspaces.currentPaths;
    models.useWorkspace(paths);
    conversations.useWorkspace(paths);
    resumes.useWorkspace(paths);
    memory.useWorkspace(paths);
    companies.useWorkspace(paths);
    jobs.useWorkspace(paths);
    applications.useWorkspace(paths);
    pipeline.useWorkspace(paths);
    interviews.useWorkspace(paths);
    notifyStore.useWorkspace(paths);
    browserSettings.useWorkspace(paths);
    // 通知调度随新工作区继续跑（stopAll 清掉了 ticker）。
    notify.start();
    sendToUi(IPC.workspaceChanged, state);
    return state;
  });
}
