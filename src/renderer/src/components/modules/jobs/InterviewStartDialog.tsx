import { useEffect, useState } from "react";

import { MessageSquareText, Mic, Users } from "lucide-react";

import type { Job } from "@shared/types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * 发起模拟面试（P3 M1）：选轮次与模式。文本可用；语音置灰提示（M2 等厂商清单）。
 * 前置校验在弹窗里给引导：无定制稿 → 去二级页生成；无 JD → 去编辑补上。
 * 真正的发起过模型门（建记录本身不调模型，但进场第一步就是面试官开始提问）。
 */
export function InterviewStartDialog({
  job,
  hasTailored,
  onClose,
  onOverlayChange,
  requireModel,
  onOpenJobWorkbench,
  onEditJob,
  onStarted,
}: {
  job: Job | null;
  hasTailored: boolean;
  onClose: () => void;
  onOverlayChange: (open: boolean) => void;
  requireModel: (action: () => void) => void;
  onOpenJobWorkbench: (jobId: string) => void;
  onEditJob: (jobId: string) => void;
  onStarted: (interviewId: string) => void;
}) {
  const [rounds, setRounds] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (job === null) return;
    setRounds("5");
    setError(null);
    setBusy(false);
  }, [job]);

  const jdMissing = job !== null && job.jd.trim() === "";
  const ready = hasTailored && !jdMissing;

  const start = (): void => {
    if (job === null) return;
    requireModel(() => {
      setBusy(true);
      setError(null);
      void window.goodjob.interviews
        .create({ jobId: job.id, rounds: Number(rounds), mode: "text" })
        .then((interview) => {
          onClose();
          onStarted(interview.id);
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          setBusy(false);
        });
    });
  };

  return (
    <Dialog
      open={job !== null}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <DialogContent className="flex max-h-[86vh] flex-col gap-4 overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle>模拟面试{job !== null ? ` · ${job.title}` : ""}</DialogTitle>
          <DialogDescription>
            面试官围绕这个岗位的 JD 与定制简历追问式提问；结束后出总评与改进建议。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 overflow-y-auto pr-1">
          {job !== null && !hasTailored && (
            <div className="flex items-start justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5">
              <p className="text-xs leading-relaxed text-warning">
                面试以定制简历为口径，这个岗位还没有定制稿。
              </p>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => {
                  onClose();
                  onOpenJobWorkbench(job.id);
                }}
              >
                去生成
              </Button>
            </div>
          )}
          {job !== null && jdMissing && (
            <div className="flex items-start justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5">
              <p className="text-xs leading-relaxed text-warning">
                这个岗位还没有 JD，面试官提问会没有依据。
              </p>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => onEditJob(job.id)}
              >
                去补 JD
              </Button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              aria-pressed="true"
              className="flex flex-col items-start gap-1 rounded-xl border border-ring bg-muted/60 p-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
            >
              <MessageSquareText className="size-4" />
              <span className="text-sm font-medium">文本面试</span>
              <span className="text-xs text-muted-foreground">打字问答</span>
            </button>
            <button
              type="button"
              disabled
              title="待接入语音供应商"
              className="flex flex-col items-start gap-1 rounded-xl border border-dashed border-border/60 p-3 text-left opacity-60"
            >
              <Mic className="size-4" />
              <span className="text-sm font-medium">语音面试</span>
              <span className="text-xs text-muted-foreground">待接入语音供应商</span>
            </button>
          </div>

          <div className="grid gap-1.5">
            <Label>轮次</Label>
            <Select
              value={rounds}
              onValueChange={setRounds}
              onOpenChange={onOverlayChange}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["3", "5", "8", "10"].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value} 轮
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              每轮 = 1 个主问题 + 0~2 个追问（追问不计入轮次）；轮次走完自动出总评，也可随时提前结束。
            </p>
          </div>
        </div>

        {error !== null && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!ready || busy} onClick={start}>
            <Users />
            开始面试
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
