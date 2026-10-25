import { useCallback, useEffect, useMemo, useState } from "react";

import type { UIMessage } from "ai";
import {
  BookOpenText,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import type { Company } from "@shared/types";

import { useBrowserTakeover, useConversationInitial, useModuleChat } from "@/components/chat/use-module-chat";
import { ChatPanel } from "@/components/ChatPanel";
import { MarkdownPreview } from "@/components/MarkdownPreview";
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
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { ModuleLoadingCard, type ModulePageProps } from "./module-page";
import { ResumeMarkdownEditor } from "./ResumeMarkdownEditor";
import { cmpText, cmpTime, formatTime, SortableHead, useTableSort } from "./table-bits";

const CHAT_MIN_WIDTH = 380;
const TABLE_MIN_WIDTH = 440;

type CompanyField = "name" | "industry" | "city" | "updatedAt";

/**
 * 「公司」模块页：左边是公司会话（Agent 有 CRUD 工具），右边是公司表。
 * 表格列：名称 / 行业 / 城市 / 更新时间（列头点击排序，内存 asc/desc）。
 * 调研快照单独开一个弹窗（MarkdownPreview 预览 + 源码编辑），不塞进表格。
 */
export function CompaniesPage(props: ModulePageProps) {
  const initial = useConversationInitial("companies");
  if (initial === null) return <ModuleLoadingCard />;
  return <CompaniesPageLoaded initialMessages={initial} {...props} />;
}

function CompaniesPageLoaded({
  initialMessages,
  models,
  onSelectModel,
  onOpenModelSettings,
  onOverlayChange,
}: ModulePageProps & { initialMessages: UIMessage[] }) {
  const chat = useModuleChat("companies", initialMessages);
  // 浏览器面板工具条「让 Agent 接管」：在本会话发一条起手指令（P4）。
  useBrowserTakeover(chat.send);

  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 编辑中的公司；draft 为空 id 表示新建。 */
  const [editing, setEditing] = useState<Company | "new" | null>(null);
  const [deleting, setDeleting] = useState<Company | null>(null);
  /** 查看调研快照的公司。 */
  const [researchOf, setResearchOf] = useState<Company | null>(null);

  const sort = useTableSort<CompanyField>("updatedAt", "desc");

  const reload = useCallback((): void => {
    setError(null);
    void window.goodjob.companies
      .list()
      .then(setCompanies)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, []);

  useEffect(() => reload(), [reload]);

  const sorted = useMemo(() => {
    if (companies === null) return null;
    const rows = [...companies];
    rows.sort((a, b) => {
      switch (sort.sortKey) {
        case "name":
          return sort.direction === "asc" ? cmpText(a.name, b.name) : cmpText(b.name, a.name);
        case "industry":
          return sort.direction === "asc"
            ? cmpText(a.industry, b.industry)
            : cmpText(b.industry, a.industry);
        case "city":
          return sort.direction === "asc" ? cmpText(a.city, b.city) : cmpText(b.city, a.city);
        default:
          return cmpTime(a.updatedAt, b.updatedAt, sort.direction);
      }
    });
    return rows;
  }, [companies, sort.sortKey, sort.direction]);

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel minSize={CHAT_MIN_WIDTH} defaultSize="45%">
        <div className="h-full overflow-hidden rounded-2xl bg-card shadow-sm">
          <ChatPanel
            messages={chat.messages}
            status={chat.status}
            errorText={chat.errorText}
            models={models}
            emptyTitle="维护你的公司库"
            emptyDescription="让 Agent 记录公司资料、整理调研结论；右边表格和它操作的是同一份数据。"
            placeholder="例如：帮我记录一家公司：字节跳动，互联网，北京，官网 bytedance.com"
            onSelectModel={onSelectModel}
            onOpenModelSettings={onOpenModelSettings}
            onOverlayChange={onOverlayChange}
            onSend={chat.send}
            onStop={chat.stop}
            onApprovalResponse={chat.respondApproval}
            conversationKey="companies"
          />
        </div>
      </ResizablePanel>
      {/* 8px 间隙里的一条可拖拽细线：既是分隔提示，也是拖拽热区。 */}
      <ResizableHandle className="mx-1 w-1 justify-self-center rounded-full bg-border/60 transition-colors after:hidden hover:bg-border data-[separator]:bg-border/60" />
      <ResizablePanel minSize={TABLE_MIN_WIDTH} defaultSize="55%">
        <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl bg-card shadow-sm">
          {/* 表卡头：标题 + 新建入口；错误提示贴在这里（操作失败不说谎）。 */}
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
            <span className="text-sm font-medium">公司</span>
            {companies !== null && (
              <span className="text-xs text-muted-foreground">{companies.length}</span>
            )}
            {error !== null && (
              <span className="min-w-0 flex-1 truncate text-xs text-destructive" title={error}>
                {error}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <Button size="sm" onClick={() => setEditing("new")}>
                <Plus />
                新建公司
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
                    <EmptyTitle>还没有公司</EmptyTitle>
                    <EmptyDescription>
                      新建一条，或直接在左边对话里让 Agent 记录；岗位可以引用公司。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : (
              <Table className="group/head">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <SortableHead label="名称" sortKey="name" table={sort} className="pl-4" />
                    <SortableHead label="行业" sortKey="industry" table={sort} />
                    <SortableHead label="城市" sortKey="city" table={sort} />
                    <SortableHead label="更新时间" sortKey="updatedAt" table={sort} />
                    <TableHead className="w-10 pr-3" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((company) => (
                    <TableRow key={company.id}>
                      <TableCell className="pl-4 font-medium">{company.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {company.industry === "" ? "—" : company.industry}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {company.city === "" ? "—" : company.city}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        {formatTime(company.updatedAt)}
                      </TableCell>
                      <TableCell className="pr-3 text-right">
                        <RowMenu
                          company={company}
                          onEdit={() => setEditing(company)}
                          onResearch={() => setResearchOf(company)}
                          onDelete={() => setDeleting(company)}
                          onOverlayChange={onOverlayChange}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      </ResizablePanel>

      <CompanyEditDialog
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={reload}
        onOverlayChange={onOverlayChange}
      />
      <ResearchDialog
        company={researchOf}
        onClose={() => setResearchOf(null)}
        onSaved={reload}
        onOverlayChange={onOverlayChange}
      />
      <DeleteDialog
        company={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={reload}
        onOverlayChange={onOverlayChange}
      />
    </ResizablePanelGroup>
  );
}

/** 行尾「⋯」菜单：编辑 / 调研快照 / 删除。 */
function RowMenu({
  company,
  onEdit,
  onResearch,
  onDelete,
  onOverlayChange,
}: {
  company: Company;
  onEdit: () => void;
  onResearch: () => void;
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
          aria-label={`「${company.name}」的操作`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil />
          编辑资料
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onResearch}>
          <BookOpenText />
          调研快照
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const EDIT_FIELDS = [
  { key: "name", label: "名称", required: true, placeholder: "如：字节跳动" },
  { key: "industry", label: "行业", required: false, placeholder: "如：互联网 / 教育" },
  { key: "scale", label: "规模", required: false, placeholder: "如：10000+ 人" },
  { key: "city", label: "城市", required: false, placeholder: "如：北京" },
  { key: "website", label: "官网", required: false, placeholder: "https://…" },
  { key: "source", label: "来源", required: false, placeholder: "内推 / 招聘平台 / 官网" },
] as const;

function CompanyEditDialog({
  target,
  onClose,
  onSaved,
  onOverlayChange,
}: {
  target: Company | "new" | null;
  onClose: () => void;
  onSaved: () => void;
  onOverlayChange: (open: boolean) => void;
}) {
  const isNew = target === "new";
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (target === null) return;
    setError(null);
    setDraft(
      isNew
        ? {}
        : {
            name: target.name,
            industry: target.industry,
            scale: target.scale,
            city: target.city,
            website: target.website,
            source: target.source,
          },
    );
  }, [target, isNew]);

  const submit = (): void => {
    if (draft.name?.trim() === "" || draft.name === undefined) {
      setError("名称是必填的。");
      return;
    }
    setSaving(true);
    setError(null);
    const patch = {
      name: draft.name?.trim() ?? "",
      industry: draft.industry?.trim() ?? "",
      scale: draft.scale?.trim() ?? "",
      city: draft.city?.trim() ?? "",
      website: draft.website?.trim() ?? "",
      source: draft.source?.trim() ?? "",
    };
    const request = isNew
      ? window.goodjob.companies.create(patch)
      : window.goodjob.companies.update((target as Company).id, patch);
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isNew ? "新建公司" : "编辑公司"}</DialogTitle>
          <DialogDescription>
            调研结论不在这里：用行菜单里的「调研快照」单独维护（Markdown）。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {EDIT_FIELDS.map((field) => (
            <div key={field.key} className="grid gap-1.5">
              <Label htmlFor={`company-${field.key}`}>
                {field.label}
                {field.required && <span className="ml-0.5 text-destructive">*</span>}
              </Label>
              <Input
                id={`company-${field.key}`}
                value={draft[field.key] ?? ""}
                placeholder={field.placeholder}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, [field.key]: event.target.value }))
                }
              />
            </div>
          ))}
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

/** 调研快照：预览（模板排版）/ 编辑（Markdown 源码）两个模式。 */
function ResearchDialog({
  company,
  onClose,
  onSaved,
  onOverlayChange,
}: {
  company: Company | null;
  onClose: () => void;
  onSaved: () => void;
  onOverlayChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (company === null) return;
    setMode("preview");
    setError(null);
    setDraft(company.research);
  }, [company]);

  const save = (): void => {
    if (company === null) return;
    setSaving(true);
    setError(null);
    void window.goodjob.companies
      .update(company.id, { research: draft })
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
      open={company !== null}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <DialogContent className="flex h-[min(80vh,680px)] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{company === null ? "" : `${company.name} · 调研快照`}</DialogTitle>
          <DialogDescription>
            {company !== null && company.researchedAt !== null
              ? `最近更新 ${formatTime(company.researchedAt)}`
              : "由你或 Agent 整理的公开信息（Markdown），标注来源与时间。"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1">
          <ModeChip active={mode === "preview"} onClick={() => setMode("preview")}>
            预览
          </ModeChip>
          <ModeChip active={mode === "edit"} onClick={() => setMode("edit")}>
            编辑
          </ModeChip>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60">
          {mode === "preview" ? (
            <MarkdownPreview
              markdown={draft}
              emptyText="还没有调研快照。切到「编辑」写一份，或直接在左边对话里让 Agent 整理。"
            />
          ) : (
            <ResumeMarkdownEditor
              value={draft}
              onChange={setDraft}
              placeholder="用 Markdown 整理：业务、产品、规模、融资、面试评价…标注来源与时间"
            />
          )}
        </div>

        {error !== null && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button disabled={saving} onClick={save}>
            保存快照
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  company,
  onClose,
  onDeleted,
  onOverlayChange,
}: {
  company: Company | null;
  onClose: () => void;
  onDeleted: () => void;
  onOverlayChange: (open: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);

  const remove = (): void => {
    if (company === null) return;
    setSaving(true);
    void window.goodjob.companies
      .remove(company.id)
      .then(() => {
        onClose();
        onDeleted();
      })
      .catch(() => setSaving(false));
  };

  return (
    <AlertDialog
      open={company !== null}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除「{company?.name}」？</AlertDialogTitle>
          <AlertDialogDescription>
            删除不做级联：引用它的岗位会显示为「公司已删除」，但不会被删。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            disabled={saving}
            onClick={(event) => {
              // 阻止默认关闭：等 remove 成功后再由父级收弹窗。
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

function ModeChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      className={cn(
        "rounded-lg px-2.5",
        active ? "bg-muted text-foreground" : "text-muted-foreground",
      )}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
