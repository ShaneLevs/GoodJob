import { useEffect, useRef, useState } from "react";

import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";

import type {
  AppearanceSettings,
  ChatMessage,
  ModelSelection,
  ModelsConfig,
  WorkspacesState,
} from "@shared/types";

import { ChatPanel } from "./components/ChatPanel";
import { SettingsModal, type SettingsSection } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { ThemeApplier } from "./components/theme-applier";
import { Workbench } from "./components/Workbench";
import { Button } from "./components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { cn } from "./lib/utils";
import type { PaneKey } from "./panes";
import { resolveDark } from "./theme";
import type { UiMessage } from "./types";

/** 右栏默认宽度（px）。拖拽后会记住用户自己拖出来的宽度。 */
const WORKBENCH_DEFAULT_WIDTH = 560;
/** 拖拽分栏时的最小宽度：再窄对话区和标签页就没法用了。 */
const CHAT_MIN_WIDTH = 420;
const WORKBENCH_MIN_WIDTH = 340;

export function App() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
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
  /*
   * 右栏默认收起：首次启动时界面只需要对话，右栏由 Agent 需要时自己打开，
   * 顶栏右侧那个按钮随时可以手动展开。
   */
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [openPanes, setOpenPanes] = useState<PaneKey[]>([]);
  const [activePane, setActivePane] = useState<PaneKey | null>(null);
  /** 对话区里的浮层（模型下拉）打开期间为 true，原生浏览器视图要让位。 */
  const [overlayOpen, setOverlayOpen] = useState(false);

  const streamingIdRef = useRef<string | null>(null);

  useEffect(() => {
    void window.goodjob.models.get().then(setModels);
    void window.goodjob.workspace.get().then(setWorkspaces);
    void window.goodjob.appearance.get().then(setAppearance);
  }, []);

  // "跟随系统"要能实时响应系统外观的变化。
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  // 工作区切换由 main 广播：这里只需要把两个状态重读一遍。
  useEffect(
    () =>
      window.goodjob.workspace.onChanged((state) => {
        setWorkspaces(state);
        void window.goodjob.models.get().then(setModels);
      }),
    [],
  );

  useEffect(() => {
    const unsubscribe = window.goodjob.chat.onEvent((event) => {
      if (event.id !== streamingIdRef.current) return;

      if (event.type === "delta") {
        const text = event.text;
        setMessages((prev) =>
          prev.map((message) =>
            message.id === event.id ? { ...message, content: message.content + text } : message,
          ),
        );
        return;
      }

      streamingIdRef.current = null;
      setStreaming(false);

      if (event.type === "done") {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === event.id ? { ...message, streaming: false } : message,
          ),
        );
        return;
      }

      setMessages((prev) =>
        prev.map((message) =>
          message.id === event.id
            ? {
                ...message,
                streaming: false,
                failed: true,
                content:
                  message.content === ""
                    ? event.message
                    : `${message.content}\n\n${event.message}`,
              }
            : message,
        ),
      );
    });

    return unsubscribe;
  }, []);

  const send = (text: string): void => {
    if (streaming) return;

    const id = crypto.randomUUID();
    const history: ChatMessage[] = [
      ...messages
        .filter((message) => message.failed !== true)
        .map((message): ChatMessage => ({ role: message.role, content: message.content })),
      { role: "user", content: text },
    ];

    streamingIdRef.current = id;
    setStreaming(true);
    setMessages((prev) => [
      ...prev,
      { id: `user-${id}`, role: "user", content: text },
      { id, role: "assistant", content: "", streaming: true },
    ]);

    void window.goodjob.chat.send(id, history);
  };

  const stop = (): void => {
    const id = streamingIdRef.current;
    if (id !== null) window.goodjob.chat.abort(id);
  };

  // 右栏不提供手动创建标签的入口：openPane 留给 Agent 侧通道（后续 IPC 事件）。
  const openPane = (key: PaneKey): void => {
    setOpenPanes((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setActivePane(key);
    setWorkbenchOpen(true);
  };

  const closePane = (key: PaneKey): void => {
    const next = openPanes.filter((pane) => pane !== key);
    setOpenPanes(next);
    if (activePane === key) setActivePane(next[next.length - 1] ?? null);
  };

  const dark = resolveDark(appearance.themeMode, systemDark);

  const workspaceName =
    workspaces?.items.find((item) => item.id === workspaces.currentId)?.name ?? "工作区";


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

  const chatPanel = (
    <ChatPanel
      messages={messages}
      streaming={streaming}
      models={models}
      onSend={send}
      onStop={stop}
      onSelectModel={selectModel}
      onOpenModelSettings={() => openSettings("models")}
      onOverlayChange={setOverlayOpen}
    />
  );

  const chat = (
    <div className="h-full overflow-hidden rounded-2xl bg-card shadow-sm">
      {chatPanel}
    </div>
  );

  const workbench = (
    <Workbench
      openPanes={openPanes}
      activePane={activePane}
      suspended={settingsOpen || overlayOpen || !workbenchOpen}
      onSelect={setActivePane}
      onOpen={openPane}
      onClose={closePane}
    />
  );

  return (
    <TooltipProvider delayDuration={300}>
      <ThemeApplier dark={dark} fontSize={appearance.fontSize} />
      {/*
       * 窗口 = 48px 顶栏（交通灯 + 我们的操作按钮）+ 下面分块的内容。
       * 左栏直接铺在窗口底色上（没有卡片、没有描边），只有内容块是白色卡片，
       * 层级因此是：窗口底 → 侧栏（导航）→ 内容卡（对话 / 右栏）。
       */}
      <div className="flex h-screen flex-col overflow-hidden bg-shell text-foreground">
        {topbar}

        <div className="no-drag flex min-h-0 flex-1 gap-2 px-2 pb-2">
          {sidebarOpen && (
            <div className="w-[248px] shrink-0 overflow-hidden">
              <Sidebar
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
                  {chat}
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
              chat
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
