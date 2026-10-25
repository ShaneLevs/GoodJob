import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { IPC, type AgentStep } from "@shared/types";

import type { BrowserReadAction, BrowserActAction, BrowserSubmitAction } from "./actions";
import { buildArgv } from "./actions";
import { AgentBrowserCli, type CliResult } from "./agent-browser";
import { lockPanelTarget, type OwnWindowSignatures } from "./target";
import type { PanelDescriptor } from "./target";
import type { BrowserAgentSettingsStore } from "./settings-store";

/**
 * 浏览器任务执行器（BROWSER-AGENT §6 runner.ts）：模型在工具循环里逐个发受控
 * 动作，这里负责任务包络与审计——
 *
 * - tab 锁定：任务开始先解析并锁定面板 target（target.ts），之后所有命令都跑在
 *   这个 tab 上（--pin-tab 兜底），UI 窗口 target 永不进入命令范围；
 * - 审计：每步的命令 argv + 结果摘要（不含页面正文）→ 右栏「工作日志」（agent:step
 *   事件 + 内存缓冲）+ `<workspace>/logs/agent.log`（JSONL，0700 目录内）；
 * - 中止：SIGTERM 必要时 SIGKILL 杀命令进程 + 收 daemon（M5）；before-quit 走
 *   killAll 兜底（M6）；
 * - 一次只放一个任务：浏览器面板与 tab 锁都是全局唯一的，第二个会话要等或中止。
 */

/** 喂给模型的 snapshot 上限：字符数（审计只记摘要，这里限的是模型上下文）。 */
const SNAPSHOT_MODEL_LIMIT = 24_000;
/** 工作日志内存缓冲上限（旧的丢弃，磁盘上 agent.log 保留全量）。 */
const STEP_BUFFER_LIMIT = 400;
/** 供审计摘要使用的单值上限。 */
const SUMMARY_LIMIT = 200;

export interface BrowserAgentDeps {
  cli: AgentBrowserCli;
  /** 面板 webContents 的懒访问（窗口未建 / 已销毁时 null）。 */
  panel: () => PanelDescriptor;
  /** 应用自身窗口的 URL / title 排除集（index.ts 用 BrowserWindow.getAllWindows()
   * 算；面板是 WebContentsView 不在其中）。tab 锁定匹配前先排除（M2）。 */
  ownWindows: () => OwnWindowSignatures;
  settings: BrowserAgentSettingsStore;
  /** 工作区相关路径的懒访问（切工作区即换）。 */
  logsDir: () => string;
  cacheDir: () => string;
  /** main → 渲染层的统一出口（index.ts 注入，窗口没了就是 no-op）。 */
  sendToUi: (channel: string, payload: unknown) => void;
}

export interface ExecuteInput {
  /** 工具名（审计动作名的前缀）。 */
  tool: "browser_read" | "browser_act" | "browser_submit";
  action: BrowserReadAction | BrowserActAction | BrowserSubmitAction;
  /** 发起会话（ConversationKey）。 */
  key: string;
  signal?: AbortSignal;
}

/** 一次任务 = 一个会话内的一段连续浏览器操作；全局同时只有一个。 */
interface CurrentTask {
  key: string;
  targetId: string;
}

export class BrowserAgentService {
  private readonly steps: AgentStep[] = [];
  /** stepId → 原始动作（单步重放用；提交类动作不可重放）。 */
  private readonly replayable = new Map<string, { tool: "browser_read" | "browser_act"; action: BrowserReadAction | BrowserActAction; key: string }>();
  private current: CurrentTask | null = null;
  private lastPanelUrl = "";

  constructor(private readonly deps: BrowserAgentDeps) {}

  // ———————————————————— 模型工具面 ————————————————————

  isEnabled(): boolean {
    return this.deps.settings.isEnabled();
  }

  /** 当前面板页面的 host（限速按站记账；模型伪造不了）。 */
  currentHost(): string {
    try {
      const contents = this.deps.panel().getContents();
      const url = contents !== null && !contents.isDestroyed() ? contents.getURL() : this.lastPanelUrl;
      return safeHost(url);
    } catch {
      return safeHost(this.lastPanelUrl);
    }
  }

  /**
   * 执行一个受控动作：确保任务已锁定面板 tab → 组装 argv → 跑 CLI → 审计。
   * 返回值直接进模型上下文（snapshot 截断到上限）；页面正文不进审计摘要。
   */
  async execute(input: ExecuteInput): Promise<Record<string, unknown>> {
    const argv = await this.prepare(input);
    const started = Date.now();
    const result = await this.deps.cli.run(argv, input.signal);
    const step = this.record({
      key: input.key,
      action: `${input.tool}.${input.action.kind}`,
      command: argv,
      ok: result.ok,
      summary: summarizeResult(input.action, result),
      error: result.error,
      durationMs: Date.now() - started,
    });
    if (input.tool !== "browser_submit" && step !== null) {
      this.replayable.set(step.id, { tool: input.tool, action: input.action as BrowserReadAction | BrowserActAction, key: input.key });
    }
    if (!result.ok) throw new Error(result.error ?? "浏览器命令执行失败。");
    return modelView(input.action.kind, result);
  }

  /**
   * 任务收尾：会话 run 结束（正常 / 出错）时由 AgentRuntime 调。tab 锁是
   * 会话级的——run 之间保留绑定没有意义，收掉等待下一个任务重新锁定。
   */
  endTask(key: string): void {
    if (this.current === null || this.current.key !== key) return;
    this.current = null;
    this.pushStatus();
  }

  // ———————————————————— 用户面（右栏 / 工具条） ————————————————————

  listSteps(): AgentStep[] {
    return [...this.steps];
  }

  status(): { running: boolean; key: string | null } {
    return { running: this.current !== null, key: this.current?.key ?? null };
  }

  /** 中止当前任务（M5）：杀命令进程 + 收 daemon + 审计。工具循环里在跑的
   * execute 会随命令进程被杀而失败返回，模型收到错误后收尾。 */
  abort(): void {
    if (this.current === null) return;
    const key = this.current.key;
    this.deps.cli.abortCurrent();
    this.deps.cli.close();
    this.record({
      key,
      action: "agent.abort",
      command: [],
      ok: true,
      summary: "用户中止了浏览器任务，已停止命令并清理 agent-browser 守护进程。",
      error: null,
      durationMs: 0,
    });
    this.current = null;
    this.pushStatus();
  }

  /** 单步重放：重放同一条受控动作（只读 / 已审批过的写动作）。提交类步骤
   * 不重放——必须重新走 browser_submit 的双重门。 */
  async replayStep(stepId: string): Promise<void> {
    const entry = this.replayable.get(stepId);
    if (entry === undefined) {
      const step = this.steps.find((item) => item.id === stepId);
      if (step !== undefined && step.action.startsWith("browser_submit")) {
        throw new Error("提交类步骤不能重放：请重新走 browser_submit（它会再次走确认门与限速）。");
      }
      throw new Error("找不到可重放的步骤（可能来自上一次启动，重放只在本次会话内可用）。");
    }
    await this.execute({ tool: entry.tool, action: entry.action, key: entry.key });
  }

  /** before-quit 兜底（M6）：close + 按 pid kill daemon。 */
  cleanup(): void {
    this.deps.cli.killAll();
  }

  /** 切工作区：当前任务按中止处理；日志与缓存路径经 deps 的懒访问自动跟上。 */
  onWorkspaceSwitch(): void {
    if (this.current !== null) this.abort();
    this.steps.length = 0;
    this.replayable.clear();
    this.pushStatus();
  }

  // ———————————————————— 内部 ————————————————————

  /** 任务包络：首步锁定面板 target（失败即整个任务拒绝），并打开工作日志标签。 */
  private async prepare(input: ExecuteInput): Promise<string[]> {
    if (!this.isEnabled()) {
      throw new Error("浏览器自动化已在设置里停用。请到设置 → 浏览器里开启后再试。");
    }
    if (this.current === null) {
      const lock = await lockPanelTarget((args) => this.deps.cli.run(args, input.signal), this.deps.panel(), this.deps.ownWindows());
      this.current = { key: input.key, targetId: lock.targetId };
      this.lastPanelUrl = lock.url;
      const contents = this.deps.panel().getContents();
      if (contents !== null && !contents.isDestroyed()) this.lastPanelUrl = contents.getURL() || lock.url;
      this.record({
        key: input.key,
        action: "agent.lock-target",
        command: ["tab", "list", "→", "tab", lock.targetId],
        ok: true,
        summary: `已锁定面板标签（target ${lock.targetId.slice(0, 8)}…）：${safeHost(lock.url) || "空白页"}`,
        error: null,
        durationMs: 0,
      });
      // 任务开场把右栏「工作日志」打开（P2 兑现的 agent:pane-open 链路）。
      this.deps.sendToUi(IPC.agentPaneOpen, { pane: "log" });
      this.pushStatus();
    } else if (this.current.key !== input.key) {
      throw new Error("另一个会话正在操作浏览器（一次只允许一个浏览器任务）。请等它完成或在右栏中止。");
    }
    return buildArgv(input.action, {
      screenshotPath: input.action.kind === "screenshot" ? this.nextScreenshotPath() : undefined,
    });
  }

  private nextScreenshotPath(): string {
    const dir = path.join(this.deps.cacheDir(), "agent-screenshots");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  }

  /** 记一步审计：内存缓冲（推给右栏）+ logs/agent.log 追加一行 JSONL。 */
  private record(input: Omit<AgentStep, "id" | "at">): AgentStep {
    const step: AgentStep = {
      ...input,
      id: `step_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      at: new Date().toISOString(),
    };
    this.steps.push(step);
    if (this.steps.length > STEP_BUFFER_LIMIT) {
      const dropped = this.steps.splice(0, this.steps.length - STEP_BUFFER_LIMIT);
      for (const item of dropped) this.replayable.delete(item.id);
    }
    this.deps.sendToUi(IPC.agentStepEvent, { type: "step", step });
    try {
      fs.mkdirSync(this.deps.logsDir(), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.deps.logsDir() + "/agent.log", `${JSON.stringify(step)}\n`, { mode: 0o600 });
    } catch {
      // 日志写不进去不影响任务（右栏缓冲还在），下不为例即可。
    }
    return step;
  }

  private pushStatus(): void {
    this.deps.sendToUi(IPC.agentStepEvent, { type: "status", ...this.status() });
  }
}

// ———————————————————— 结果整形 ————————————————————

/** 模型视图：把 CLI 的 data 收成小而完整的形状（正文类截断）。 */
function modelView(kind: string, result: CliResult): Record<string, unknown> {
  const data = result.data;
  if (kind === "snapshot") {
    const snapshot = typeof data.snapshot === "string" ? data.snapshot : "";
    const refs = typeof data.refs === "object" && data.refs !== null ? (data.refs as Record<string, unknown>) : {};
    const refCount = Object.keys(refs).length;
    return {
      refCount,
      snapshot:
        snapshot.length > SNAPSHOT_MODEL_LIMIT
          ? `${snapshot.slice(0, SNAPSHOT_MODEL_LIMIT)}\n…（快照过长已截断，可用 -s 选择器或 -d 深度缩小范围再 snapshot）`
          : snapshot,
    };
  }
  if (kind === "screenshot") {
    return { savedTo: typeof data.path === "string" ? data.path : "已保存（见返回的命令输出）" };
  }
  // 其余命令的 data 都是小标量（url / title / text / box…），剥掉 lifecycle 噪音原样给。
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "lifecycle") continue;
    rest[key] = typeof value === "string" && value.length > SNAPSHOT_MODEL_LIMIT
      ? `${value.slice(0, SNAPSHOT_MODEL_LIMIT)}…（过长已截断）`
      : value;
  }
  return rest;
}

/**
 * 审计摘要：只有统计与标量，绝不含页面正文（BROWSER-AGENT §3 M4）。
 * get text / get value 的值可能是元素文本、Agent 刚填进表单的个人信息，
 * 按严格口径只记字符数——值本体只回模型（modelView），不进审计。
 */
function summarizeResult(action: BrowserReadAction | BrowserActAction | BrowserSubmitAction, result: CliResult): string {
  if (result.ok) {
    const data = result.data;
    switch (action.kind) {
      case "snapshot": {
        const snapshot = typeof data.snapshot === "string" ? data.snapshot : "";
        const refs = typeof data.refs === "object" && data.refs !== null ? Object.keys(data.refs as object).length : 0;
        return `快照 ${refs} 个可交互元素，${snapshot.length} 字符（正文不入日志）`;
      }
      case "screenshot":
        return typeof data.path === "string" ? `已保存截图 ${data.path}` : "已保存截图";
      case "get":
        if (action.what === "text" || action.what === "value") return summarizeContent(data);
        return summarizeScalars(data);
      default:
        return summarizeScalars(data);
    }
  }
  return truncateSummary(result.error ?? "执行失败");
}

/** 标量键值对摘要（url / title / count / box…）：剥掉 lifecycle 噪音后原样记。 */
function summarizeScalars(data: Record<string, unknown>): string {
  const bits = Object.entries(data)
    .filter(([key]) => key !== "lifecycle")
    .map(([key, value]) => `${key}=${singleLine(String(value))}`);
  return bits.length > 0 ? truncateSummary(bits.join(", ")) : "ok";
}

/** 内容类结果（get text / get value）：字符串只记长度，值本体不进日志。 */
function summarizeContent(data: Record<string, unknown>): string {
  const bits = Object.entries(data)
    .filter(([key]) => key !== "lifecycle")
    .map(([key, value]) =>
      typeof value === "string" ? `${key}=${value.length} 字符（值不入日志）` : `${key}=${singleLine(String(value))}`,
    );
  return bits.length > 0 ? truncateSummary(bits.join(", ")) : "ok";
}

function singleLine(text: string): string {
  return truncateSummary(text.replace(/\s+/g, " ").trim());
}

function truncateSummary(text: string): string {
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text;
}

/** 从页面 URL 里取 host（限速记账的「站」）；解析不出就整段 URL 兜底。 */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
