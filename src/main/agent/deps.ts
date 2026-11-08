import type { ConversationKey } from "@shared/types";

import type { BrowserAgentService } from "../browser/automation/runner";
import type { BrowserAgentSettingsStore } from "../browser/automation/settings-store";
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
import type { ResumeStore } from "../stores/resumes";
import type { WorkflowService } from "./workflow";

export interface AgentDeps {
  models: ModelsStore;
  conversations: ConversationsStore;
  resumes: ResumeStore;
  memory: MemoryStore;
  companies: CompaniesStore;
  jobs: JobsStore;
  applications: ApplicationsStore;
  pipeline: PipelineStore;
  interviews: InterviewsStore;
  tasks: TaskManager;
  /** 通知服务（P3 M3）：notify / request_confirmation 两个工具的后端。 */
  notify: NotifyService;
  /** 浏览器自动化（P4）：受控动作执行 + tab 锁定 + 审计。 */
  browser: BrowserAgentService;
  /** 浏览器自动化设置（P4）：启用开关与提交限速。 */
  browserSettings: BrowserAgentSettingsStore;
  /** 诊断日志目录（`<workspace>/logs`）：每次 run 的收发痕迹写 chat.log。 */
  logsDir: () => string;
  /** 会话对应的上传目录（按 key 落到各自模块的 upload/，见 workspace/uploads.ts）。 */
  uploadDir: (key: ConversationKey) => string;
  /** GoodJob agent 的子任务调度与工作流状态（单 agent 派发也走它）。 */
  workflow: WorkflowService;
}
