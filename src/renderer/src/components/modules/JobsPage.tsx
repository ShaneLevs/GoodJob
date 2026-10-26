import { useCallback, useEffect, useMemo, useState } from "react";

import type { UIMessage } from "ai";
import {
  CircleAlert,
  FileText,
  LoaderCircle,
  MessageSquareText,
  Mic,
  MoreHorizontal,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";

import type { Company, Job, ScorecardTarget, ScriptDoc, TaskState } from "@shared/types";

import { useBrowserTakeover, useConversationInitial, useModuleChat } from "@/components/chat/use-module-chat";
import { ChatPanel } from "@/components/ChatPanel";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

import { ModelGateDialog } from "./ModelGateDialog";
import { ModuleLoadingCard, type ModulePageProps } from "./module-page";
import { ScorecardDialog } from "../ScorecardDialog";
import { ScriptDialog, ScriptStatusBadge } from "./ScriptDialog";
import { cmpNumber, cmpText, cmpTime, formatTime, SortableHead, useTableSort } from "./table-bits";

const CHAT_MIN_WIDTH = 380;
const TABLE_MIN_WIDTH = 560;

type JobField = "title" | "company" | "salaryBand" | "match" | "script" | "updatedAt";

/** 无定制稿时「生成简历」进二级页后自动发给岗位 Agent 的起草指令。 */
const TAILORED_DRAFT_PROMPT =
  "请基于主简历（resume_read）和这个岗位的 JD（job_info），生成一份定制简历初稿：针对 JD 取舍改写，用 job_tailored_write 写入。写完简述你做了哪些取舍。";
/** 无话术时「生成初稿」进二级页后自动发给岗位 Agent 的起草指令。 */
const SCRIPT_DRAFT_PROMPT =
  "请为这个岗位生成面试话术初稿（job_info 看 JD，resume_read 看主简历）：按「自我介绍 / 项目深挖 / 反问环节」组织，用 job_script_write 写入。";

export interface JobsPageProps extends ModulePageProps {
  /** 生成简历 / 生成话术：进入该岗位的二级工作台（可带自动起草指令）。 */
  onOpenJob: (jobId: string, autoPrompt: string | null) => void;
  /** 发起模拟面试成功 → 跳到面试模块并选中这场面试。 */
  onOpenInterview: (interviewId: string) => void;
}

/**
 * 「岗位」模块页（操作枢纽）：左边岗位会话，右边岗位表。
 * 列：标题 / 公司 / 薪资带 / 匹配度 / 话术 / 更新时间。行操作：
 * 生成简历（二级页）、简历评估（后台任务，行内 评估中→分数）、
 * 话术管理（定稿 sidecar）、模拟面试（选轮次发起，进面试模块）、编辑 / 删除。
 */
export function JobsPage(props: JobsPageProps) {
  const initial = useConversationInitial("jobs");
  if (initial === null) return <ModuleLoadingCard />;
  return <JobsPageLoaded initialMessages={initial} {...props} />;
}

function JobsPageLoaded({
  initialMessages,
  models,
  onSelectModel,
  onOpenModelSettings,
  onOverlayChange,
  onOpenJob,
  onOpenInterview,
}: JobsPageProps & { initialMessages: UIMessage[] }) {
  const chat = useModuleChat("jobs", initialMessages);
  // 浏览器面板工具条「让 Agent 接管」：在本会话发一条起手指令（P4）。
  useBrowserTakeover(chat.send);

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
    void window.goodjob.resume
      .listTailored()
      .then((docs) => setTailoredKeys(new Set(docs.map((doc) => doc.name))))
      .catch(() => setTailoredKeys(new Set()));
    void window.goodjob.resume.scripts
      .list()
      .then((docs) => setScripts(docs))
      .catch(() => setScripts([]));
  }, []);

  useEffect(() => reload(), [reload]);

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
    // 已有定制稿：直接进二级页共编（看稿不需要模型）。
    if (tailoredKeys.has(job.id)) {
      onOpenJob(job.id, null);
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
            onSend={chat.send}
            onStop={chat.stop}
            onApprovalResponse={chat.respondApproval}
            conversationKey="jobs"
          />
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
        job={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={reload}
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

function JobRowMenu({
  job,
  hasTailored,
  evaluating,
  onGenerateResume,
  onEvaluate,
  onScript,
  onInterview,
  onEdit,
  onDelete,
  onOverlayChange,
}: {
  job: Job;
  hasTailored: boolean;
  evaluating: boolean;
  onGenerateResume: () => void;
  onEvaluate: () => void;
  onScript: () => void;
  onInterview: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOverlayChange: (open: boolean) => void;
}) {
  return (
    <DropdownMenu onOpenChange={onOverlayChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={`「${job.title}」的操作`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          求职流程
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={onGenerateResume}>
          <FileText />
          生成简历{hasTailored ? "" : "（起草）"}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={evaluating} onSelect={onEvaluate}>
          <Sparkles />
          {job.matchReport === null ? "简历评估" : "重新评估"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onScript}>
          <MessageSquareText />
          话术管理
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onInterview}>
          <Users />
          模拟面试
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">数据</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil />
          编辑
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function JobEditDialog({
  target,
  companies,
  onClose,
  onSaved,
  onOverlayChange,
}: {
  target: Job | "new" | null;
  companies: Company[];
  onClose: () => void;
  onSaved: () => void;
  onOverlayChange: (open: boolean) => void;
}) {
  const isNew = target === "new";
  const [draft, setDraft] = useState({
    title: "",
    companyId: "none",
    url: "",
    salaryBand: "",
    jd: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (target === null) return;
    setError(null);
    setDraft(
      isNew
        ? { title: "", companyId: "none", url: "", salaryBand: "", jd: "" }
        : {
            title: target.title,
            companyId: target.companyId ?? "none",
            url: target.url,
            salaryBand: target.salaryBand,
            jd: target.jd,
          },
    );
  }, [target, isNew]);

  const submit = (): void => {
    if (draft.title.trim() === "") {
      setError("标题是必填的。");
      return;
    }
    setSaving(true);
    setError(null);
    const patch = {
      title: draft.title.trim(),
      companyId: draft.companyId === "none" ? null : draft.companyId,
      url: draft.url.trim(),
      salaryBand: draft.salaryBand.trim(),
      jd: draft.jd,
    };
    const request = isNew
      ? window.goodjob.jobs.create(patch)
      : window.goodjob.jobs.update((target as Job).id, patch);
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

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <DialogContent className="flex max-h-[86vh] flex-col gap-4 overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? "新建岗位" : "编辑岗位"}</DialogTitle>
          <DialogDescription>
            JD 建议粘贴原文（Markdown）；「简历评估」与定制简历都以它为准。
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          <div className="grid gap-1.5">
            <Label htmlFor="job-title">
              标题<span className="ml-0.5 text-destructive">*</span>
            </Label>
            <Input
              id="job-title"
              value={draft.title}
              placeholder="如：资深前端工程师"
              onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>公司</Label>
              <Select
                value={draft.companyId}
                onValueChange={(value) => setDraft((prev) => ({ ...prev, companyId: value }))}
                onOpenChange={onOverlayChange}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择公司" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">（不关联）</SelectItem>
                  {companies.map((company) => (
                    <SelectItem key={company.id} value={company.id}>
                      {company.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-salary">薪资带</Label>
              <Input
                id="job-salary"
                value={draft.salaryBand}
                placeholder="如：25-40k·16 薪"
                onChange={(event) => setDraft((prev) => ({ ...prev, salaryBand: event.target.value }))}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="job-url">链接</Label>
            <Input
              id="job-url"
              value={draft.url}
              placeholder="https://…"
              onChange={(event) => setDraft((prev) => ({ ...prev, url: event.target.value }))}
            />
          </div>
          <div className="grid min-h-40 flex-1 gap-1.5">
            <Label htmlFor="job-jd">JD 原文</Label>
            <Textarea
              id="job-jd"
              value={draft.jd}
              placeholder="粘贴岗位描述原文（Markdown）"
              className="min-h-40 flex-1 resize-none font-mono text-xs leading-relaxed"
              onChange={(event) => setDraft((prev) => ({ ...prev, jd: event.target.value }))}
            />
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

function DeleteDialog({
  job,
  onClose,
  onDeleted,
  onOverlayChange,
}: {
  job: Job | null;
  onClose: () => void;
  onDeleted: () => void;
  onOverlayChange: (open: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);

  const remove = (): void => {
    if (job === null) return;
    setSaving(true);
    void window.goodjob.jobs
      .remove(job.id)
      .then(() => {
        onClose();
        onDeleted();
      })
      .catch(() => setSaving(false));
  };

  return (
    <AlertDialog
      open={job !== null}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除「{job?.title}」？</AlertDialogTitle>
          <AlertDialogDescription>
            删除不做级联：这个岗位的定制简历、话术和投递记录都会保留，显示为悬空引用。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            disabled={saving}
            onClick={(event) => {
              event.preventDefault();
              remove();
            }}
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * 发起模拟面试（P3 M1）：选轮次与模式。文本可用；语音置灰提示（M2 等厂商清单）。
 * 前置校验在弹窗里给引导：无定制稿 → 去二级页生成；无 JD → 去编辑补上。
 * 真正的发起过模型门（建记录本身不调模型，但进场第一步就是面试官开始提问）。
 */
function InterviewStartDialog({
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
