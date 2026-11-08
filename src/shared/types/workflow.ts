import type { ConversationKey } from "./chat";

/** 单条工作流的任务上限：控制一次派发的成本与右侧流程图的规模。 */
export const MAX_WORKFLOW_TASKS = 10;

/**
 * GoodJob Agent 可以派发的子 Agent 角色。每个角色对应一个已有模块的能力边界：
 * resume = 简历，companies = 公司档案，jobs = 岗位档案，
 * applications = 投递，job = 某个岗位的二级工作台（定制简历 / 话术）。
 */
export type SubagentRole = "resume" | "companies" | "jobs" | "applications" | "job";

/**
 * 单个子任务的运行状态。
 * blocked = 前置任务失败或工作流被中止，任务不会再执行。
 */
export type SubagentStatus = "pending" | "running" | "done" | "failed" | "blocked";

export type WorkflowStatus = "pending" | "running" | "done" | "failed";

export interface WorkflowTask {
  /** 任务内唯一 id（短英文 / 数字 / 连字符），dependsOn 用它引用。 */
  id: string;
  agent: SubagentRole;
  title: string;
  /** 派发给子 Agent 的完整任务说明。子 Agent 看不到 GoodJob 对话，必须自带上下文。 */
  instruction: string;
  /** job 角色必填：要操作的岗位 id；其余角色为 null。 */
  targetId: string | null;
  /** 前置任务 id；空数组表示可以立即开始。 */
  dependsOn: string[];
  status: SubagentStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** 子 Agent 的最终交付摘要。 */
  summary: string | null;
  error: string | null;
}

/**
 * 一次工作流的持久化快照。一个 GoodJob 对话只保留最近一次工作流，
 * 右侧栏按当前对话 key 读取 / 订阅。
 */
export interface WorkflowState {
  id: string;
  key: ConversationKey;
  title: string;
  status: WorkflowStatus;
  tasks: WorkflowTask[];
  createdAt: string;
  updatedAt: string;
}
