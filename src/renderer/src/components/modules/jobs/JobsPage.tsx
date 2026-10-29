import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CircleAlert,
  LoaderCircle,
  Plus,
} from "lucide-react";

import type { Company, Job, ScorecardTarget, ScriptDoc, TaskState } from "@shared/types";

import { ChatPanel } from "@/components/chat/ChatPanel";
import { ConversationPane } from "@/components/chat/conversation-pane";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

import { InterviewStartDialog } from "./InterviewStartDialog";
import { JobEditDialog } from "./JobEditDialog";
import { JobRowMenu } from "./JobRowMenu";
import { ModelGateDialog } from "../shared/ModelGateDialog";
import { DeleteDialog } from "../shared/DeleteDialog";
import type { ModulePageProps } from "../shared/module-page";
import { useDomainChange } from "../shared/use-domain-change";
import { ScorecardDialog } from "../shared/ScorecardDialog";
import { ScriptDialog, ScriptStatusBadge } from "./ScriptDialog";
import { cmpNumber, cmpText, cmpTime, SortableHead, useTableSort } from "../shared/table-bits";
import { formatTime } from "@/lib/format";

const CHAT_MIN_WIDTH = 380;
const TABLE_MIN_WIDTH = 560;

type JobField = "title" | "company" | "salaryBand" | "match" | "script" | "updatedAt";

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
 * 「岗位」模块页（操作枢纽）：左边岗位会话，右边岗位表。
 * 列：标题 / 公司 / 薪资带 / 匹配度 / 话术 / 更新时间。行操作：
 * 生成简历（二级页）、简历评估（后台任务，行内 评估中→分数）、
 * 话术管理（定稿 sidecar）、模拟面试（选轮次发起，进面试模块）、编辑 / 删除。
 */
export function JobsPage({
  models,
  onSelectModel,
  onOpenModelSettings,
  onOverlayChange,
  onOpenBrowser,
  onOpenJob,
  onOpenInterview,
}: JobsPageProps) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [tailoredKeys, setTailoredKeys] = useState<Set<string>>(new Set());
  const [scripts, setScripts] = useState<ScriptDoc[]>([]);
  const [tasks, setTasks] = useState<TaskState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Job | "new" | null>(null);
  const [deleting, setDeleting] = useState<Job | null>(null);
  const [scriptJob, setScriptJob] = useState<Job | null>(null);
  const [interviewJob, setInterviewJob] = useState<Job | null>(null);
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
    reloadResumeState();
  }, [reloadResumeState]);

  useEffect(() => reload(), [reload]);
  // Agent 在同一页右边建档：写完就刷新表格 / 公司名 / 定制稿标记，不用切模块。
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
        default:
          return cmpTime(a.updatedAt, b.updatedAt, sort.direction);
      }
    });
    return rows;
  }, [jobs, sort.sortKey, sort.direction, companyName, scriptOf]);

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
                emptyDescription="粘贴 JD 让 Agent 归档岗位；评估匹配度去右边岗位表点「简历评估」。"
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
                      新建一个（顺手粘上 JD），或直接在左边对话里让 Agent 归档。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <SortableHead label="标题" sortKey="title" table={sort} className="pl-4" />
                    <SortableHead label="公司" sortKey="company" table={sort} />
                    <SortableHead label="薪资带" sortKey="salaryBand" table={sort} />
                    <SortableHead label="匹配度" sortKey="match" table={sort} />
                    <SortableHead label="话术" sortKey="script" table={sort} />
                    <SortableHead label="更新时间" sortKey="updatedAt" table={sort} />
                    <TableHead className="w-10 pr-3" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((job) => {
                    const company = companyName(job.companyId);
                    const task = evaluating(job.id);
                    const script = scriptOf(job.id);
                    return (
                      <TableRow key={job.id}>
                        <TableCell className="max-w-56 truncate pl-4 font-medium" title={job.title}>
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
                        <TableCell className="text-xs text-muted-foreground tabular-nums">
                          {formatTime(job.updatedAt)}
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
        onStarted={onOpenInterview}
      />
      <DeleteDialog
        open={deleting !== null}
        title={`删除「{deleting?.title}」？`}
        description="删除不做级联：这个岗位的定制简历、话术和投递记录都会保留，显示为悬空引用。"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting === null) return;
          await window.goodjob.jobs.remove(deleting.id);
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
