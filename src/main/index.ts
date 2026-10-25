import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { app, BrowserWindow, nativeImage } from "electron";

import { IPC } from "@shared/types";

import { AgentBrowserCli, resolveAgentBrowserBinary, resolveCdpPort } from "./agent/agent-browser";
import { BrowserAgentService } from "./agent/runner";
import { BrowserAgentSettingsStore } from "./agent/settings-store";
import { AgentRuntime } from "./agent-runtime";
import { BrowserPanel } from "./browser";
import { ConversationsStore } from "./conversations-store";
import { ApplicationsStore, CompaniesStore, JobsStore, PipelineStore } from "./domain-store";
import { InterviewsStore } from "./interviews-store";
import { MemoryStore } from "./memory";
import { ModelsStore } from "./models-store";
import { NotifyStore } from "./notify-store";
import { NotifyService } from "./notify-service";
import { PreferencesStore } from "./preferences-store";
import { ResumeStore } from "./resume-store";
import { TaskManager } from "./tasks";
import { WorkspacesStore } from "./workspaces-store";
import { registerIpc } from "./ipc";
import { hardenRendererSession, hardenRendererWindow } from "./security";

const here = path.dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL;
const isMac = process.platform === "darwin";

// Test/dev isolation. Relocating userData gives the instance its own single-instance
// lock and Chromium profile, so a test run never fights with the real app.
const instanceHome = process.env.GOODJOB_HOME;
if (instanceHome !== undefined && instanceHome.trim() !== "") {
  app.setPath("userData", path.join(instanceHome, "electron-profile"));
}

// Data files are only ever readable by the current user.
process.umask(0o077);

let mainWindow: BrowserWindow | null = null;
let browserPanel: BrowserPanel | null = null;
let agentRuntime: AgentRuntime | null = null;
let browserAgent: BrowserAgentService | null = null;
let taskManager: TaskManager | null = null;
let modelsStore: ModelsStore | null = null;
let notifyService: NotifyService | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: "#ffffff",
    title: "GoodJob",
    // The sidebar owns the traffic lights, WorkBuddy-style.
    ...(isMac
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } }
      : {}),
    webPreferences: {
      preload: path.join(here, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow = win;

  const panel = new BrowserPanel(win, (state) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.browserState, state);
  });
  browserPanel = panel;

  hardenRendererWindow(win);

  win.once("ready-to-show", () => win.show());

  win.on("closed", () => {
    panel.dispose();
    browserPanel = null;
    mainWindow = null;
  });

  if (rendererDevUrl !== undefined) {
    void win.loadURL(rendererDevUrl);
  } else {
    void win.loadFile(path.join(here, "../renderer/index.html"));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  /*
   * CDP 端口（BROWSER-AGENT §2）必须在 ready 之前写进 remote-debugging-port。
   * Electron 的 ESM 主进程入口会等这里的 top-level await settle 才触发 ready
   * （实测 appendSwitch 生效），所以模块顶层 await 一次即可；命令行已带
   * --remote-debugging-port（测试脚本 / 手动调试）时直接沿用。
   */
  const cdpPort = await resolveCdpPort();

  app.whenReady().then(() => {
    hardenRendererSession(isDev);

    // 打包后的图标来自 bundle 里的 icns；dev 下 Dock 还是 Electron 默认图标，手动换上。
    if (isMac && isDev) {
      const iconPath = path.join(here, "../../build/icon.png");
      if (existsSync(iconPath)) app.dock?.setIcon(nativeImage.createFromPath(iconPath));
    }

    // 工作区必须先建：一个工作区就是一个文件夹，其余 store 的数据都挂在它下面。
    const workspaces = new WorkspacesStore();
    const preferences = new PreferencesStore();
    modelsStore = new ModelsStore(workspaces.currentPaths);
    const models = modelsStore;
    const conversations = new ConversationsStore(workspaces.currentPaths);
    const memory = new MemoryStore(workspaces.currentPaths);
    // 领域实体（P2）：pipeline 先建（投递的时间线校验要用），再 companies → jobs →
    // applications（引用校验的方向：投递引岗位、岗位引公司）。
    const pipeline = new PipelineStore(workspaces.currentPaths);
    const companies = new CompaniesStore(workspaces.currentPaths);
    const jobs = new JobsStore(workspaces.currentPaths, companies);
    const applications = new ApplicationsStore(workspaces.currentPaths, jobs, pipeline);
    // 简历文件变化直接推给渲染层编辑器（Agent 写入 / 用户保存都会触发）。
    const resumes = new ResumeStore(workspaces.currentPaths, (event) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.resumeFileChanged, event);
      }
    });
    // 模拟面试（P3）：依赖岗位（jobId 校验）与简历（定制稿存在性校验）。
    const interviews = new InterviewsStore(workspaces.currentPaths, jobs, resumes);
    // 通知（P3 M3）：配置跟着工作区走；调度到点经 AgentRuntime.runDigest 发日报 / 周报。
    const notifyStore = new NotifyStore(workspaces.currentPaths);
    const notify = new NotifyService({ store: notifyStore });
    // 浏览器自动化（P4）：agent-browser CLI 宿主 + 设置（开关 / 限速）+ 任务执行器。
    // CLI 只进 devDependencies，二进制在打包时由 extraResources 带进去。
    const agentCli = new AgentBrowserCli(resolveAgentBrowserBinary(), cdpPort);
    void agentCli.probeVersion().then((version) => {
      console.log(`[agent] agent-browser ${version}（cdp 127.0.0.1:${cdpPort}，session goodjob）`);
    });
    const agentSettings = new BrowserAgentSettingsStore(workspaces.currentPaths);
    browserAgent = new BrowserAgentService({
      cli: agentCli,
      // 面板懒访问：窗口没建 / 已销毁时 getContents 给 null，target.ts 会报「面板未就绪」。
      panel: () => ({ getContents: () => browserPanel?.agentContents ?? null }),
      // 应用自身窗口排除集（M2）：面板是 WebContentsView 不是 BrowserWindow，所以
      // 这里收集到的 URL / title 全是 UI 侧的（主窗 file://，dev 态 http://127.0.0.1:1420）。
      ownWindows: () => {
        const urls = new Set<string>();
        const titles = new Set<string>();
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue;
          const url = win.webContents.getURL();
          if (url !== "") urls.add(url);
          const title = win.webContents.getTitle();
          if (title !== "") titles.add(title);
        }
        return { urls, titles };
      },
      settings: agentSettings,
      logsDir: () => workspaces.currentPaths.logs,
      cacheDir: () => workspaces.currentPaths.cache,
      sendToUi: (channel, payload) => {
        if (mainWindow === null || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send(channel, payload);
      },
    });
    // 后台任务（简历评估 / 完整性评分）：状态事件推给渲染层的「任务」角标。
    // 评分类任务成功完成时再发 agent:pane-open（BROWSER-AGENT §6 预留的事件），
    // 让渲染层打开右栏评分卡——这就是 P2 兑现的第一条链路，后续浏览器 / 日志同法。
    taskManager = new TaskManager({
      models,
      jobs,
      resumes,
      emit: (event) => {
        if (mainWindow === null || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send(IPC.taskEvent, event);
        if (event.type !== "finish" || event.task.status !== "done") return;
        if (event.task.type !== "job-match" && event.task.type !== "resume-integrity") return;
        mainWindow.webContents.send(IPC.agentPaneOpen, {
          pane: "scorecard",
          scorecard:
            event.task.type === "job-match"
              ? { kind: "job", jobId: event.task.target }
              : { kind: "integrity", resumeId: event.task.target },
        });
      },
    });
    agentRuntime = new AgentRuntime({
      models,
      conversations,
      resumes,
      memory,
      companies,
      jobs,
      applications,
      pipeline,
      interviews,
      tasks: taskManager,
      notify,
      browser: browserAgent,
      browserSettings: agentSettings,
    });
    const runtime = agentRuntime;
    // 循环依赖从这里剪断：NotifyService 只认「到点要跑一次汇总」，跑什么由 runtime 决定。
    notify.setDigestRunner((kind) => runtime.runDigest(kind).then(() => undefined));

    registerIpc({
      getWindow: () => mainWindow,
      getPanel: () => browserPanel,
      runtime,
      conversations,
      resumes,
      memory,
      models,
      preferences,
      workspaces,
      companies,
      jobs,
      applications,
      pipeline,
      interviews,
      tasks: taskManager,
      notify,
      notifyStore,
      browser: browserAgent,
      browserSettings: agentSettings,
      appInfo: () => ({
        platform: process.platform,
        version: app.getVersion(),
        dataDir: workspaces.root.root,
        workspaceDir: workspaces.currentPaths.dir,
      }),
    });

    // 分钟级调度（确认门窗口推进 + 日报 / 周报到点）：应用活着就跑。
    notify.start();
    notifyService = notify;

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });

  app.on("before-quit", () => {
    agentRuntime?.abortAll();
    // 浏览器任务：杀命令进程 + 收 agent-browser daemon（close 失败按 pid 兜底）。
    browserAgent?.cleanup();
    browserAgent = null;
    // 后台任务不做断点续跑：退出即停（结果都已落库，重启后可重跑）。
    taskManager?.stopAll();
    // 通知调度与 IMAP 长连接同样退出即停；等待中的确认门按取消处理。
    notifyService?.stopAll();
    browserPanel?.dispose();
  });
}
