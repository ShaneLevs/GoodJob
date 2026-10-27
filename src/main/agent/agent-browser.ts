import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { app } from "electron";

/**
 * agent-browser CLI 的宿主层（BROWSER-AGENT §2 / §4）：定位原生二进制、探测版本、
 * spawn 单条命令并解析 JSON 输出。进程模型：agent-browser 每条命令起一个短命进程，
 * 真正的浏览器连接由它自己的 daemon（--session goodjob）持有，CDP 附着到内嵌面板。
 *
 * 全局旗标固定只有三个：--session goodjob / --cdp <port> / --pin-tab。
 * --pin-tab 是粘性会话旗标：绑定的 tab 被关掉后命令直接报 tab_gone，
 * 绝不回退到别的 tab——UI 窗口 target 因此永远摸不到（M2 的第二道保险）。
 */

/** 会话名固定：常驻清单里的一项，避免多实例互相抢 tab。 */
export const AGENT_SESSION = "goodjob";

/** 单条命令的最长执行时间；导航 / 大页面 snapshot 可能慢，放宽到 90s。 */
const COMMAND_TIMEOUT_MS = 90_000;
/** 中止时 SIGTERM 后等待进程退出的时间，超时 SIGKILL。 */
const KILL_GRACE_MS = 3_000;

/** 与 npm 包 postinstall 的 platformKey 规则一致（含 musl / win32-arm64 回退）。 */
export function agentBrowserBinaryName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const ext = platform === "win32" ? ".exe" : "";
  const isMusl =
    platform === "linux" &&
    (() => {
      try {
        return fs.readFileSync("/proc/self/maps", "utf8").includes("/ld-musl-");
      } catch {
        return fs.existsSync("/lib/ld-musl-x86_64.so.1") || fs.existsSync("/lib/ld-musl-aarch64.so.1");
      }
    })();
  const osKey = isMusl ? "linux-musl" : platform;
  // Windows 没有 arm64 原生构建，官方回退到 x64（系统自带模拟）。
  const effectiveArch = platform === "win32" && arch === "arm64" ? "x64" : arch;
  return `agent-browser-${osKey}-${effectiveArch}${ext}`;
}

/** 开发 = 仓库 node_modules；打包 = extraResources 拷进去的单平台二进制。 */
export function resolveAgentBrowserBinary(): string {
  const name = agentBrowserBinaryName();
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "agent-browser", name);
  }
  return path.join(app.getAppPath(), "node_modules", "agent-browser", "bin", name);
}

/**
 * CDP 端口（BROWSER-AGENT §2）：必须在 app.ready 之前写进 remote-debugging-port。
 * 命令行已带 --remote-debugging-port（如测试脚本传入）时直接沿用，不 append 第二个；
 * 否则先 net.createServer().listen(0) 探一个空闲端口再关闭，然后 appendSwitch。
 * Chromium 默认只绑定回环地址，不加 --remote-debugging-address（M1）。
 *
 * Electron 的 ESM 主进程入口支持 top-level await，且会等它 settle 才触发 ready，
 * 所以 index.ts 在模块顶层 await 本函数即可保证 appendSwitch 先于 ready。
 */
export async function resolveCdpPort(): Promise<number> {
  const existing = app.commandLine.getSwitchValue("remote-debugging-port");
  if (/^\d+$/.test(existing) && Number(existing) > 0) {
    return Number(existing);
  }
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const picked = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (picked > 0) resolve(picked);
        else reject(new Error("没有取到空闲端口"));
      });
    });
  });
  app.commandLine.appendSwitch("remote-debugging-port", String(port));
  return port;
}

/** 单条命令的解析结果：data 是 CLI 的 data 字段（不含 lifecycle 噪音时另行摘要）。 */
export interface CliResult {
  ok: boolean;
  data: Record<string, unknown>;
  error: string | null;
}

/**
 * 一个 session 一条短命进程跑一条命令。abort 走 SIGTERM → 宽限后 SIGKILL；
 * 守护进程的清理不在这里（close / killAll 由 runner 在任务结束与退出钩子调用）。
 */
export class AgentBrowserCli {
  private child: ChildProcess | null = null;

  constructor(
    private readonly binary: string,
    private readonly cdpPort: number,
  ) {}

  /** 启动时跑一次 --version 记日志（BROWSER-AGENT §4：避免"用了新命令但二进制没升级"）。 */
  probeVersion(): Promise<string> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (version: string): void => {
        if (!settled) {
          settled = true;
          resolve(version);
        }
      };
      try {
        const child = spawn(this.binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          out += chunk.toString();
        });
        child.on("error", () => done("（无法执行）"));
        child.on("close", (code) =>
          done(code === 0 ? out.trim().replace(/^agent-browser\s+/i, "") : `（退出码 ${code}）`),
        );
      } catch {
        done("（spawn 失败）");
      }
    });
  }

  /**
   * 跑一条受控命令：argv 由 actions.buildArgv 产出，这里只补全局旗标。
   * 返回解析后的 { success, data, error }；输出不是 JSON（崩溃 / 超时被杀）按失败处理。
   *
   * `pin: false` 用于**会话还没绑定标签时的第一条命令**：`--pin-tab` 在未绑定时
   * 会尝试 `Target.createTarget` 开一个新标签，而 Electron 不支持这个 CDP 命令，
   * 会直接报 “CDP error (Target.createTarget): Not supported”。所以先不带 pin
   * 跑一次 tab list，再显式 `tab <targetId>` 绑定，之后就都是 pin 的严格语义。
   */
  run(args: string[], signal?: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS, options: { pin?: boolean } = {}): Promise<CliResult> {
    const argv = [
      "--session",
      AGENT_SESSION,
      "--cdp",
      String(this.cdpPort),
      ...(options.pin === false ? [] : ["--pin-tab"]),
      ...args,
      "--json",
    ];
    return new Promise<CliResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let child: ChildProcess;
      const finish = (result: CliResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (this.child === child) this.child = null;
        resolve(result);
      };
      const killChild = (): void => {
        if (child.pid === undefined || child.exitCode !== null) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, KILL_GRACE_MS).unref();
      };
      const timer = setTimeout(() => {
        killChild();
        finish({ ok: false, data: {}, error: `命令超时（${Math.round(timeoutMs / 1000)}s）：${args.join(" ")}` });
      }, timeoutMs);
      const onAbort = (): void => {
        killChild();
        finish({ ok: false, data: {}, error: "已取消（用户中止了浏览器任务）。" });
      };

      try {
        child = spawn(this.binary, argv, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (cause) {
        finish({ ok: false, data: {}, error: describe(cause) });
        return;
      }
      this.child = child;
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (cause) => {
        finish({ ok: false, data: {}, error: `无法启动 agent-browser：${describe(cause)}` });
      });
      child.on("close", (code) => {
        const trimmed = stdout.trim();
        if (code === 0 && trimmed !== "") {
          try {
            const parsed = JSON.parse(trimmed) as { success?: boolean; data?: Record<string, unknown>; error?: string | null };
            finish({
              ok: parsed.success === true,
              data: parsed.data ?? {},
              error: parsed.error ?? null,
            });
            return;
          } catch {
            finish({ ok: false, data: {}, error: `输出不是 JSON：${truncate(stderr || trimmed, 300)}` });
            return;
          }
        }
        finish({
          ok: false,
          data: {},
          error: `agent-browser 退出（code ${code}）：${truncate(stderr || trimmed || "（无输出）", 300)}`,
        });
      });

      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /** 是否有正在执行的命令（中止按钮的依据之一）。 */
  get busy(): boolean {
    return this.child !== null;
  }

  /** 杀掉正在执行的命令进程（SIGTERM → 宽限后 SIGKILL）；run() 会以失败收场。 */
  abortCurrent(): void {
    const child = this.child;
    if (child === null || child.pid === undefined || child.exitCode !== null) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, KILL_GRACE_MS).unref();
  }

  /**
   * 优雅关闭本会话（关浏览器连接 + 收 daemon）：任务中止后和退出钩子都会调。
   * close 自身也要限时，退出时不被它拖住。
   */
  close(): void {
    try {
      spawnSync(this.binary, ["--session", AGENT_SESSION, "close"], { timeout: 5_000 });
    } catch {
      // 关不掉就走 killAll 的按 pid 兜底。
    }
  }

  /**
   * 兜底清理（before-quit）：close 之后若 daemon 还活着（~/.agent-browser/<session>.pid），
   * 按 pid SIGTERM → SIGKILL（BROWSER-AGENT §5.4）。
   */
  killAll(): void {
    this.close();
    const pidFile = path.join(os.homedir(), ".agent-browser", `${AGENT_SESSION}.pid`);
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0) return;
      process.kill(pid, 0); // 还活着才会往下走
      process.kill(pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(pid, 0);
          process.kill(pid, "SIGKILL");
        } catch {
          // 已经退了。
        }
      }, KILL_GRACE_MS).unref();
    } catch {
      // pid 文件不存在 / 进程已死：正常。
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
