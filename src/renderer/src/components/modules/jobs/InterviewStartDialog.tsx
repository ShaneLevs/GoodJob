import { useEffect, useState } from "react";

import { MessageSquareText, Mic, Users } from "lucide-react";

import type { InterviewMode, Job } from "@shared/types";

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
 * 发起模拟面试：选轮次与模式（文本 / 语音）。
 * 语音模式要先把「设置 → Agent 设置 → 语音模型」的 TTS 与 ASR 都配好；
 * 没配好时给出直达设置的入口，不把按钮置灰（用户得先知道差什么）。
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
  onOpenVoiceSettings,
  onStarted,
}: {
  job: Job | null;
  hasTailored: boolean;
  onClose: () => void;
  onOverlayChange: (open: boolean) => void;
  requireModel: (action: () => void) => void;
  onOpenJobWorkbench: (jobId: string) => void;
  onEditJob: (jobId: string) => void;
  onOpenVoiceSettings: () => void;
  onStarted: (interviewId: string) => void;
}) {
  const [rounds, setRounds] = useState("5");
  const [mode, setMode] = useState<InterviewMode>("text");
  const [voiceReady, setVoiceReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (job === null) return;
    setRounds("5");
    setMode("text");
    setError(null);
    setBusy(false);
  }, [job]);

  // 语音可用性是全局设置：每次打开都重新读，用户刚去设置里填完 Key 回来就能选。
  useEffect(() => {
    if (job === null) return;
    let alive = true;
    setVoiceReady(null);
    void window.goodjob.voice
      .getSettings()
      .then((settings) => {
        if (alive) setVoiceReady(settings.ready.interview);
      })
      .catch(() => {
        if (alive) setVoiceReady(false);
      });
    return () => {
      alive = false;
    };
  }, [job]);

  const jdMissing = job !== null && job.jd.trim() === "";
  const ready = hasTailored && !jdMissing;

  const start = (): void => {
    if (job === null) return;
    if (mode === "voice" && voiceReady !== true) {
      setError("语音模型还没配置完：在 设置 → Agent 设置 → 语音模型 里填好 TTS 与 ASR 的 API Key。");
      return;
    }
    requireModel(() => {
      setBusy(true);
      setError(null);
      void window.goodjob.interviews
        .create({ jobId: job.id, rounds: Number(rounds), mode })
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
            <ModeButton
              selected={mode === "text"}
              icon={<MessageSquareText className="size-4" />}
              title="文本面试"
              hint="打字问答"
              onClick={() => setMode("text")}
            />
            <ModeButton
              selected={mode === "voice"}
              icon={<Mic className="size-4" />}
              title="语音面试"
              hint={
                voiceReady === null
                  ? "检查语音配置…"
                  : voiceReady
                    ? "面试官朗读 · 你说回答"
                    : "语音模型未配置"
              }
              onClick={() => setMode("voice")}
            />
          </div>

          {mode === "voice" && voiceReady === false && (
            <div className="flex items-start justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5">
              <p className="text-xs leading-relaxed text-warning">
                语音面试需要 TTS（朗读提问）与 ASR（识别回答）两份配置。配好后回来重新发起即可。
              </p>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => {
                  onClose();
                  onOpenVoiceSettings();
                }}
              >
                去设置
              </Button>
            </div>
          )}

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

function ModeButton({
  selected,
  icon,
  title,
  hint,
  onClick,
}: {
  selected: boolean;
  icon: React.ReactNode;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={
        selected
          ? "flex flex-col items-start gap-1 rounded-xl border border-ring bg-muted/60 p-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
          : "flex flex-col items-start gap-1 rounded-xl border border-dashed border-border/60 p-3 text-left text-muted-foreground outline-none hover:bg-muted/30 focus-visible:ring-[3px] focus-visible:ring-ring/30"
      }
    >
      {icon}
      <span className={selected ? "text-sm font-medium text-foreground" : "text-sm font-medium"}>
        {title}
      </span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  );
}
