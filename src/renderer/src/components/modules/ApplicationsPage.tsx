import { useCallback, useEffect, useMemo, useState } from "react";

import type { UIMessage } from "ai";
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  GitCompareArrows,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";

import type {
  Application,
  Company,
  Job,
  PipelineConfig,
  PipelineStage,
} from "@shared/types";

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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { ModuleLoadingCard, type ModulePageProps } from "./module-page";
import { cmpNumber, cmpText, cmpTime, formatTime, SortableHead, stageDotClass, useTableSort } from "./table-bits";

const CHAT_MIN_WIDTH = 380;
const TABLE_MIN_WIDTH = 560;

type AppField = "job" | "company" | "stage" | "lastAt" | "offer";

export function ApplicationsPage(props: ModulePageProps) {
  const initial = useConversationInitial("applications");
  if (initial === null) return <ModuleLoadingCard />;
  return <ApplicationsPageLoaded initialMessages={initial} {...props} />;
}

function ApplicationsPageLoaded({
  initialMessages,
  models,
  onSelectModel,
  onOpenModelSettings,
  onOverlayChange,
}: ModulePageProps & { initialMessages: UIMessage[] }) {
  const chat = useModuleChat("applications", initialMessages);
  // 浏览器面板工具条「让 Agent 接管」：在本会话发一条起手指令（P4）。
  useBrowserTakeover(chat.send);

  const [applications, setApplications] = useState<Application[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [pipeline, setPipeline] = useState<PipelineConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Application | "new" | null>(null);
  const [deleting, setDeleting] = useState<Application | null>(null);
  const [advancing, setAdvancing] = useState<Application | null>(null);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  /** 勾选了要对比 Offer 的投递 id（只有含 Offer 的行给勾选框）。 */
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const sort = useTableSort<AppField>("lastAt", "desc");

  const reload = useCallback((): void => {
    setError(null);
    void window.goodjob.applications
      .list()
      .then(setApplications)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    void window.goodjob.jobs.list().then(setJobs).catch(() => setJobs([]));
    void window.goodjob.companies.list().then(setCompanies).catch(() => setCompanies([]));
    void window.goodjob.pipeline.get().then(setPipeline).catch(() => setPipeline(null));
  }, []);

  useEffect(() => reload(), [reload]);

  const jobOf = useCallback(
    (appId: string | null): { job: Job | null; title: string; dangling: boolean } => {
      if (appId === null) return { job: null, title: "（未关联岗位）", dangling: false };
      const job = jobs.find((item) => item.id === appId) ?? null;
      if (job === null) return { job: null, title: "岗位已删除", dangling: true };
      return { job, title: job.title, dangling: false };
    },
    [jobs],
  );

  const companyNameOf = useCallback(
    (job: Job | null): string => {
      if (job === null || job.companyId === null) return "";
      return companies.find((item) => item.id === job.companyId)?.name ?? "公司已删除";
    },
    [companies],
  );

  /** 当前状态 = 时间线最后一条；阶段序号来自流水线（未配置时按名字找不到给 -1）。 */
  const stageOf = useCallback(
    (app: Application): { name: string; index: number; final: boolean; at: string | null } => {
      const last = app.timeline.at(-1) ?? null;
      if (last === null) return { name: "未开始", index: -1, final: false, at: null };
      const index = (pipeline?.stages ?? []).findIndex((stage) => stage.name === last.stage);
      const final = (pipeline?.stages ?? [])[index]?.final ?? false;
      return { name: last.stage, index, final, at: last.at };
    },
    [pipeline],
  );

  const offerRank = (app: Application): number => (app.offer !== null ? 1 : 0);

  const sorted = useMemo(() => {
    if (applications === null) return null;
    const rows = [...applications];
    rows.sort((a, b) => {
      const asc = sort.direction === "asc";
      switch (sort.sortKey) {
        case "job": {
          const left = jobOf(a.jobId).title;
          const right = jobOf(b.jobId).title;
          return asc ? cmpText(left, right) : cmpText(right, left);
        }
        case "company": {
          const left = companyNameOf(jobOf(a.jobId).job);
          const right = companyNameOf(jobOf(b.jobId).job);
          return asc ? cmpText(left, right) : cmpText(right, left);
        }
        case "stage": {
          // 阶段排序按流水线序号（看板分组同源）；未开始的排最前。
          const left = stageOf(a).index;
          const right = stageOf(b).index;
          return asc ? left - right : right - left;
        }
        case "offer":
          return cmpNumber(offerRank(a), offerRank(b), sort.direction);
        default:
          return cmpTime(stageOf(a).at, stageOf(b).at, sort.direction);
      }
    });
    return rows;
  }, [applications, sort.sortKey, sort.direction, jobOf, companyNameOf, stageOf]);

  const selectedApps = useMemo(
    () => (applications ?? []).filter((app) => selected.has(app.id)),
    [applications, selected],
  );

  const toggleSelected = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
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
            emptyTitle="管理你的投递"
            emptyDescription="让 Agent 记录投递、推进状态；阶段不够用（比如「四面」）在右边「流水线」里加。"
            placeholder="例如：把字节的那个岗位标记为简历通过"
            onSelectModel={onSelectModel}
            onOpenModelSettings={onOpenModelSettings}
            onOverlayChange={onOverlayChange}
            onSend={chat.send}
            onStop={chat.stop}
            onApprovalResponse={chat.respondApproval}
            conversationKey="applications"
          />
        </div>
      </ResizablePanel>
      {/* 8px 间隙里的一条可拖拽细线：既是分隔提示，也是拖拽热区。 */}
      <ResizableHandle className="mx-1 w-1 justify-self-center rounded-full bg-border/60 transition-colors after:hidden hover:bg-border data-[separator]:bg-border/60" />
      <ResizablePanel minSize={TABLE_MIN_WIDTH} defaultSize="58%">
        <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl bg-card shadow-sm">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
            <span className="text-sm font-medium">投递</span>
            {applications !== null && (
              <span className="text-xs text-muted-foreground">{applications.length}</span>
            )}
            {error !== null && (
              <span className="min-w-0 flex-1 truncate text-xs text-destructive" title={error}>
                {error}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {selected.size >= 2 && (
                <Button variant="outline" size="sm" onClick={() => setCompareOpen(true)}>
                  <GitCompareArrows />
                  对比 Offer（{selected.size}）
                </Button>
              )}
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setPipelineOpen(true)}>
                <Settings2 />
                流水线
              </Button>
              <Button size="sm" onClick={() => setEditing("new")}>
                <Plus />
                新建投递
              </Button>
            </div>
          </div>

          {/* @container：岗位列的截断下限按容器宽度分段（见下方 TableCell），横向
              滚动条只在真的放不下时出现。 */}
          <div className="@container min-h-0 flex-1 overflow-auto">
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
                    <EmptyTitle>还没有投递</EmptyTitle>
                    <EmptyDescription>
                      新建一条投递并推进状态；含 Offer 的投递可以勾选后横向对比。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-8 pl-4" aria-label="勾选对比 Offer" />
                    <SortableHead label="岗位" sortKey="job" table={sort} />
                    <SortableHead label="公司" sortKey="company" table={sort} />
                    <SortableHead label="当前状态" sortKey="stage" table={sort} />
                    <SortableHead label="最近推进" sortKey="lastAt" table={sort} />
                    <SortableHead label="Offer" sortKey="offer" table={sort} />
                    <TableHead className="w-10 pr-3" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((app) => {
                    const { job, title, dangling } = jobOf(app.jobId);
                    const stage = stageOf(app);
                    return (
                      <TableRow key={app.id} data-selected={selected.has(app.id) || undefined}>
                        <TableCell className="pl-4">
                          {app.offer !== null && (
                            <Checkbox
                              aria-label={`对比「${title}」的 Offer`}
                              checked={selected.has(app.id)}
                              onCheckedChange={() => toggleSelected(app.id)}
                            />
                          )}
                        </TableCell>
                        <TableCell
                          className={cn(
                            // 截断列是唯一的弹性列：窄面板把它的 min-content 下限降
                            // 到 max-w-20，避免 nowrap 列头/时间列撑出常驻横向滚动条；
                            // 容器 ≥@2xl（672px）恢复 max-w-52，宽面板行为不变。
                            "max-w-20 truncate font-medium @2xl:max-w-52",
                            dangling && "text-destructive",
                          )}
                          title={title}
                        >
                          {dangling && <CircleAlert className="mr-1 inline size-3" />}
                          {title}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {companyNameOf(job) === "" ? "—" : companyNameOf(job)}
                        </TableCell>
                        <TableCell>
                          {/* 可分组字段（看板预留）：色点 = 阶段在流水线里的序号。 */}
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <span className={cn("size-1.5 rounded-full", stageDotClass(stage.index))} />
                            <span>{stage.name}</span>
                            {stage.final && (
                              <span className="text-muted-foreground" title="终态">
                                ∎
                              </span>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">
                          {formatTime(stage.at)}
                        </TableCell>
                        <TableCell>
                          {app.offer === null ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            <span className="text-xs" title={`${app.offer.equity} ${app.offer.note}`}>
                              {app.offer.salary === "" ? "有 Offer" : app.offer.salary}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="pr-3 text-right">
                          <DropdownMenu onOpenChange={onOverlayChange}>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-muted-foreground"
                                aria-label={`「${title}」的操作`}
                              >
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                              <DropdownMenuItem onSelect={() => setAdvancing(app)}>
                                <GitCompareArrows className="rotate-90" />
                                推进状态
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => setEditing(app)}>
                                <Pencil />
                                编辑
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(app)}>
                                <Trash2 />
                                删除
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
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

      <AdvanceDialog
        app={advancing}
        pipeline={pipeline}
        stageOf={stageOf}
        onClose={() => setAdvancing(null)}
        onSaved={reload}
        onOverlayChange={onOverlayChange}
      />
      <ApplicationEditDialog
        target={editing}
        jobs={jobs}
        onClose={() => setEditing(null)}
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
        apps={selectedApps}
        jobs={jobs}
        companies={companies}
        pipeline={pipeline}
        onClose={() => setCompareOpen(false)}
        onOverlayChange={onOverlayChange}
      />
      <DeleteDialog
        app={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={reload}
        onOverlayChange={onOverlayChange}
      />
    </ResizablePanelGroup>
  );
}

/** 推进状态：只能顺流（选当前阶段之后的阶段），时间自动取当前时刻。 */
function AdvanceDialog({
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

function ApplicationEditDialog({
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

/** 流水线设置：阶段增删 / 改名 / 排序 / 终态标记（工作区级，存 applications/pipeline.json）。 */
function PipelineDialog({
  open,
  config,
  onClose,
  onSaved,
  onOverlayChange,
}: {
  open: boolean;
  config: PipelineConfig | null;
  onClose: () => void;
  onSaved: (config: PipelineConfig) => void;
  onOverlayChange: (open: boolean) => void;
}) {
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || config === null) return;
    setError(null);
    setStages(config.stages.map((stage) => ({ ...stage })));
  }, [open, config]);

  const patch = (index: number, changes: Partial<PipelineStage>): void => {
    setStages((prev) => prev.map((stage, i) => (i === index ? { ...stage, ...changes } : stage)));
  };

  const move = (index: number, delta: -1 | 1): void => {
    setStages((prev) => {
      const to = index + delta;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const left = next[index];
      const right = next[to];
      if (left === undefined || right === undefined) return prev;
      next[index] = right;
      next[to] = left;
      return next;
    });
  };

  const save = (): void => {
    setSaving(true);
    setError(null);
    void window.goodjob.pipeline
      .save({ stages })
      .then((saved) => {
        onSaved(saved);
        onClose();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>投递状态流水线</DialogTitle>
          <DialogDescription>
            工作区级配置：阶段有序、名字唯一，至少一个终态；不同公司的二面 / 三面 / 四面按需自己加。
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-80 gap-1.5 overflow-y-auto pr-1">
          {stages.map((stage, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                value={stage.name}
                aria-label={`阶段 ${index + 1} 名称`}
                className="h-8"
                onChange={(event) => patch(index, { name: event.target.value })}
              />
              <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <Switch
                  checked={stage.final}
                  aria-label={`「${stage.name}」是否终态`}
                  onCheckedChange={(checked) => patch(index, { final: checked })}
                />
                终态
              </label>
              <div className="flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="上移"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="下移"
                  disabled={index === stages.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  aria-label={`删除阶段「${stage.name}」`}
                  disabled={stages.length <= 1}
                  onClick={() => setStages((prev) => prev.filter((_, i) => i !== index))}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setStages((prev) => [...prev, { name: "", final: false }])}
          >
            <Plus />
            添加阶段
          </Button>
        </div>

        {error !== null && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={saving} onClick={save}>
            保存流水线
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Offer 对比：勾选的多条含 Offer 投递 → 一行一个维度的对比表。 */
function OfferCompareDialog({
  open,
  apps,
  jobs,
  companies,
  pipeline,
  onClose,
  onOverlayChange,
}: {
  open: boolean;
  apps: Application[];
  jobs: Job[];
  companies: Company[];
  pipeline: PipelineConfig | null;
  onClose: () => void;
  onOverlayChange: (open: boolean) => void;
}) {
  const rows = useMemo(() => {
    const jobOf = (app: Application): { job: Job | null; title: string } => {
      const job = jobs.find((item) => item.id === app.jobId) ?? null;
      return { job, title: job?.title ?? "岗位已删除" };
    };
    return apps.map((app) => {
      const { job, title } = jobOf(app);
      const companyName =
        job === null || job.companyId === null
          ? "—"
          : companies.find((item) => item.id === job.companyId)?.name ?? "公司已删除";
      const stage = app.timeline.at(-1)?.stage ?? "未开始";
      return {
        id: app.id,
        title,
        companyName,
        stage: (pipeline?.stages ?? []).some((item) => item.name === stage) ? stage : `${stage}（不在流水线）`,
        salary: app.offer?.salary ?? "",
        equity: app.offer?.equity ?? "",
        note: app.offer?.note ?? "",
      };
    });
  }, [apps, jobs, companies, pipeline]);

  const dimensions: { key: keyof (typeof rows)[number]; label: string }[] = [
    { key: "title", label: "岗位" },
    { key: "companyName", label: "公司" },
    { key: "stage", label: "当前状态" },
    { key: "salary", label: "薪资" },
    { key: "equity", label: "期权 / 其他" },
    { key: "note", label: "条款备注" },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Offer 对比</DialogTitle>
          <DialogDescription>勾选的 {rows.length} 条含 Offer 的投递，一行一个维度。</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-3 text-muted-foreground">维度</TableHead>
                {rows.map((row) => (
                  <TableHead key={row.id} className="min-w-32 font-medium">
                    {row.title}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {dimensions.map((dimension) => (
                <TableRow key={dimension.key}>
                  <TableCell className="pl-3 text-xs text-muted-foreground">{dimension.label}</TableCell>
                  {rows.map((row) => (
                    <TableCell key={row.id} className="text-xs whitespace-normal">
                      {row[dimension.key] === "" ? "—" : row[dimension.key]}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  app,
  onClose,
  onDeleted,
  onOverlayChange,
}: {
  app: Application | null;
  onClose: () => void;
  onDeleted: () => void;
  onOverlayChange: (open: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);

  const remove = (): void => {
    if (app === null) return;
    setSaving(true);
    void window.goodjob.applications
      .remove(app.id)
      .then(() => {
        onClose();
        onDeleted();
      })
      .catch(() => setSaving(false));
  };

  return (
    <AlertDialog
      open={app !== null}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除这条投递？</AlertDialogTitle>
          <AlertDialogDescription>
            只删这条投递记录；岗位、简历和话术都不受影响。删除前请确认——历史不保留。
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
