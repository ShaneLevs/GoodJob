import { Check, ChevronsUpDown, Settings } from "lucide-react";

import type { WorkspaceInfo } from "@shared/types";

import beeUrl from "@/assets/bee.svg";
import { MODULES, type ModuleKey } from "@/config/modules";
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
  activeModule: ModuleKey;
  onSelectModule: (key: ModuleKey) => void;
  workspaces: WorkspaceInfo[];
  currentWorkspace: WorkspaceInfo | null;
  onOpenSettings: () => void;
  onSwitchWorkspace: (id: string) => void;
}

export function Sidebar({
  activeModule,
  onSelectModule,
  workspaces,
  currentWorkspace,
  onOpenSettings,
  onSwitchWorkspace,
}: SidebarProps) {
  return (
    <aside className="flex h-full w-full select-none flex-col px-3 pb-2 pt-1">
      {/* 左栏平铺在窗口底色上：没有卡片、没有描边，收起/展开交给顶栏。 */}
      <div className="flex h-11 shrink-0 items-center gap-2 px-2">
        <img src={beeUrl} alt="" draggable={false} className="size-6 shrink-0" />
        <span className="text-[19px] leading-none font-semibold tracking-tight">GoodJob</span>
      </div>

      {/* 模块菜单：结构与 shadcn sidebar 的 menu-button 一致（h-8 / rounded-xl /
      	data-active 加底色和 medium），底色按项目约定用 foreground 透明度——
      	--sidebar-accent 在 shell 底色上不可见。 */}
      <nav className="flex flex-col gap-0.5">
        {MODULES.map((item) => {
          const active = item.key === activeModule;
          return (
            <button
              key={item.key}
              type="button"
              aria-current={active ? "page" : undefined}
              data-active={active || undefined}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left text-sm whitespace-nowrap transition-colors outline-none",
                "[&_svg]:size-4 [&_svg]:shrink-0 [&>span]:truncate",
                "focus-visible:ring-[3px] focus-visible:ring-ring/30",
                active
                  ? "bg-foreground/[0.07] font-medium text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground active:bg-foreground/[0.045]",
              )}
              onClick={() => onSelectModule(item.key)}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.planned && (
                <span className="ml-auto rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] leading-none font-medium tracking-wide text-muted-foreground">
                  {item.planned}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* 左下角：工作区切换占满整行，设置贴在最右。 */}
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="h-8 min-w-0 flex-1 justify-between gap-2 rounded-xl px-2.5 font-normal text-muted-foreground"
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
