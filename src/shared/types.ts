/**
 * Types shared by the main process, the preload bridge and the renderer.
 * Keep this file dependency-free so it can be compiled into every process.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * 滚动会话的 key：一个模块一条会话，没有用户可见的"会话列表"。
 * 「对话」通用页已移除（产品决策：独立聊天不在规划内）。
 * 模块 key 在这里登记，main 的工具注册表（toolsFor）按它分发；
 * 复合 key 是通用机制——`job:<jobId>` 是岗位二级工作台的独立会话
 * （避免多岗位上下文互串），`interview:<id>` 是一场模拟面试的独立会话。
 * 落盘文件名对 key 做 encodeURIComponent（`:` 等不安全字符会被编码掉）。
 */
export type ConversationKey =
  | "resume"
  | "companies"
  | "jobs"
  | "applications"
  | `job:${string}`
  | `interview:${string}`;

/** 从复合 key 里取岗位 id；不是 job 会话时返回 null。 */
export function jobKeyTarget(key: ConversationKey): string | null {
  return key.startsWith("job:") ? key.slice("job:".length) : null;
}

/** 从复合 key 里取面试 id；不是 interview 会话时返回 null。 */
export function interviewKeyTarget(key: ConversationKey): string | null {
  return key.startsWith("interview:") ? key.slice("interview:".length) : null;
}

/**
 * 会话消息的线上形态 —— 与 AI SDK 的 UIMessage 结构兼容。
 * shared 保持零依赖，所以 parts 用 unknown 承载，渲染层再断言回 UIMessage。
 */
export interface WireMessage {
  id: string;
  role: "system" | "user" | "assistant";
  parts: unknown[];
  /**
   * 消息元数据（AI SDK UIMessage.metadata 的线形态）。
   * 目前渲染层会在 run 结束时给助手消息写入 `{ durationMs }`（本轮耗时）。
   */
  metadata?: unknown;
}

/** 模型上下文的出厂默认值：窗口 200K，单次回复最多 64K。 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

/**
 * 思考等级（输入框里的那个选项）：映射到 AI SDK 顶层 `reasoning` 参数，
 * 由各供应商适配层翻成自己的字段（OpenAI 的 reasoning_effort、Anthropic 的预算等）。
 */
export type ReasoningEffort = "low" | "medium" | "high";

/** 默认思考等级（新建会话 / 老会话没有记录时）。 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export interface ConversationState {
  key: ConversationKey;
  messages: WireMessage[];
  updatedAt: string | null;
}

/** 渲染层 → main 的一次 agent run：messages 是含新用户消息的完整 UI 历史。 */
export interface ChatSendPayload {
  key: ConversationKey;
  runId: string;
  messages: WireMessage[];
  /** 本次 run 的思考等级；不传则用默认值（medium）。只在推理模型上生效。 */
  effort?: ReasoningEffort;
}

/**
 * 上下文用量（`chat:context` 的返回）：token 数为估算值（按字符数折算），
 * 只用于展示与压缩判定，不是供应商账单上的数字。
 */
export interface ContextUsage {
  /** 模型的上下文窗口（token）。 */
  limit: number;
  /** 单次回复预留的输出上限（token）。 */
  maxOutputTokens: number;
  /** 到多少就自动压缩（约等于窗口 90%，并为输出预留空间）。 */
  threshold: number;
  /** 指令（系统提示 + 记忆 + 摘要）占用的 token。 */
  instructions: number;
  /** 会送进模型的消息里，用户 / 工具结果的 token。 */
  input: number;
  /** 助手正文的 token。 */
  output: number;
  /** 思考内容的 token。 */
  reasoning: number;
  /** 合计 = instructions + input + output + reasoning。 */
  used: number;
  /** 已被压缩进摘要的消息条数。 */
  summarizedMessages: number;
}

/** main → 渲染层的流事件：chunk 是 UIMessageChunk（可序列化线协议）；done 表示 run 结束。 */
export type ChatStreamEvent =
  | { key: ConversationKey; runId: string; type: "chunk"; chunk: unknown }
  | { key: ConversationKey; runId: string; type: "done" };

/** 一份主简历 = resumes/ 下一个文件夹；这里是索引里的元数据。 */
export interface ResumeMeta {
  id: string;
  name: string;
  createdAt: string;
}

export interface ResumeListState {
  items: ResumeMeta[];
  currentId: string | null;
}

/** 编辑器当前打开的文件：主简历正文，或某份岗位定制稿。 */
export type ResumeDocTarget =
  | { kind: "main" }
  | { kind: "tailored"; name: string };

export interface ResumeDoc {
  resumeId: string;
  /** 简历名称（索引里的人类可读名字）。 */
  name: string;
  target: ResumeDocTarget;
  content: string;
}

export interface TailoredDoc {
  /** 文件名（不含扩展名，slug）。 */
  name: string;
  updatedAt: string | null;
}

/**
 * 一次上传的回执：文件已原样复制进当前会话所属模块的 `upload/` 目录。
 * 消息里只带文件名，内容由 Agent 用工具自行读取（不再把全文塞进消息）。
 */
export interface UploadedFileMeta {
  /** 落盘后的文件名；与所选文件同名，重名时自动加 `-2` / `-3` 后缀。 */
  fileName: string;
  /** 文件大小（字节）。 */
  size: number;
}

/** 用户或 Agent 写入简历文件后广播；编辑器据此热更新，或（有未保存修改时）提示冲突。 */
export interface ResumeFileEvent {
  resumeId: string;
  /** "main" 或定制稿文件名（不含扩展名）。 */
  file: string;
}

/*
 * —— 领域实体（P2）——
 *
 * 一个实体一个 JSON 文件（`<集合目录>/<id>.json`，0600），ID 惯例 `co_` / `job_` / `app_`
 * + 12 位 hex。引用存名不存内容：岗位 / 投递被删时不级联，悬空引用由渲染层提示。
 * 排序 / 过滤在渲染层做（内存排序），store 只保证数据可排：list 原样返回全量。
 */

/** 公司档案（`companies/<id>.json`）。 */
export interface Company {
  id: string;
  name: string;
  industry: string;
  scale: string;
  city: string;
  website: string;
  /** 怎么了解到这家公司的（内推 / 招聘平台 / 官网…）。 */
  source: string;
  /** 调研快照（Markdown），由用户或 Agent 整理。 */
  research: string;
  /** 最近一次写入调研快照的时间；没有快照为 null。 */
  researchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 岗位的简历匹配度报告：后台任务（job-match）写入，Agent 工具不手改。 */
export interface JobMatchReport {
  /** 0–100 的总分。 */
  score: number;
  dimensions: JobMatchDimension[];
  /** 一段结论 / 建议。 */
  conclusion: string;
  /** 评分任务完成时间。 */
  evaluatedAt: string;
}

export interface JobMatchDimension {
  name: string;
  /** 0–100。 */
  score: number;
  comment: string;
}

/** 岗位档案（`jobs/<id>.json`）。 */
export interface Job {
  id: string;
  /** 引用公司；被删的公司会成为悬空引用（渲染层提示），不阻止岗位本身。 */
  companyId: string | null;
  title: string;
  /** JD 原文（Markdown，用户粘贴或 Agent 整理）。 */
  jd: string;
  url: string;
  /** 薪资带（自由文本，如「25-40k·16 薪」）。 */
  salaryBand: string;
  /** 匹配度报告；从未评估过为 null。 */
  matchReport: JobMatchReport | null;
  createdAt: string;
  updatedAt: string;
}

/** 投递的状态时间线：只追加，历史不改写。 */
export interface ApplicationTimelineEntry {
  /** 阶段名，必须出现在 pipeline 里（追加时校验）。 */
  stage: string;
  at: string;
  note: string;
}

/** Offer 信息（投递进入 Offer 终态后填写，供对比）。 */
export interface OfferInfo {
  salary: string;
  equity: string;
  note: string;
}

/** 投递档案（`applications/<id>.json`）。 */
export interface Application {
  id: string;
  jobId: string | null;
  timeline: ApplicationTimelineEntry[];
  offer: OfferInfo | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** 创建 / 更新实体时传入的字段集：更新只传要改的，创建必填字段由 main 校验。 */
export interface CompanyPatch {
  name?: string;
  industry?: string;
  scale?: string;
  city?: string;
  website?: string;
  source?: string;
  research?: string;
}

export interface JobPatch {
  companyId?: string | null;
  title?: string;
  jd?: string;
  url?: string;
  salaryBand?: string;
}

export interface ApplicationPatch {
  jobId?: string | null;
  timeline?: ApplicationTimelineEntry[];
  offer?: OfferInfo | null;
  note?: string;
}

/** 流水线阶段（`applications/pipeline.json`）：有序 + 终态标记，工作区级可配置。 */
export interface PipelineStage {
  name: string;
  /** 终态（Offer / 未通过…）：到达后不再顺流。保存时至少要有一个终态。 */
  final: boolean;
}

export interface PipelineConfig {
  stages: PipelineStage[];
}

/** 保存流水线时的入参（读取走 pipeline.get）。 */
export interface PipelineDraft {
  stages: PipelineStage[];
}

/*
 * —— 模拟面试（P3 M1：文本）——
 *
 * 一场面试一条记录（`interviews/<id>.json`，ID 惯例 `iv_` + 12 位 hex），
 * 绑定岗位 JD 与该岗位的定制简历（P2 的 1:1）。逐轮问答本体在会话
 * `interview:<id>` 里（UIMessage，与滚动会话同一渲染管线），这里的 rounds
 * 是面试官经工具写回的结构化轮次记录，供列表与逐轮时间线使用。
 */

export type InterviewMode = "text" | "voice";

/** 面试配置：轮次由用户在发起时设定；语音模式 M2 接入（先占位）。 */
export interface InterviewConfig {
  rounds: number;
  mode: InterviewMode;
}

/** 一轮面试记录：主问题 + 0~2 个追问（追问不计入用户设定的轮次）+ 回答。 */
export interface InterviewRound {
  /** 轮次序号（从 1 开始，由 store 按记录顺序分配，模型不能指定）。 */
  no: number;
  /** 本轮主问题。 */
  question: string;
  /** 追问列表（0~2 条）。 */
  followUps?: string[];
  /** 候选人的回答（要点）。 */
  answer: string;
  /** 本轮表现小结（出总评时按轮补写）。 */
  note?: string;
  /** M2 语音轮次标记（不存音频本体）。 */
  audioMark?: string;
}

/** 面试总评：四维评价在 overall（Markdown）里，亮点 / 风险 / 建议分列。 */
export interface InterviewReview {
  /** 总评分（0–100），面试列表的「总评分」列用。 */
  score: number;
  /** 总评正文（Markdown）：表达 / 深度 / 结构 / 岗位匹配四维 + 逐轮小结。 */
  overall: string;
  /** 亮点。 */
  strengths: string[];
  /** 风险与不足。 */
  weaknesses: string[];
  /** 逐条可执行的改进建议。 */
  suggestions: string[];
}

/** 面试档案（`interviews/<id>.json`）。 */
export interface Interview {
  id: string;
  /** 绑定的岗位；岗位被删后成为悬空引用（渲染层提示），不阻止面试记录本身。 */
  jobId: string;
  /** 面试所依据的定制稿（tailored/<jobId>.md），发起时固化。 */
  resumeRef: string;
  config: InterviewConfig;
  rounds: InterviewRound[];
  /** 总评；未结束（或结束流程没走完）为 null。 */
  review: InterviewReview | null;
  status: "running" | "finished";
  createdAt: string;
  finishedAt: string | null;
}

/** 发起面试的入参（渲染层弹窗 / 后续入口共用）。 */
export interface InterviewCreateInput {
  jobId: string;
  rounds: number;
  mode: InterviewMode;
}

/*
 * —— 通知（P3 M3）——
 *
 * notifications.json 跟随工作区：不同工作区可以配不同邮箱。SMTP / IMAP 密码是
 * safeStorage 密文，只在 main 侧解密——渲染层只看得到「有没有已存密码」，
 * 密码本身不进渲染层、不进日志。
 */

/** SMTP / IMAP 账户的连接字段（不含密码）。 */
export interface NotifyMailAccount {
  host: string;
  port: number;
  /** true = 直连 TLS（465/993），false = STARTTLS（587 等）。 */
  secure: boolean;
  user: string;
}

/** 渲染层看到的通知账户：只给「有没有已存密码」，不给密码本身。 */
export interface PublicNotifyMailAccount extends NotifyMailAccount {
  hasPassword: boolean;
}

/** 保存时的账户字段：password 省略 = 保持已存，null = 清除，字符串 = 替换。 */
export interface NotifyMailAccountDraft extends NotifyMailAccount {
  password?: string | null;
}

/** 日报 / 周报调度：time 为本地时间 HH:mm；周报 weekday 0=周日。 */
export interface DigestSchedule {
  enabled: boolean;
  time: string;
  /** 周报用；日报忽略。 */
  weekday?: number;
}

/** 通知设置（notifications.json 的公开投影）。 */
export interface NotificationSettings {
  /** 发件人显示地址；为空时用 SMTP 账户。 */
  fromAddress: string;
  smtp: PublicNotifyMailAccount;
  imap: PublicNotifyMailAccount;
  digest: {
    daily: DigestSchedule;
    weekly: DigestSchedule;
  };
  /** False when the OS keychain is unavailable, so passwords cannot be encrypted. */
  canStorePassword: boolean;
}

/** 保存通知设置：只传要改的部分。 */
export interface NotificationDraft {
  fromAddress?: string;
  smtp?: NotifyMailAccountDraft;
  imap?: NotifyMailAccountDraft;
  digest?: {
    daily?: Partial<DigestSchedule>;
    weekly?: Partial<DigestSchedule>;
  };
}

/** 「测试连接」：SMTP = 发送通道，IMAP = 收信通道（IDLE 依赖它）。 */
export type NotifyTestKind = "smtp" | "imap";

/** 测试入参带表单当前值：密码省略时用已存的，测的是「填完之后能不能通」。 */
export interface NotifyTestRequest {
  kind: NotifyTestKind;
  account: NotifyMailAccountDraft;
}

export interface NotifyTestResult {
  ok: boolean;
  /** 成功 / 失败的具体原因，直接给人看；永不包含密码。 */
  message: string;
}

export type DigestKind = "daily" | "weekly";

/** 手动生成日报 / 周报的回执（自动调度没有回执，出错只记日志）。 */
export interface DigestRunResult {
  ok: boolean;
  message: string;
}

/*
 * —— 浏览器自动化（P4）——
 *
 * main 侧的 src/main/agent/（agent-browser 四件套）驱动内嵌浏览器；每一步 CLI
 * 都是一条受控动作（actions.ts 白名单），审计 = 右栏「工作日志」标签 + 工作区
 * logs/agent.log（不含页面正文）。渲染层只消费 AgentStep / 状态事件，拼不了命令。
 */

/** 一步浏览器动作的审计记录（agent:step 事件与 agent:log-list 共用形状）。 */
export interface AgentStep {
  id: string;
  /** 发起会话（ConversationKey）；系统动作（tab 锁定 / 中止）为 null。 */
  key: string | null;
  /** 动作名：browser_read.open / browser_act.click / agent.lock-target / agent.abort。 */
  action: string;
  /** 实际执行的完整 argv（含 --session / --cdp 全局旗标），审计可复查。 */
  command: string[];
  ok: boolean;
  /** 结果摘要（不含页面正文）。 */
  summary: string;
  error: string | null;
  durationMs: number;
  at: string;
}

/** agent:step 的载荷：step 是新的一步；status 表示「是否有浏览器任务在跑」。 */
export type AgentStepEvent =
  | { type: "step"; step: AgentStep }
  | { type: "status"; running: boolean; key: string | null };

/** 浏览器自动化设置（<workspace>/agent-browser.json 的公开投影）。 */
export interface BrowserAgentSettings {
  /** 总开关：关闭时 companies / jobs / applications 会话不注册浏览器工具。 */
  enabled: boolean;
  submit: {
    /** 单站每日提交上限（默认 10）。 */
    dailyLimitPerSite: number;
    /** 两次提交之间的最小间隔秒数（默认 90，实际再加随机抖动）。 */
    minIntervalSeconds: number;
  };
  /** 平台适配模板（browser-playbooks.md）的落盘路径，只读展示；用户直接编辑文件。 */
  playbooksPath: string;
}

/** 保存浏览器自动化设置：只传要改的部分，数值由 main 夹紧。 */
export interface BrowserAgentSettingsDraft {
  enabled?: boolean;
  submit?: {
    dailyLimitPerSite?: number;
    minIntervalSeconds?: number;
  };
}

/*
 * —— 后台任务（P2）——
 *
 * 技能双入口（表格按钮 / 会话内工具）触发的是同一个 TaskManager.run；
 * 注册表只在内存里：应用退出即停、不做断点续跑（结果已落库，重启可重跑）。
 */

export type TaskType = "job-match" | "resume-integrity";

export type TaskStatus = "running" | "done" | "failed";

/** task.target：job-match → 岗位 id；resume-integrity → 简历 id。 */
export interface TaskState {
  id: string;
  type: TaskType;
  target: string;
  status: TaskStatus;
  /** 人类可读的进度提示（如「正在读取简历与 JD」）。 */
  progress: string | null;
  /** 失败原因（status === "failed" 时非空）。 */
  error: string | null;
  /** 完成时的结果摘要（如「匹配度 72/100」），详情在实体 / 报告文件里。 */
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

/** main → 渲染层的任务事件：每次状态变化发一次，task 是变化后的全量。 */
export type TaskEvent =
  | { type: "start"; task: TaskState }
  | { type: "update"; task: TaskState }
  | { type: "finish"; task: TaskState };

/*
 * —— 右栏工作台事件（P2）——
 *
 * BROWSER-AGENT §6 预留的 main → renderer 事件：main 侧（后台任务等）
 * 请求渲染层打开右栏与对应标签。渲染层 panes.tsx 注册标签内容，
 * 这里只放跨进程的那部分类型。
 */

/** 右栏工作台标签的 key（渲染层 panes.tsx 是内容注册表，两边保持同步）。 */
export type PaneKey = "browser" | "markdown" | "editor" | "log" | "scorecard";

/** 评分卡要展示的报告定位：岗位匹配度报告，或主简历完整性报告。 */
export type ScorecardTarget =
  | { kind: "job"; jobId: string }
  | { kind: "integrity"; resumeId: string };

/** agent:pane-open 的载荷：scorecard 标签必须带定位，其余标签无参数。 */
export type AgentPaneOpenEvent = {
  pane: PaneKey;
  scorecard?: ScorecardTarget;
};

/** 话术当前版（scripts/<jobId>.md）+ 定稿 sidecar 汇总出的列表项。 */
export interface ScriptDoc {
  /** 岗位 id（文件名即 key，与岗位 1:1）。 */
  jobId: string;
  updatedAt: string | null;
  /** 是否存在定稿。 */
  final: boolean;
  finalizedAt: string | null;
  /** 定稿后又编辑过（内容指纹 != 定稿指纹），提示「待重新定稿」。 */
  modifiedSinceFinal: boolean;
}

/** 主简历完整性报告（resumes/<id>/reports/<ts>-integrity.json）。 */
export interface IntegrityReport {
  /** 文件名（不含路径），按时间排序的键。 */
  file: string;
  score: number;
  dimensions: JobMatchDimension[];
  conclusion: string;
  createdAt: string;
}

/** pdf:export 的入参。 */
export interface PdfExportPayload {
  /** 要排版的 Markdown 源文。 */
  markdown: string;
  /** 文档模板 id（渲染层 markdown/templates 登记过的），缺省用默认模板。 */
  templateId?: string;
  /** 保存对话框预填的文件名（不含扩展名）。 */
  fileName?: string;
}

/** pdf:export 的回执：用户取消返回 null。 */
export interface PdfExportResult {
  savedTo: string;
}

/**
 * Wire protocol of a provider. Each one maps to a different AI SDK adapter
 * factory, which is why it is stored per provider instead of per model.
 */
export type ProviderProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export interface ModelEntry {
  /** Value sent as `model` in the request. */
  id: string;
  /** Display name; falls back to `id` when empty. */
  name: string;
  enabled: boolean;
  /**
   * 上下文窗口（token）：Agent 的对话预算由它决定——不再按「保留最近 12 条」截尾，
   * 而是用到约 90% 就把更早的消息压进摘要。缺省 200K（DEFAULT_CONTEXT_WINDOW）。
   */
  contextWindow: number;
  /** 单次回复的输出上限（token），同时从上下文里预留这么多空间。缺省 64K。 */
  maxOutputTokens: number;
  vision?: boolean;
  /** 推理模型：勾上才会把思考等级发给供应商，也才会显示思考过程。 */
  reasoning?: boolean;
}

/** One model provider as stored in `<workspace>/models.json`. */
export interface ProviderConfig {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  enabled: boolean;
  models: ModelEntry[];
}

/**
 * 对话要调用的模型。设置页不再提供这个选择（那里只管"有哪些模型可用"），
 * 将来由对话侧的模型选择器写入。
 */
export interface ModelSelection {
  providerId: string;
  modelId: string;
}

/** Provider as seen by the renderer: the API key itself never crosses the bridge. */
export interface PublicProvider extends ProviderConfig {
  hasApiKey: boolean;
}

/** The model the chat will actually call, plus whether it is usable yet. */
export interface ActiveModel {
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  /** False when the provider needs an API key that has not been stored. */
  ready: boolean;
  /** 推理模型：输入框才显示思考等级选项。 */
  reasoning: boolean;
}

export interface ModelsConfig {
  version: number;
  defaultModel: ModelSelection | null;
  providers: PublicProvider[];
  activeModel: ActiveModel | null;
  /** False when the OS keychain is unavailable, so keys cannot be encrypted. */
  canStoreKey: boolean;
}

export interface ProviderDraft extends ProviderConfig {
  /** `undefined` keeps the stored key, `null` clears it, a string replaces it. */
  apiKey?: string | null;
}

export interface ModelsDraft {
  /**
   * 省略表示"保持原值"。设置页只维护供应商与模型清单，对话用哪个模型由对话侧自己决定，
   * 所以这里不再由设置页写入。
   */
  defaultModel?: ModelSelection | null;
  providers: ProviderDraft[];
}

/**
 * 一个工作区 = 配置文件夹下的一个子文件夹，目录名用 `id`，`name` 只存在索引里。
 * 切换工作区会连带换掉模型配置和后续所有数据。
 */
export interface WorkspaceInfo {
  id: string;
  name: string;
  createdAt: string;
}

export interface WorkspacesState {
  items: WorkspaceInfo[];
  /** 始终有值：首次启动会自动创建默认工作区。 */
  currentId: string;
}

/**
 * 界面主题：跟随系统 / 强制浅色 / 强制深色。
 * 外观设置属于"这台机器上的这个人"，不属于工作区，所以存在配置根目录而不是工作区里。
 */
export type ThemeMode = "system" | "light" | "dark";

export interface AppearanceSettings {
  themeMode: ThemeMode;
  /** 界面字号（px），10–18。 */
  fontSize: number;
}

export interface AppInfo {
  platform: string;
  version: string;
  /** 配置根目录，例如 ~/.goodjob */
  dataDir: string;
  /** 当前工作区目录，配置与数据都在里面 */
  workspaceDir: string;
}

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
  browserState: "browser:state",
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
  agentLogList: "agent:log-list",
  agentStepEvent: "agent:step",
  agentAbort: "agent:abort",
  agentReplayStep: "agent:replay-step",
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
    onState: (listener: (state: BrowserState) => void) => () => void;
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
  /** 右栏工作台：main（后台任务 / 后续 Agent）请求打开某个标签。 */
  workbench: {
    onPaneOpen: (listener: (event: AgentPaneOpenEvent) => void) => () => void;
  };
  /**
   * 浏览器自动化（P4）：审计日志读取与订阅、中止 / 单步重放（main 侧只重放
   * 非提交类步骤），以及设置读写。命令组装全在 main，渲染层拼不了 CLI。
   */
  agent: {
    listLog: () => Promise<AgentStep[]>;
    onStep: (listener: (event: AgentStepEvent) => void) => () => void;
    abort: () => void;
    replayStep: (stepId: string) => Promise<void>;
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
