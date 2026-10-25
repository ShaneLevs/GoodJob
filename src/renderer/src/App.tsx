import { useEffect, useState } from "react";

import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";

import type {
  AppearanceSettings,
  ModelSelection,
  ModelsConfig,
  ScorecardTarget,
  TaskState,
  WorkspacesState,
} from "@shared/types";

import { SettingsModal, type SettingsSection } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { ThemeApplier } from "./components/theme-applier";
import { Workbench } from "./components/Workbench";
import { Button } from "./components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { cn } from "./lib/utils";
import { ApplicationsPage } from "./components/modules/ApplicationsPage";
import { CompaniesPage } from "./components/modules/CompaniesPage";
import { InterviewPage } from "./components/modules/InterviewPage";
import { JobWorkbenchPage } from "./components/modules/JobWorkbenchPage";
import { JobsPage } from "./components/modules/JobsPage";
import { ResumePage } from "./components/modules/ResumePage";
import type { ModuleKey } from "./modules";
import type { PaneKey } from "./panes";
import { resolveDark } from "./theme";

/** 右栏默认宽度（px）。拖拽后会记住用户自己拖出来的宽度。 */
const WORKBENCH_DEFAULT_WIDTH = 560;
/** 拖拽分栏时的最小宽度：再窄对话区和标签页就没法用了。 */
const CHAT_MIN_WIDTH = 420;
const WORKBENCH_MIN_WIDTH = 340;

export function App() {
  const [models, setModels] = useState<ModelsConfig | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspacesState | null>(null);
  const [appearance, setAppearance] = useState<AppearanceSettings>({
    themeMode: "system",
    fontSize: 13,
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
   * 岗位二级工作台（定制简历）：有值时「岗位」模块渲染 JobWorkbenchPage。
   * autoPrompt 是进入时的一次性起草指令（生成简历 / 生成话术），发完即清。
   */
  const [jobWorkbench, setJobWorkbench] = useState<{ jobId: string; autoPrompt: string | null } | null>(null);
  /*
   * 模拟面试的一次性定位：从岗位页发起后跳到面试模块并选中这场面试，选中即清。
   */
  const [interviewFocus, setInterviewFocus] = useState<string | null>(null);
  /*
   * 右栏默认收起：首次启动时界面只需要对话，右栏由 Agent 需要时自己打开，
   * 顶栏右侧那个按钮随时可以手动展开。
   */
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [openPanes, setOpenPanes] = useState<PaneKey[]>([]);
  const [activePane, setActivePane] = useState<PaneKey | null>(null);
  /** 评分卡标签当前展示的报告定位。 */
  const [scorecardTarget, setScorecardTarget] = useState<ScorecardTarget | null>(null);
  /** 后台任务注册表快照（右栏「任务」角标汇总用）。 */
  const [tasks, setTasks] = useState<TaskState[]>([]);
  /** 对话区里的浮层（模型下拉）打开期间为 true，原生浏览器视图要让位。 */
  const [overlayOpen, setOverlayOpen] = useState(false);

  useEffect(() => {
    void window.goodjob.models.get().then(setModels);
    void window.goodjob.workspace.get().then(setWorkspaces);
    void window.goodjob.appearance.get().then(setAppearance);
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
  // 岗位工作台、面试定位与评分卡指向的是旧工作区的数据，一并退出。
  useEffect(
    () =>
      window.goodjob.workspace.onChanged((state) => {
        setWorkspaces(state);
        setJobWorkbench(null);
        setInterviewFocus(null);
        setScorecardTarget(null);
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
      <IconToggle
        label={workbenchOpen ? "收起右栏" : "展开右栏"}
        active={workbenchOpen}
        onClick={() => setWorkbenchOpen(!workbenchOpen)}
      >
        {workbenchOpen ? <PanelRightClose /> : <PanelRightOpen />}
      </IconToggle>
    </div>
  );

  // 模块页公共 props：模型选择与浮层上报都来自 App。
  const moduleProps = {
    models,
    onSelectModel: selectModel,
    onOpenModelSettings: () => openSettings("models"),
    onOverlayChange: setOverlayOpen,
  };

  // 切工作区 = 换一整套数据：模块页按 workspaceId remount，会话和简历全部重载。
  const workspaceVersion = workspaces?.currentId ?? "loading";
  const moduleContent = (() => {
    switch (activeModule) {
      case "resume":
        return <ResumePage key={workspaceVersion} {...moduleProps} />;
      case "companies":
        return <CompaniesPage key={workspaceVersion} {...moduleProps} />;
      case "jobs":
        // 二级工作台（定制简历）优先于岗位表；返回键落回表格。
        return jobWorkbench !== null ? (
          <JobWorkbenchPage
            key={`${workspaceVersion}:${jobWorkbench.jobId}`}
            jobId={jobWorkbench.jobId}
            autoPrompt={jobWorkbench.autoPrompt}
            onAutoPromptSent={() =>
              setJobWorkbench((prev) => (prev === null ? prev : { ...prev, autoPrompt: null }))
            }
            onBack={() => setJobWorkbench(null)}
            {...moduleProps}
          />
        ) : (
          <JobsPage
            key={workspaceVersion}
            onOpenJob={(jobId, autoPrompt) => setJobWorkbench({ jobId, autoPrompt })}
            onOpenScorecard={(target) => openPane("scorecard", target)}
            onOpenInterview={(interviewId) => {
              setInterviewFocus(interviewId);
              setActiveModule("interview");
            }}
            {...moduleProps}
          />
        );
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
      case "companies":
        return <CompaniesPage key={workspaceVersion} {...moduleProps} />;
    }
  })();

  // 右栏不提供手动创建标签的入口：openPane 留给 Agent 侧通道（评分卡可带定位）。
  const openPane = (key: PaneKey, scorecard?: ScorecardTarget): void => {
    setOpenPanes((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setActivePane(key);
    setWorkbenchOpen(true);
    if (key === "scorecard" && scorecard !== undefined) setScorecardTarget(scorecard);
  };

  // agent:pane-open（BROWSER-AGENT §6 预留事件）的兑现：main（后台任务等）
  // 请求打开右栏与对应标签——评分类任务完成时带评分卡定位。
  useEffect(
    () =>
      window.goodjob.workbench.onPaneOpen((event) => {
        setOpenPanes((prev) => (prev.includes(event.pane) ? prev : [...prev, event.pane]));
        setActivePane(event.pane);
        setWorkbenchOpen(true);
        if (event.pane === "scorecard" && event.scorecard !== undefined) {
          setScorecardTarget(event.scorecard);
        }
      }),
    [],
  );

  const closePane = (key: PaneKey): void => {
    const next = openPanes.filter((pane) => pane !== key);
    setOpenPanes(next);
    if (activePane === key) setActivePane(next[next.length - 1] ?? null);
  };

  const workbench = (
    <Workbench
      openPanes={openPanes}
      activePane={activePane}
      suspended={settingsOpen || overlayOpen || !workbenchOpen}
      scorecardTarget={scorecardTarget}
      tasks={tasks}
      // 「让 Agent 接管」只在挂了 useBrowserTakeover 的会话里出现
      // （companies / jobs / applications；岗位二级工作台的 job:<id> 会话没有浏览器工具）。
      takeoverAvailable={
        (activeModule === "companies" || activeModule === "jobs" || activeModule === "applications") &&
        !(activeModule === "jobs" && jobWorkbench !== null)
      }
      onSelect={setActivePane}
      onOpen={openPane}
      onClose={closePane}
      onOverlayChange={setOverlayOpen}
    />
  );

  return (
    <TooltipProvider delayDuration={300}>
      <ThemeApplier dark={dark} fontSize={appearance.fontSize} />
      {/*
       * 窗口 = 48px 顶栏（交通灯 + 我们的操作按钮）+ 下面分块的内容。
       * 左栏直接铺在窗口底色上（没有卡片、没有描边），只有内容块是白色卡片，
       * 层级因此是：窗口底 → 侧栏（导航）→ 内容卡（模块页 / 右栏）。
       */}
      <div className="flex h-screen flex-col overflow-hidden bg-shell text-foreground">
        {topbar}

        <div className="no-drag flex min-h-0 flex-1 gap-2 px-2 pb-2">
          {sidebarOpen && (
            <div className="w-[248px] shrink-0 overflow-hidden">
              <Sidebar
                activeModule={activeModule}
                onSelectModule={(key) => {
                  setActiveModule(key);
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

          <main className="min-h-0 min-w-0 flex-1">
            {workbenchOpen ? (
              <ResizablePanelGroup orientation="horizontal">
                <ResizablePanel minSize={CHAT_MIN_WIDTH} defaultSize="56%">
                  {moduleContent}
                </ResizablePanel>
                {/* 8px 间隙里的一条可拖拽细线：既是分隔提示，也是拖拽热区。 */}
                <ResizableHandle className="mx-1 w-1 justify-self-center rounded-full bg-border/60 transition-colors after:hidden hover:bg-border data-[separator]:bg-border/60" />
                <ResizablePanel minSize={WORKBENCH_MIN_WIDTH} defaultSize={WORKBENCH_DEFAULT_WIDTH}>
                  <div className="h-full overflow-hidden rounded-2xl bg-card shadow-sm">
                    {workbench}
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>
            ) : (
              moduleContent
            )}
          </main>
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        models={models}
        appearance={appearance}
        workspaceName={workspaceName}
        initialSection={settingsSection}
        onClose={() => setSettingsOpen(false)}
        onSaved={setModels}
        onAppearanceChange={changeAppearance}
      />
    </TooltipProvider>
  );
}

function IconToggle({
  label,
  active = false,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? "secondary" : "ghost"}
          size="icon-sm"
          className={cn("no-drag text-muted-foreground", active && "text-foreground")}
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
