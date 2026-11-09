import { CircleAlert, LoaderCircle, Mic, Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { useVoiceInterview } from "./use-voice-interview";

const CONFIG_ERRORS = new Set([
  "voice_not_configured",
  "voice_sdk_unavailable",
  "voice_auth_failed",
]);

/**
 * 语音面试的状态条（贴在输入框上方）：连接中 / 朗读中 / 聆听中 / 识别中 / 出错，
 * 并把实时识别文本显示出来。任何一步失败都能退回打字——输入框一直在。
 */
export function VoiceInterviewBar({
  voice,
  onOpenSettings,
}: {
  voice: ReturnType<typeof useVoiceInterview>;
  onOpenSettings: () => void;
}) {
  const { state, notice } = voice;
  const phase = state.phase;

  const tone =
    phase === "error"
      ? "border-destructive/30 bg-destructive/5"
      : phase === "listening"
        ? "border-primary/30 bg-primary/5"
        : "border-border/60 bg-muted/30";

  return (
    <div className={cn("mb-2 rounded-xl border px-3 py-2", tone)}>
      <div className="flex items-center gap-2">
        <StatusIcon phase={phase} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{statusTitle(phase)}</p>
          {phase === "speaking" && state.speech !== null && (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{state.speech}</p>
          )}
          {phase === "listening" && state.interim !== "" && (
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
              {state.interim}
            </p>
          )}
          {phase === "listening" && state.interim === "" && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              直接说你的回答，说完点右边的「完成回答」。
            </p>
          )}
          {phase === "error" && state.error !== null && (
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-destructive">
              {state.error}
            </p>
          )}
          {phase !== "error" && phase !== "speaking" && phase !== "listening" && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              语音面试 · 面试官的提问会自动朗读；也可以随时在下面打字。
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {phase === "idle" && (
            <>
              <Button type="button" size="sm" variant="outline" onClick={voice.startListening}>
                <Mic />
                开始回答
              </Button>
              {voice.needsSettings && (
                <Button type="button" size="sm" variant="ghost" onClick={onOpenSettings}>
                  去设置
                </Button>
              )}
            </>
          )}
          {phase === "speaking" && (
            <Button type="button" size="sm" variant="ghost" onClick={voice.stopSpeaking}>
              跳过朗读
            </Button>
          )}
          {phase === "listening" && (
            <Button type="button" size="sm" onClick={voice.finishAnswer}>
              完成回答
            </Button>
          )}
          {(phase === "connecting" || phase === "recognizing") && (
            <span className="text-[11px] text-muted-foreground">
              {phase === "connecting" ? "约 1–3 秒" : "收尾中"}
            </span>
          )}
          {phase === "error" && (
            <>
              <Button type="button" size="sm" variant="outline" onClick={voice.startListening}>
                重试
              </Button>
              {(state.errorCode === null || CONFIG_ERRORS.has(state.errorCode)) && (
                <Button type="button" size="sm" variant="ghost" onClick={onOpenSettings}>
                  去设置
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {notice !== null && phase !== "error" && (
        <p className="mt-2 border-t border-border/50 pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}

function StatusIcon({ phase }: { phase: ReturnType<typeof useVoiceInterview>["state"]["phase"] }) {
  if (phase === "connecting" || phase === "recognizing") {
    return <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />;
  }
  if (phase === "error") {
    return <CircleAlert className="size-4 shrink-0 text-destructive" />;
  }
  if (phase === "speaking") {
    return <Volume2 className="size-4 shrink-0 text-muted-foreground" />;
  }
  if (phase === "listening") {
    return <Mic className="size-4 shrink-0 animate-pulse text-primary" />;
  }
  return <Mic className="size-4 shrink-0 text-muted-foreground" />;
}

function statusTitle(phase: ReturnType<typeof useVoiceInterview>["state"]["phase"]): string {
  switch (phase) {
    case "connecting":
      return "正在连接语音服务…";
    case "speaking":
      return "面试官正在说话";
    case "listening":
      return "正在聆听你的回答";
    case "recognizing":
      return "正在识别最后一句…";
    case "error":
      return "语音这一步没成功";
    default:
      return "语音面试已就绪";
  }
}
