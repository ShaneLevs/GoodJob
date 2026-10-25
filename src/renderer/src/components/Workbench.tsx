import { X } from "lucide-react";

import type { ScorecardTarget, TaskState } from "@shared/types";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

import { BrowserPanel } from "./BrowserPanel";
import { ScorecardPane } from "./ScorecardPane";
import { TasksBadge } from "./TasksBadge";
import { PANES, PANE_BY_KEY, type PaneKey } from "../panes";

interface WorkbenchProps {
  openPanes: PaneKey[];
  activePane: PaneKey | null;
  /** Overlays (dialog/dropdown) must hide the native browser view. */
  suspended: boolean;
  /** 评分卡要展示的报告定位（agent:pane-open / 岗位表带过来）。 */
  scorecardTarget: ScorecardTarget | null;
  /** 后台任务注册表快照：标签栏右侧「任务」角标汇总进度。 */
  tasks: TaskState[];
  onSelect: (key: PaneKey) => void;
  /**
   * 只给 Agent 侧的通道预留：右栏不提供手动创建标签的入口，
   * 标签页由 Agent 在需要时打开（评分卡可带定位）。
   */
  onOpen: (key: PaneKey) => void;
  onClose: (key: PaneKey) => void;
}

const PLACEHOLDER_HINT: Record<Exclude<PaneKey, "browser" | "scorecard">, string> = {
  markdown: "AI 生成的简历、岗位对比、面试准备清单会以 Markdown 形式在这里预览。",
  editor: "在这里直接修改文档，改动会保存到本地工作区。",
  log: "AI 每一步做了什么、看了哪个页面、提交了哪些信息，都会记录在这里。",
};

export function Workbench({
  openPanes,
  activePane,
  suspended,
  scorecardTarget,
  tasks,
  onSelect,
  onClose,
  onOverlayChange,
}: WorkbenchProps & { onOverlayChange: (open: boolean) => void }) {
  const current = activePane ?? openPanes[0] ?? null;

  const renderPane = (key: PaneKey) => {
    if (key === "browser") {
      return <BrowserPanel active={current === "browser"} suspended={suspended} />;
    }
    if (key === "scorecard") {
      return <ScorecardPane target={scorecardTarget} active={current === "scorecard"} />;
    }
    const meta = PANE_BY_KEY[key];
    return (
      <div className="grid h-full place-items-center p-6">
        <Empty className="max-w-sm">
          <EmptyHeader>
            <EmptyMedia variant="icon">{meta.icon}</EmptyMedia>
            <EmptyTitle>{meta.label}</EmptyTitle>
            <EmptyDescription>{PLACEHOLDER_HINT[key]}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/*
       * 细标题栏：左边是 Agent 打开的标签页，没有标签时显示「工作台」；
       * 右边是后台任务角标。收起/展开在顶栏，这里不放第二个把手。
       */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        {openPanes.length === 0 ? (
          <span className="px-1 text-xs font-medium text-muted-foreground">工作台</span>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {openPanes.map((key) => {
              const meta = PANE_BY_KEY[key];
              const active = key === current;
              return (
                <div
                  key={key}
                  className={cn(
                    "group flex shrink-0 items-center gap-1 rounded-lg pr-1 pl-2 text-[var(--text-sm)] transition-colors",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50",
                  )}
                >
                  <button
                    type="button"
                    className="flex items-center gap-1.5 py-1"
                    onClick={() => onSelect(key)}
                  >
                    <span className="opacity-70">{meta.icon}</span>
                    {meta.label}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label={`关闭 ${meta.label}`}
                    onClick={() => onClose(key)}
                  >
                    <X />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        {tasks.length > 0 && <TasksBadge tasks={tasks} onOverlayChange={onOverlayChange} />}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {current === null ? (
          <div className="flex h-full items-center justify-center overflow-y-auto p-6">
            <Empty className="max-w-sm">
              <EmptyHeader>
                <EmptyMedia variant="icon">{PANES[0]?.icon}</EmptyMedia>
                <EmptyTitle>右栏由 Agent 使用</EmptyTitle>
                <EmptyDescription>
                  这里不需要你手动打开标签。对话中 Agent 需要给你看东西时，会自己把标签页打开在这里。
                </EmptyDescription>
              </EmptyHeader>
              <ul className="flex w-full flex-col gap-1 text-left">
                {PANES.map((pane) => (
                  <li
                    key={pane.key}
                    className="flex items-start gap-2.5 rounded-lg bg-muted/50 px-3 py-2"
                  >
                    <span className="mt-0.5 text-muted-foreground">{pane.icon}</span>
                    <div className="min-w-0">
                      <div className="text-[var(--text-sm)] font-medium text-foreground">
                        {pane.label}
                      </div>
                      <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {pane.hint}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Empty>
          </div>
        ) : (
          renderPane(current)
        )}
      </div>
    </div>
  );
}
