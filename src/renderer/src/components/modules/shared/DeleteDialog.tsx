import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface DeleteDialogProps {
  open: boolean;
  title: string;
  description: string;
  onClose: () => void;
  /** 删除成功后再关闭；失败时弹窗保持打开。 */
  onConfirm: () => Promise<void>;
  onOverlayChange: (open: boolean) => void;
}

/** 三个模块共用的删除确认：等删除成功再收弹窗，失败保持打开。 */
export function DeleteDialog({
  open,
  title,
  description,
  onClose,
  onConfirm,
  onOverlayChange,
}: DeleteDialogProps) {
  const [saving, setSaving] = useState(false);

  // 关闭时清掉 loading：组件常驻，否则下一次打开会沿用上一次的 disabled 状态。
  useEffect(() => {
    if (!open) setSaving(false);
  }, [open]);

  const remove = (): void => {
    setSaving(true);
    void onConfirm()
      .then(() => onClose())
      .catch(() => setSaving(false));
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            disabled={saving}
            onClick={(event) => {
              // 阻止默认关闭：等 remove 成功后再由父级收弹窗。
              event.preventDefault();
              remove();
            }}
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
