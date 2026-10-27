import type { BrowserAgentSettings, BrowserAgentSettingsDraft, BrowserState } from "./browser";
import type { AgentPaneOpenEvent, AgentStepEvent } from "./browser";
import type {
  ChatSendPayload,
  ChatStreamEvent,
  ContextUsage,
  ConversationKey,
  ConversationState,
  UploadedFileMeta,
  WireMessage,
} from "./chat";
import type { Rect } from "./common";
import type {
  Application,
  ApplicationPatch,
  Company,
  CompanyPatch,
  Interview,
  InterviewCreateInput,
  Job,
  JobPatch,
  PipelineConfig,
  PipelineDraft,
} from "./domain";
import type { PdfExportPayload, PdfExportResult } from "./export";
import type { ModelSelection, ModelsConfig, ModelsDraft } from "./models";
import type {
  DigestKind,
  DigestRunResult,
  NotificationDraft,
  NotificationSettings,
  NotifyTestRequest,
  NotifyTestResult,
} from "./notify";
import type {
  IntegrityReport,
  ResumeDoc,
  ResumeDocTarget,
  ResumeFileEvent,
  ResumeListState,
  ScriptDoc,
  TailoredDoc,
} from "./resume";
import type { TaskEvent, TaskState, TaskType } from "./tasks";
import type { AppearanceSettings, AppInfo, WorkspacesState } from "./workspace";

/** IPC channel names — a single source of truth for both sides. */
export const IPC = {
  appInfo: "app:info",
  browserSetBounds: "browser:set-bounds",
  browserSetVisible: "browser:set-visible",
  browserNavigate: "browser:navigate",
  browserBack: "browser:back",
  browserForward: "browser:forward",
  browserReload: "browser:reload",
  browserStop: "browser:stop",
  browserToggleDevTools: "browser:toggle-devtools",
  browserNewTab: "browser:new-tab",
  browserCloseTab: "browser:close-tab",
  browserActivateTab: "browser:activate-tab",
  browserState: "browser:state",
  browserGetState: "browser:get-state",
  chatSend: "chat:send",
  chatAbort: "chat:abort",
  chatChunk: "chat:chunk",
  chatContext: "chat:context",
  chatCompact: "chat:compact",
  chatUpload: "chat:upload",
  conversationsGet: "conversations:get",
  conversationsSync: "conversations:sync",
  resumeList: "resume:list",
  resumeCreate: "resume:create",
  resumeRename: "resume:rename",
  resumeDelete: "resume:delete",
  resumeSelect: "resume:select",
  resumeRead: "resume:read",
  resumeSave: "resume:save",
  resumePhoto: "resume:photo",
  resumeTailoredList: "resume:tailored-list",
  resumeFileChanged: "resume:file-changed",
  resumeScriptList: "resume:script-list",
  resumeScriptRead: "resume:script-read",
  resumeScriptSave: "resume:script-save",
  resumeScriptFinalize: "resume:script-finalize",
  resumeIntegrityReports: "resume:integrity-reports",
  companiesList: "companies:list",
  companiesCreate: "companies:create",
  companiesUpdate: "companies:update",
  companiesDelete: "companies:delete",
  jobsList: "jobs:list",
  jobsCreate: "jobs:create",
  jobsUpdate: "jobs:update",
  jobsDelete: "jobs:delete",
  applicationsList: "applications:list",
  applicationsCreate: "applications:create",
  applicationsUpdate: "applications:update",
  applicationsDelete: "applications:delete",
  pipelineGet: "pipeline:get",
  pipelineSave: "pipeline:save",
  tasksList: "tasks:list",
  tasksRun: "tasks:run",
  tasksRerun: "tasks:rerun",
  taskEvent: "task:event",
  agentPaneOpen: "agent:pane-open",
  agentStepEvent: "agent:step",
  agentAbort: "agent:abort",
  agentSettingsGet: "agent:settings-get",
  agentSettingsSave: "agent:settings-save",
  pdfExport: "pdf:export",
  interviewsList: "interviews:list",
  interviewsCreate: "interviews:create",
  interviewsRemove: "interviews:remove",
  notifyGet: "notify:get",
  notifySave: "notify:save",
  notifyTest: "notify:test",
  notifyDigestRun: "notify:digest-run",
  modelsGet: "models:get",
  modelsSave: "models:save",
  modelsSelect: "models:select",
  appearanceGet: "appearance:get",
  appearanceSave: "appearance:save",
  workspaceGet: "workspace:get",
  workspaceSwitch: "workspace:switch",
  workspaceChanged: "workspace:changed",
} as const;

/** Shape exposed on `window.goodjob` by the preload script. */
export interface GoodjobApi {
  app: {
    info: () => Promise<AppInfo>;
  };
  browser: {
    setBounds: (rect: Rect | null) => void;
    setVisible: (visible: boolean) => void;
    navigate: (url: string) => Promise<void>;
    back: () => void;
    forward: () => void;
    reload: () => void;
    stop: () => void;
    toggleDevTools: () => void;
    /** 新建标签（url 省略时开空白页）；返回新标签 id。 */
    newTab: (url?: string) => Promise<string>;
    /** 关闭标签；关掉最后一个时自动补一个空白页，面板不会空掉。 */
    closeTab: (id: string) => void;
    activateTab: (id: string) => void;
    /** 当前状态快照：面板重新挂载时主动拉一次（main 只在变化时推送）。 */
    getState: () => Promise<BrowserState>;
    onState: (listener: (state: BrowserState) => void) => () => void;
    /** main 侧请求把浏览器铺满内容区（agent:pane-open，浏览器任务开场触发）。 */
    onRequestOpen: (listener: (event: AgentPaneOpenEvent) => void) => () => void;
  };
  chat: {
    /** 发起一次 agent run；chunk 流从 onChunk 订阅（按 key + runId 过滤）。 */
    send: (payload: ChatSendPayload) => Promise<void>;
    abort: (key: ConversationKey) => void;
    onChunk: (listener: (event: ChatStreamEvent) => void) => () => void;
    /** 当前会话的上下文用量（token 估算 + 自动压缩阈值）。 */
    context: (key: ConversationKey) => Promise<ContextUsage>;
    /** 手动压缩：把更早的消息并进摘要，返回压缩后的用量。 */
    compact: (key: ConversationKey) => Promise<ContextUsage>;
    /**
     * 打开系统选择框，把所选文件原样复制进这个会话所属模块的上传目录
     * （公司 / 岗位 / 投递 / 面试各自己的 `upload/`，简历落当前简历文件夹）；
     * 取消返回 null。正文由 Agent 用 upload_list / upload_read 按需读。
     */
    upload: (key: ConversationKey) => Promise<UploadedFileMeta[] | null>;
  };
  conversations: {
    /** 模块滚动会话：挂载时取初始消息，run 结束后用 sync 落盘装配结果。 */
    get: (key: ConversationKey) => Promise<ConversationState>;
    sync: (key: ConversationKey, messages: WireMessage[]) => Promise<void>;
  };
  resume: {
    list: () => Promise<ResumeListState>;
    create: (name: string) => Promise<ResumeListState>;
    rename: (id: string, name: string) => Promise<ResumeListState>;
    remove: (id: string) => Promise<ResumeListState>;
    select: (id: string) => Promise<ResumeListState>;
    /** 读取当前简历的正文或定制稿；还没有简历时返回 null。 */
    read: (target: ResumeDocTarget) => Promise<ResumeDoc | null>;
    save: (target: ResumeDocTarget, content: string) => Promise<ResumeDoc | null>;
    /**
     * `photo:` 指令指向的证件照 → data URL（只允许当前简历 upload/ 下的
     * png / jpg / jpeg）。文件不存在或格式不支持时返回 null。
     */
    photo: (relPath: string) => Promise<string | null>;
    listTailored: () => Promise<TailoredDoc[]>;
    onFileChanged: (listener: (event: ResumeFileEvent) => void) => () => void;
    /*
     * 岗位话术（scripts/<jobId>.md + 定稿 sidecar）：与岗位 1:1，按 jobId 读写。
     * 生成 / 编辑走 save，定稿走 finalize（旧定稿自动进 scripts/history/）。
     */
    scripts: {
      list: () => Promise<ScriptDoc[]>;
      read: (jobId: string) => Promise<{ jobId: string; content: string; doc: ScriptDoc } | null>;
      save: (jobId: string, content: string) => Promise<ScriptDoc>;
      finalize: (jobId: string) => Promise<ScriptDoc>;
    };
    /** 主简历完整性报告（后台任务写入 reports/，保留历史）。 */
    integrityReports: (resumeId: string) => Promise<IntegrityReport[]>;
  };
  companies: {
    list: () => Promise<Company[]>;
    create: (patch: CompanyPatch) => Promise<Company>;
    update: (id: string, patch: CompanyPatch) => Promise<Company>;
    remove: (id: string) => Promise<void>;
  };
  jobs: {
    list: () => Promise<Job[]>;
    create: (patch: JobPatch) => Promise<Job>;
    update: (id: string, patch: JobPatch) => Promise<Job>;
    remove: (id: string) => Promise<void>;
  };
  applications: {
    list: () => Promise<Application[]>;
    create: (patch: ApplicationPatch) => Promise<Application>;
    update: (id: string, patch: ApplicationPatch) => Promise<Application>;
    remove: (id: string) => Promise<void>;
  };
  /** 投递状态流水线（工作区级）；设置区 UI 维护，读取方渲染下拉与校验。 */
  pipeline: {
    get: () => Promise<PipelineConfig>;
    save: (draft: PipelineDraft) => Promise<PipelineConfig>;
  };
  /** 后台任务：事件从 onEvent 订阅（含 start / update / finish）。 */
  tasks: {
    list: () => Promise<TaskState[]>;
    /** 同 type 同 target 去重：运行中再发起会以错误回执（提示稍候）。 */
    run: (type: TaskType, target: string) => Promise<TaskState>;
    /** 重跑一个已结束的任务（新 id，同 type + target）。 */
    rerun: (taskId: string) => Promise<TaskState>;
    onEvent: (listener: (event: TaskEvent) => void) => () => void;
  };
  /** 简历 / 定制稿导出 PDF：main 起隐藏窗口走渲染层导出路由排版。取消返回 null。 */
  pdf: {
    export: (payload: PdfExportPayload) => Promise<PdfExportResult | null>;
  };
  /**
   * 模拟面试（P3）：记录的增删与列表。轮次与总评由面试官 Agent 在
   * `interview:<id>` 会话里经工具写回，不走 IPC。
   */
  interviews: {
    list: () => Promise<Interview[]>;
    create: (input: InterviewCreateInput) => Promise<Interview>;
    remove: (id: string) => Promise<void>;
  };
  /**
   * 通知（P3 M3）：配置读写 + 逐项连通性测试 + 手动生成日报 / 周报。
   * SMTP / IMAP 密码是 safeStorage 密文，只在 main 侧解密，渲染层拿不到明文。
   * 发送与回信监控经 AgentRuntime 的 notify / requestConfirmation 工具走，
   * 不在这里暴露。
   */
  notify: {
    get: () => Promise<NotificationSettings>;
    save: (draft: NotificationDraft) => Promise<NotificationSettings>;
    /** 逐项连通性测试（带表单当前值；密码省略时用已存的）。 */
    test: (request: NotifyTestRequest) => Promise<NotifyTestResult>;
    /** 立即生成一次日报 / 周报（调度之外的手动入口）。 */
    runDigest: (kind: DigestKind) => Promise<DigestRunResult>;
  };
  /**
   * 浏览器自动化（P4）：审计日志读取与订阅、中止 / 单步重放（main 侧只重放
   * 非提交类步骤），以及设置读写。命令组装全在 main，渲染层拼不了 CLI。
   */
  agent: {
    onStep: (listener: (event: AgentStepEvent) => void) => () => void;
    abort: () => void;
    getSettings: () => Promise<BrowserAgentSettings>;
    saveSettings: (draft: BrowserAgentSettingsDraft) => Promise<BrowserAgentSettings>;
  };
  models: {
    get: () => Promise<ModelsConfig>;
    save: (draft: ModelsDraft) => Promise<ModelsConfig>;
    /** 对话侧模型选择器：只改这个工作区的默认模型，不动供应商与 Key。 */
    selectDefault: (selection: ModelSelection | null) => Promise<ModelsConfig>;
  };
  appearance: {
    get: () => Promise<AppearanceSettings>;
    save: (patch: Partial<AppearanceSettings>) => Promise<AppearanceSettings>;
  };
  workspace: {
    get: () => Promise<WorkspacesState>;
    switchTo: (id: string) => Promise<WorkspacesState>;
    /** 切换成功后 main 会广播，渲染层据此重读 models。 */
    onChanged: (listener: (state: WorkspacesState) => void) => () => void;
  };
}
