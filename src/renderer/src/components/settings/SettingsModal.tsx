import { useEffect, useState } from "react";

import { ArrowLeft, Bell, FileText, Globe, Info, Palette, Plug, Sparkles } from "lucide-react";

import type {
  AppearanceSettings,
  MarkdownSettings,
  ModelsConfig,
  UpdateState,
} from "@shared/types";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { AboutSettings } from "./AboutSettings";
import { AppearanceSettings as AppearanceSettingsPane } from "./AppearanceSettings";
import { BrowserAgentSettings } from "./BrowserAgentSettings";
import { MarkdownSettings as ResumeThemeSettingsPane } from "./MarkdownSettings";
import { ModelsSettings } from "./ModelsSettings";
import { NotifySettings } from "./NotifySettings";
import { SkillSettings } from "./SkillSettings";

export type SettingsSection =
  | "appearance"
  | "resumeTheme"
  | "models"
  | "skills"
  | "browser"
  | "notify"
  | "about";

/**
 * 设置分两组，全局通用（所有工作区共用一份配置）：
 * - 基础设置：只关乎这台机器上的界面本身。
 * - Agent 设置：决定 Agent 用什么模型、能做什么。
 */
const NAV_GROUPS: {
  label: string;
  items: { key: SettingsSection; label: string; icon: React.ReactNode }[];
}[] = [
  {
    label: "基础设置",
    items: [
      { key: "appearance", label: "外观", icon: <Palette /> },
      { key: "resumeTheme", label: "简历主题", icon: <FileText /> },
      { key: "about", label: "关于", icon: <Info /> },
    ],
  },
  {
    label: "Agent 设置",
    items: [
      { key: "models", label: "模型设置", icon: <Plug /> },
      { key: "skills", label: "Skill 管理", icon: <Sparkles /> },
      { key: "browser", label: "浏览器", icon: <Globe /> },
      { key: "notify", label: "通知", icon: <Bell /> },
    ],
  },
];

interface SettingsModalProps {
  open: boolean;
  models: ModelsConfig | null;
  appearance: AppearanceSettings;
  markdown: MarkdownSettings;
  /** 打开时落在哪一页：从对话区的模型菜单跳进来时直接看模型。 */
  initialSection?: SettingsSection;
  onClose: () => void;
  onSaved: (models: ModelsConfig) => void;
  onAppearanceChange: (patch: Partial<AppearanceSettings>) => void;
  onMarkdownChange: (patch: Partial<MarkdownSettings>) => void;
}

/**
 * 设置：左侧分区导航 + 右侧内容，铺满整个弹窗（无标题栏、无页脚）。
 * 「返回工作区」就是关闭，和以前的抽屉手感一致。
 */
export function SettingsModal({
  open,
  models,
  appearance,
  markdown,
  initialSection = "appearance",
  onClose,
  onSaved,
  onAppearanceChange,
  onMarkdownChange,
}: SettingsModalProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [update, setUpdate] = useState<UpdateState | null>(null);

  // 每次打开都回到调用方指定的分区：入口不同，落点也不同。
  useEffect(() => {
    if (open) setSection(initialSection);
  }, [open, initialSection]);

  // 导航上的小圆点：后台查到新版本时，即使没打开「关于」也能看见。
  useEffect(() => {
    void window.goodjob.update.getState().then(setUpdate);
    return window.goodjob.update.onState(setUpdate);
  }, []);

  const updateWaiting =
    update !== null &&
    (update.phase === "available" ||
      update.phase === "downloading" ||
      update.phase === "downloaded");

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
          <nav className="flex w-52 shrink-0 flex-col gap-3 overflow-y-auto border-r bg-muted/40 p-2">
            <Button variant="ghost" className="justify-start gap-2" onClick={onClose}>
              <ArrowLeft />
              返回工作区
            </Button>

            {NAV_GROUPS.map((group) => (
              <div key={group.label} className="flex flex-col gap-0.5">
                <p className="px-2 pb-1 text-xs text-muted-foreground">{group.label}</p>
                {group.items.map((item) => (
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
                    {item.key === "about" && updateWaiting && (
                      <span
                        className="ml-auto size-1.5 rounded-full bg-primary"
                        aria-label="有新版本"
                      />
                    )}
                  </Button>
                ))}
              </div>
            ))}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            {section === "appearance" ? (
              <AppearanceSettingsPane appearance={appearance} onChange={onAppearanceChange} />
            ) : section === "resumeTheme" ? (
              <ResumeThemeSettingsPane settings={markdown} onChange={onMarkdownChange} />
            ) : section === "about" ? (
              <AboutSettings />
            ) : section === "notify" ? (
              <NotifySettings />
            ) : section === "browser" ? (
              <BrowserAgentSettings />
            ) : section === "skills" ? (
              <SkillSettings />
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
