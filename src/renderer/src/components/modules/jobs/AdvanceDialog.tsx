import { useEffect, useState } from "react";

import type { Job, PipelineConfig } from "@shared/types";

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

/** 标记 / 推进投递状态：只能顺流（选当前阶段之后的阶段），时间自动取当前时刻。 */
export function AdvanceDialog({
  job,
  pipeline,
  stageOf,
  onClose,
  onSaved,
  onOverlayChange,
}: {
  job: Job | null;
  pipeline: PipelineConfig | null;
  stageOf: (job: Job) => { name: string; index: number; final: boolean; at: string | null };
  onClose: () => void;
  onSaved: () => void;
  onOverlayChange: (open: boolean) => void;
}) {
  const stages = pipeline?.stages ?? [];
  const current = job === null ? null : stageOf(job);
  const isNew = job !== null && job.timeline.length === 0;
  const nextStages =
    current === null
      ? []
      : isNew
        ? stages
        : current.index < 0
          ? []
          : stages.slice(current.index + 1);
  const [stage, setStage] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (job === null) return;
    setError(null);
    setNote("");
    setStage(nextStages[0]?.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换目标行时重置。
  }, [job]);

  const submit = (): void => {
    if (job === null || stage === "") return;
    setSaving(true);
    setError(null);
    void window.goodjob.jobs
      .advance(job.id, stage, note.trim())
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
      open={job !== null}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{isNew ? "标记投递" : "推进状态"}</DialogTitle>
          <DialogDescription>
            {current === null
              ? ""
              : isNew
                ? "还没投递，选择第一个阶段。"
                : current.index < 0
                  ? `当前阶段「${current.name}」不在流水线里，去「流水线」设置里补上。`
                  : `当前是「${current.name}」${current.final ? "（终态，不再顺流）" : ""}。`}
          </DialogDescription>
        </DialogHeader>

        {current !== null && current.final ? (
          <p className="text-sm text-muted-foreground">已在终态，不再顺流推进。</p>
        ) : !isNew && current !== null && current.index < 0 ? (
          <p className="text-sm text-muted-foreground">
            当前阶段不在流水线里；补进流水线后才能继续顺流推进。
          </p>
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
            {isNew ? "标记" : "推进"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
