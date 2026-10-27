import type { BrowserWindow } from "electron";

import type { AgentRuntime } from "../agent/runtime";
import type { BrowserAgentService } from "../browser/automation/runner";
import type { BrowserAgentSettingsStore } from "../browser/automation/settings-store";
import type { BrowserPanel } from "../browser/panel";
import type { NotifyService } from "../services/notify";
import type { TaskManager } from "../services/tasks";
import type { ConversationsStore } from "../stores/conversations";
import type { ApplicationsStore } from "../stores/domain/applications";
import type { CompaniesStore } from "../stores/domain/companies";
import type { InterviewsStore } from "../stores/domain/interviews";
import type { JobsStore } from "../stores/domain/jobs";
import type { PipelineStore } from "../stores/domain/pipeline";
import type { MemoryStore } from "../stores/memory";
import type { ModelsStore } from "../stores/models";
import type { NotifyStore } from "../stores/notify";
import type { PreferencesStore } from "../stores/preferences";
import type { ResumeStore } from "../stores/resumes";
import type { WorkspacesStore } from "../stores/workspaces";

export type SendToUi = (channel: string, payload: unknown) => void;

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
