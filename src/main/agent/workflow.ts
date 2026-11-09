import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ToolLoopAgent, stepCountIs } from "ai";

import {
  MAX_WORKFLOW_TASKS,
  type ConversationKey,
  type SubagentRole,
  type SubagentStatus,
  type WorkflowState,
  type WorkflowStatus,
  type WorkflowTask,
} from "@shared/types";

import { ensureDir, writeJsonFile, type WorkspacePaths } from "../workspace/paths";
import type { AgentDeps } from "./deps";
import { buildInstructions } from "./instructions";
import { createLanguageModel, requireActiveModel } from "./model-provider";
import { subagentToolsFor } from "./tools";

/** 子 agent 单次任务上限：避免一个任务卡住整条工作流。 */
const SUBAGENT_TIMEOUT_MS = 5 * 60_000;
/** 整个工作流的上限：所有任务共享这一条时间预算。 */
const WORKFLOW_TIMEOUT_MS = 30 * 60_000;
/** 子 agent 流式期间的心跳：重置 AgentRuntime 的 90 秒首字节看门狗。 */
const HEARTBEAT_MS = 20_000;
/** 子 agent 输出回灌 GoodJob 时的截断上限。 */
const SUBAGENT_SUMMARY_LIMIT = 12_000;

export interface WorkflowTaskInput {
  id: string;
  agent: SubagentRole;
  title: string;
  instruction: string;
  dependsOn?: string[];
  targetId?: string | null;
}

export interface WorkflowRunInput {
  key: ConversationKey;
  title: string;
  tasks: WorkflowTaskInput[];
  signal?: AbortSignal;
  touch?: () => void;
}

export interface WorkflowRunResult {
  workflowId: string;
  status: WorkflowStatus;
  tasks: Array<{
    id: string;
    agent: SubagentRole;
    title: string;
    status: SubagentStatus;
    summary: string | null;
    error: string | null;
  }>;
}

export interface SubagentRunInput {
  agent: SubagentRole;
  title: string;
  instruction: string;
  targetId?: string | null;
  signal?: AbortSignal;
  touch?: () => void;
}

const ROLES: readonly SubagentRole[] = ["resume", "companies", "jobs", "job"];
const TASK_STATUSES: readonly SubagentStatus[] = [
  "pending",
  "running",
  "done",
  "failed",
  "blocked",
];
const WORKFLOW_STATUSES: readonly WorkflowStatus[] = ["pending", "running", "done", "failed"];

/**
 * GoodJob 的子任务调度器。
 *
 * 两类入口：
 * - `runSubagent`：单个角色的一次性任务，不产生工作流（右侧栏不出现流程图）。
 * - `runWorkflow`：带依赖的多任务，按波次并行执行，状态实时推渲染层并落盘。
 *
 * 子 agent 默认拿不到浏览器 / 通知 / 上传 / 会话工具：AI SDK 的 subagent 不支持
 * toolApproval，若把有副作用的浏览器 / 邮件工具放进去，现有审批门会被绕过。
 * 子 agent 只做各自模块的本地读写与产出，结果回到 GoodJob 再统一答复。
 */
export class WorkflowService {
  private dir: string;
  private readonly cache = new Map<ConversationKey, WorkflowState>();
  private readonly controllers = new Set<AbortController>();
  private readonly active = new Map<ConversationKey, WorkflowState>();

  constructor(
    private readonly deps: AgentDeps,
    workspace: WorkspacePaths,
    private readonly emit: (state: WorkflowState) => void,
  ) {
    this.dir = workspace.workflows;
  }

  useWorkspace(workspace: WorkspacePaths): void {
    this.abortAll();
    this.dir = workspace.workflows;
    this.cache.clear();
    // 旧工作区的工作流还在收尾：清掉 active，让它的 commit 认不出自己而跳过，
    // 避免把上一个工作区的状态写进新工作区。
    this.active.clear();
  }

  /** 当前 GoodJob 对话的最近一次工作流；没有时返回 null。 */
  get(key: ConversationKey): WorkflowState | null {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.fileFor(key), "utf8"));
    } catch {
      return null;
    }
    const state = reviveWorkflow(raw, key);
    if (state === null) return null;

    // 上次退出 / 切工作区时还在跑的任务已经不可能继续：把状态收成终态，
    // 否则右侧栏会永远显示「运行中」。
    if (state.status === "running") {
      const now = new Date().toISOString();
      for (const task of state.tasks) {
        if (task.status === "running") {
          task.status = "failed";
          task.error = "应用退出或工作区切换，任务被中断。";
          task.finishedAt = now;
        } else if (task.status === "pending") {
          task.status = "blocked";
          task.error = "工作流中断，任务未执行。";
          task.finishedAt = now;
        }
      }
      state.status = "failed";
      state.updatedAt = now;
      this.persist(state);
    }
    this.cache.set(key, state);
    return state;
  }

  /** 单个子 agent：直接在 GoodJob run 的 tool execute 里同步返回结果。 */
  async runSubagent(input: SubagentRunInput): Promise<{
    agent: SubagentRole;
    title: string;
    status: "done";
    summary: string;
  }> {
    this.validateRole(input.agent, input.targetId ?? null);
    const summary = await this.executeSubagent(
      input.agent,
      normalizeTarget(input.targetId),
      input.instruction.trim(),
      input.signal,
      input.touch,
    );
    return { agent: input.agent, title: input.title.trim(), status: "done", summary };
  }

  /**
   * 多任务工作流：先校验图（唯一 id / 依赖存在 / 无环），再按依赖波次执行。
   * 依赖失败的任务标 blocked，不会拖住其他分支。
   */
  async runWorkflow(input: WorkflowRunInput): Promise<WorkflowRunResult> {
    if (this.active.has(input.key)) {
      throw new Error("这个对话已经有一条工作流在运行，等它结束再派发新的。");
    }
    const tasks = input.tasks.map((task) => this.toTask(task));
    if (tasks.length < 2) {
      throw new Error("只有一个任务时不要建工作流，直接调用 subagent_run。");
    }
    if (tasks.length > MAX_WORKFLOW_TASKS) {
      throw new Error(`一次最多派发 ${MAX_WORKFLOW_TASKS} 个任务，请合并或分两次。`);
    }
    this.validateGraph(tasks);

    const now = new Date().toISOString();
    const state: WorkflowState = {
      id: `wf_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      key: input.key,
      title: input.title.trim() || "未命名工作流",
      status: "running",
      tasks,
      createdAt: now,
      updatedAt: now,
    };
    const link = this.linkSignal(input.signal, WORKFLOW_TIMEOUT_MS);
    this.active.set(input.key, state);
    this.commit(state);

    const byId = new Map(tasks.map((task) => [task.id, task]));
    try {
      while (true) {
        if (link.signal.aborted) break;

        // 前置任务失败 / 被跳过：当前任务不会再有机会执行。
        let blocked = false;
        for (const task of state.tasks) {
          if (task.status !== "pending") continue;
          const failed = task.dependsOn.some((id) => {
            const status = byId.get(id)?.status;
            return status === "failed" || status === "blocked";
          });
          if (failed) {
            task.status = "blocked";
            task.error = "前置任务没有完成，已跳过。";
            task.finishedAt = new Date().toISOString();
            blocked = true;
          }
        }
        if (blocked) this.commit(state);

        const ready = state.tasks.filter(
          (task) =>
            task.status === "pending" &&
            task.dependsOn.every((id) => byId.get(id)?.status === "done"),
        );
        if (ready.length === 0) {
          // 没有可执行的任务但仍有 pending：只会是图有问题（校验已挡住环）或被中止。
          for (const task of state.tasks) {
            if (task.status !== "pending") continue;
            task.status = "blocked";
            task.error = link.signal.aborted ? "工作流已中止。" : "前置任务没有完成，已跳过。";
            task.finishedAt = new Date().toISOString();
          }
          this.commit(state);
          break;
        }

        // 同一角色的任务串行：避免两个子 agent 同时写同一份简历 / 同一个实体。
        // 不同角色（以及不同岗位的 job 工作台）可以并行。
        const groups = new Map<string, WorkflowTask[]>();
        for (const task of ready) {
          const groupKey = `${task.agent}:${task.targetId ?? ""}`;
          const list = groups.get(groupKey);
          if (list === undefined) groups.set(groupKey, [task]);
          else list.push(task);
        }
        await runWithConcurrency([...groups.values()], 3, async (group) => {
          for (const task of group) {
            if (link.signal.aborted) return;
            await this.runTask(state, task, link.signal, input.touch);
          }
        });
      }
    } finally {
      for (const task of state.tasks) {
        if (task.status !== "pending") continue;
        task.status = "blocked";
        task.error = link.signal.aborted ? "工作流已中止。" : "前置任务没有完成，已跳过。";
        task.finishedAt = new Date().toISOString();
      }
      state.status = state.tasks.every((task) => task.status === "done") ? "done" : "failed";
      this.active.delete(input.key);
      this.commit(state);
      link.dispose();
    }

    return {
      workflowId: state.id,
      status: state.status,
      tasks: state.tasks.map((task) => ({
        id: task.id,
        agent: task.agent,
        title: task.title,
        status: task.status,
        summary: task.summary,
        error: task.error,
      })),
    };
  }

  /** 停掉所有正在跑的任务（应用退出 / 切工作区 / 用户停止 GoodJob run）。 */
  abortAll(): void {
    for (const controller of this.controllers) controller.abort(new Error("工作流已停止。"));
    this.controllers.clear();
  }

  private async runTask(
    state: WorkflowState,
    task: WorkflowTask,
    signal: AbortSignal,
    touch?: () => void,
  ): Promise<void> {
    task.status = "running";
    task.startedAt = new Date().toISOString();
    task.error = null;
    this.commit(state);

    try {
      const summary = await this.executeSubagent(
        task.agent,
        task.targetId,
        task.instruction,
        signal,
        touch,
      );
      task.summary = summary;
      task.status = "done";
    } catch (error) {
      task.status = "failed";
      task.error = signal.aborted ? "任务被中止。" : errorMessage(error);
    } finally {
      task.finishedAt = new Date().toISOString();
      this.commit(state);
    }
  }

  private async executeSubagent(
    role: SubagentRole,
    targetId: string | null,
    instruction: string,
    parentSignal?: AbortSignal,
    touch?: () => void,
  ): Promise<string> {
    this.validateRole(role, targetId);
    if (instruction.trim() === "") throw new Error("子任务说明不能为空。");

    const target = requireActiveModel(this.deps.models);
    const key = subagentConversationKey(role, targetId);
    const instructions = buildSubagentInstructions(this.deps, key);
    const agent = new ToolLoopAgent({
      model: createLanguageModel(target),
      instructions,
      tools: subagentToolsFor(this.deps, role, targetId),
      // 子任务不需要长篇输出；给 GoodJob 留足上下文。
      maxOutputTokens: Math.min(target.maxOutputTokens, 32_000),
      stopWhen: stepCountIs(20),
      onStepFinish: () => touch?.(),
    });

    const link = this.linkSignal(parentSignal, SUBAGENT_TIMEOUT_MS);
    const heartbeat = setInterval(() => touch?.(), HEARTBEAT_MS);
    touch?.();
    try {
      const result = await agent.generate({ prompt: instruction, abortSignal: link.signal });
      const text = result.text.trim();
      return text === "" ? "（子 agent 没有产出文字结果）" : clip(text, SUBAGENT_SUMMARY_LIMIT);
    } finally {
      clearInterval(heartbeat);
      link.dispose();
    }
  }

  private linkSignal(parent: AbortSignal | undefined, timeoutMs: number) {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(parent?.reason);
    if (parent?.aborted === true) controller.abort(parent.reason);
    else parent?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("任务执行超时。")), timeoutMs);
    this.controllers.add(controller);
    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timer);
        parent?.removeEventListener("abort", onAbort);
        this.controllers.delete(controller);
      },
    };
  }

  private toTask(input: WorkflowTaskInput): WorkflowTask {
    const id = input.id.trim();
    const title = input.title.trim();
    const instruction = input.instruction.trim();
    if (id === "" || !/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      throw new Error(`任务 id 不合法：${input.id}（用 1-32 位字母 / 数字 / 下划线 / 连字符）`);
    }
    if (title === "") throw new Error(`任务 ${id} 缺少标题。`);
    if (instruction === "") throw new Error(`任务 ${id} 缺少说明。`);
    return {
      id,
      agent: input.agent,
      title,
      instruction,
      targetId: normalizeTarget(input.targetId),
      dependsOn: [...new Set(input.dependsOn ?? [])],
      status: "pending",
      startedAt: null,
      finishedAt: null,
      summary: null,
      error: null,
    };
  }

  private validateRole(role: SubagentRole, targetId: string | null): void {
    if (!ROLES.includes(role)) throw new Error(`未知的子 agent 角色：${String(role)}`);
    if (role === "job") {
      if (targetId === null || targetId === "") {
        throw new Error("job 角色的子任务必须指定 targetId（岗位 id）。");
      }
      if (this.deps.jobs.get(targetId) === null) {
        throw new Error(`岗位不存在：${targetId}（先用 workspace_overview 查 id）`);
      }
    } else if (targetId !== null) {
      throw new Error(`${role} 角色不接受 targetId；只有 job 需要岗位 id。`);
    }
  }

  private validateGraph(tasks: WorkflowTask[]): void {
    const ids = new Set<string>();
    for (const task of tasks) {
      if (ids.has(task.id)) throw new Error(`任务 id 重复：${task.id}`);
      ids.add(task.id);
    }
    for (const task of tasks) {
      for (const dep of task.dependsOn) {
        if (!ids.has(dep)) throw new Error(`任务 ${task.id} 依赖了不存在的任务：${dep}`);
        if (dep === task.id) throw new Error(`任务 ${task.id} 不能依赖自己。`);
      }
    }
    // Kahn 拓扑排序：有环时无解，提前挡住而不是让执行循环空转。
    const indegree = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const queue = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id);
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      visited += 1;
      for (const task of tasks) {
        if (!task.dependsOn.includes(id)) continue;
        const next = (indegree.get(task.id) ?? 0) - 1;
        indegree.set(task.id, next);
        if (next === 0) queue.push(task.id);
      }
    }
    if (visited !== tasks.length) {
      const cyclic = tasks.filter((task) => (indegree.get(task.id) ?? 0) > 0).map((task) => task.id);
      throw new Error(`任务依赖有环：${cyclic.join(" → ")}`);
    }
    // byId 只用于确认所有 id 都能解析（上面的依赖检查已覆盖），这里保留一个防御。
    for (const task of tasks) {
      for (const dep of task.dependsOn) {
        if (byId.get(dep) === undefined) throw new Error(`任务 ${task.id} 的前置任务不存在：${dep}`);
      }
    }
  }

  private commit(state: WorkflowState): void {
    const active = this.active.get(state.key);
    // 旧工作区 / 旧工作流的收尾提交：active 已被清掉且缓存也换过了，直接丢弃。
    if (active !== undefined && active !== state) return;
    if (active === undefined && this.cache.get(state.key) !== state) return;
    state.updatedAt = new Date().toISOString();
    this.cache.set(state.key, state);
    this.persist(state);
    this.emit(state);
  }

  private persist(state: WorkflowState): void {
    try {
      ensureDir(this.dir);
      writeJsonFile(this.fileFor(state.key), state);
    } catch {
      // 落盘失败不影响本次运行；内存里仍有完整状态，界面照常更新。
    }
  }

  private fileFor(key: ConversationKey): string {
    return path.join(this.dir, `${encodeURIComponent(key)}.json`);
  }
}

/** 子 agent 对应的会话 key：决定工具集与岗位锁定。 */
export function subagentConversationKey(
  role: SubagentRole,
  targetId: string | null,
): ConversationKey {
  return (
    role === "job" && targetId !== null ? `job:${targetId}` : role
  ) as ConversationKey;
}

function buildSubagentInstructions(deps: AgentDeps, key: ConversationKey): string {
  const base = buildInstructions(deps, key, null, deps.memory.read());
  return `你是 GoodJob 的子 Agent，由 GoodJob 派发一次性任务。

硬规则：
- 只完成本次任务，不要向用户提问，也不要等待用户确认。信息不足时按已有资料保守完成，并在结果里列出缺口。
- 上传文件只有只读的 upload_list / upload_read，读的是 GoodJob 会话的 uploads/ 目录；下文模块指令里提到的模块 upload/ 目录你没有工具访问。需要附件时以 upload_list 的结果为准，找不到就在结果里说明。
- 你的工具集没有浏览器、通知和会话工具；需要联网时在结果里说明缺什么，不要假装查过。
- 不要创建或修改任务范围之外的数据。
- 最终回复会原样回到 GoodJob，不会直接展示给用户。请给一段可转述的结果摘要：先结论，再写关键事实 / 产出位置（文件、实体 id、分数），最后写风险或未完成项。不要写「已完成」这类空话。

${base}`;
}

function normalizeTarget(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…（输出过长已截断）` : text;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `：${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await run(items[index]!);
    }
  });
  await Promise.all(workers);
}

function reviveWorkflow(raw: unknown, key: ConversationKey): WorkflowState | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.title !== "string") return null;
  if (!Array.isArray(raw.tasks)) return null;
  const status = WORKFLOW_STATUSES.includes(raw.status as WorkflowStatus)
    ? (raw.status as WorkflowStatus)
    : "failed";
  const tasks: WorkflowTask[] = [];
  for (const item of raw.tasks) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    // 旧快照里的 applications 角色已并入 jobs，回放时按新角色处理。
    const role =
      item.agent === "applications"
        ? "jobs"
        : ROLES.includes(item.agent as SubagentRole)
          ? (item.agent as SubagentRole)
          : null;
    if (role === null) continue;
    tasks.push({
      id: item.id,
      agent: role,
      title: typeof item.title === "string" ? item.title : item.id,
      instruction: typeof item.instruction === "string" ? item.instruction : "",
      targetId: typeof item.targetId === "string" ? item.targetId : null,
      dependsOn: Array.isArray(item.dependsOn)
        ? item.dependsOn.filter((dep): dep is string => typeof dep === "string")
        : [],
      status: TASK_STATUSES.includes(item.status as SubagentStatus)
        ? (item.status as SubagentStatus)
        : "pending",
      startedAt: typeof item.startedAt === "string" ? item.startedAt : null,
      finishedAt: typeof item.finishedAt === "string" ? item.finishedAt : null,
      summary: typeof item.summary === "string" ? item.summary : null,
      error: typeof item.error === "string" ? item.error : null,
    });
  }
  return {
    id: raw.id,
    key,
    title: raw.title,
    status,
    tasks,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
