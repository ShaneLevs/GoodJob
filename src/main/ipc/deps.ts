import type { BrowserWindow } from "electron";

import type { AgentRuntime } from "../agent/runtime";
import type { WorkflowService } from "../agent/workflow";
import type { BrowserAgentService } from "../browser/automation/runner";
import type { BrowserAgentSettingsStore } from "../browser/automation/settings-store";
import type { BrowserPanel } from "../browser/panel";
import type { NotifyService } from "../services/notify";
import type { TaskManager } from "../services/tasks";
import type { VoiceService } from "../services/voice";
import type { UpdateService } from "../services/updater";
import type { ConversationsStore } from "../stores/conversations";
import type { CompaniesStore } from "../stores/domain/companies";
import type { InterviewsStore } from "../stores/domain/interviews";
import type { JobsStore } from "../stores/domain/jobs";
import type { PipelineStore } from "../stores/domain/pipeline";
import type { MemoryStore } from "../stores/memory";
import type { ModelsStore } from "../stores/models";
import type { NotifyStore } from "../stores/notify";
import type { PreferencesStore } from "../stores/preferences";
import type { ResumeStore } from "../stores/resumes";
import type { VoiceSettingsStore } from "../stores/voice";
import type { WorkspacesStore } from "../stores/workspaces";

export type SendToUi = (channel: string, payload: unknown) => void;

export interface IpcDeps {
  getWindow: () => BrowserWindow | null;
  getPanel: () => BrowserPanel | null;
  runtime: AgentRuntime;
  workflow: WorkflowService;
  conversations: ConversationsStore;
  resumes: ResumeStore;
  memory: MemoryStore;
  models: ModelsStore;
  preferences: PreferencesStore;
  workspaces: WorkspacesStore;
  companies: CompaniesStore;
  jobs: JobsStore;
  pipeline: PipelineStore;
  interviews: InterviewsStore;
  tasks: TaskManager;
  notify: NotifyService;
  notifyStore: NotifyStore;
  /** 语音模型设置与语音会话（TTS / ASR，原生 AOQ 引擎只在 main）。 */
  voice: VoiceService;
  voiceSettings: VoiceSettingsStore;
  /** 浏览器自动化（P4）：审计日志 / 中止 / 重放 + 设置读写。 */
  browser: BrowserAgentService;
  browserSettings: BrowserAgentSettingsStore;
  updates: UpdateService;
  appInfo: () => { platform: string; version: string; dataDir: string; workspaceDir: string };
}
