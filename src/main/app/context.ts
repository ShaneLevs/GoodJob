import { BrowserWindow } from "electron";

import { IPC, type ConversationKey } from "@shared/types";

import type { AgentDeps } from "../agent/deps";
import { AgentRuntime } from "../agent/runtime";
import { WorkflowService } from "../agent/workflow";
import { AgentBrowserCli, resolveAgentBrowserBinary } from "../browser/automation/cli";
import { BrowserAgentService } from "../browser/automation/runner";
import { BrowserAgentSettingsStore } from "../browser/automation/settings-store";
import type { BrowserPanel } from "../browser/panel";
import { NotifyService } from "../services/notify";
import { TaskManager } from "../services/tasks";
import { ConversationsStore } from "../stores/conversations";
import { ApplicationsStore } from "../stores/domain/applications";
import { CompaniesStore } from "../stores/domain/companies";
import { InterviewsStore } from "../stores/domain/interviews";
import { JobsStore } from "../stores/domain/jobs";
import { PipelineStore } from "../stores/domain/pipeline";
import { onCollectionChanged } from "../stores/json-collection";
import { MemoryStore } from "../stores/memory";
import { ModelsStore } from "../stores/models";
import { NotifyStore } from "../stores/notify";
import { PreferencesStore } from "../stores/preferences";
import { ResumeStore } from "../stores/resumes";
import { WorkspacesStore } from "../stores/workspaces";
import { uploadDirFor } from "../workspace/uploads";

export interface AppContext {
  workspaces: WorkspacesStore;
  preferences: PreferencesStore;
  models: ModelsStore;
  conversations: ConversationsStore;
  resumes: ResumeStore;
  memory: MemoryStore;
  companies: CompaniesStore;
  jobs: JobsStore;
  applications: ApplicationsStore;
  pipeline: PipelineStore;
  interviews: InterviewsStore;
  tasks: TaskManager;
  notify: NotifyService;
  notifyStore: NotifyStore;
  browser: BrowserAgentService;
  browserSettings: BrowserAgentSettingsStore;
  runtime: AgentRuntime;
  workflow: WorkflowService;
}

export interface AppContextOptions {
  cdpPort: number;
  getWindow: () => BrowserWindow | null;
  getPanel: () => BrowserPanel | null;
}

/** 构造所有跟随工作区的 store 与后台服务；窗口本身由 app/window.ts 负责。 */
export function createAppContext({
  cdpPort,
  getWindow,
  getPanel,
}: AppContextOptions): AppContext {
  // 工作区必须先建：一个工作区就是一个文件夹，其余 store 的数据都挂在它下面。
  const workspaces = new WorkspacesStore();
  const preferences = new PreferencesStore();
  // 设置（基础设置 / Agent 设置）全在根目录，所有工作区共用一份，构造后不再换文件。
  const models = new ModelsStore(workspaces.root);
  const conversations = new ConversationsStore(workspaces.currentPaths);
  const memory = new MemoryStore(workspaces.currentPaths);

  // 领域实体（P2）：pipeline 先建（投递的时间线校验要用），再 companies → jobs →
  // applications（引用校验的方向：投递引岗位、岗位引公司）。
  const pipeline = new PipelineStore(workspaces.currentPaths);
  // 领域集合写入广播：Agent 工具与 IPC 走同一套 store，所以在这里注册一次就够——
  // 页面表格不必等切模块重挂载才看到 Agent 刚建的岗位 / 公司。
  onCollectionChanged((entity) => {
    const win = getWindow();
    if (win === null || win.isDestroyed()) return;
    win.webContents.send(IPC.domainChanged, { entity });
  });
  const companies = new CompaniesStore(workspaces.currentPaths);
  const jobs = new JobsStore(workspaces.currentPaths, companies);
  const applications = new ApplicationsStore(workspaces.currentPaths, jobs, pipeline);

  // 简历文件变化直接推给渲染层编辑器（Agent 写入 / 用户保存都会触发）。
  const resumes = new ResumeStore(workspaces.currentPaths, (event) => {
    const win = getWindow();
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send(IPC.resumeFileChanged, event);
    }
  });
  // 模拟面试（P3）：依赖岗位（jobId 校验）与简历（定制稿存在性校验）。
  const interviews = new InterviewsStore(workspaces.currentPaths, jobs, resumes);

  // 通知（P3 M3）：设置是全局的（不跟工作区走）；调度到点经 AgentRuntime.runDigest 发日报 / 周报。
  const notifyStore = new NotifyStore(workspaces.root);
  const notify = new NotifyService({ store: notifyStore });

  // 浏览器自动化（P4）：agent-browser CLI 宿主 + 设置（开关 / 限速）+ 任务执行器。
  // CLI 只进 devDependencies，二进制在打包时由 extraResources 带进去。
  const agentCli = new AgentBrowserCli(resolveAgentBrowserBinary(), cdpPort);
  void agentCli.probeVersion().then((version) => {
    console.log(`[agent] agent-browser ${version}（cdp 127.0.0.1:${cdpPort}，session goodjob）`);
  });
  const browserSettings = new BrowserAgentSettingsStore(workspaces.root);
  const browser = new BrowserAgentService({
    cli: agentCli,
    // 面板懒访问：窗口没建 / 已销毁时返回空列表。target.ts 用 agentTabs()
    // 把我们的标签翻译成 CDP targetId（每个 webContents 自己报 target id）。
    // Agent 与用户看到的是同一套标签，不存在隐形页面。
    panel: () => ({
      tabs: () => getPanel()?.agentTabs() ?? [],
      createTab: (url?: string) => getPanel()?.createAgentTab(url) ?? Promise.resolve(null),
      closeTab: (id: string) => getPanel()?.closeTab(id),
      activateTab: (id: string) => getPanel()?.activateTab(id),
      markAgentTab: (id: string | null) => getPanel()?.markAgentTab(id),
    }),
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
    settings: browserSettings,
    logsDir: () => workspaces.currentPaths.logs,
    cacheDir: () => workspaces.currentPaths.cache,
    sendToUi: (channel, payload) => {
      const win = getWindow();
      if (win === null || win.isDestroyed()) return;
      win.webContents.send(channel, payload);
    },
  });

  // 后台任务（简历评估 / 完整性评分）：状态事件推给渲染层的「任务」角标；
  // 报告本体由渲染层在任务完成后自己拉（岗位表 / 简历页的弹窗）。
  const tasks = new TaskManager({
    models,
    jobs,
    resumes,
    emit: (event) => {
      const win = getWindow();
      if (win === null || win.isDestroyed()) return;
      win.webContents.send(IPC.taskEvent, event);
    },
  });

  /*
   * GoodJob 工作流与 AgentRuntime 互相引用：workflow 需要 AgentDeps 调子 agent，
   * AgentDeps 又要把 workflow 交给 GoodJob 工具。用 getter 剪断构造顺序——
   * WorkflowService 构造期间不访问 deps.workflow，运行时它已经指向实例。
   */
  let workflow: WorkflowService;
  const agentDeps: AgentDeps = {
    models,
    conversations,
    resumes,
    memory,
    companies,
    jobs,
    applications,
    pipeline,
    interviews,
    tasks,
    notify,
    browser,
    browserSettings,
    logsDir: () => workspaces.currentPaths.logs,
    uploadDir: (key: ConversationKey) =>
      uploadDirFor(workspaces.currentPaths, key, resumes.currentUploadDir()),
    get workflow() {
      return workflow;
    },
  };
  workflow = new WorkflowService(agentDeps, workspaces.currentPaths, (state) => {
    const win = getWindow();
    if (win === null || win.isDestroyed()) return;
    win.webContents.send(IPC.workflowEvent, state);
  });
  const runtime = new AgentRuntime(agentDeps);

  // 循环依赖从这里剪断：NotifyService 只认「到点要跑一次汇总」，跑什么由 runtime 决定。
  notify.setDigestRunner((kind) => runtime.runDigest(kind).then(() => undefined));

  return {
    workspaces,
    preferences,
    models,
    conversations,
    resumes,
    memory,
    companies,
    jobs,
    applications,
    pipeline,
    interviews,
    tasks,
    notify,
    notifyStore,
    browser,
    browserSettings,
    runtime,
    workflow,
  };
}
