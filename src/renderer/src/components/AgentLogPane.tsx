import { useEffect, useState } from "react";

import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";

import type { AgentStep, AgentStepEvent } from "@shared/types";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

/**
 * 右栏「工作日志」标签（P4）：Agent 每一步受控动作的时间线——命令、结果摘要
 * （不含页面正文）、耗时；失败红色，可展开看完整 argv；失败的非提交步骤可以
 * 单步重放（重放 = main 侧重跑同一条受控动作，提交类永远走不了重放）。
 * 数据来自 agent:step 事件流 + agent:log-list 初始快照。
 */
export function AgentLogPane() {
  const [steps, setSteps] = useState<AgentStep[] | null>(null);
  const [running, setRunning] = useState(false);
  const [replaying, setReplaying] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.goodjob.agent.listLog().then((list) => {
      if (alive) setSteps(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () =>
      window.goodjob.agent.onStep((event: AgentStepEvent) => {
        if (event.type === "step") {
          setSteps((prev) => (prev === null ? [event.step] : [...prev, event.step].slice(-400)));
        } else {
          setRunning(event.running);
        }
      }),
    [],
  );

  const replay = (step: AgentStep): void => {
    setReplaying(step.id);
    setReplayError(null);
    void window.goodjob.agent
      .replayStep(step.id)
      .catch((cause: unknown) => {
        setReplayError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setReplaying(null));
  };

  if (steps === null) {
    return (
      <div className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
        正在读取工作日志…
      </div>
    );
  }

  if (steps.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6">
        <Empty className="max-w-sm">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Bot />
            </EmptyMedia>
            <EmptyTitle>还没有浏览器动作</EmptyTitle>
            <EmptyDescription>
              Agent 在对话里使用浏览器工具时（调研 / 抓 JD / 填表投递），每一步命令与结果摘要都会记录在这里。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span
          className={cn(
            "size-1.5 rounded-full",
            running ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/40",
          )}
        />
        {running ? "浏览器任务运行中" : "空闲"}
        {replayError !== null && <span className="ml-auto text-destructive">{replayError}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <ol className="flex flex-col gap-1.5">
          {steps.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              replaying={replaying === step.id}
              onReplay={() => replay(step)}
            />
          ))}
        </ol>
      </div>
    </div>
  );
}

function StepRow({
  step,
  replaying,
  onReplay,
}: {
  step: AgentStep;
  replaying: boolean;
  onReplay: () => void;
}) {
  const [open, setOpen] = useState(false);
  const failed = !step.ok;
  // 提交类步骤不提供重放（必须重新走双重门）；其余失败步骤可重放。
  const replayable = failed && !step.action.startsWith("browser_submit");

  return (
    <li
      className={cn(
        "overflow-hidden rounded-lg border bg-muted/30 text-xs",
        failed ? "border-destructive/40" : "border-border/60",
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/50"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        {replaying ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : failed ? (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Check className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className={cn("shrink-0 font-medium", failed && "text-destructive")}>
          {step.action}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-muted-foreground", failed && "text-destructive/90")}>
          {step.summary}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground/70">
          {(step.durationMs / 1000).toFixed(1)}s
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div
          className={cn(
            "space-y-2 border-t px-2.5 py-2",
            failed ? "border-destructive/30" : "border-border/60",
          )}
        >
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted-foreground">命令（argv）</p>
            <pre className="overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {step.command.length > 0 ? step.command.join(" ") : "（系统动作，无 CLI 命令）"}
            </pre>
          </div>
          {step.error !== null && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">错误</p>
              <pre className="overflow-auto rounded-md bg-destructive/10 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-destructive">
                {step.error}
              </pre>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {new Date(step.at).toLocaleTimeString()} · {step.key ?? "系统"}
            </span>
            {replayable && (
              <Button
                variant="outline"
                size="xs"
                disabled={replaying}
                onClick={onReplay}
              >
                {replaying ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
                重试本步
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
