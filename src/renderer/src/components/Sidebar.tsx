import { Check, ChevronsUpDown, FileText, Settings } from "lucide-react";

import type { WorkspaceInfo } from "@shared/types";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface SidebarProps {
  workspaces: WorkspaceInfo[];
  currentWorkspace: WorkspaceInfo | null;
  onOpenSettings: () => void;
  onSwitchWorkspace: (id: string) => void;
}

/** 主菜单：暂时只有一项，后续文档类入口都挂在这里。 */
const MENU = [{ key: "resume", label: "个人简历" }];

export function Sidebar({
  workspaces,
  currentWorkspace,
  onOpenSettings,
  onSwitchWorkspace,
}: SidebarProps) {
  return (
    <aside className="flex h-full w-full flex-col gap-1 px-3 pb-2">
      {/* 左栏平铺在窗口底色上：没有卡片、没有描边，收起/展开交给顶栏。 */}
      <div className="flex h-9 shrink-0 items-center px-2">
        <span className="text-[19px] leading-none font-semibold tracking-tight">GoodJob</span>
      </div>

      <p className="px-2 pt-1 pb-1 text-[calc(var(--text-xs)-1px)] font-medium tracking-wide text-muted-foreground">
        工作区
      </p>

      <nav className="flex flex-col gap-0.5">
        {MENU.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-current="page"
            className="flex w-full items-center gap-2 rounded-lg bg-foreground/[0.07] px-2 py-1.5 text-left text-[var(--text-sm)] font-medium text-accent-foreground transition-colors"
          >
            <FileText className="size-4 shrink-0 opacity-70" />
            {item.label}
          </button>
        ))}
      </nav>

      <div className="flex-1" />

      {/* 左下角：工作区切换占满整行，设置贴在最右。 */}
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="h-8 min-w-0 flex-1 justify-between gap-2 px-2 font-normal text-muted-foreground"
              aria-label="切换工作区"
            >
              <span className="truncate">{currentWorkspace?.name ?? "工作区"}</span>
              <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
            <DropdownMenuLabel className="text-xs text-muted-foreground">工作区</DropdownMenuLabel>
            {workspaces.map((workspace) => {
              const active = workspace.id === currentWorkspace?.id;
              return (
                <DropdownMenuItem
                  key={workspace.id}
                  onSelect={() => {
                    if (!active) onSwitchWorkspace(workspace.id);
                  }}
                >
                  <span className="truncate">{workspace.name}</span>
                  <Check className={cn("ml-auto size-4", active ? "opacity-100" : "opacity-0")} />
                </DropdownMenuItem>
              );
            })}
            {workspaces.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">还没有工作区</div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground"
          aria-label="设置"
          onClick={onOpenSettings}
        >
          <Settings />
        </Button>
      </div>
    </aside>
  );
}
