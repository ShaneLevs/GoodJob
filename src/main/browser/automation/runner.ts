import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { IPC, type AgentStep } from "@shared/types";

import type { BrowserReadAction, BrowserActAction, BrowserSubmitAction, TabAction } from "./actions";
import { buildArgv } from "./actions";
import { AgentBrowserCli, type CliResult } from "./cli";
import {
  closeLockedTab,
  createLockedTab,
  lockPanelTarget,
  switchLockedTarget,
  type OwnWindowSignatures,
  type PanelDescriptor,
  type CliRun,
  type TargetLock,
} from "./target";
import type { BrowserAgentSettingsStore } from "./settings-store";

/**
 * 浏览器任务执行器（BROWSER-AGENT §6 runner.ts）：模型在工具循环里逐个发受控
 * 动作，这里负责任务包络与审计——
 *
 * - tab 锁定：任务开始先解析并锁定面板 target（target.ts），之后所有命令都跑在
 *   这个 tab 上（--pin-tab 兜底），UI 窗口 target 永不进入命令范围；
 * - 审计：每步的命令 argv + 结果摘要（不含页面正文）→ `<workspace>/logs/agent.log`
 *   （JSONL，0700 目录内）+ agent:step 事件（浏览器工具条据此切换运行态）；
 * - 中止：SIGTERM 必要时 SIGKILL 杀命令进程 + 收 daemon（M5）；before-quit 走
 *   killAll 兜底（M6）；
 * - 一次只放一个任务：浏览器面板与 tab 锁都是全局唯一的，第二个会话要等或中止。
 */

/** 喂给模型的 snapshot 上限：字符数（审计只记摘要，这里限的是模型上下文）。 */
const SNAPSHOT_MODEL_LIMIT = 24_000;
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
  tool: "browser_read" | "browser_act" | "browser_submit" | "browser_tab";
  action: BrowserReadAction | BrowserActAction | BrowserSubmitAction | TabAction;
  /** 发起会话（ConversationKey）。 */
  key: string;
  signal?: AbortSignal;
}

/** 一次任务 = 一个会话内的一段连续浏览器操作；全局同时只有一个。 */
interface CurrentTask {
  key: string;
  /** 标签锁：当前落点 + 允许触碰的 target 集合（见 target.ts）。 */
  lock: TargetLock;
}

export class BrowserAgentService {
  private current: CurrentTask | null = null;
  private lastPanelUrl = "";

  constructor(private readonly deps: BrowserAgentDeps) {}

  // ———————————————————— 模型工具面 ————————————————————

  isEnabled(): boolean {
    return this.deps.settings.isEnabled();
  }

  /** 当前面板页面的 host（限速按站记账；模型伪造不了）。多标签下按**当前锁定
   *  的标签**算，不是「活动标签」——否则 Agent 切了标签用户又切回去，限速就记错站。 */
  currentHost(): string {
    const tabId = this.current?.lock.tabId;
    const locked = tabId === undefined ? undefined : this.deps.panel().tabs().find((tab) => tab.id === tabId);
    const url = locked !== undefined && !locked.contents.isDestroyed() ? locked.contents.getURL() : "";
    return safeHost(url === "" ? this.lastPanelUrl : url);
  }

  /**
   * 执行一个受控动作：确保任务已锁定面板 tab → 组装 argv → 跑 CLI → 审计。
   * 返回值直接进模型上下文（snapshot 截断到上限）；页面正文不进审计摘要。
   *
   * 两类动作不走「直接跑 argv」：
   * - `tab` 动作（list / new / switch / close）：标签的新建与关闭必须经 panel，
   *   否则会造出用户看不见的页面（见 target.ts 头部注释）；
   * - `click newTab`：同理，先读 href 再在我们的面板里新建标签。
   */
  async execute(input: ExecuteInput): Promise<Record<string, unknown>> {
    await this.prepare(input);
    const task = this.current!;

    if (input.action.kind === "tab") return this.executeTab(input, input.action);
    if (input.action.kind === "click" && "newTab" in input.action && input.action.newTab === true) {
      return this.executeClickNewTab(input, input.action.ref);
    }

    const argv = buildArgv(input.action, {
      screenshotPath: input.action.kind === "screenshot" ? this.nextScreenshotPath() : undefined,
    });
    const started = Date.now();
    const result = await this.deps.cli.run(argv, input.signal);
    this.record({
      key: input.key,
      action: `${input.tool}.${input.action.kind}`,
      command: argv,
      ok: result.ok,
      summary: summarizeResult(input.action, result),
      error: result.error,
      durationMs: Date.now() - started,
    });
    if (!result.ok) {
      // 标签被用户关掉（tab_gone）：锁已经失效，清掉任务逼下一次动作重新锁定，
      // 否则后续每一步都会撞同一个 tab_gone。
      if (result.error !== null && /tab_gone/.test(result.error)) this.dropLock();
      throw new Error(explainCliError(result.error));
    }
    if (input.action.kind === "open") this.noteLockedUrl(task);
    return modelView(input.action.kind, result);
  }

  /**
   * 任务收尾：会话 run 结束（正常 / 出错）时由 AgentRuntime 调。tab 锁是
   * 会话级的——run 之间保留绑定没有意义，收掉等待下一个任务重新锁定。
   *
   * 这里还要做两件「善后」，都是为了不让 Agent 走了之后浏览器还在自己动：
   * 1. **断掉 CDP 会话**（`cli.closeAsync`）。实测（2026-10-28）：BOSS直聘这类站点
   *    一检测到 CDP 就在页面里折腾——先是 `window.close()` 杀自己的标签，被守卫
   *    拦住后改成每 1–8 秒 `location.reload()` 一次；**断开 daemon 后重载循环立刻停**。
   *    不主动断的话，会话会一直活着直到下一次 abort / 退出。
   * 2. **停下锁定标签上正在跑的加载**，别让一个还在翻页的请求接着拖下去。
   */
  endTask(key: string): void {
    if (this.current === null || this.current.key !== key) return;
    const tabId = this.current.lock.tabId;
    this.current = null;
    this.settleTab(tabId);
    try {
      this.deps.cli.closeAsync();
    } catch {
      // 关不掉不影响什么。
    }
    this.pushStatus();
  }

  /** 任务收尾时把锁定标签的加载掐掉（页面自己 reload 的定时器掐不掉，那是站点的事）。 */
  private settleTab(tabId: string): void {
    try {
      const tab = this.deps.panel().tabs().find((item) => item.id === tabId);
      if (tab === undefined || tab.contents.isDestroyed()) return;
      tab.contents.stop();
    } catch {
      // 面板已销毁 / 标签刚消失：不用处理。
    }
  }

  // ———————————————————— 用户面（顶栏开关 / 浏览器工具条） ————————————————————

  status(): { running: boolean; key: string | null } {
    return { running: this.current !== null, key: this.current?.key ?? null };
  }

  /** 中止当前任务（M5）：杀命令进程 + 收 daemon + 审计。工具循环里在跑的
   * execute 会随命令进程被杀而失败返回，模型收到错误后收尾。 */
  abort(): void {
    if (this.current === null) return;
    const key = this.current.key;
    const tabId = this.current.lock.tabId;
    this.deps.cli.abortCurrent();
    this.deps.cli.closeAsync();
    this.settleTab(tabId);
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
    this.deps.panel().markAgentTab(null);
    this.pushStatus();
  }

  /** before-quit 兜底（M6）：close + 按 pid kill daemon。 */
  cleanup(): void {
    this.deps.cli.killAll();
  }

  /** 切工作区：当前任务按中止处理；日志与缓存路径经 deps 的懒访问自动跟上。 */
  onWorkspaceSwitch(): void {
    if (this.current !== null) this.abort();
    this.pushStatus();
  }

  // ———————————————————— 内部 ————————————————————

  /** 任务包络：首步锁定面板的一个标签（失败即整个任务拒绝），并让浏览器现身。 */
  private async prepare(input: ExecuteInput): Promise<void> {
    if (!this.isEnabled()) {
      throw new Error("浏览器自动化已在设置里停用。请到设置 → 浏览器里开启后再试。");
    }
    if (this.current === null) {
      const run: CliRun = (args, options) => this.deps.cli.run(args, input.signal, undefined, options);
      const lock = await lockPanelTarget(run, this.deps.panel(), this.deps.ownWindows());
      this.current = { key: input.key, lock };
      this.deps.panel().markAgentTab(lock.tabId);
      this.noteLockedUrl(this.current);
      this.record({
        key: input.key,
        action: "agent.lock-target",
        command: ["tab", "list", "→", "tab", lock.targetId],
        ok: true,
        summary: `已锁定面板标签 ${lock.tabId}（target ${lock.targetId.slice(0, 8)}…）：${safeHost(this.lastPanelUrl) || "空白页"}`,
        error: null,
        durationMs: 0,
      });
      // 任务开场**不**把浏览器摊到前台：读页面 / snapshot 全程在后台跑，顶栏地球
      // 图标会亮成「agent 控制中」。只有用户批准了写动作（点击 / 填写 / 提交）才由
      // 渲染层打开面板——那时候他需要看见 Agent 到底点了哪。
      this.pushStatus();
    } else if (this.current.key !== input.key) {
      throw new Error("另一个会话正在操作浏览器（一次只允许一个浏览器任务）。请等它完成或在浏览器工具条中止。");
    }
  }

  /**
   * 丢弃当前标签锁（标签被关掉时用）：下一次动作会重新 lockPanelTarget。
   * 不动已打开的 run——模型看到 tab_gone 的提示后会自己 list / switch / new。
   */
  private dropLock(): void {
    if (this.current === null) return;
    this.current = null;
    try {
      this.deps.panel().markAgentTab(null);
    } catch {
      // 面板销毁了：无所谓。
    }
  }

  /** 把当前锁定标签的 URL 记下来（限速兜底 / tab list 摘要用）。 */
  private noteLockedUrl(task: CurrentTask): void {
    const locked = this.deps.panel().tabs().find((tab) => tab.id === task.lock.tabId);
    if (locked === undefined || locked.contents.isDestroyed()) return;
    const url = locked.contents.getURL();
    if (url !== "") this.lastPanelUrl = url;
  }

  /**
   * tab 工具面：真正的标签动作都过 panel（用户看得见），CLI 只负责把会话绑定
   * 切过去（`tab <targetId>`）；list 直接把我们的标签表给模型。
   */
  private async executeTab(input: ExecuteInput, action: TabAction): Promise<Record<string, unknown>> {
    const task = this.current!;
    const panel = this.deps.panel();
    const run: CliRun = (args, options) => this.deps.cli.run(args, input.signal, undefined, options);
    const started = Date.now();

    if (action.op === "list") {
      const tabs = panel.tabs().map((tab) => ({
        id: tab.id,
        url: tab.contents.isDestroyed() ? "" : tab.contents.getURL(),
        title: tab.contents.isDestroyed() ? "" : tab.contents.getTitle(),
        active: tab.active,
        current: tab.id === task.lock.tabId,
      }));
      this.record({
        key: input.key,
        action: "browser_tab.list",
        command: ["tab", "list"],
        ok: true,
        summary: `${tabs.length} 个标签（当前：${task.lock.tabId}）`,
        error: null,
        durationMs: Date.now() - started,
      });
      return { tabs };
    }

    if (action.op === "switch") {
      const next = await switchLockedTarget(run, panel, task.lock, action.target);
      task.lock = next;
      panel.markAgentTab(next.tabId);
      this.noteLockedUrl(task);
      this.record({
        key: input.key,
        action: "browser_tab.switch",
        command: ["tab", next.targetId],
        ok: true,
        summary: `已切到标签 ${next.tabId}：${safeHost(this.lastPanelUrl) || "空白页"}`,
        error: null,
        durationMs: Date.now() - started,
      });
      // 切标签之后旧 ref 全部失效（是不同的文档），必须提醒模型重新 snapshot。
      return { switchedTo: next.tabId, url: this.lastPanelUrl, hint: "切换标签后旧的 @ref 全部失效，重新 snapshot 再操作。" };
    }

    if (action.op === "new") {
      const created = await createLockedTab(run, panel, task.lock, action.url);
      task.lock = created.lock;
      panel.markAgentTab(created.tabId);
      this.noteLockedUrl(task);
      this.record({
        key: input.key,
        action: "browser_tab.new",
        command: ["tab", created.targetId],
        ok: true,
        summary: `新建标签 ${created.tabId}：${safeHost(this.lastPanelUrl) || "空白页"}`,
        error: null,
        durationMs: Date.now() - started,
      });
      return { newTabId: created.tabId, url: this.lastPanelUrl, hint: "新标签已就绪，先 snapshot 再操作。" };
    }

    closeLockedTab(panel, task.lock, action.target);
    this.record({
      key: input.key,
      action: "browser_tab.close",
      command: ["tab", "close", action.target],
      ok: true,
      summary: `已关闭标签 ${action.target}`,
      error: null,
      durationMs: Date.now() - started,
    });
    return { closed: action.target };
  }

  /**
   * click newTab：不在当前标签里点击，而是读链接 href → 在我们的面板新建标签打开。
   * 这样用户看得见，也不会把当前上下文顶掉。
   */
  private async executeClickNewTab(input: ExecuteInput, ref: string): Promise<Record<string, unknown>> {
    const task = this.current!;
    const panel = this.deps.panel();
    const run: CliRun = (args, options) => this.deps.cli.run(args, input.signal, undefined, options);
    const started = Date.now();

    const href = await this.deps.cli.run(["get", "attr", ref, "href"], input.signal);
    const url = typeof href.data.value === "string" ? href.data.value.trim() : "";
    if (!href.ok || !/^https?:\/\//i.test(url)) {
      throw new Error("这个元素没有可用的 http(s) 链接（newTab 只能用于 <a href>）；请改用普通 click 或 tab new。");
    }

    const created = await createLockedTab(run, panel, task.lock, url);
    task.lock = created.lock;
    panel.markAgentTab(created.tabId);
    this.noteLockedUrl(task);
    this.record({
      key: input.key,
      action: "browser_act.click",
      command: ["get", "attr", ref, "href", "→", "tab", created.targetId],
      ok: true,
      summary: `链接在新标签打开：${created.tabId}（${safeHost(this.lastPanelUrl)}）`,
      error: null,
      durationMs: Date.now() - started,
    });
    return { newTabId: created.tabId, url: this.lastPanelUrl, hint: "已在新标签打开，先 snapshot 再操作。" };
  }

  private nextScreenshotPath(): string {
    const dir = path.join(this.deps.cacheDir(), "agent-screenshots");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  }

  /** 记一步审计：推给工具条（停止按钮凭 status 事件）+ logs/agent.log 追加一行 JSONL。 */
  private record(input: Omit<AgentStep, "id" | "at">): AgentStep {
    const step: AgentStep = {
      ...input,
      id: `step_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      at: new Date().toISOString(),
    };
    this.deps.sendToUi(IPC.agentStepEvent, { type: "step", step });
    try {
      fs.mkdirSync(this.deps.logsDir(), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.deps.logsDir() + "/agent.log", `${JSON.stringify(step)}\n`, { mode: 0o600 });
    } catch {
      // 日志写不进去不影响任务（审计流已推给 UI），下不为例即可。
    }
    return step;
  }

  private pushStatus(): void {
    this.deps.sendToUi(IPC.agentStepEvent, { type: "status", ...this.status() });
  }
}

/**
 * CLI 错误 → 模型能直接消化的提示。
 *
 * 主要处理 `tab_gone`：锁定标签没了（用户手动关的、网页自己 window.close()、
 * 渲染进程挂掉）。CLI 的原文会让模型去执行 `agent-browser tab new <url>`，但模型
 * 根本拼不了 CLI（命令白名单在类型层）——所以这里改写成「用 browser_tab 新建或
 * 切到别的标签」，并且把锁重新落到一个还活着的标签上，任务可以继续。
 */
function explainCliError(error: string | null): string {
  const message = error ?? "浏览器命令执行失败。";
  if (!/tab_gone/.test(message)) return message;
  return [
    "你正在操作的标签没了（用户手动关掉，或者这个网站自己把页面关掉了）。",
    "用 browser_tab 的 list 看现在还有哪些标签，再 switch 过去；没有可用的就 new 一个，",
    "然后重新 snapshot 再继续。不要重试同一个动作。",
    `（底层错误：${message.slice(0, 200)}）`,
  ].join(" ");
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
