import { LoaderCircle } from "lucide-react";

import type { ModelSelection, ModelsConfig } from "@shared/types";

/** 所有模块页从 App 拿到的公共 props：模型选择与浮层上报。 */
export interface ModulePageProps {
  models: ModelsConfig | null;
  onSelectModel: (selection: ModelSelection) => void;
  onOpenModelSettings: () => void;
  /** 下拉浮层打开时，原生浏览器视图要让位。 */
  onOverlayChange: (open: boolean) => void;
  /** 把浏览器面板打开（批准浏览器写动作后自动调，让用户看见 Agent 在操作什么）。 */
  onOpenBrowser: () => void;
}

export function ModuleLoadingCard() {
  return (
    <div className="flex h-full items-center justify-center rounded-2xl bg-card shadow-sm">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        正在加载…
      </div>
    </div>
  );
}
