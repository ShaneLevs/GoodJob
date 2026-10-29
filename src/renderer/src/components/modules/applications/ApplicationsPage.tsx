import { useCallback, useEffect, useMemo, useState } from "react";

import {
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
} from "@shared/types";

import { ChatPanel } from "@/components/chat/ChatPanel";
import { ConversationPane } from "@/components/chat/conversation-pane";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

import { DeleteDialog } from "../shared/DeleteDialog";
import { AdvanceDialog } from "./AdvanceDialog";
import { ApplicationEditDialog } from "./ApplicationEditDialog";
import { OfferCompareDialog } from "./OfferCompareDialog";
import { PipelineDialog } from "./PipelineDialog";
import type { ModulePageProps } from "../shared/module-page";
import { useDomainChange } from "../shared/use-domain-change";
import { cmpNumber, cmpText, cmpTime, SortableHead, stageDotClass, useTableSort } from "../shared/table-bits";
import { formatTime } from "@/lib/format";

const CHAT_MIN_WIDTH = 380;
const TABLE_MIN_WIDTH = 560;

type AppField = "job" | "company" | "stage" | "lastAt" | "offer";

export function ApplicationsPage({
  models,
  onSelectModel,
  onOpenModelSettings,
  onOverlayChange,
  onOpenBrowser,
}: ModulePageProps) {
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
  // Agent 改投递 / 岗位时刷新（岗位标题在表里要跟着变）。
  useDomainChange(["applications", "jobs"], reload);

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
          <ConversationPane scope="applications" takeover onOverlayChange={onOverlayChange}>
            {(chat, conversation) => (
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
        open={deleting !== null}
        title={`删除这条投递？`}
        description="只删这条投递记录；岗位、简历和话术都不受影响。删除前请确认——历史不保留。"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting === null) return;
          await window.goodjob.applications.remove(deleting.id);
          reload();
        }}
        onOverlayChange={onOverlayChange}
      />
    </ResizablePanelGroup>
  );
}
