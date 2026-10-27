import { useEffect, useState } from "react";

import type { Application, PipelineConfig } from "@shared/types";

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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** 推进状态：只能顺流（选当前阶段之后的阶段），时间自动取当前时刻。 */
export function AdvanceDialog({
  app,
  pipeline,
  stageOf,
  onClose,
  onSaved,
  onOverlayChange,
}: {
  app: Application | null;
  pipeline: PipelineConfig | null;
  stageOf: (app: Application) => { name: string; index: number; final: boolean; at: string | null };
  onClose: () => void;
  onSaved: () => void;
  onOverlayChange: (open: boolean) => void;
}) {
  const stages = pipeline?.stages ?? [];
  const current = app === null ? null : stageOf(app);
  const nextStages =
    current === null
      ? []
      : current.index < 0
        ? stages
        : stages.slice(current.index + 1);
  const [stage, setStage] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (app === null) return;
    setError(null);
    setNote("");
    setStage(nextStages[0]?.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换目标行时重置。
  }, [app]);

  const submit = (): void => {
    if (app === null || stage === "") return;
    setSaving(true);
    setError(null);
    const entry = { stage, at: new Date().toISOString(), note: note.trim() };
    void window.goodjob.applications
      .update(app.id, { timeline: [...app.timeline, entry] })
      .then(() => {
        onClose();
        onSaved();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open={app !== null}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>推进状态</DialogTitle>
          <DialogDescription>
            {current === null
              ? ""
              : current.index < 0
                ? "还没有状态，选择第一个阶段。"
                : `当前是「${current.name}」${current.final ? "（终态，不再顺流）" : ""}。`}
          </DialogDescription>
        </DialogHeader>

        {current !== null && current.final ? (
          <p className="text-sm text-muted-foreground">已在终态；如需修正请用「编辑」改时间线。</p>
        ) : nextStages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            流水线里没有更后面的阶段了；要加阶段去「流水线」设置里维护。
          </p>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>推进到</Label>
              <Select value={stage} onValueChange={setStage} onOpenChange={onOverlayChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择阶段" />
                </SelectTrigger>
                <SelectContent>
                  {nextStages.map((item) => (
                    <SelectItem key={item.name} value={item.name}>
                      {item.name}
                      {item.final ? "（终态）" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="advance-note">备注</Label>
              <Input
                id="advance-note"
                value={note}
                placeholder="如：HR 面 / 约了下周三 / 官网投的"
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          </div>
        )}

        {error !== null && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={saving || stage === ""} onClick={submit}>
            推进
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
