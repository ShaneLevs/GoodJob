import { useEffect, useMemo, useState } from "react";

import {
  Ban,
  CheckCircle2,
  Circle,
  LoaderCircle,
  Workflow as WorkflowIcon,
  XCircle,
} from "lucide-react";

import type {
  SubagentRole,
  SubagentStatus,
  WorkflowState,
  WorkflowStatus,
  WorkflowTask,
} from "@shared/types";

import { AssistantMarkdown } from "@/components/chat/AssistantMarkdown";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const AGENT_LABELS: Record<SubagentRole, string> = {
  resume: "简历",
  companies: "公司",
  jobs: "岗位与投递",
  job: "岗位定制",
};

const STATUS_LABELS: Record<SubagentStatus, string> = {
  pending: "等待",
  running: "运行中",
  done: "完成",
  failed: "失败",
  blocked: "已跳过",
};

const WORKFLOW_LABELS: Record<WorkflowStatus, string> = {
  pending: "待开始",
  running: "运行中",
  done: "已完成",
  failed: "未完成",
};

const NODE_WIDTH = 156;
const NODE_HEIGHT = 62;
const GAP_X = 16;
const GAP_Y = 36;

interface NodePosition {
  task: WorkflowTask;
  x: number;
  y: number;
  level: number;
}

interface GraphLayout {
  nodes: NodePosition[];
  edges: Array<{ from: NodePosition; to: NodePosition }>;
  width: number;
  height: number;
}

/**
 * 依赖图布局：按最长路径把任务分到不同层，同层水平排开。
 * 侧栏很窄，所以用「层」而不是自动排布库；节点超宽时容器横向滚动。
 */
function layoutWorkflow(tasks: WorkflowTask[]): GraphLayout {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const levels = new Map<string, number>();

  const levelOf = (id: string, seen: Set<string>): number => {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    const task = byId.get(id);
    if (task === undefined || seen.has(id)) return 0;
    seen.add(id);
    const level =
      task.dependsOn.length === 0
        ? 0
        : Math.max(...task.dependsOn.map((dep) => levelOf(dep, seen) + 1));
    levels.set(id, level);
    return level;
  };

  for (const task of tasks) levelOf(task.id, new Set());

  const rows = new Map<number, WorkflowTask[]>();
  for (const task of tasks) {
    const level = levels.get(task.id) ?? 0;
    const row = rows.get(level);
    if (row === undefined) rows.set(level, [task]);
    else row.push(task);
  }

  const orderedLevels = [...rows.keys()].sort((a, b) => a - b);
  const maxWidth = Math.max(
    NODE_WIDTH,
    ...[...rows.values()].map(
      (row) => row.length * NODE_WIDTH + Math.max(0, row.length - 1) * GAP_X,
    ),
  );

  const nodes: NodePosition[] = [];
  for (const level of orderedLevels) {
    const row = rows.get(level) ?? [];
    const rowWidth = row.length * NODE_WIDTH + Math.max(0, row.length - 1) * GAP_X;
    const startX = (maxWidth - rowWidth) / 2;
    row.forEach((task, index) => {
      nodes.push({
        task,
        level,
        x: startX + index * (NODE_WIDTH + GAP_X),
        y: level * (NODE_HEIGHT + GAP_Y),
      });
    });
  }

  const nodeById = new Map(nodes.map((node) => [node.task.id, node]));
  const edges: GraphLayout["edges"] = [];
  for (const node of nodes) {
    for (const dep of node.task.dependsOn) {
      const from = nodeById.get(dep);
      if (from !== undefined) edges.push({ from, to: node });
    }
  }

  const levelCount = orderedLevels.length;
  return {
    nodes,
    edges,
    width: maxWidth,
    height: Math.max(
      NODE_HEIGHT,
      levelCount * NODE_HEIGHT + Math.max(0, levelCount - 1) * GAP_Y,
    ),
  };
}

function StatusIcon({ status, className }: { status: SubagentStatus; className?: string }) {
  switch (status) {
    case "running":
      return <LoaderCircle className={cn("animate-spin", className)} />;
    case "done":
      return <CheckCircle2 className={className} />;
    case "failed":
      return <XCircle className={className} />;
    case "blocked":
      return <Ban className={className} />;
    default:
      return <Circle className={className} />;
  }
}

function statusTone(status: SubagentStatus): string {
  switch (status) {
    case "running":
      return "border-primary/40 bg-primary/5 text-primary";
    case "done":
      return "border-success/30 bg-success/5 text-success";
    case "failed":
      return "border-destructive/30 bg-destructive/5 text-destructive";
    case "blocked":
      return "border-border bg-muted/20 text-muted-foreground/70";
    default:
      return "border-border bg-card text-muted-foreground";
  }
}

function WorkflowGraph({
  tasks,
  selectedId,
  onSelect,
}: {
  tasks: WorkflowTask[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const layout = useMemo(() => layoutWorkflow(tasks), [tasks]);

  return (
    <div className="overflow-auto rounded-xl border bg-muted/15 p-3">
      <div
        className="relative mx-auto"
        style={{ width: layout.width, height: layout.height }}
      >
        <svg
          className="pointer-events-none absolute inset-0 text-border"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
        >
          {layout.edges.map(({ from, to }) => {
            const x1 = from.x + NODE_WIDTH / 2;
            const y1 = from.y + NODE_HEIGHT;
            const x2 = to.x + NODE_WIDTH / 2;
            const y2 = to.y;
            const midY = (y1 + y2) / 2;
            return (
              <g key={`${from.task.id}-${to.task.id}`}>
                <path
                  d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
                <circle cx={x2} cy={y2} r={2.5} fill="currentColor" />
              </g>
            );
          })}
        </svg>

        {layout.nodes.map((node) => {
          const { task } = node;
          const selected = task.id === selectedId;
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => onSelect(task.id)}
              aria-pressed={selected}
              className={cn(
                "absolute flex flex-col justify-between rounded-xl border px-3 py-2 text-left transition-[box-shadow,border-color,background-color] outline-none",
                "focus-visible:ring-[3px] focus-visible:ring-ring/30",
                statusTone(task.status),
                selected && "ring-2 ring-primary/25",
                task.status === "running" && "shadow-sm",
              )}
              style={{
                left: node.x,
                top: node.y,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
              }}
            >
              <div className="flex w-full items-center gap-1.5">
                <StatusIcon
                  status={task.status}
                  className={cn("size-3 shrink-0", task.status === "running" && "text-primary")}
                />
                <span className="truncate text-[10px] font-medium tracking-wide">
                  {AGENT_LABELS[task.agent]}
                </span>
                <span className="ml-auto shrink-0 text-[10px] opacity-70">
                  {STATUS_LABELS[task.status]}
                </span>
              </div>
              <div className="line-clamp-2 text-xs leading-snug font-medium text-foreground">
                {task.title}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StatusCount({ status, count }: { status: SubagentStatus; count: number }) {
  if (count === 0) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        statusTone(status),
      )}
    >
      <StatusIcon status={status} className="size-3" />
      {STATUS_LABELS[status]} {count}
    </span>
  );
}

/**
 * GoodJob 右侧的工作流面板：只在 GoodJob 真的创建了工作流时渲染。
 * 头部是子 agent 数量与状态汇总，中间是依赖图，底部是选中任务的交付摘要。
 */
export function WorkflowPanel({ workflow }: { workflow: WorkflowState }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 默认跟着运行中的任务走；用户点过节点后保持自己的选择。
  useEffect(() => {
    if (selectedId !== null && workflow.tasks.some((task) => task.id === selectedId)) return;
    setSelectedId(
      workflow.tasks.find((task) => task.status === "running")?.id ??
        workflow.tasks[0]?.id ??
        null,
    );
  }, [selectedId, workflow.tasks]);

  const selected = workflow.tasks.find((task) => task.id === selectedId) ?? null;
  const counts = workflow.tasks.reduce<Record<SubagentStatus, number>>(
    (acc, task) => {
      acc[task.status] += 1;
      return acc;
    },
    { pending: 0, running: 0, done: 0, failed: 0, blocked: 0 },
  );

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl bg-card shadow-sm">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <WorkflowIcon className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{workflow.title}</span>
        <Badge
          variant="secondary"
          className={cn(
            "shrink-0",
            workflow.status === "running" && "bg-primary/10 text-primary",
            workflow.status === "done" && "bg-success/10 text-success",
            workflow.status === "failed" && "bg-destructive/10 text-destructive",
          )}
        >
          {WORKFLOW_LABELS[workflow.status]}
        </Badge>
      </div>

      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl leading-none font-semibold tabular-nums">
            {workflow.tasks.length}
          </span>
          <span className="text-xs text-muted-foreground">个子 agent</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <StatusCount status="running" count={counts.running} />
          <StatusCount status="pending" count={counts.pending} />
          <StatusCount status="done" count={counts.done} />
          <StatusCount status="failed" count={counts.failed} />
          <StatusCount status="blocked" count={counts.blocked} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3 p-3">
          <WorkflowGraph
            tasks={workflow.tasks}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />

          {selected !== null && (
            <div className="rounded-xl border bg-card p-3">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {AGENT_LABELS[selected.agent]}
                </span>
                <span className="text-xs font-medium">{selected.title}</span>
                <span
                  className={cn(
                    "ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                    statusTone(selected.status),
                  )}
                >
                  <StatusIcon status={selected.status} className="size-3" />
                  {STATUS_LABELS[selected.status]}
                </span>
              </div>

              {selected.error !== null && (
                <div className="mt-2 rounded-lg border border-destructive/25 bg-destructive/5 px-2.5 py-2 text-xs leading-relaxed whitespace-pre-wrap text-destructive">
                  {selected.error}
                </div>
              )}

              {selected.summary !== null ? (
                <AssistantMarkdown className="mt-2 text-xs">
                  {selected.summary}
                </AssistantMarkdown>
              ) : (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {selected.status === "running"
                    ? "子 agent 正在执行，完成后这里会显示它的交付摘要。"
                    : selected.status === "pending"
                      ? "等待前置任务完成。"
                      : selected.status === "blocked"
                        ? "前置任务没有完成，这个任务没有执行。"
                        : "还没有结果。"}
                </p>
              )}

              {selected.dependsOn.length > 0 && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  前置：{selected.dependsOn.join("、")}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
