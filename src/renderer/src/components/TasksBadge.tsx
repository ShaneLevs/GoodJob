import { useState } from "react";

import { CircleAlert, ListChecks, LoaderCircle, RotateCw } from "lucide-react";

import type { TaskState } from "@shared/types";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const TYPE_LABELS: Record<TaskState["type"], string> = {
  "job-match": "简历评估",
  "resume-integrity": "简历完整性",
};

/**
 * 右栏「任务」角标（Workbench 标签栏右侧）：后台任务进度汇总。
 * 运行中给转圈 + 数量；点开看每个任务的进度 / 结果，已结束的点击重跑
 * （重跑 = 新任务，同 type + target；未配置模型时错误直接显示在菜单里）。
 */
export function TasksBadge({
  tasks,
  onOverlayChange,
}: {
  tasks: TaskState[];
  onOverlayChange: (open: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const running = tasks.filter((task) => task.status === "running").length;
  const shown = tasks.slice(0, 8);

  const rerun = (task: TaskState): void => {
    setError(null);
    void window.goodjob.tasks
      .rerun(task.id)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  return (
    <DropdownMenu onOpenChange={(open) => { setError(null); onOverlayChange(open); }}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className={cn(
            "ml-auto gap-1 text-xs text-muted-foreground",
            running > 0 && "text-foreground",
          )}
          aria-label={`后台任务（${running} 个运行中）`}
        >
          {running > 0 ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <ListChecks />
          )}
          任务
          {running > 0 && <span className="tabular-nums">{running}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          后台任务{running > 0 ? ` · ${running} 个运行中` : ""}
        </DropdownMenuLabel>
        {shown.map((task) => {
          const runningTask = task.status === "running";
          return (
            <DropdownMenuItem
              key={task.id}
              disabled={runningTask}
              className="flex-col items-start gap-0.5"
              onSelect={() => rerun(task)}
            >
              <span className="flex w-full items-center gap-1.5 text-xs font-medium">
                {runningTask ? (
                  <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
                ) : task.status === "done" ? (
                  <RotateCw className="size-3 text-muted-foreground" />
                ) : (
                  <CircleAlert className="size-3 text-destructive" />
                )}
                {TYPE_LABELS[task.type]}
                <span className="ml-auto pl-2 font-normal text-muted-foreground">
                  {runningTask ? "进行中" : task.status === "done" ? "点击重跑" : "失败，点击重试"}
                </span>
              </span>
              <span className="w-full text-[11px] leading-relaxed break-words whitespace-normal text-muted-foreground">
                {runningTask
                  ? (task.progress ?? "…")
                  : task.status === "failed"
                    ? (task.error ?? "失败")
                    : (task.result ?? "已完成")}
              </span>
            </DropdownMenuItem>
          );
        })}
        {tasks.length > shown.length && (
          <DropdownMenuItem disabled className="text-center text-[11px] text-muted-foreground">
            还有 {tasks.length - shown.length} 条更早的任务
          </DropdownMenuItem>
        )}
        {error !== null && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-[11px] leading-relaxed text-destructive">{error}</p>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
