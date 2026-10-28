import { useEffect, useState } from "react";

import { Globe, PanelLeftClose, PanelLeftOpen } from "lucide-react";

import {
  DEFAULT_MARKDOWN_THEME_ID,
  type AppearanceSettings,
  type MarkdownSettings,
  type ModelSelection,
  type ModelsConfig,
  type TaskState,
  type WorkspacesState,
} from "@shared/types";

import { BrowserPanel } from "@/components/browser/BrowserPanel";
import { MarkdownThemeProvider } from "@/components/document/MarkdownTheme";
import { getDocumentTemplate } from "@/components/document/templates";
import { SettingsModal, type SettingsSection } from "@/components/settings/SettingsModal";
import { Sidebar } from "@/components/shell/Sidebar";
import { TasksBadge } from "@/components/shell/TasksBadge";
import { ThemeApplier } from "@/components/shell/ThemeApplier";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ApplicationsPage } from "@/components/modules/applications/ApplicationsPage";
import { CompaniesPage } from "@/components/modules/companies/CompaniesPage";
import { InterviewPage } from "@/components/modules/interview/InterviewPage";
import { JobWorkbenchPage } from "@/components/modules/jobs/JobWorkbenchPage";
import { JobsPage } from "@/components/modules/jobs/JobsPage";
import { ResumePage } from "@/components/modules/resume/ResumePage";
import type { ModuleKey } from "@/config/modules";
import { resolveDark } from "@/lib/theme";

export function App() {
  const [models, setModels] = useState<ModelsConfig | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspacesState | null>(null);
  const [appearance, setAppearance] = useState<AppearanceSettings>({
    themeMode: "system",
    fontSize: 13,
  });
  const [markdown, setMarkdown] = useState<MarkdownSettings>({
    themeId: DEFAULT_MARKDOWN_THEME_ID,
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 设置弹窗落点：侧边栏进来是外观，对话区的模型菜单进来直接看模型。 */
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeModule, setActiveModule] = useState<ModuleKey>("resume");
  /*
   * 模块页常驻（懒挂载一次，之后只切可见性）：会话状态住在页面里的 useChat 实例上，
   * 卸载一次就等于把这个会话的流打断、消息丢在内存里——切模块不该有这种副作用。
   * 所以只有第一次进入才挂载，之后一直留着，切模块只改 visible / invisible。
   */
  const [mountedModules, setMountedModules] = useState<ModuleKey[]>(() => ["resume"]);
  /*
   * 岗位二级工作台（定制简历）：有值时「岗位」模块渲染 JobWorkbenchPage。
   * autoPrompt 是进入时的一次性起草指令（生成简历 / 生成话术），发完即清。
   */
  const [jobWorkbench, setJobWorkbench] = useState<{ jobId: string; autoPrompt: string | null } | null>(null);
  /*
   * 模拟面试的一次性定位：从岗位页发起后跳到面试模块并选中这场面试，选中即清。
   */
  const [interviewFocus, setInterviewFocus] = useState<string | null>(null);
  /*
   * 内嵌浏览器铺满内容区（原生 WebContentsView）：默认关着。Agent 的浏览器任务
   * 在后台跑不弹面板；只有用户批准了写动作（点击 / 填写 / 提交）或顶栏按钮才打开。
   */
  const [browserOpen, setBrowserOpen] = useState(false);
  /** 是否有浏览器任务在跑（agent:step 的 status 事件）：顶栏图标据此显示「agent 控制中」。 */
  const [agentRunning, setAgentRunning] = useState(false);
  /** 后台任务注册表快照（顶栏「任务」角标汇总用）。 */
  const [tasks, setTasks] = useState<TaskState[]>([]);
  /** 对话区里的浮层（模型下拉）打开期间为 true，原生浏览器视图要让位。 */
  const [overlayOpen, setOverlayOpen] = useState(false);

  useEffect(() => {
    void window.goodjob.models.get().then(setModels);
    void window.goodjob.workspace.get().then(setWorkspaces);
    void window.goodjob.appearance.get().then(setAppearance);
    // 旧版 / 已下线主题的 id 在这里收敛成当前注册表里的 id，顺手写回偏好；
    // 否则设置页下拉的 value 与存储值不一致，重选同一个主题不会触发保存。
    void window.goodjob.markdown.get().then((settings) => {
      const themeId = getDocumentTemplate(settings.themeId).id;
      setMarkdown({ ...settings, themeId });
      if (themeId !== settings.themeId) {
        void window.goodjob.markdown.save({ themeId }).then(setMarkdown);
      }
    });
  }, []);

  // 后台任务：挂载取一次注册表，事件增量更新（任务只在内存，切工作区会清空重取）。
  useEffect(() => {
    void window.goodjob.tasks.list().then(setTasks);
    return window.goodjob.tasks.onEvent((event) => {
      setTasks((prev) => [event.task, ...prev.filter((task) => task.id !== event.task.id)]);
    });
  }, []);

  // "跟随系统"要能实时响应系统外观的变化。
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  // 工作区切换由 main 广播：重读模型配置与任务注册表；模块页通过 remount key 换整套数据。
  // 岗位工作台与面试定位指向的是旧工作区的数据，一并退出。
  useEffect(
    () =>
      window.goodjob.workspace.onChanged((state) => {
        setWorkspaces(state);
        setJobWorkbench(null);
        setInterviewFocus(null);
        void window.goodjob.models.get().then(setModels);
        void window.goodjob.tasks.list().then(setTasks);
      }),
    [],
  );

  const changeAppearance = (patch: Partial<AppearanceSettings>): void => {
    // 先本地生效（主题/字号要即时反馈），再落盘。
    setAppearance((prev) => ({ ...prev, ...patch }));
    void window.goodjob.appearance.save(patch).then(setAppearance);
  };

  const changeMarkdown = (patch: Partial<MarkdownSettings>): void => {
    // 主题切换同样先本地生效，预览与设置页里的示例立刻换装。
    setMarkdown((prev) => ({ ...prev, ...patch }));
    void window.goodjob.markdown.save(patch).then(setMarkdown);
  };

  const switchWorkspace = (id: string): void => {
    void window.goodjob.workspace.switchTo(id).then((state) => {
      setWorkspaces(state);
      void window.goodjob.models.get().then(setModels);
    });
  };

  // 对话侧选模型：main 落盘后回传整份配置，activeModel 也就跟着变了。
  const selectModel = (selection: ModelSelection): void => {
    void window.goodjob.models.selectDefault(selection).then(setModels);
  };

  const openSettings = (section: SettingsSection = "appearance"): void => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  const dark = resolveDark(appearance.themeMode, systemDark);

  const workspaceName =
    workspaces?.items.find((item) => item.id === workspaces.currentId)?.name ?? "工作区";

  /*
   * 顶栏一条 48px：左边让出 macOS 交通灯（实测窗口 x 16–75 / y 19–30.5，中心 y≈24.5，
   * 正好落在 48px 的中线上），右边放我们自己的操作按钮 —— 展开/收起、以及后续新功能。
   * 内容区不再各自留位置，也不再往卡片里塞把手。
   *
   * 内容区不要加 no-drag：-webkit-app-region 会继承给后代，而 Blink 计算拖拽区域时
   * 不按滚动容器的裁剪处理。消息流往上滚后，内容的布局盒会伸进顶栏，整片 no-drag
   * 区域就在顶栏上挖出一个洞，表现为「对话上方的顶栏拖不动窗口」。
   */
  const topbar = (
    <div className="drag flex h-12 shrink-0 items-center gap-0.5 pr-2 pl-[92px]">
      <IconToggle
        label={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
        active={sidebarOpen}
        onClick={() => setSidebarOpen(!sidebarOpen)}
      >
        {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
      </IconToggle>
      <div className="flex-1" />
      <div className="no-drag mr-1">
        <TasksBadge tasks={tasks} onOverlayChange={setOverlayOpen} />
      </div>
      <IconToggle
        label={browserOpen ? "收起浏览器" : "打开浏览器"}
        active={browserOpen}
        className={agentRunning ? "bg-primary/10 text-primary hover:bg-primary/15" : undefined}
        onClick={() => setBrowserOpen(!browserOpen)}
      >
        <AgentGlobe running={agentRunning} />
      </IconToggle>
      {agentRunning && <AgentRunningHint />}
    </div>
  );

  // 模块页公共 props：模型选择与浮层上报都来自 App。
  const moduleProps = {
    models,
    onSelectModel: selectModel,
    onOpenModelSettings: () => openSettings("models"),
    onOverlayChange: setOverlayOpen,
    onOpenBrowser: () => setBrowserOpen(true),
  };

  // 切工作区 = 换一整套数据：模块页按 workspaceId remount，会话和简历全部重载。
  const workspaceVersion = workspaces?.currentId ?? "loading";
  const renderModule = (key: ModuleKey) => {
    switch (key) {
      case "resume":
        return <ResumePage key={workspaceVersion} {...moduleProps} />;
      case "companies":
        return <CompaniesPage key={workspaceVersion} {...moduleProps} />;
      case "jobs": {
        // 岗位表与二级工作台都常驻：从表格钻进某个岗位时，表格那边正在跑的对话
        // 不该被卸载打断（它的会话就在表格页里）。返回时工作台卸载，表格复现。
        const workbenchOpen = jobWorkbench !== null;
        return (
          <>
            <div
              className={cn("absolute inset-0", workbenchOpen && "invisible pointer-events-none")}
              aria-hidden={workbenchOpen}
            >
              <JobsPage
                key={workspaceVersion}
                onOpenJob={(jobId, autoPrompt) => setJobWorkbench({ jobId, autoPrompt })}
                onOpenInterview={(interviewId) => {
                  setInterviewFocus(interviewId);
                  setActiveModule("interview");
                }}
                {...moduleProps}
              />
            </div>
            {jobWorkbench !== null && (
              <div className="absolute inset-0">
                <JobWorkbenchPage
                  key={`${workspaceVersion}:${jobWorkbench.jobId}`}
                  jobId={jobWorkbench.jobId}
                  autoPrompt={jobWorkbench.autoPrompt}
                  onAutoPromptSent={() =>
                    setJobWorkbench((prev) =>
                      prev === null ? prev : { ...prev, autoPrompt: null },
                    )
                  }
                  onBack={() => setJobWorkbench(null)}
                  {...moduleProps}
                />
              </div>
            )}
          </>
        );
      }
      case "applications":
        return <ApplicationsPage key={workspaceVersion} {...moduleProps} />;
      case "interview":
        return (
          <InterviewPage
            key={workspaceVersion}
            focusId={interviewFocus}
            onFocusConsumed={() => setInterviewFocus(null)}
            {...moduleProps}
          />
        );
    }
  };

  // 第一次进入某模块时把它挂上，之后不再卸载。
  useEffect(() => {
    setMountedModules((prev) => (prev.includes(activeModule) ? prev : [...prev, activeModule]));
  }, [activeModule]);

  // agent:pane-open 通道保留作为兜底；现在 Agent 在后台跑不会再请求弹面板。
  useEffect(() => window.goodjob.browser.onRequestOpen(() => setBrowserOpen(true)), []);

  // 浏览器任务在跑（agent:step 的 status）：顶栏地球图标亮成「agent 控制中」。
  useEffect(
    () =>
      window.goodjob.agent.onStep((event) => {
        if (event.type === "status") setAgentRunning(event.running);
        else setAgentRunning(true);
      }),
    [],
  );

  // 「让 Agent 接管」只在挂了 useBrowserTakeover 的会话里出现
  // （companies / jobs / applications；岗位二级工作台的 job:<id> 会话没有浏览器工具）。
  const takeoverAvailable =
    (activeModule === "companies" || activeModule === "jobs" || activeModule === "applications") &&
    !(activeModule === "jobs" && jobWorkbench !== null);

  return (
    <MarkdownThemeProvider themeId={markdown.themeId}>
      <TooltipProvider delayDuration={300}>
        <ThemeApplier dark={dark} fontSize={appearance.fontSize} />
        {/*
         * 窗口 = 48px 顶栏（交通灯 + 我们的操作按钮）+ 下面分块的内容。
         * 左栏直接铺在窗口底色上（没有卡片、没有描边），只有内容块是白色卡片，
         * 层级因此是：窗口底 → 侧栏（导航）→ 内容卡（模块页 / 浏览器面板）。
         */}
        <div className="flex h-screen flex-col overflow-hidden bg-shell text-foreground">
          {topbar}

          <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
            {sidebarOpen && (
              <div className="w-[248px] shrink-0 overflow-hidden">
                <Sidebar
                  activeModule={activeModule}
                  onSelectModule={(key) => {
                    setActiveModule(key);
                    // 浏览器是为当前模块打开的，换模块就收起来（否则它盖住新页面，看着像没反应）。
                    setBrowserOpen(false);
                    // 离开岗位模块即退出二级工作台（回来落在岗位表）。
                    if (key !== "jobs") setJobWorkbench(null);
                  }}
                  workspaces={workspaces?.items ?? []}
                  currentWorkspace={
                    workspaces?.items.find((item) => item.id === workspaces.currentId) ?? null
                  }
                  onOpenSettings={() => openSettings()}
                  onSwitchWorkspace={switchWorkspace}
                />
              </div>
            )}

            <main className="relative min-h-0 min-w-0 flex-1">
              {mountedModules.map((key) => (
                <div
                  key={`${workspaceVersion}:${key}`}
                  // 非活动模块只隐身不卸载：visibility 会保留布局，滚动位置与
                  // 消息滚动锚定都还在；invisible 同时也是不可聚焦的。
                  className={cn(
                    "absolute inset-0",
                    key === activeModule ? "visible" : "invisible pointer-events-none",
                  )}
                  aria-hidden={key !== activeModule}
                >
                  {renderModule(key)}
                </div>
              ))}
              {/*
               * 浏览器铺满整个内容块（原生 WebContentsView 停在其中留出的矩形上）。
               * 模块页留在下层不卸载：它的会话与「让 Agent 接管」监听都要继续活着。
               */}
              {browserOpen && (
                <div className="absolute inset-0 overflow-hidden rounded-2xl bg-card shadow-sm">
                  <BrowserPanel
                    active
                    suspended={settingsOpen || overlayOpen}
                    takeoverAvailable={takeoverAvailable}
                    onClose={() => setBrowserOpen(false)}
                  />
                </div>
              )}
            </main>
          </div>
        </div>

        <SettingsModal
          open={settingsOpen}
          models={models}
          appearance={appearance}
          markdown={markdown}
          workspaceName={workspaceName}
          initialSection={settingsSection}
          onClose={() => setSettingsOpen(false)}
          onSaved={setModels}
          onAppearanceChange={changeAppearance}
          onMarkdownChange={changeMarkdown}
        />
      </TooltipProvider>
    </MarkdownThemeProvider>
  );
}

/** 顶栏地球图标：Agent 在后台跑浏览器时亮起来（像任务栏的“工作中”）。 */
function AgentGlobe({ running }: { running: boolean }) {
  return (
    <span className="relative inline-flex">
      <Globe className={running ? "text-primary" : undefined} />
      {running && (
        <span className="absolute -top-0.5 -right-0.5 flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
          <span className="relative inline-flex size-2 rounded-full bg-primary" />
        </span>
      )}
    </span>
  );
}

/** 「agent 控制中」字样：跟着地球图标出现，带一点流光，不抢内容区的空间。 */
function AgentRunningHint() {
  return (
    <span
      className="no-drag flex shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
      aria-live="polite"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-primary" />
      agent 控制中
    </span>
  );
}

function IconToggle({
  label,
  active = false,
  className,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? "secondary" : "ghost"}
          size="icon-sm"
          className={cn("no-drag text-muted-foreground", active && "text-foreground", className)}
          aria-label={label}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
