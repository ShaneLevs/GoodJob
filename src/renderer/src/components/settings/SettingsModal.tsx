import { useEffect, useState } from "react";

import { ArrowLeft, Bell, Globe, Palette, Plug } from "lucide-react";

import type { AppearanceSettings, ModelsConfig } from "@shared/types";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { AppearanceSettings as AppearanceSettingsPane } from "./AppearanceSettings";
import { BrowserAgentSettings } from "./BrowserAgentSettings";
import { ModelsSettings } from "./ModelsSettings";
import { NotifySettings } from "./NotifySettings";

export type SettingsSection = "appearance" | "models" | "notify" | "browser";

const NAV: { key: SettingsSection; label: string; icon: React.ReactNode }[] = [
  { key: "appearance", label: "外观", icon: <Palette /> },
  { key: "models", label: "模型设置", icon: <Plug /> },
  { key: "notify", label: "通知", icon: <Bell /> },
  { key: "browser", label: "浏览器", icon: <Globe /> },
];

interface SettingsModalProps {
  open: boolean;
  models: ModelsConfig | null;
  appearance: AppearanceSettings;
  /** 左下角显示当前工作区，和主界面一致。 */
  workspaceName: string;
  /** 打开时落在哪一页：从对话区的模型菜单跳进来时直接看模型。 */
  initialSection?: SettingsSection;
  onClose: () => void;
  onSaved: (models: ModelsConfig) => void;
  onAppearanceChange: (patch: Partial<AppearanceSettings>) => void;
}

/**
 * 设置：左侧分区导航 + 右侧内容，铺满整个弹窗（无标题栏、无页脚）。
 * 「返回工作区」就是关闭，和以前的抽屉手感一致。
 */
export function SettingsModal({
  open,
  models,
  appearance,
  workspaceName,
  initialSection = "appearance",
  onClose,
  onSaved,
  onAppearanceChange,
}: SettingsModalProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);

  // 每次打开都回到调用方指定的分区：入口不同，落点也不同。
  useEffect(() => {
    if (open) setSection(initialSection);
  }, [open, initialSection]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0 sm:max-w-4xl"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">设置</DialogTitle>

        <div className="flex h-[min(86vh,720px)] min-h-[440px]">
          <nav className="flex w-52 shrink-0 flex-col border-r bg-muted/40 p-2">
            <Button variant="ghost" className="justify-start gap-2" onClick={onClose}>
              <ArrowLeft />
              返回工作区
            </Button>

            <p className="px-2 pt-4 pb-1 text-xs text-muted-foreground">基础设置</p>
            <div className="flex flex-col gap-0.5">
              {NAV.map((item) => (
                <Button
                  key={item.key}
                  variant="ghost"
                  className={cn(
                    "justify-start gap-2 font-normal text-muted-foreground",
                    section === item.key && "bg-accent font-medium text-accent-foreground",
                  )}
                  onClick={() => setSection(item.key)}
                >
                  {item.icon}
                  {item.label}
                </Button>
              ))}
            </div>

            <div className="mt-auto flex min-w-0 items-center gap-2 px-2 pt-2 pb-1">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-[11px] font-semibold">
                {workspaceName.trim().slice(0, 1) || "G"}
              </span>
              <span className="truncate text-xs text-muted-foreground">{workspaceName}</span>
            </div>
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            {section === "appearance" ? (
              <AppearanceSettingsPane appearance={appearance} onChange={onAppearanceChange} />
            ) : section === "notify" ? (
              <NotifySettings />
            ) : section === "browser" ? (
              <BrowserAgentSettings />
            ) : models === null ? (
              <div className="p-8 text-sm text-muted-foreground">正在读取模型…</div>
            ) : (
              <ModelsSettings models={models} onSaved={onSaved} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
