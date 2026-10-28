/*
 * —— 领域实体（P2）——
 *
 * 一个实体一个 JSON 文件（`<集合目录>/<id>.json`，0600），ID 惯例 `co_` / `job_` / `app_`
 * + 12 位 hex。引用存名不存内容：岗位 / 投递被删时不级联，悬空引用由渲染层提示。
 * 排序 / 过滤在渲染层做（内存排序），store 只保证数据可排：list 原样返回全量。
 */

/** 会被 Agent 工具 / IPC 写入的领域集合（变更事件按集合名广播）。 */
export type DomainEntity = "companies" | "jobs" | "applications" | "interviews";

/**
 * 领域集合变更事件：main 在任意一次写入（用户操作或 Agent 工具）之后广播，
 * 渲染层的表格据此重拉。只带集合名，不带内容——列表本来就该由 IPC 读。
 */
export interface DomainChangedEvent {
  entity: DomainEntity;
}

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

/**
 * 评分卡要展示的报告定位：岗位匹配度报告，或主简历完整性报告。
 * 报告本体在渲染层的 Dialog 里展示（岗位表点匹配度徽标 / 简历页点完整性报告）。
 */
export type ScorecardTarget =
  | { kind: "job"; jobId: string }
  | { kind: "integrity"; resumeId: string };
