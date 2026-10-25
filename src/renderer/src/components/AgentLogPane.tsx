import { useEffect, useState } from "react";

import { Bot, Check, CircleAlert, LoaderCircle, RotateCcw } from "lucide-react";

import type { AgentStep, AgentStepEvent } from "@shared/types";

import { Button } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
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
  const failed = !step.ok;
  // 提交类步骤不提供重放（必须重新走双重门）；其余失败步骤可重放。
  const replayable = failed && !step.action.startsWith("browser_submit");

  return (
    <li>
      <Trace>
        <TraceCollapsible>
          <TraceCollapsibleTrigger>
            <TraceLine status={failed ? "error" : replaying ? "running" : undefined}>
              <TraceIcon>
                {replaying ? (
                  <LoaderCircle className="animate-spin" />
                ) : failed ? (
                  <CircleAlert />
                ) : (
                  <Check />
                )}
              </TraceIcon>
              <TraceTitle>{step.action}</TraceTitle>
              <span className="min-w-0 flex-1 truncate text-xs">{step.summary}</span>
              <TraceDescription>{(step.durationMs / 1000).toFixed(1)}s</TraceDescription>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="text-xs">
            <div className="flex flex-col gap-2">
              <CodeBlock size="sm">
                <CodeBlockHeader>
                  <CodeBlockTitle>命令（argv）</CodeBlockTitle>
                </CodeBlockHeader>
                <CodeBlockContent wrap>
                  {step.command.length > 0 ? step.command.join(" ") : "（系统动作，无 CLI 命令）"}
                </CodeBlockContent>
              </CodeBlock>
              {step.error !== null && (
                <CodeBlock size="sm" variant="destructive">
                  <CodeBlockHeader>
                    <CodeBlockTitle>错误</CodeBlockTitle>
                  </CodeBlockHeader>
                  <CodeBlockContent wrap>{step.error}</CodeBlockContent>
                </CodeBlock>
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
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
    </li>
  );
}
