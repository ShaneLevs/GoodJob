import { contextBridge, ipcRenderer } from "electron";

import type {
  AgentPaneOpenEvent,
  AgentStep,
  AgentStepEvent,
  AppearanceSettings,
  AppInfo,
  Application,
  ApplicationPatch,
  BrowserAgentSettings,
  BrowserAgentSettingsDraft,
  BrowserState,
  ChatSendPayload,
  ChatStreamEvent,
  Company,
  CompanyPatch,
  ConversationKey,
  ConversationState,
  GoodjobApi,
  IntegrityReport,
  InterviewCreateInput,
  Interview,
  Job,
  JobPatch,
  ModelSelection,
  ModelsConfig,
  ModelsDraft,
  NotificationDraft,
  NotificationSettings,
  NotifyTestRequest,
  NotifyTestResult,
  DigestKind,
  DigestRunResult,
  PdfExportPayload,
  PdfExportResult,
  PipelineConfig,
  PipelineDraft,
  Rect,
  ResumeDoc,
  ResumeDocTarget,
  ResumeFileEvent,
  ResumeListState,
  ScriptDoc,
  TailoredDoc,
  TaskEvent,
  TaskState,
  TaskType,
  UploadedFileMeta,
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
    upload: () => ipcRenderer.invoke(IPC.resumeUpload) as Promise<UploadedFileMeta[] | null>,
    onFileChanged: (listener: (event: ResumeFileEvent) => void) =>
      subscribe(IPC.resumeFileChanged, listener),
    scripts: {
      list: () => ipcRenderer.invoke(IPC.resumeScriptList) as Promise<ScriptDoc[]>,
      read: (jobId: string) =>
        ipcRenderer.invoke(IPC.resumeScriptRead, jobId) as Promise<
          { jobId: string; content: string; doc: ScriptDoc } | null
        >,
      save: (jobId: string, content: string) =>
        ipcRenderer.invoke(IPC.resumeScriptSave, jobId, content) as Promise<ScriptDoc>,
      finalize: (jobId: string) =>
        ipcRenderer.invoke(IPC.resumeScriptFinalize, jobId) as Promise<ScriptDoc>,
    },
    integrityReports: (resumeId: string) =>
      ipcRenderer.invoke(IPC.resumeIntegrityReports, resumeId) as Promise<IntegrityReport[]>,
  },
  companies: {
    list: () => ipcRenderer.invoke(IPC.companiesList) as Promise<Company[]>,
    create: (patch: CompanyPatch) =>
      ipcRenderer.invoke(IPC.companiesCreate, patch) as Promise<Company>,
    update: (id: string, patch: CompanyPatch) =>
      ipcRenderer.invoke(IPC.companiesUpdate, id, patch) as Promise<Company>,
    remove: (id: string) => ipcRenderer.invoke(IPC.companiesDelete, id) as Promise<void>,
  },
  jobs: {
    list: () => ipcRenderer.invoke(IPC.jobsList) as Promise<Job[]>,
    create: (patch: JobPatch) => ipcRenderer.invoke(IPC.jobsCreate, patch) as Promise<Job>,
    update: (id: string, patch: JobPatch) =>
      ipcRenderer.invoke(IPC.jobsUpdate, id, patch) as Promise<Job>,
    remove: (id: string) => ipcRenderer.invoke(IPC.jobsDelete, id) as Promise<void>,
  },
  applications: {
    list: () => ipcRenderer.invoke(IPC.applicationsList) as Promise<Application[]>,
    create: (patch: ApplicationPatch) =>
      ipcRenderer.invoke(IPC.applicationsCreate, patch) as Promise<Application>,
    update: (id: string, patch: ApplicationPatch) =>
      ipcRenderer.invoke(IPC.applicationsUpdate, id, patch) as Promise<Application>,
    remove: (id: string) => ipcRenderer.invoke(IPC.applicationsDelete, id) as Promise<void>,
  },
  pipeline: {
    get: () => ipcRenderer.invoke(IPC.pipelineGet) as Promise<PipelineConfig>,
    save: (draft: PipelineDraft) =>
      ipcRenderer.invoke(IPC.pipelineSave, draft) as Promise<PipelineConfig>,
  },
  tasks: {
    list: () => ipcRenderer.invoke(IPC.tasksList) as Promise<TaskState[]>,
    run: (type: TaskType, target: string) =>
      ipcRenderer.invoke(IPC.tasksRun, type, target) as Promise<TaskState>,
    rerun: (taskId: string) => ipcRenderer.invoke(IPC.tasksRerun, taskId) as Promise<TaskState>,
    onEvent: (listener: (event: TaskEvent) => void) => subscribe(IPC.taskEvent, listener),
  },
  pdf: {
    export: (payload: PdfExportPayload) =>
      ipcRenderer.invoke(IPC.pdfExport, payload) as Promise<PdfExportResult | null>,
  },
  interviews: {
    list: () => ipcRenderer.invoke(IPC.interviewsList) as Promise<Interview[]>,
    create: (input: InterviewCreateInput) =>
      ipcRenderer.invoke(IPC.interviewsCreate, input) as Promise<Interview>,
    remove: (id: string) => ipcRenderer.invoke(IPC.interviewsRemove, id) as Promise<void>,
  },
  notify: {
    get: () => ipcRenderer.invoke(IPC.notifyGet) as Promise<NotificationSettings>,
    save: (draft: NotificationDraft) =>
      ipcRenderer.invoke(IPC.notifySave, draft) as Promise<NotificationSettings>,
    test: (request: NotifyTestRequest) =>
      ipcRenderer.invoke(IPC.notifyTest, request) as Promise<NotifyTestResult>,
    runDigest: (kind: DigestKind) =>
      ipcRenderer.invoke(IPC.notifyDigestRun, kind) as Promise<DigestRunResult>,
  },
  workbench: {
    onPaneOpen: (listener: (event: AgentPaneOpenEvent) => void) =>
      subscribe(IPC.agentPaneOpen, listener),
  },
  agent: {
    listLog: () => ipcRenderer.invoke(IPC.agentLogList) as Promise<AgentStep[]>,
    onStep: (listener: (event: AgentStepEvent) => void) =>
      subscribe(IPC.agentStepEvent, listener),
    abort: () => ipcRenderer.send(IPC.agentAbort),
    replayStep: (stepId: string) =>
      ipcRenderer.invoke(IPC.agentReplayStep, stepId) as Promise<void>,
    getSettings: () =>
      ipcRenderer.invoke(IPC.agentSettingsGet) as Promise<BrowserAgentSettings>,
    saveSettings: (draft: BrowserAgentSettingsDraft) =>
      ipcRenderer.invoke(IPC.agentSettingsSave, draft) as Promise<BrowserAgentSettings>,
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
