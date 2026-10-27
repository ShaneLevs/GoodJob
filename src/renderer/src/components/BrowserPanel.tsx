import { useEffect, useRef, useState } from "react";

import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Bug,
  Home,
  Plus,
  RotateCw,
  Square,
  X,
} from "lucide-react";

import type { AgentStepEvent, BrowserState } from "@shared/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const HOME = "https://www.bing.com";

/**
 * 「让 Agent 接管」在当前会话里发起一次浏览器工具调用：具体落点由挂了
 * useBrowserTakeover 的模块会话（companies / jobs / applications）接住，
 * 这里只广播事件（renderer 内，不经 main）。
 */
const TAKEOVER_EVENT = "goodjob:agent-takeover";

const INITIAL_STATE: BrowserState = {
  activeId: null,
  url: HOME,
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  tabs: [],
};

interface BrowserPanelProps {
  /** Only the visible tab may own the native view. */
  active: boolean;
  /** 任何浮层（dialog / dropdown）打开时必须挂起原生视图，否则它会盖在浮层上面。 */
  suspended: boolean;
  /**
   * 当前会话是否接得住「让 Agent 接管」（companies / jobs / applications 三个
   * 挂了 useBrowserTakeover 的会话）；接不住就不显示按钮，免得点了没反应。
   */
  takeoverAvailable?: boolean;
  /** 关闭浏览器（回到模块页）；提供时工具条尾部出现关闭按钮。 */
  onClose?: () => void;
}

/**
 * Reserves a rectangle in the DOM and tells the main process to park the native
 * `WebContentsView` exactly there. The DOM node itself stays empty on purpose.
 *
 * 标签条与地址栏都是普通 DOM，原生视图只在下面那块矩形里——所以标签条的点击
 * 不会被视图吃掉。
 */
export function BrowserPanel({
  active,
  suspended,
  takeoverAvailable = false,
  onClose,
}: BrowserPanelProps) {
  const holderRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(false);
  const [state, setState] = useState<BrowserState>(INITIAL_STATE);
  const [address, setAddress] = useState(HOME);
  const [agentRunning, setAgentRunning] = useState(false);

  const browser = window.goodjob.browser;

  // 挂载时先拉一次快照：main 只在状态变化时推送，而面板是「打开 / 关闭」重新挂载的
  // （顶栏地球图标），不拉就会看到空标签条。
  useEffect(() => {
    void browser.getState().then((next) => {
      if (next === null) return;
      setState(next);
      if (next.url !== "") setAddress(next.url);
    });
  }, [browser]);

  useEffect(
    () =>
      browser.onState((next) => {
        setState(next);
        if (!editingRef.current && next.url !== "") setAddress(next.url);
      }),
    [browser],
  );

  // 浏览器任务的运行态（P4）：工具条据此在「让 Agent 接管」与红色「中止 Agent」间切换。
  useEffect(
    () =>
      window.goodjob.agent.onStep((event: AgentStepEvent) => {
        if (event.type === "status") setAgentRunning(event.running);
      }),
    [],
  );

  // Keep the native view glued to the placeholder while the splitter moves.
  useEffect(() => {
    const element = holderRef.current;
    if (element === null) return;

    if (!active) {
      browser.setBounds(null);
      return;
    }

    const sync = (): void => {
      const rect = element.getBoundingClientRect();
      browser.setBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    window.addEventListener("resize", sync);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      browser.setBounds(null);
    };
  }, [browser, active]);

  useEffect(() => {
    browser.setVisible(active && !suspended);
  }, [browser, active, suspended]);

  const navigate = (value: string): void => {
    editingRef.current = false;
    void browser.navigate(value);
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-card">
      {/* 标签条：最上面一条，每个标签可切换 / 关闭，尾部是「+」。 */}
      <div className="flex shrink-0 items-center gap-1 border-b px-2 pt-1.5 pb-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {state.tabs.map((tab) => {
            const current = tab.id === state.activeId;
            return (
              <div
                key={tab.id}
                className={cn(
                  "group flex h-7 min-w-0 max-w-52 shrink-0 items-center gap-1 rounded-md pr-1 pl-2 text-xs transition-colors",
                  current
                    ? "bg-foreground/[0.07] text-foreground"
                    : "text-muted-foreground hover:bg-foreground/[0.04]",
                )}
              >
                <button
                  type="button"
                  title={tab.title === "" ? tab.url : `${tab.title}\n${tab.url}`}
                  className="flex min-w-0 flex-1 items-center gap-1"
                  onClick={() => browser.activateTab(tab.id)}
                >
                  {tab.agentBusy ? (
                    <Bot className="size-3 shrink-0 text-primary" aria-label="Agent 正在操作" />
                  ) : tab.loading ? (
                    <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-current" />
                  ) : null}
                  <span className="truncate">{tabLabel(tab.title, tab.url)}</span>
                </button>
                <button
                  type="button"
                  aria-label="关闭标签"
                  className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-foreground/10 data-active:opacity-100"
                  onClick={() => browser.closeTab(tab.id)}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <IconButton label="新建标签" onClick={() => void browser.newTab()}>
          <Plus />
        </IconButton>
      </div>

      {/* 工具条：只作用于当前活动标签。 */}
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <IconButton label="后退" disabled={!state.canGoBack} onClick={() => browser.back()}>
          <ArrowLeft />
        </IconButton>
        <IconButton
          label="前进"
          disabled={!state.canGoForward}
          onClick={() => browser.forward()}
        >
          <ArrowRight />
        </IconButton>
        {state.loading ? (
          <IconButton label="停止" onClick={() => browser.stop()}>
            <Square className="fill-current" />
          </IconButton>
        ) : (
          <IconButton label="刷新" onClick={() => browser.reload()}>
            <RotateCw />
          </IconButton>
        )}
        <IconButton label="回到首页" onClick={() => navigate(HOME)}>
          <Home />
        </IconButton>

        <Input
          value={address}
          spellCheck={false}
          placeholder="输入网址或搜索内容"
          className="h-7 min-w-0 flex-1 text-xs"
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => {
            editingRef.current = true;
            event.currentTarget.select();
          }}
          onBlur={() => {
            editingRef.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") navigate(address);
          }}
        />

        {agentRunning ? (
          // M5 终止开关的 UI 面：红色、一眼可点，杀了命令进程并收 daemon。
          <Button
            variant="destructive"
            size="sm"
            className="h-7 shrink-0 gap-1 text-xs"
            aria-label="中止 Agent"
            onClick={() => window.goodjob.agent.abort()}
          >
            <Square className="fill-current" />
            中止 Agent
          </Button>
        ) : takeoverAvailable ? (
          <IconButton label="让 Agent 接管（在当前会话发起浏览器任务）" onClick={() => window.dispatchEvent(new CustomEvent(TAKEOVER_EVENT))}>
            <Bot />
          </IconButton>
        ) : null}

        <IconButton label="浏览器 DevTools" onClick={() => browser.toggleDevTools()}>
          <Bug />
        </IconButton>
        {onClose !== undefined && (
          <IconButton label="关闭浏览器" onClick={onClose}>
            <X />
          </IconButton>
        )}
      </div>

      {/* 原生 WebContentsView 会精确停在这个矩形上，DOM 里刻意留空。 */}
      <div ref={holderRef} className="min-h-0 flex-1" />

      {state.title !== "" && (
        <div className="truncate border-t px-3 py-1 text-[calc(var(--text-xs)-1px)] text-muted-foreground">
          {state.title}
        </div>
      )}
    </div>
  );
}

/** 标签上显示的文字：标题优先，没有标题时退回域名（空白页显示「新标签页」）。 */
function tabLabel(title: string, url: string): string {
  if (title.trim() !== "") return title.trim();
  if (url === "" || url === "about:blank") return "新标签页";
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function IconButton({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
