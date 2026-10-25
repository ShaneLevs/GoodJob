import { CircleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 未配置模型时的统一引导（硬约束 4：不伪造回复）。
 * 需要 Agent / 后台任务的动作先过这道门，把用户送去模型设置，
 * 而不是让按钮静默失败或假装成功。
 */
export function ModelGateDialog({
  open,
  onClose,
  onOpenSettings,
  onOverlayChange,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  /** 浮层开合要让位内嵌浏览器视图（硬约束 5）。 */
  onOverlayChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CircleAlert className="size-4 text-warning" />
            还没有可用的模型
          </DialogTitle>
          <DialogDescription>
            这个操作需要 AI 模型（llm_not_configured）。先在设置里添加一个供应商、
            填好 API Key 并启用至少一个模型，再回来继续。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
          >
            打开模型设置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
