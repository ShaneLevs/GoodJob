import { useEffect, useState } from "react";

import { BadgeCheck, FileSignature, LoaderCircle, PencilLine } from "lucide-react";

import type { Job, ScriptDoc } from "@shared/types";

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
import { DocumentPreview } from "@/components/document/DocumentPreview";
import { cn } from "@/lib/utils";

import { ResumeMarkdownEditor } from "../shared/ResumeMarkdownEditor";
import { formatTime } from "@/lib/format";

/**
 * 话术管理弹窗（与岗位 1:1，scripts/<jobId>.md + 定稿 sidecar）：
 * 预览 = DocumentPreview，编辑 = Markdown 源码；「标记定稿」写 sidecar
 * （final / finalizedAt / 指纹）。定稿后仍可编辑，改过会提示「待重新定稿」。
 * 生成初稿不在本地伪造：交给岗位二级工作台的会话 Agent（onGenerate 跳转）。
 */
export function ScriptDialog({
  job,
  onClose,
  onOverlayChange,
  onSaved,
  onGenerate,
}: {
  job: Job | null;
  onClose: () => void;
  onOverlayChange: (open: boolean) => void;
  /** 保存 / 定稿后让父级重拉话术列表（表格列状态要跟着变）。 */
  onSaved: () => void;
  /** 「生成初稿」：跳到该岗位的二级工作台并自动让 Agent 起草。 */
  onGenerate: (jobId: string) => void;
}) {
  const [doc, setDoc] = useState<ScriptDoc | null>(null);
  const [content, setContent] = useState<string | null>(null);
  /** 磁盘上的内容，用来算「有修改」。 */
  const [disk, setDisk] = useState("");
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (job === null) return;
    setMode("preview");
    setError(null);
    setDoc(null);
    setContent(null);
    setDisk("");
    let alive = true;
    void window.goodjob.resume.scripts
      .read(job.id)
      .then((result) => {
        if (!alive) return;
        setDoc(result?.doc ?? null);
        setContent(result?.content ?? "");
        setDisk(result?.content ?? "");
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [job]);

  const save = (): void => {
    if (job === null || content === null) return;
    const text = content;
    setBusy(true);
    setError(null);
    void window.goodjob.resume.scripts
      .save(job.id, text)
      .then((next) => {
        setDoc(next);
        setDisk(text);
        onSaved();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  const finalize = (): void => {
    if (job === null || content === null) return;
    // 定稿针对磁盘内容：先把本地修改落盘再定稿，避免「定稿的不是刚看到的」。
    const text = content;
    setBusy(true);
    setError(null);
    void window.goodjob.resume.scripts
      .save(job.id, text)
      .then(() => window.goodjob.resume.scripts.finalize(job.id))
      .then((next) => {
        setDoc(next);
        setDisk(text);
        onSaved();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  const dirty = content !== null && content !== disk;

  return (
    <Dialog
      open={job !== null}
      onOpenChange={(next) => {
        onOverlayChange(next);
        if (!next) onClose();
      }}
    >
      <DialogContent className="flex h-[min(80vh,680px)] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <FileSignature className="size-4 text-muted-foreground" />
            {job === null ? "" : `${job.title} · 面试话术`}
            {doc !== null && <ScriptStatusBadge doc={doc} />}
          </DialogTitle>
          <DialogDescription>
            结构约定：自我介绍 / 项目深挖（预判 JD 相关问题给要点式回答）/ 反问环节。
            定稿锁定的是供引用的版本，之后仍可继续编辑。
          </DialogDescription>
        </DialogHeader>

        {content === null ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            正在读取…
          </div>
        ) : doc === null ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
              还没有这个岗位的话术。初稿由 Agent 基于主简历与 JD 生成——
              会打开该岗位的工作台自动起草，写完后这里可以直接编辑和定稿。
            </p>
            <Button onClick={() => job !== null && onGenerate(job.id)}>
              <FileSignature />
              让 Agent 生成初稿
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1">
              <ModeChip active={mode === "preview"} onClick={() => setMode("preview")}>
                预览
              </ModeChip>
              <ModeChip active={mode === "edit"} onClick={() => setMode("edit")}>
                编辑
              </ModeChip>
              {doc.final && doc.finalizedAt !== null && (
                <span className="ml-2 text-xs text-muted-foreground">
                  定稿于 {formatTime(doc.finalizedAt)}
                </span>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60">
              {mode === "preview" ? (
                <DocumentPreview
                  markdown={content}
                  emptyText="话术还是空的：切到「编辑」写一版，或让 Agent 生成初稿。"
                />
              ) : (
                <ResumeMarkdownEditor
                  value={content}
                  onChange={setContent}
                  placeholder={"# 自我介绍\n\n# 项目深挖\n\n# 反问环节"}
                />
              )}
            </div>

            {error !== null && <p className="text-xs text-destructive">{error}</p>}

            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                关闭
              </Button>
              <Button variant="outline" disabled={busy} onClick={finalize}>
                <BadgeCheck />
                {doc.final && !doc.modifiedSinceFinal ? "重新定稿" : "标记定稿"}
              </Button>
              <Button disabled={busy} onClick={save}>
                <PencilLine />
                保存{dirty ? "（有修改）" : ""}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 话术状态徽标：表格列与弹窗共用一套口径。 */
export function ScriptStatusBadge({ doc }: { doc: ScriptDoc }) {
  if (doc.modifiedSinceFinal) {
    return (
      <Badge variant="destructive" className="gap-1">
        待重新定稿
      </Badge>
    );
  }
  if (doc.final) {
    return (
      <Badge variant="secondary" className="gap-1">
        <BadgeCheck />
        已定稿
      </Badge>
    );
  }
  return <Badge variant="outline">草稿</Badge>;
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
