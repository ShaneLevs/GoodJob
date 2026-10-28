import { useCallback, useEffect, useMemo, useState } from "react";

import type { UIMessage } from "ai";
import {
  CircleAlert,
  CircleCheck,
  Lightbulb,
  LoaderCircle,
  Trash2,
  Users,
} from "lucide-react";

import type { Interview, Job } from "@shared/types";

import { useConversationInitial, useModuleChat } from "@/components/chat/use-module-chat";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { DocumentPreview } from "@/components/document/DocumentPreview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";

import { ModelGateDialog } from "../shared/ModelGateDialog";
import { ModuleLoadingCard, type ModulePageProps } from "../shared/module-page";
import { useDomainChange } from "../shared/use-domain-change";
import { formatTime } from "@/lib/format";

const LIST_MIN_WIDTH = 264;
const CHAT_MIN_WIDTH = 380;
const REVIEW_MIN_WIDTH = 300;

/** 进入一场还没开始对话的面试时，自动发给面试官的开场指令（机制同二级页的 autoPrompt）。 */
const INTERVIEW_OPENING_PROMPT =
  "（面试开始）请先用工具读取这个岗位的 JD 与定制简历，然后直接开始第 1 轮提问。";
/** 「结束并出总评」按钮发给面试官的指令。 */
const INTERVIEW_FINISH_PROMPT =
  "（我选择提前结束）请立即收束这场面试：调用 interview_submit_review 生成本场总评并保存，然后在回复里给出完整总评。";

export interface InterviewPageProps extends ModulePageProps {
  /** 从岗位页发起后的一次性定位：进入时选中这场面试（用完即清）。 */
  focusId: string | null;
  onFocusConsumed: () => void;
}

/**
 * 「面试」模块页（P3 M1 文本模拟面试）：
 * 左内容卡 = 面试列表（进行中置顶），中间 = 当前面试会话（key = `interview:<id>`，
 * 轮次进度 + 结束并出总评），右侧 = 结束后的总评卡（总评 Markdown + 逐轮时间线）。
 * 面试从岗位页发起；这里不提供新建入口。
 */
export function InterviewPage({
  models,
  onSelectModel,
  onOpenModelSettings,
  onOverlayChange,
  focusId,
  onFocusConsumed,
}: InterviewPageProps) {
  const [interviews, setInterviews] = useState<Interview[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Interview | null>(null);
  const [gateOpen, setGateOpen] = useState(false);

  const reload = useCallback((): void => {
    setError(null);
    void window.goodjob.interviews
      .list()
      .then(setInterviews)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, []);

  useEffect(() => reload(), [reload]);
  // 面试记录由面试官 Agent 在会话里写回：写完就刷新轮次与状态。
  useDomainChange(["interviews"], reload);

  useEffect(() => {
    void window.goodjob.jobs.list().then(setJobs).catch(() => setJobs([]));
  }, []);

  // 岗位页发起后的定位：选中目标面试并立刻消费掉（避免下次进入又跳回）。
  useEffect(() => {
    if (focusId === null) return;
    onFocusConsumed();
    setSelectedId(focusId);
  }, [focusId, onFocusConsumed]);

  // 列表顺序：进行中的置顶（新的在前），已结束按时间倒序。
  const ordered = useMemo(() => {
    if (interviews === null) return null;
    const byCreatedDesc = (a: Interview, b: Interview): number =>
      b.createdAt.localeCompare(a.createdAt);
    const running = interviews
      .filter((item) => item.status === "running")
      .sort(byCreatedDesc);
    const finished = interviews
      .filter((item) => item.status === "finished")
      .sort(byCreatedDesc);
    return [...running, ...finished];
  }, [interviews]);

  // 选中项被删掉（或还没有选中）时落到列表头部；用户的手动选择保持不变。
  useEffect(() => {
    if (ordered === null) return;
    setSelectedId(
      (prev) =>
        (prev !== null && ordered.some((item) => item.id === prev) ? prev : ordered[0]?.id) ??
        null,
    );
  }, [ordered]);

  const selected = ordered?.find((item) => item.id === selectedId) ?? null;
  const jobOf = useCallback(
    (jobId: string): Job | undefined => jobs.find((item) => item.id === jobId),
    [jobs],
  );

  const modelReady = models?.activeModel?.ready === true;

  const removeInterview = (interview: Interview): void => {
    void window.goodjob.interviews
      .remove(interview.id)
      .then(() => {
        setDeleting(null);
        reload();
      })
      .catch(() => setDeleting(null));
  };

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel id="interview-list" minSize={LIST_MIN_WIDTH} defaultSize="26%">
        <div className="flex h-full flex-col overflow-hidden rounded-2xl bg-card shadow-sm">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
            <span className="text-sm font-medium">模拟面试</span>
            {interviews !== null && (
              <span className="text-xs text-muted-foreground">{interviews.length}</span>
            )}
            {error !== null && (
              <span className="min-w-0 flex-1 truncate text-right text-xs text-destructive" title={error}>
                {error}
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {ordered === null ? (
              <div className="grid h-full place-items-center text-sm text-muted-foreground">
                正在加载…
              </div>
            ) : ordered.length === 0 ? (
              <div className="grid h-full place-items-center p-6">
                <Empty className="max-w-xs">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Users />
                    </EmptyMedia>
                    <EmptyTitle>还没有模拟面试</EmptyTitle>
                    <EmptyDescription>
                      去岗位页，在岗位的行操作里点「模拟面试」发起一场。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : (
              ordered.map((interview) => (
                <InterviewRow
                  key={interview.id}
                  interview={interview}
                  job={jobOf(interview.jobId)}
                  selected={interview.id === selectedId}
                  onSelect={() => setSelectedId(interview.id)}
                  onDelete={() => setDeleting(interview)}
                />
              ))
            )}
          </div>
        </div>
      </ResizablePanel>
      {/* 8px 间隙里的一条可拖拽细线：既是分隔提示，也是拖拽热区。 */}
      <ResizableHandle className="mx-1 w-1 justify-self-center rounded-full bg-border/60 transition-colors after:hidden hover:bg-border data-[separator]:bg-border/60" />
      <ResizablePanel id="interview-chat" minSize={CHAT_MIN_WIDTH} defaultSize="46%">
        {selected === null ? (
          <div className="grid h-full place-items-center rounded-2xl bg-card text-sm text-muted-foreground shadow-sm">
            从左边选一场面试
          </div>
        ) : (
          <InterviewChatCard
            key={selected.id}
            interview={selected}
            job={jobOf(selected.jobId)}
            models={models}
            modelReady={modelReady}
            onSelectModel={onSelectModel}
            onOpenModelSettings={onOpenModelSettings}
            onOverlayChange={onOverlayChange}
            onRequireModel={() => setGateOpen(true)}
            onChanged={reload}
          />
        )}
      </ResizablePanel>
      {selected !== null && selected.review !== null && (
        <>
          <ResizableHandle className="mx-1 w-1 justify-self-center rounded-full bg-border/60 transition-colors after:hidden hover:bg-border data-[separator]:bg-border/60" />
          <ResizablePanel id="interview-review" minSize={REVIEW_MIN_WIDTH} defaultSize="30%">
            <ReviewCard interview={selected} />
          </ResizablePanel>
        </>
      )}

      <DeleteInterviewDialog
        interview={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => deleting !== null && removeInterview(deleting)}
        onOverlayChange={onOverlayChange}
      />
      <ModelGateDialog
        open={gateOpen}
        onClose={() => setGateOpen(false)}
        onOpenSettings={onOpenModelSettings}
        onOverlayChange={onOverlayChange}
      />
    </ResizablePanelGroup>
  );
}

function modeLabel(mode: Interview["config"]["mode"]): string {
  return mode === "voice" ? "语音" : "文本";
}

function roundsLabel(interview: Interview): string {
  return interview.status === "finished"
    ? `共 ${interview.rounds.length} 轮`
    : `已记录 ${interview.rounds.length}/${interview.config.rounds} 轮`;
}

/** 列表行：岗位（悬空提示）/ 时间 · 轮次 · 模式 + 进行中或总评分徽标；悬停出现删除。 */
function InterviewRow({
  interview,
  job,
  selected,
  onSelect,
  onDelete,
}: {
  interview: Interview;
  job: Job | undefined;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const dangling = job === undefined;
  return (
    <div
      className={cn(
        "group relative border-b border-border/40 last:border-b-0",
        selected ? "bg-muted" : "hover:bg-muted/50",
      )}
    >
      <button
        type="button"
        className="w-full px-3 py-2.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
        onClick={onSelect}
        aria-current={selected || undefined}
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {dangling && <CircleAlert className="mr-1 inline size-3.5 text-destructive" />}
            {dangling ? "岗位已删除" : job.title}
          </span>
          {interview.status === "running" ? (
            <Badge variant="secondary" className="gap-1">
              <LoaderCircle className="animate-spin" />
              进行中
            </Badge>
          ) : interview.review !== null ? (
            <ReviewScoreBadge score={interview.review.score} />
          ) : null}
        </span>
        <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
          <span>{formatTime(interview.createdAt)}</span>
          <span>·</span>
          <span>{roundsLabel(interview)}</span>
          <span>·</span>
          <span>{modeLabel(interview.config.mode)}</span>
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute right-2 top-2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        aria-label="删除这场面试"
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

/** 总评分徽标（与匹配度徽标同一套分档语义）。 */
function ReviewScoreBadge({ score }: { score: number }) {
  const tone = score >= 75 ? "default" : score >= 50 ? "secondary" : "outline";
  return (
    <Badge variant={tone} className="tabular-nums">
      {score}
    </Badge>
  );
}

/** 中栏：当前面试的会话卡（会话 key = interview:<id>），头部带轮次进度与收尾按钮。 */
function InterviewChatCard({
  interview,
  job,
  models,
  modelReady,
  onSelectModel,
  onOpenModelSettings,
  onOverlayChange,
  onRequireModel,
  onChanged,
}: {
  interview: Interview;
  job: Job | undefined;
  models: ModulePageProps["models"];
  modelReady: boolean;
  onSelectModel: ModulePageProps["onSelectModel"];
  onOpenModelSettings: () => void;
  onOverlayChange: (open: boolean) => void;
  onRequireModel: () => void;
  onChanged: () => void;
}) {
  const key = `interview:${interview.id}` as const;
  const initial = useConversationInitial(key);
  if (initial === null) return <ModuleLoadingCard />;
  return (
    <InterviewChatLoaded
      key={interview.id}
      interview={interview}
      job={job}
      initialMessages={initial}
      models={models}
      modelReady={modelReady}
      onSelectModel={onSelectModel}
      onOpenModelSettings={onOpenModelSettings}
      onOverlayChange={onOverlayChange}
      onRequireModel={onRequireModel}
      onChanged={onChanged}
    />
  );
}

function InterviewChatLoaded({
  interview,
  job,
  initialMessages,
  models,
  modelReady,
  onSelectModel,
  onOpenModelSettings,
  onOverlayChange,
  onRequireModel,
  onChanged,
}: {
  interview: Interview;
  job: Job | undefined;
  initialMessages: UIMessage[];
} & Omit<Parameters<typeof InterviewChatCard>[0], "interview" | "job">) {
  const chat = useModuleChat(`interview:${interview.id}` as const, initialMessages);
  const busy = chat.status === "submitted" || chat.status === "streaming";
  const running = interview.status === "running";

  // run 结束（含出错）后刷新面试记录：轮次落账与总评都发生在 run 里。
  useEffect(() => {
    if (chat.status !== "ready" && chat.status !== "error") return;
    onChanged();
  }, [chat.status, onChanged]);

  // 开场：进行中 + 会话还是空的 + 模型可用 → 自动让面试官开始（发一次后历史非空，不会重复）。
  useEffect(() => {
    if (!running || initialMessages.length > 0 || !modelReady) return;
    chat.send(INTERVIEW_OPENING_PROMPT, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在空会话进入时发一次。
  }, [running, initialMessages, modelReady]);

  const finish = (): void => {
    if (!running || busy) return;
    if (!modelReady) {
      onRequireModel();
      return;
    }
    chat.send(INTERVIEW_FINISH_PROMPT, []);
  };

  const configured = interview.config.rounds;
  const done = Math.min(interview.rounds.length, configured);
  const progressPct = Math.round((done / configured) * 100);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl bg-card shadow-sm">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className="min-w-0 truncate text-sm font-medium">
          {job === undefined ? "岗位已删除" : job.title}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {modeLabel(interview.config.mode)}
        </span>
        {running ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">
              第 {Math.min(interview.rounds.length + 1, configured)} / {configured} 轮
            </span>
            <div className="h-1 w-20 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={finish}>
              结束并出总评
            </Button>
          </div>
        ) : (
          <Badge variant="secondary" className="ml-auto shrink-0">
            已结束{interview.review !== null ? ` · ${interview.review.score} 分` : ""}
          </Badge>
        )}
      </div>
      <ChatPanel
        messages={chat.messages}
        status={chat.status}
        errorText={chat.errorText}
        models={models}
        emptyTitle={running ? "这场面试还没有开始" : "这场面试没有留下对话"}
        emptyDescription={
          modelReady
            ? running
              ? "面试官马上开始第 1 轮提问。"
              : "总评在右边；对话区可以继续追问改进建议。"
            : "还没有可用的模型：在下方选择或去设置配置一个，面试官会自动开始提问。"
        }
        placeholder="回答面试官的问题；想提前结束就点右上角「结束并出总评」"
        onSelectModel={onSelectModel}
        onOpenModelSettings={onOpenModelSettings}
        onOverlayChange={onOverlayChange}
        onSend={chat.send}
        onStop={chat.stop}
        onApprovalResponse={chat.respondApproval}
        conversationKey={`interview:${interview.id}`}
        allowUpload={false}
      />
    </div>
  );
}

/** 点评卡（面试页第三栏）：总评 Markdown（文档纸面）+ 亮点 / 风险 / 建议 + 逐轮时间线。 */
function ReviewCard({ interview }: { interview: Interview }) {
  const review = interview.review;
  if (review === null) return null;
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl bg-card shadow-sm">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className="text-sm font-medium">总评</span>
        <ReviewScoreBadge score={review.score} />
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {formatTime(interview.finishedAt)}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
        <section className="overflow-hidden rounded-xl border border-border/60">
          <DocumentPreview markdown={review.overall} emptyText="总评正文为空。" />
        </section>

        {review.strengths.length > 0 && (
          <ReviewList title="亮点" icon={<CircleCheck className="text-emerald-600 dark:text-emerald-400" />} items={review.strengths} />
        )}
        {review.weaknesses.length > 0 && (
          <ReviewList title="风险与不足" icon={<CircleAlert className="text-amber-600 dark:text-amber-400" />} items={review.weaknesses} />
        )}
        {review.suggestions.length > 0 && (
          <ReviewList title="改进建议" icon={<Lightbulb className="text-sky-600 dark:text-sky-400" />} items={review.suggestions} />
        )}

        {interview.rounds.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">逐轮记录</h3>
            <ol className="space-y-3">
              {interview.rounds.map((round) => (
                <li key={round.no} className="border-l-2 border-border/60 pl-3">
                  <p className="text-[11px] font-medium tracking-wide text-muted-foreground">
                    第 {round.no} 轮
                  </p>
                  <p className="mt-0.5 text-sm font-medium">{round.question}</p>
                  {round.followUps?.map((followUp, index) => (
                    <p key={index} className="mt-1 text-xs text-muted-foreground">
                      追问：{followUp}
                    </p>
                  ))}
                  <p className="mt-1 text-xs leading-relaxed">
                    {round.answer === "" ? "（未记录回答）" : round.answer}
                  </p>
                  {round.note !== undefined && (
                    <p className="mt-1 rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
                      小结：{round.note}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}

function ReviewList({
  title,
  icon,
  items,
}: {
  title: string;
  icon: React.ReactNode;
  items: string[];
}) {
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {title}
      </h3>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li key={index} className="flex gap-1.5 text-sm leading-relaxed">
            <span className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/50" />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DeleteInterviewDialog({
  interview,
  onClose,
  onDeleted,
  onOverlayChange,
}: {
  interview: Interview | null;
  onClose: () => void;
  onDeleted: () => void;
  onOverlayChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog
      open={interview !== null}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除这场面试记录？</AlertDialogTitle>
          <AlertDialogDescription>
            面试的对话与逐轮记录、总评会一并删除，不可恢复；岗位本身不受影响。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            onClick={(event) => {
              event.preventDefault();
              onDeleted();
            }}
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
