import { useEffect, useRef, useState } from "react";

import { ArrowLeft, ArrowRight, Bug, Home, Bot, RotateCw, Square } from "lucide-react";

import type { AgentStepEvent, BrowserState } from "@shared/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const HOME = "https://www.bing.com";

/**
 * 「让 Agent 接管」在当前会话里发起一次浏览器工具调用：具体落点由挂了
 * useBrowserTakeover 的模块会话（companies / jobs / applications）接住，
 * 这里只广播事件（renderer 内，不经 main）。
 */
const TAKEOVER_EVENT = "goodjob:agent-takeover";

const INITIAL_STATE: BrowserState = {
  url: HOME,
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
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
}

/**
 * Reserves a rectangle in the DOM and tells the main process to park the native
 * `WebContentsView` exactly there. The DOM node itself stays empty on purpose.
 */
export function BrowserPanel({ active, suspended, takeoverAvailable = false }: BrowserPanelProps) {
  const holderRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(false);
  const [state, setState] = useState<BrowserState>(INITIAL_STATE);
  const [address, setAddress] = useState(HOME);
  const [agentRunning, setAgentRunning] = useState(false);

  const browser = window.goodjob.browser;

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
