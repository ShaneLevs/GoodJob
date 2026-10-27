import { useEffect, useState } from "react";

import type { Application, Job } from "@shared/types";

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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export function ApplicationEditDialog({
  target,
  jobs,
  onClose,
  onSaved,
  onOverlayChange,
}: {
  target: Application | "new" | null;
  jobs: Job[];
  onClose: () => void;
  onSaved: () => void;
  onOverlayChange: (open: boolean) => void;
}) {
  const isNew = target === "new";
  const [jobId, setJobId] = useState("none");
  const [note, setNote] = useState("");
  const [hasOffer, setHasOffer] = useState(false);
  const [offer, setOffer] = useState({ salary: "", equity: "", note: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (target === null) return;
    setError(null);
    if (isNew) {
      setJobId("none");
      setNote("");
      setHasOffer(false);
      setOffer({ salary: "", equity: "", note: "" });
    } else {
      setJobId(target.jobId ?? "none");
      setNote(target.note);
      setHasOffer(target.offer !== null);
      setOffer({
        salary: target.offer?.salary ?? "",
        equity: target.offer?.equity ?? "",
        note: target.offer?.note ?? "",
      });
    }
  }, [target, isNew]);

  const submit = (): void => {
    setSaving(true);
    setError(null);
    const patch = {
      jobId: jobId === "none" ? null : jobId,
      note: note.trim(),
      offer: hasOffer ? { salary: offer.salary.trim(), equity: offer.equity.trim(), note: offer.note.trim() } : null,
    };
    const request = isNew
      ? window.goodjob.applications.create(patch)
      : window.goodjob.applications.update((target as Application).id, patch);
    void request
      .then(() => {
        onClose();
        onSaved();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setSaving(false));
  };

  const linkedJob = target !== null && target !== "new" && target.jobId !== null
    ? jobs.find((job) => job.id === target.jobId)
    : undefined;
  /** 关联的岗位已被删除：下拉里保留这个悬空选项，别让显示值凭空消失。 */
  const danglingJobId =
    target !== null && target !== "new" && target.jobId !== null && linkedJob === undefined
      ? target.jobId
      : null;

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isNew ? "新建投递" : "编辑投递"}</DialogTitle>
          <DialogDescription>
            状态推进用行菜单的「推进状态」（只顺流、不改写历史）；这里管关联岗位、备注和 Offer。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>岗位</Label>
            <Select value={jobId} onValueChange={setJobId} onOpenChange={onOverlayChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择岗位" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">（不关联）</SelectItem>
                {danglingJobId !== null && (
                  <SelectItem value={danglingJobId}>岗位已删除（悬空引用）</SelectItem>
                )}
                {jobs.map((job) => (
                  <SelectItem key={job.id} value={job.id}>
                    {job.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="app-note">备注</Label>
            <Textarea
              id="app-note"
              value={note}
              placeholder="如：官网投递 / 内推人 / 渠道备注"
              className="min-h-16 resize-none"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          <div className="grid gap-2 rounded-xl bg-muted/40 p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Switch checked={hasOffer} onCheckedChange={setHasOffer} />
              已拿到 Offer
            </label>
            {hasOffer && (
              <div className="grid gap-2">
                <Input
                  value={offer.salary}
                  placeholder="薪资，如：32k·16 薪"
                  onChange={(event) => setOffer((prev) => ({ ...prev, salary: event.target.value }))}
                />
                <Input
                  value={offer.equity}
                  placeholder="期权 / 签字费等"
                  onChange={(event) => setOffer((prev) => ({ ...prev, equity: event.target.value }))}
                />
                <Input
                  value={offer.note}
                  placeholder="其他条款备注（到岗时间、竞业…）"
                  onChange={(event) => setOffer((prev) => ({ ...prev, note: event.target.value }))}
                />
              </div>
            )}
          </div>
        </div>

        {error !== null && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={saving} onClick={submit}>
            {isNew ? "创建" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
