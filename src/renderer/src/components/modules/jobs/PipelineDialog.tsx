import { useEffect, useState } from "react";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import type { PipelineConfig, PipelineStage } from "@shared/types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

/** 流水线设置：阶段增删 / 改名 / 排序 / 终态标记（工作区级，存 pipeline.json）。 */
export function PipelineDialog({
  open,
  config,
  onClose,
  onSaved,
  onOverlayChange,
}: {
  open: boolean;
  config: PipelineConfig | null;
  onClose: () => void;
  onSaved: (config: PipelineConfig) => void;
  onOverlayChange: (open: boolean) => void;
}) {
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || config === null) return;
    setError(null);
    setStages(config.stages.map((stage) => ({ ...stage })));
  }, [open, config]);

  const patch = (index: number, changes: Partial<PipelineStage>): void => {
    setStages((prev) => prev.map((stage, i) => (i === index ? { ...stage, ...changes } : stage)));
  };

  const move = (index: number, delta: -1 | 1): void => {
    setStages((prev) => {
      const to = index + delta;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const left = next[index];
      const right = next[to];
      if (left === undefined || right === undefined) return prev;
      next[index] = right;
      next[to] = left;
      return next;
    });
  };

  const save = (): void => {
    setSaving(true);
    setError(null);
    void window.goodjob.pipeline
      .save({ stages })
      .then((saved) => {
        onSaved(saved);
        onClose();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>投递状态流水线</DialogTitle>
          <DialogDescription>
            工作区级配置：阶段有序、名字唯一，至少一个终态；不同公司的二面 / 三面 / 四面按需自己加。
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-80 gap-1.5 overflow-y-auto pr-1">
          {stages.map((stage, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                value={stage.name}
                aria-label={`阶段 ${index + 1} 名称`}
                className="h-8"
                onChange={(event) => patch(index, { name: event.target.value })}
              />
              <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <Switch
                  checked={stage.final}
                  aria-label={`「${stage.name}」是否终态`}
                  onCheckedChange={(checked) => patch(index, { final: checked })}
                />
                终态
              </label>
              <div className="flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="上移"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="下移"
                  disabled={index === stages.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  aria-label={`删除阶段「${stage.name}」`}
                  disabled={stages.length <= 1}
                  onClick={() => setStages((prev) => prev.filter((_, i) => i !== index))}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setStages((prev) => [...prev, { name: "", final: false }])}
          >
            <Plus />
            添加阶段
          </Button>
        </div>

        {error !== null && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={saving} onClick={save}>
            保存流水线
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
