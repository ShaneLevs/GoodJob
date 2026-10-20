import { useEffect, useMemo, useRef, useState } from "react";

import { XProvider } from "@ant-design/x";
import { App as AntdApp, Button, ConfigProvider, Splitter, Tooltip } from "antd";
import zhCN from "antd/locale/zh_CN";

import type {
  AppearanceSettings,
  ChatMessage,
  ModelsConfig,
  WorkspacesState,
} from "@shared/types";

import { ChatPanel } from "./components/ChatPanel";
import { PanelLeftIcon, PanelRightIcon } from "./components/PanelIcons";
import { SettingsModal } from "./components/SettingsModal";
import { ThemeVars } from "./components/ThemeVars";
import { Sidebar } from "./components/Sidebar";
import { Workbench } from "./components/Workbench";
import type { PaneKey } from "./panes";
import { buildTheme, resolveDark } from "./theme";
import type { UiMessage } from "./types";

/** 右栏宽度动画时长，需与 styles.css 里 `.app-splitter-anim` 的过渡一致。 */
const WORKBENCH_ANIM_MS = 220;
/** 动画结束后再多等一帧才卸载，避免最后一帧被截断。 */
const WORKBENCH_SETTLE_MS = WORKBENCH_ANIM_MS + 20;
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

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [workbenchOpen, setWorkbenchOpen] = useState(true);
  /** 受控宽度：收起/展开靠动画 flex-basis，和左侧栏的宽度过渡手感一致。 */
  const [workbenchWidth, setWorkbenchWidth] = useState(WORKBENCH_DEFAULT_WIDTH);
  /** 仅在程序化开合期间为 true，这时才给面板加 flex-basis 过渡（拖拽时不能有）。 */
  const [workbenchAnimating, setWorkbenchAnimating] = useState(false);
  const [openPanes, setOpenPanes] = useState<PaneKey[]>([]);
  const [activePane, setActivePane] = useState<PaneKey | null>(null);

  const streamingIdRef = useRef<string | null>(null);
  const workbenchTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (workbenchTimerRef.current !== null) window.clearTimeout(workbenchTimerRef.current);
    },
    [],
  );

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

      if (event.code === "llm_not_configured") setSettingsOpen(true);
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

  // 收起工作台靠宽度过渡，原生浏览器视图由 BrowserPanel 的 suspended 负责隐藏。

  /*
   * 开合只改一个布尔值，宽度由它推导（开 → 记住的宽度，关 → 0）。
   * 面板始终挂载，所以两个方向都是在既有节点上过渡 flex-basis：
   * 和左侧栏收缩同一手感，也不会出现"挂载首帧没有过渡"的生硬跳变。
   */
  const dark = resolveDark(appearance.themeMode, systemDark);
  const theme = useMemo(
    () => buildTheme({ dark, fontSize: appearance.fontSize }),
    [dark, appearance.fontSize],
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

  const toggleWorkbench = (): void => {
    if (workbenchTimerRef.current !== null) {
      window.clearTimeout(workbenchTimerRef.current);
    }
    setWorkbenchAnimating(true);
    setWorkbenchOpen((open) => !open);
    workbenchTimerRef.current = window.setTimeout(() => {
      setWorkbenchAnimating(false);
      workbenchTimerRef.current = null;
    }, WORKBENCH_SETTLE_MS);
  };

  /*
   * 顶栏是浮在卡片上方的一层，不占布局高度：卡片可以一直顶到窗口顶部。
   * 拖拽区只铺在侧边栏那一列，否则会盖住卡片顶部的标签页/消息并吞掉点击。
   */
  const topbar = (
    <div className="topbar">
      <div className="topbar-drag drag" />
      <Tooltip title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}>
        <Button
          type="text"
          className="topbar-button topbar-button-lead"
          aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
          icon={<PanelLeftIcon />}
          onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
        />
      </Tooltip>
      <Tooltip title={workbenchOpen ? "收起右栏" : "展开右栏"}>
        <Button
          type="text"
          className="topbar-button topbar-button-tail"
          aria-label={workbenchOpen ? "收起右栏" : "展开右栏"}
          icon={<PanelRightIcon />}
          onClick={toggleWorkbench}
        />
      </Tooltip>
    </div>
  );

  const chat = (
    <ChatPanel
      messages={messages}
      streaming={streaming}
      activeModel={models?.activeModel ?? null}
      onSend={send}
      onStop={stop}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );

  const workbench = (
    <Workbench
      openPanes={openPanes}
      activePane={activePane}
      suspended={settingsOpen || !workbenchOpen || workbenchAnimating}
      onSelect={setActivePane}
      onOpen={openPane}
      onClose={closePane}
    />
  );

  return (
    <ConfigProvider locale={zhCN} theme={theme}>
      <XProvider>
        <AntdApp>
          <ThemeVars dark={dark} />
          <div className="app-shell">
            {topbar}

            <div className="app-body">
              <div className={`sidebar-slot${sidebarCollapsed ? " sidebar-slot-collapsed" : ""}`}>
                <Sidebar
                  workspaces={workspaces?.items ?? []}
                  currentWorkspace={
                    workspaces?.items.find((item) => item.id === workspaces.currentId) ?? null
                  }
                  onOpenSettings={() => setSettingsOpen(true)}
                  onSwitchWorkspace={switchWorkspace}
                />
              </div>

              <div className="app-main">
                <Splitter
                  className={`app-splitter${workbenchAnimating ? " app-splitter-anim" : ""}${
                    workbenchOpen ? "" : " app-splitter-collapsed"
                  }`}
                  onResize={(sizes) => {
                    if (!workbenchAnimating && workbenchOpen && typeof sizes[1] === "number") {
                      setWorkbenchWidth(sizes[1]);
                    }
                  }}
                >
                  <Splitter.Panel min={CHAT_MIN_WIDTH}>
                    <div className="pane-slot">{chat}</div>
                  </Splitter.Panel>
                  <Splitter.Panel
                    // 收起即 0 宽；最小宽度只在展开时才生效，否则会把 0 夹回 340。
                    size={workbenchOpen ? workbenchWidth : 0}
                    min={workbenchOpen ? WORKBENCH_MIN_WIDTH : 0}
                  >
                    {/* 动画结束后才卸载：既留住过渡，又不留 2px 的卡片残边。 */}
                    <div className="pane-slot">
                      {workbenchOpen || workbenchAnimating ? workbench : null}
                    </div>
                  </Splitter.Panel>
                </Splitter>
              </div>
            </div>
          </div>

          <SettingsModal
            open={settingsOpen}
            models={models}
            appearance={appearance}
            workspaceName={
              workspaces?.items.find((item) => item.id === workspaces.currentId)?.name ?? "工作区"
            }
            onClose={() => setSettingsOpen(false)}
            onSaved={setModels}
            onAppearanceChange={changeAppearance}
          />
        </AntdApp>
      </XProvider>
    </ConfigProvider>
  );
}
