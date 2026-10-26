import { randomUUID } from "node:crypto";

import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

import type { JobMatchDimension, TaskEvent, TaskState, TaskType } from "@shared/types";

import type { JobsStore } from "./domain-store";
import { createLanguageModel, requireActiveModel } from "./model-provider";
import type { ModelsStore, ResolvedModel } from "./models-store";
import type { ResumeStore } from "./resume-store";

/**
 * 后台任务管理器（P2）：技能双入口（表格按钮 / 会话内工具）最终都调 `run(type, target)`。
 * 任务在 main 侧直接跑 Agent 环节（generateText + 结构化输出），不经过对话流，
 * 状态变化通过 `task:event` 推给渲染层；注册表只在内存里——应用退出即停、
 * 不做断点续跑（结果已落库：匹配度报告写回岗位，完整性报告落 resumes/<id>/reports/）。
 */

export interface TaskDeps {
  models: ModelsStore;
  jobs: JobsStore;
  resumes: ResumeStore;
  /** 状态变化的广播出口（IPC 层接 task:event）。 */
  emit: (event: TaskEvent) => void;
}

/** 评分类输出的统一形状：job-match 与 resume-integrity 共用。 */
const reportSchema = z.object({
  score: z.number().min(0).max(100),
  dimensions: z
    .array(
      z.object({
        name: z.string(),
        score: z.number().min(0).max(100),
        comment: z.string(),
      }),
    )
    .min(3)
    .max(8),
  conclusion: z.string(),
});

type ReportOutput = z.infer<typeof reportSchema>;

export class TaskManager {
  private readonly registry = new Map<string, TaskState>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: TaskDeps) {}

  /** 新任务排前面；渲染层拿去渲染「任务」角标与重跑入口。 */
  list(): TaskState[] {
    return [...this.registry.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 同 type 同 target 的最近一条（含已结束的），供会话工具返回「结果摘要」。 */
  latest(type: TaskType, target: string): TaskState | null {
    let latestTask: TaskState | null = null;
    for (const task of this.registry.values()) {
      if (task.type !== type || task.target !== target) continue;
      if (latestTask === null || task.createdAt > latestTask.createdAt) latestTask = task;
    }
    return latestTask;
  }

  /**
   * 发起一个任务：校验 target、去重（同 type 同 target 运行中 → 抛错提示）、
   * 解析模型（未配置 → 抛 llm_not_configured 引导去设置，不伪造），然后立刻返回，
   * 执行在后台继续。
   */
  run(type: TaskType, target: string): TaskState {
    const trimmed = target.trim();
    if (trimmed === "") throw new Error("任务目标不能为空。");
    this.validateTarget(type, trimmed);

    for (const task of this.registry.values()) {
      if (task.type === type && task.target === trimmed && task.status === "running") {
        throw new Error("这个任务已经在运行中了，请等它完成（进度会显示在顶栏任务角标）。");
      }
    }

    // 模型检查放在发起前：未配置就把错误直接带回调用方（按钮 / 工具），不去伪造结果。
    const resolved = requireActiveModel(this.deps.models);

    const now = new Date().toISOString();
    const task: TaskState = {
      id: `task_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      type,
      target: trimmed,
      status: "running",
      progress: "正在准备材料…",
      error: null,
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    this.registry.set(task.id, task);
    this.deps.emit({ type: "start", task });

    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    void this.execute(task, resolved, controller);

    return task;
  }

  /** 重跑一个已结束的任务：新建一条（新 id），旧记录留在注册表里。 */
  rerun(taskId: string): TaskState {
    const previous = this.registry.get(taskId);
    if (previous === undefined) throw new Error(`任务不存在：${taskId}`);
    if (previous.status === "running") throw new Error("这个任务还在运行中，等它完成后再重跑。");
    return this.run(previous.type, previous.target);
  }

  /** 应用退出 / 切换工作区时调用：停掉所有运行中的任务并清空注册表（结果都在实体里）。 */
  stopAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.registry.clear();
  }

  private validateTarget(type: TaskType, target: string): void {
    if (type === "job-match") {
      if (this.deps.jobs.get(target) === null) {
        throw new Error(`岗位不存在：${target}（可用 job_list 或岗位表查 id）`);
      }
      return;
    }
    if (!this.deps.resumes.list().items.some((item) => item.id === target)) {
      throw new Error(`简历不存在：${target}`);
    }
  }

  private async execute(task: TaskState, resolved: ResolvedModel, controller: AbortController): Promise<void> {
    try {
      const model = createLanguageModel(resolved);
      const result =
        task.type === "job-match"
          ? await this.runJobMatch(task, model, controller.signal)
          : await this.runIntegrity(task, model, controller.signal);
      this.finish(task, { status: "done", progress: null, result });
    } catch (error) {
      this.finish(task, {
        status: "failed",
        progress: null,
        error: controller.signal.aborted ? "已停止（应用退出或切换工作区）。" : describeError(error),
      });
    } finally {
      this.controllers.delete(task.id);
    }
  }

  /** 简历评估（JD 匹配度）：材料优先用该岗位的定制稿，没有再用当前主简历。 */
  private async runJobMatch(task: TaskState, model: LanguageModel, signal: AbortSignal): Promise<string> {
    this.patch(task, { progress: "正在读取岗位与简历…" });
    const job = this.deps.jobs.get(task.target);
    if (job === null) throw new Error(`岗位不存在：${task.target}`);

    const tailored = this.deps.resumes.readTailored(job.id);
    const resumeText = tailored ?? this.deps.resumes.read({ kind: "main" })?.content ?? "";
    if (resumeText.trim() === "") throw new Error("简历还是空的，先在简历页写一份再评估。");
    if (job.jd.trim() === "") throw new Error("这个岗位还没有填 JD，先在岗位表里补上再评估。");

    this.patch(task, { progress: "正在评分（对照 JD 与简历）…" });
    const { output } = await generateText({
      model,
      output: Output.object({ schema: reportSchema }),
      abortSignal: signal,
      prompt: [
        "你是资深招聘官，请逐条对照下面的岗位 JD 与候选人简历，评估这份简历投这个岗位的匹配度。",
        "",
        `【岗位】${job.title}${job.salaryBand === "" ? "" : `（薪资：${job.salaryBand}）`}`,
        "【JD】",
        job.jd.trim(),
        "",
        `【候选人简历】（${tailored === null ? "主简历" : "该岗位的定制简历"}）`,
        resumeText.trim(),
        "",
        [
          "输出要求：",
          "- score：总体匹配度 0-100 的整数，克制打分——简历里没有证据的能力不给分。",
          "- dimensions：3-6 个维度，每个含 name / score(0-100) / comment。按这个 JD 的实际要求取舍，",
          "  常见维度：核心技能匹配、经验与年限、行业或业务域、硬性条件（学历/证书/城市）、加分项。",
          "- conclusion：120 字以内。先说最匹配的点，再说最大缺口与建议（简历补什么 / 面试怎么讲）。",
          "简历里没写的不要臆造；JD 里含糊的要求在 comment 里说明你的理解。",
        ].join("\n"),
      ].join("\n"),
    });

    const report = normalizeReport(output);
    this.patch(task, { progress: "正在写回匹配度报告…" });
    this.deps.jobs.setMatchReport(job.id, {
      ...report,
      evaluatedAt: new Date().toISOString(),
    });
    return `匹配度 ${report.score}/100：${report.conclusion}`;
  }

  /** 主简历完整性评分：报告落 resumes/<id>/reports/<ts>-integrity.json（保留历史）。 */
  private async runIntegrity(task: TaskState, model: LanguageModel, signal: AbortSignal): Promise<string> {
    this.patch(task, { progress: "正在读取简历…" });
    const resume = this.deps.resumes.readMainById(task.target);
    if (resume === null || resume.trim() === "") throw new Error("这份简历还是空的，先写点内容再评估。");

    this.patch(task, { progress: "正在评估完整性…" });
    const { output } = await generateText({
      model,
      output: Output.object({ schema: reportSchema }),
      abortSignal: signal,
      prompt: [
        "你是简历顾问，请审查下面这份求职简历的完整性，找出最影响投递效果的问题。",
        "",
        "【简历】",
        resume.trim(),
        "",
        [
          "输出要求：",
          "- score：完整性 0-100 的整数。",
          "- dimensions：3-6 个维度，每个含 name / score(0-100) / comment。常见维度：基本信息完整度、",
          "  经历量化程度（有没有数字与成果）、技能表述、结构与排版一致性、教育与其他背景；按实际内容取舍。",
          "- conclusion：120 字以内，列出最值得先补的三件事。",
          "只评论已有内容的完整度与说服力，不要替用户编造经历。",
        ].join("\n"),
      ].join("\n"),
    });

    const report = normalizeReport(output);
    this.patch(task, { progress: "正在保存报告…" });
    const saved = this.deps.resumes.saveIntegrityReport(task.target, report);
    return `完整性 ${saved.score}/100：${saved.conclusion}（已存 ${saved.file}）`;
  }

  private patch(task: TaskState, changes: Partial<TaskState>): void {
    const current = this.registry.get(task.id);
    if (current === undefined) return; // stopAll 清空后：任务不再上报。
    Object.assign(current, changes, { updatedAt: new Date().toISOString() });
    this.deps.emit({ type: "update", task: current });
  }

  private finish(
    task: TaskState,
    outcome: { status: TaskState["status"]; progress: string | null; result?: string; error?: string },
  ): void {
    const current = this.registry.get(task.id);
    if (current === undefined) return;
    Object.assign(current, outcome, { updatedAt: new Date().toISOString() });
    this.deps.emit({ type: "finish", task: current });
  }
}

/** 模型输出 → 落库形状：分数取整、维度清洗，保证报告字段稳定。 */
function normalizeReport(output: ReportOutput): { score: number; dimensions: JobMatchDimension[]; conclusion: string } {
  return {
    score: Math.round(output.score),
    dimensions: output.dimensions.map((dimension) => ({
      name: dimension.name.trim() === "" ? "维度" : dimension.name.trim(),
      score: Math.round(dimension.score),
      comment: dimension.comment.trim(),
    })),
    conclusion: output.conclusion.trim(),
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "任务执行失败（未知错误）";
}
