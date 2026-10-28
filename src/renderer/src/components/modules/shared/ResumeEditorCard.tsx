import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CircleAlert, FileDown, Gauge, Save } from "lucide-react";

import type { ResumeDocTarget, ResumeFileEvent } from "@shared/types";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  extractPhotoDirective,
  extractUploadImagePaths,
} from "@/components/document/render";

import { DocumentPreview } from "@/components/document/DocumentPreview";

import { ResumeMarkdownEditor } from "./ResumeMarkdownEditor";

type EditorMode = "edit" | "preview";

/** 正文引用的 upload/ 图片 → main 读出的 data URL；读不到的图片不放进映射。 */
async function resolveUploadImages(paths: readonly string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    paths.map(async (path) => {
      try {
        return [path, await window.goodjob.resume.photo(path)] as const;
      } catch {
        return [path, null] as const;
      }
    }),
  );
  const urls: Record<string, string> = {};
  for (const [path, url] of entries) {
    if (url !== null) urls[path] = url;
  }
  return urls;
}

interface ResumeEditorCardProps {
  /** 打开的文件：主简历正文，或某份岗位定制稿（name = jobId）。 */
  target: ResumeDocTarget;
  /** 预览空状态的提示文案（主简历 / 定制稿各给各的）。 */
  emptyText: string;
  /** 导出 PDF 的预填文件名（不含扩展名）；缺省用简历名。 */
  exportFileName?: string;
  /** 提供了才显示「完整性」按钮（打开完整性评分报告弹窗）；只有主简历有报告。 */
  onOpenReport?: () => void;
}

/**
 * 简历文档的编辑器卡：编辑（Markdown 源码）/ 预览（模板排版）两个模式。
 * 主简历页与岗位二级工作台参数化复用同一份组件（target 决定读写哪个文件）。
 * 共编协议：磁盘是唯一事实——Agent 写入经 onFileChanged 广播，非脏时热更新；
 * 有未保存修改时弹冲突条让用户二选一。用户保存前 main 会自动快照旧版。
 * 工具条右侧的「PDF」把当前内容（含未保存修改）交给 main 的导出管线。
 */
export function ResumeEditorCard({
  target,
  emptyText,
  exportFileName,
  onOpenReport,
}: ResumeEditorCardProps) {
  const [mode, setMode] = useState<EditorMode>("preview");
  /** 磁盘上的内容；null = 还没加载。 */
  const [content, setContent] = useState<string | null>(null);
  /** 当前内容（含未保存修改），编辑和预览共用同一份。 */
  const [draft, setDraft] = useState("");
  const [conflict, setConflict] = useState<ResumeFileEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 导出之类的瞬时回执（成功提示），几秒后自己消失。 */
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  /** read 回执里的简历名，导出文件名的缺省值。 */
  const [docName, setDocName] = useState<string | null>(null);
  /** 正文引用的 upload/ 图片 → data URL；预览与导出共用。 */
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});

  const dirtyRef = useRef(false);
  const dirty = content !== null && draft !== content;
  dirtyRef.current = dirty;

  const fileKey = target.kind === "main" ? "main" : target.name;
  const documentBody = useMemo(() => extractPhotoDirective(draft).markdown, [draft]);
  const imageSources = useMemo(() => extractUploadImagePaths(documentBody), [documentBody]);

  const applyContent = useCallback((text: string): void => {
    setContent(text);
    setDraft(text);
  }, []);

  // —— 挂载时读一次当前文件（切工作区 / 换岗位时由父级 remount）——
  useEffect(() => {
    let alive = true;
    void window.goodjob.resume.read(target).then((doc) => {
      if (!alive) return;
      applyContent(doc?.content ?? "");
      setDocName(doc?.name ?? null);
    });
    return () => {
      alive = false;
    };
  }, [applyContent, target]);

  // —— Agent / 其他来源写入文件：非脏热更新，脏则冲突条 ——
  useEffect(() => {
    return window.goodjob.resume.onFileChanged((event) => {
      if (event.file !== fileKey) return;

      if (dirtyRef.current) {
        setConflict(event);
        return;
      }
      void window.goodjob.resume.read(target).then((doc) => {
        if (doc !== null) applyContent(doc.content);
      });
    });
  }, [applyContent, fileKey, target]);

  // —— 正文引用的 upload/ 图片 → 让 main 读成小图 data URL（预览与导出共用）——
  useEffect(() => {
    let alive = true;
    if (imageSources.length === 0) {
      setImageUrls({});
      return;
    }
    void resolveUploadImages(imageSources).then((urls) => {
      if (alive) setImageUrls(urls);
    });
    return () => {
      alive = false;
    };
  }, [fileKey, imageSources]);

  useEffect(() => {
    if (notice === null) return;
    const timeout = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timeout);
  }, [notice]);

  const save = useCallback((): void => {
    if (!dirty || content === null) return;
    setError(null);
    void window.goodjob.resume
      .save(target, draft)
      .then((doc) => {
        if (doc === null) return;
        setContent(doc.content);
        setConflict(null);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [dirty, content, draft, target]);

  const exportPdf = useCallback((): void => {
    if (draft.trim() === "" || exporting) return;
    setError(null);
    setExporting(true);
    // 导出不走模型：排版复用预览管线（main 起隐藏窗口渲染后 printToPDF）。
    // 图片按当前 draft 重新取一次，避免改完图片引用立刻导出时拿到旧图。
    void resolveUploadImages(imageSources)
      .then((urls) =>
        window.goodjob.pdf.export({
          markdown: draft,
          fileName: exportFileName ?? docName ?? undefined,
          imageUrls: Object.keys(urls).length > 0 ? urls : undefined,
        }),
      )
      .then((result) => {
        if (result !== null) setNotice(`已导出：${result.savedTo}`);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setExporting(false));
  }, [draft, exporting, exportFileName, docName, imageSources]);

  // Cmd/Ctrl + S 保存（两个模式下都要能用）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl bg-card shadow-sm">
      {/* 卡片头：左边编辑/预览切换，右边保存与导出（切换 / 上传 / 浏览都不在这里）。 */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-2.5">
        <div className="flex items-center rounded-xl bg-foreground/[0.06] p-0.5" role="group" aria-label="简历视图">
          <ModeButton active={mode === "edit"} onClick={() => setMode("edit")}>
            编辑
          </ModeButton>
          <ModeButton active={mode === "preview"} onClick={() => setMode("preview")}>
            预览
          </ModeButton>
        </div>
        <div className="flex items-center gap-1.5">
          {(error !== null || notice !== null) && (
            <span
              className={cn(
                "max-w-64 truncate text-xs",
                error !== null ? "text-destructive" : "text-muted-foreground",
              )}
              title={error ?? notice ?? undefined}
            >
              {error ?? notice}
            </span>
          )}
          <span className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <span
              className={cn(
                "size-1.5 rounded-full",
                dirty ? "bg-[var(--status-warn)]" : "bg-[var(--status-on)]",
              )}
            />
            {dirty ? "未保存" : "已保存"}
          </span>
          {onOpenReport !== undefined && (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onOpenReport}>
              <Gauge />
              完整性
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={draft.trim() === "" || exporting}
            onClick={exportPdf}
          >
            <FileDown />
            PDF
          </Button>
          <Button variant="secondary" size="sm" disabled={!dirty} onClick={save}>
            <Save />
            保存
          </Button>
        </div>
      </div>

      {/* 冲突条：Agent 改了文件而本地有未保存修改 */}
      {conflict !== null && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-warning/10 px-3 py-2 text-xs">
          <CircleAlert className="size-3.5 shrink-0 text-warning" />
          <span className="flex-1">文件已被 Agent 修改，和你未保存的编辑冲突。</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void window.goodjob.resume.read(target).then((doc) => {
                if (doc === null) return;
                applyContent(doc.content);
                setConflict(null);
              });
            }}
          >
            载入新版
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConflict(null)}>
            保留我的
          </Button>
        </div>
      )}

      {/* 编辑区 / 预览区共用 draft：预览看到的也是未保存的最新内容 */}
      <div className="min-h-0 flex-1">
        {mode === "edit" ? (
          <ResumeMarkdownEditor value={draft} onChange={setDraft} />
        ) : (
          <DocumentPreview markdown={draft} imageUrls={imageUrls} emptyText={emptyText} />
        )}
      </div>
    </div>
  );
}

function ModeButton({
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
      className={cn("rounded-lg px-2.5", active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
