import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CircleAlert,
  GitCompareArrows,
  LoaderCircle,
  Plus,
  Settings2,
} from "lucide-react";

import type {
  Company,
  Job,
  PipelineConfig,
  ScorecardTarget,
  ScriptDoc,
  TaskState,
} from "@shared/types";

import { ChatPanel } from "@/components/chat/ChatPanel";
import { ConversationPane } from "@/components/chat/conversation-pane";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { AdvanceDialog } from "./AdvanceDialog";
import { InterviewStartDialog } from "./InterviewStartDialog";
import { JobEditDialog } from "./JobEditDialog";
import { JobRowMenu } from "./JobRowMenu";
import { OfferCompareDialog } from "./OfferCompareDialog";
import { PipelineDialog } from "./PipelineDialog";
import { ModelGateDialog } from "../shared/ModelGateDialog";
import { DeleteDialog } from "../shared/DeleteDialog";
import type { ModulePageProps } from "../shared/module-page";
import { useDomainChange } from "../shared/use-domain-change";
import { ScorecardDialog } from "../shared/ScorecardDialog";
import { ScriptDialog, ScriptStatusBadge } from "./ScriptDialog";
import { cmpNumber, cmpText, cmpTime, SortableHead, stageDotClass, useTableSort } from "../shared/table-bits";
import { formatTime } from "@/lib/format";

const CHAT_MIN_WIDTH = 380;
const TABLE_MIN_WIDTH = 560;

type JobField = "title" | "company" | "salaryBand" | "match" | "script" | "stage" | "updatedAt";

/** 无定制稿时「生成简历」进二级页后自动发给岗位 Agent 的起草指令。 */
const TAILORED_DRAFT_PROMPT =
  "请基于主简历（resume_read）和这个岗位的 JD（job_info），生成一份定制简历初稿：针对 JD 取舍改写，用 job_tailored_write 写入。写完简述你做了哪些取舍。";
/** 已有定制稿时「生成简历」只把优化提示词填进输入框，等用户确认后再发。 */
const TAILORED_OPTIMIZE_PROMPT =
  "请先读一遍这个岗位的定制简历（job_tailored_read）和主简历，对照 JD 找出最该优化的 2–3 处；然后直接改写并用 job_tailored_write 整体覆写，写完说明这次改了什么。";
/** 无话术时「生成初稿」进二级页后自动发给岗位 Agent 的起草指令。 */
const SCRIPT_DRAFT_PROMPT =
  "请为这个岗位生成面试话术初稿（job_info 看 JD，resume_read 看主简历）：按「自我介绍 / 项目深挖 / 反问环节」组织，用 job_script_write 写入。";

export interface JobsPageProps extends ModulePageProps {
  /**
   * 生成简历 / 生成话术：进入该岗位的二级工作台。
   * autoPrompt 会立刻发送；prefillPrompt 只填进输入框，不自动发送。
   */
  onOpenJob: (
    jobId: string,
    autoPrompt: string | null,
    prefillPrompt?: string | null,
  ) => void;
  /** 发起模拟面试成功 → 跳到面试模块并选中这场面试。 */
  onOpenInterview: (interviewId: string) => void;
}

/**
 * 「岗位」模块页（操作枢纽）：左边岗位会话，右边岗位表（岗位 + 投递同一条记录）。
 * 列：标题 / 公司 / 薪资带 / 匹配度 / 话术 / 投递状态 / 更新时间。行操作：
 * 生成简历（二级页）、简历评估（后台任务，行内 评估中→分数）、
 * 话术管理（定稿 sidecar）、模拟面试（选轮次发起，进面试模块）、
 * 标记投递 / 推进状态、编辑（含 Offer / 备注）/ 删除。
 */
export function JobsPage({
  models,
  onSelectModel,
  onOpenModelSettings,
  onOpenVoiceSettings,
  onOverlayChange,
  onOpenBrowser,
  onOpenJob,
  onOpenInterview,
}: JobsPageProps) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [pipeline, setPipeline] = useState<PipelineConfig | null>(null);
  const [tailoredKeys, setTailoredKeys] = useState<Set<string>>(new Set());
  const [scripts, setScripts] = useState<ScriptDoc[]>([]);
  const [tasks, setTasks] = useState<TaskState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Job | "new" | null>(null);
  const [deleting, setDeleting] = useState<Job | null>(null);
  const [scriptJob, setScriptJob] = useState<Job | null>(null);
  const [interviewJob, setInterviewJob] = useState<Job | null>(null);
  const [advancing, setAdvancing] = useState<Job | null>(null);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  /** 勾选了要对比 Offer 的岗位 id（只有含 Offer 的行给勾选框）。 */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 评分卡弹窗的定位；null = 关着。 */
  const [scorecard, setScorecard] = useState<ScorecardTarget | null>(null);
  const [gateOpen, setGateOpen] = useState(false);

  const sort = useTableSort<JobField>("updatedAt", "desc");

  const modelReady = models?.activeModel?.ready === true;

  /** 定制稿与话术：行菜单的简历状态、表格的话术状态都看这一份。 */
  const reloadResumeState = useCallback((): void => {
    void window.goodjob.resume
      .listTailored()
      .then((docs) => setTailoredKeys(new Set(docs.map((doc) => doc.name))))
      .catch(() => setTailoredKeys(new Set()));
    void window.goodjob.resume.scripts
      .list()
      .then((docs) => setScripts(docs))
      .catch(() => setScripts([]));
  }, []);

  const reload = useCallback((): void => {
    setError(null);
    void window.goodjob.jobs
      .list()
      .then(setJobs)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    void window.goodjob.companies
      .list()
      .then(setCompanies)
      .catch(() => setCompanies([]));
    void window.goodjob.pipeline.get().then(setPipeline).catch(() => setPipeline(null));
    reloadResumeState();
  }, [reloadResumeState]);

  useEffect(() => reload(), [reload]);
  // Agent 在同一页右边建档 / 推进：写完就刷新表格 / 公司名 / 定制稿标记，不用切模块。
  useDomainChange(["jobs", "companies"], reload);
  // Agent 在岗位工作台里写定制稿 / 话术：文件变化直接推过来，表格标记实时更新。
  useEffect(
    () =>
      window.goodjob.resume.onFileChanged((event) => {
        if (event.kind === "main") return;
        reloadResumeState();
      }),
    [reloadResumeState],
  );

  // 任务注册表：挂载取一次，事件增量更新；评估完成时匹配度已写回岗位，重拉岗位表。
  useEffect(() => {
    void window.goodjob.tasks.list().then(setTasks);
    return window.goodjob.tasks.onEvent((event) => {
      setTasks((prev) => {
        const next = prev.filter((task) => task.id !== event.task.id);
        return [event.task, ...next];
      });
      if (event.type === "finish" && event.task.type === "job-match") {
        void window.goodjob.jobs.list().then(setJobs);
      }
    });
  }, []);

  const companyName = useCallback(
    (companyId: string | null): { name: string; dangling: boolean } => {
      if (companyId === null) return { name: "", dangling: false };
      const company = companies.find((item) => item.id === companyId);
      if (company === undefined) return { name: "公司已删除", dangling: true };
      return { name: company.name, dangling: false };
    },
    [companies],
  );

  const evaluating = useCallback(
    (jobId: string): TaskState | null =>
      tasks.find((task) => task.type === "job-match" && task.target === jobId && task.status === "running") ??
      null,
    [tasks],
  );

  const scriptOf = useCallback(
    (jobId: string): ScriptDoc | null => scripts.find((doc) => doc.jobId === jobId) ?? null,
    [scripts],
  );

  /** 当前投递状态 = 时间线最后一条；空时间线 = 还没投。 */
  const stageOf = useCallback(
    (job: Job): { name: string; index: number; final: boolean; at: string | null } => {
      const last = job.timeline.at(-1) ?? null;
      if (last === null) return { name: "未投递", index: -1, final: false, at: null };
      const stages = pipeline?.stages ?? [];
      const index = stages.findIndex((stage) => stage.name === last.stage);
      return { name: last.stage, index, final: stages[index]?.final ?? false, at: last.at };
    },
    [pipeline],
  );

  const sorted = useMemo(() => {
    if (jobs === null) return null;
    const rank = (doc: ScriptDoc | null): number =>
      doc === null ? 0 : doc.modifiedSinceFinal ? 2 : doc.final ? 3 : 1;
    const rows = [...jobs];
    rows.sort((a, b) => {
      const asc = sort.direction === "asc";
      switch (sort.sortKey) {
        case "title":
          return asc ? cmpText(a.title, b.title) : cmpText(b.title, a.title);
        case "company": {
          const left = companyName(a.companyId).name;
          const right = companyName(b.companyId).name;
          return asc ? cmpText(left, right) : cmpText(right, left);
        }
        case "salaryBand":
          return asc ? cmpText(a.salaryBand, b.salaryBand) : cmpText(b.salaryBand, a.salaryBand);
        case "match":
          return cmpNumber(a.matchReport?.score ?? null, b.matchReport?.score ?? null, sort.direction);
        case "script":
          return asc ? rank(scriptOf(a.id)) - rank(scriptOf(b.id)) : rank(scriptOf(b.id)) - rank(scriptOf(a.id));
        case "stage": {
          const left = stageOf(a).index;
          const right = stageOf(b).index;
          return asc ? left - right : right - left;
        }
        default:
          return cmpTime(a.updatedAt, b.updatedAt, sort.direction);
      }
    });
    return rows;
  }, [jobs, sort.sortKey, sort.direction, companyName, scriptOf, stageOf]);

  const selectedJobs = useMemo(
    () => (jobs ?? []).filter((job) => selected.has(job.id) && job.offer !== null),
    [jobs, selected],
  );

  const toggleSelected = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 需要 Agent 的动作先过模型门（不伪造、不静默失败）。 */
  const requireModel = (action: () => void): void => {
    if (!modelReady) {
      setGateOpen(true);
      return;
    }
    action();
  };

  const generateResume = (job: Job): void => {
    // 已有定制稿：进二级页共编，只把优化提示词填进输入框（不自动发，避免重复起一轮）。
    if (tailoredKeys.has(job.id)) {
      onOpenJob(job.id, null, TAILORED_OPTIMIZE_PROMPT);
      return;
    }
    // 没有定制稿：进二级页并让岗位 Agent 起草初稿——这一步要模型，先过门。
    requireModel(() => onOpenJob(job.id, TAILORED_DRAFT_PROMPT));
  };

  const generateScript = (job: Job): void => {
    requireModel(() => onOpenJob(job.id, SCRIPT_DRAFT_PROMPT));
  };

  const evaluate = (job: Job): void => {
    requireModel(() => {
      setError(null);
      void window.goodjob.tasks
        .run("job-match", job.id)
        .then((task) => setTasks((prev) => [task, ...prev.filter((item) => item.id !== task.id)]))
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    });
  };

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel minSize={CHAT_MIN_WIDTH} defaultSize="42%">
        <div className="h-full overflow-hidden rounded-2xl bg-card shadow-sm">
          <ConversationPane scope="jobs" takeover onOverlayChange={onOverlayChange}>
            {(chat, conversation) => (
              <ChatPanel
                messages={chat.messages}
                status={chat.status}
                errorText={chat.errorText}
                models={models}
                emptyTitle="整理你的岗位库"
                emptyDescription="粘贴 JD 让 Agent 归档岗位；推进投递状态、评估匹配度去右边岗位表。"
                placeholder="例如：帮我记录一个岗位，JD 如下：…"
                onSelectModel={onSelectModel}
                onOpenModelSettings={onOpenModelSettings}
                onOverlayChange={onOverlayChange}
                onOpenBrowser={onOpenBrowser}
                onSend={chat.send}
                onStop={chat.stop}
                onApprovalResponse={chat.respondApproval}
                conversationKey={conversation.activeKey}
                conversation={conversation}
              />
            )}
          </ConversationPane>
        </div>
      </ResizablePanel>
      {/* 8px 间隙里的一条可拖拽细线：既是分隔提示，也是拖拽热区。 */}
      <ResizableHandle className="mx-1 w-1 justify-self-center rounded-full bg-border/60 transition-colors after:hidden hover:bg-border data-[separator]:bg-border/60" />
      <ResizablePanel minSize={TABLE_MIN_WIDTH} defaultSize="58%">
        <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl bg-card shadow-sm">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
            <span className="text-sm font-medium">岗位</span>
            {jobs !== null && (
              <span className="text-xs text-muted-foreground">{jobs.length}</span>
            )}
            {error !== null && (
              <span className="min-w-0 flex-1 truncate text-xs text-destructive" title={error}>
                {error}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {selectedJobs.length >= 2 && (
                <Button variant="outline" size="sm" onClick={() => setCompareOpen(true)}>
                  <GitCompareArrows />
                  对比 Offer（{selectedJobs.length}）
                </Button>
              )}
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setPipelineOpen(true)}>
                <Settings2 />
                流水线
              </Button>
              <Button size="sm" onClick={() => setEditing("new")}>
                <Plus />
                新建岗位
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {sorted === null ? (
              <div className="grid h-full place-items-center text-sm text-muted-foreground">
                正在加载…
              </div>
            ) : sorted.length === 0 ? (
              <div className="grid h-full place-items-center p-6">
                <Empty className="max-w-sm">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Plus />
                    </EmptyMedia>
                    <EmptyTitle>还没有岗位</EmptyTitle>
                    <EmptyDescription>
                      新建一个（顺手粘上 JD），或直接在左边对话里让 Agent 归档。投递状态也在这张表里推进。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-8 pl-4" aria-label="勾选对比 Offer" />
                    <SortableHead label="标题" sortKey="title" table={sort} />
                    <SortableHead label="公司" sortKey="company" table={sort} />
                    <SortableHead label="薪资带" sortKey="salaryBand" table={sort} />
                    <SortableHead label="匹配度" sortKey="match" table={sort} />
                    <SortableHead label="话术" sortKey="script" table={sort} />
                    <SortableHead label="投递" sortKey="stage" table={sort} />
                    <TableHead className="w-10 pr-3" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((job) => {
                    const company = companyName(job.companyId);
                    const task = evaluating(job.id);
                    const script = scriptOf(job.id);
                    const stage = stageOf(job);
                    return (
                      <TableRow key={job.id} data-selected={selected.has(job.id) || undefined}>
                        <TableCell className="pl-4">
                          {job.offer !== null && (
                            <Checkbox
                              aria-label={`对比「${job.title}」的 Offer`}
                              checked={selected.has(job.id)}
                              onCheckedChange={() => toggleSelected(job.id)}
                            />
                          )}
                        </TableCell>
                        <TableCell className="max-w-56 truncate font-medium" title={job.title}>
                          {job.title}
                        </TableCell>
                        <TableCell
                          className={
                            company.dangling
                              ? "text-xs text-destructive"
                              : "text-muted-foreground"
                          }
                        >
                          {company.dangling && <CircleAlert className="mr-1 inline size-3" />}
                          {company.name === "" ? "—" : company.name}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {job.salaryBand === "" ? "—" : job.salaryBand}
                        </TableCell>
                        <TableCell>
                          {task !== null ? (
                            <Badge variant="secondary" className="gap-1" title={task.progress ?? ""}>
                              <LoaderCircle className="animate-spin" />
                              评估中
                            </Badge>
                          ) : job.matchReport !== null ? (
                            <button
                              type="button"
                              className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
                              aria-label={`查看「${job.title}」的评分卡`}
                              onClick={() => setScorecard({ kind: "job", jobId: job.id })}
                            >
                              <MatchBadge score={job.matchReport.score} />
                            </button>
                          ) : (
                            <span className="text-xs text-muted-foreground">未评估</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {script !== null ? (
                            <button
                              type="button"
                              className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
                              aria-label={`管理「${job.title}」的话术`}
                              onClick={() => setScriptJob(job)}
                            >
                              <ScriptStatusBadge doc={script} />
                            </button>
                          ) : (
                            <span className="text-xs text-muted-foreground">未生成</span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          {job.timeline.length === 0 ? (
                            <div className="text-xs">
                              <span className="text-muted-foreground">未投递</span>
                              {job.offer !== null && (
                                <div className="text-[11px] text-muted-foreground">
                                  Offer {job.offer.salary === "" ? "已记录" : job.offer.salary}
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="text-xs">
                              <span className="inline-flex items-center gap-1.5">
                                <span className={cn("size-1.5 rounded-full", stageDotClass(stage.index))} />
                                <span>{stage.name}</span>
                                {stage.index < 0 && (
                                  <span className="text-[11px] text-muted-foreground" title="阶段不在流水线里">
                                    （不在流水线）
                                  </span>
                                )}
                                {stage.final && (
                                  <span className="text-muted-foreground" title="终态">
                                    ∎
                                  </span>
                                )}
                              </span>
                              <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                                {formatTime(stage.at)}
                              </div>
                              {job.offer !== null && (
                                <div className="text-[11px] text-muted-foreground">
                                  Offer {job.offer.salary === "" ? "已记录" : job.offer.salary}
                                </div>
                              )}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="pr-3 text-right">
                          <JobRowMenu
                            job={job}
                            hasTailored={tailoredKeys.has(job.id)}
                            evaluating={task !== null}
                            onGenerateResume={() => generateResume(job)}
                            onEvaluate={() => evaluate(job)}
                            onScript={() => setScriptJob(job)}
                            onInterview={() => setInterviewJob(job)}
                            onAdvance={() => setAdvancing(job)}
                            onEdit={() => setEditing(job)}
                            onDelete={() => setDeleting(job)}
                            onOverlayChange={onOverlayChange}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      </ResizablePanel>

      <JobEditDialog
        target={editing}
        companies={companies}
        onClose={() => setEditing(null)}
        onSaved={reload}
        onOverlayChange={onOverlayChange}
      />
      <ScriptDialog
        job={scriptJob}
        onClose={() => setScriptJob(null)}
        onOverlayChange={onOverlayChange}
        onSaved={() =>
          void window.goodjob.resume.scripts.list().then((docs) => setScripts(docs))
        }
        onGenerate={(jobId) => {
          const job = jobs?.find((item) => item.id === jobId);
          setScriptJob(null);
          if (job !== undefined) generateScript(job);
        }}
      />
      <InterviewStartDialog
        job={interviewJob}
        hasTailored={interviewJob !== null && tailoredKeys.has(interviewJob.id)}
        onClose={() => setInterviewJob(null)}
        onOverlayChange={onOverlayChange}
        requireModel={requireModel}
        onOpenJobWorkbench={(jobId) => onOpenJob(jobId, TAILORED_DRAFT_PROMPT)}
        onEditJob={(jobId) => {
          const job = jobs?.find((item) => item.id === jobId);
          setInterviewJob(null);
          if (job !== undefined) setEditing(job);
        }}
        onOpenVoiceSettings={onOpenVoiceSettings}
        onStarted={onOpenInterview}
      />
      <AdvanceDialog
        job={advancing}
        pipeline={pipeline}
        stageOf={stageOf}
        onClose={() => setAdvancing(null)}
        onSaved={reload}
        onOverlayChange={onOverlayChange}
      />
      <PipelineDialog
        open={pipelineOpen}
        config={pipeline}
        onClose={() => setPipelineOpen(false)}
        onSaved={setPipeline}
        onOverlayChange={onOverlayChange}
      />
      <OfferCompareDialog
        open={compareOpen}
        selected={selectedJobs}
        companies={companies}
        pipeline={pipeline}
        onClose={() => setCompareOpen(false)}
        onOverlayChange={onOverlayChange}
      />
      <DeleteDialog
        open={deleting !== null}
        title={`删除「{deleting?.title}」？`}
        description="只删这个岗位及其投递记录；定制简历、话术和模拟面试都会保留，显示为悬空引用。"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting === null) return;
          await window.goodjob.jobs.remove(deleting.id);
          setSelected((prev) => {
            const next = new Set(prev);
            next.delete(deleting.id);
            return next;
          });
          reload();
        }}
        onOverlayChange={onOverlayChange}
      />
      <ModelGateDialog
        open={gateOpen}
        onClose={() => setGateOpen(false)}
        onOpenSettings={onOpenModelSettings}
        onOverlayChange={onOverlayChange}
      />
      <ScorecardDialog
        target={scorecard}
        onClose={() => setScorecard(null)}
        onOverlayChange={onOverlayChange}
      />
    </ResizablePanelGroup>
  );
}

/** 匹配度徽标：分数分档着色（token 语义色，浅深两态都成立）。 */
function MatchBadge({ score }: { score: number }) {
  const tone =
    score >= 75 ? "default" : score >= 50 ? "secondary" : "outline";
  return (
    <Badge variant={tone} className="cursor-pointer tabular-nums">
      {score}
    </Badge>
  );
}
