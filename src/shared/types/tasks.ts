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
