import { useCallback, useEffect, useState } from "react";

import type { IntegrityReport, JobMatchReport, ScorecardTarget } from "@shared/types";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { formatTime } from "@/lib/format";

type Loaded =
  | { kind: "job"; title: string; subtitle: string; report: JobMatchReport }
  | { kind: "integrity"; title: string; subtitle: string; report: IntegrityReport }
  | { kind: "missing"; message: string };

/**
 * 评分卡弹窗：后台评分类任务写回的报告。
 * 两种定位：岗位匹配度（Job.matchReport，由 job-match 任务写回）与
 * 主简历完整性（resumes/<id>/reports/，由 resume-integrity 任务写入）。
 * 右栏工作台删除后，这里是报告唯一的展示入口（岗位表点匹配度徽标 / 简历页点完整性报告）。
 */
export function ScorecardDialog({
  target,
  onClose,
  onOverlayChange,
}: {
  /** null = 弹窗关闭；带定位即打开并读这份报告。 */
  target: ScorecardTarget | null;
  onClose: () => void;
  /** 弹窗打开时告知 App 隐藏内嵌浏览器（原生视图会盖住 Dialog）。 */
  onOverlayChange?: (open: boolean) => void;
}) {
  const [report, setReport] = useState<Loaded | null>(null);

  const open = target !== null;
  useEffect(() => {
    onOverlayChange?.(open);
    return () => onOverlayChange?.(false);
  }, [open, onOverlayChange]);

  const load = useCallback(async (wanted: ScorecardTarget) => {
    if (wanted.kind === "job") {
      const [jobs, companies] = await Promise.all([
        window.goodjob.jobs.list(),
        window.goodjob.companies.list(),
      ]);
      const job = jobs.find((item) => item.id === wanted.jobId) ?? null;
      if (job === null) {
        setReport({ kind: "missing", message: "这个岗位已被删除，报告找不到了。" });
        return;
      }
      if (job.matchReport === null) {
        setReport({
          kind: "missing",
          message: `「${job.title}」还没有匹配度报告：在岗位表点「简历评估」。`,
        });
        return;
      }
      const companyName = companies.find((item) => item.id === job.companyId)?.name ?? "";
      setReport({
        kind: "job",
        title: job.title,
        subtitle: companyName === "" ? "简历匹配度" : `${companyName} · 简历匹配度`,
        report: job.matchReport,
      });
      return;
    }

    const [reports, resumeState] = await Promise.all([
      window.goodjob.resume.integrityReports(wanted.resumeId),
      window.goodjob.resume.list(),
    ]);
    const latest = reports.at(-1) ?? null;
    const name = resumeState.items.find((item) => item.id === wanted.resumeId)?.name ?? "简历";
    if (latest === null) {
      setReport({ kind: "missing", message: "这份简历还没有完整性报告。" });
      return;
    }
    setReport({ kind: "integrity", title: name, subtitle: "主简历完整性", report: latest });
  }, []);

  // 打开时读一次；定位变了（换了岗位 / 简历）重新读。
  useEffect(() => {
    setReport(null);
    if (target === null) return;
    void load(target).catch(() => setReport({ kind: "missing", message: "报告读取失败。" }));
  }, [target, load]);

  // 弹窗开着时又跑完一次评分：重拉，免得停在旧分数上。
  useEffect(() => {
    if (target === null) return;
    return window.goodjob.tasks.onEvent((event) => {
      if (event.type !== "finish" || event.task.status !== "done") return;
      const hit =
        (target.kind === "job" &&
          event.task.type === "job-match" &&
          event.task.target === target.jobId) ||
        (target.kind === "integrity" &&
          event.task.type === "resume-integrity" &&
          event.task.target === target.resumeId);
      if (hit) void load(target).catch(() => undefined);
    });
  }, [target, load]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[86vh] flex-col gap-4 overflow-hidden sm:max-w-lg">
        {report === null ? (
          <ReportShell title="正在读取报告…" subtitle="">
            <p className="py-6 text-center text-sm text-muted-foreground">正在读取…</p>
          </ReportShell>
        ) : report.kind === "missing" ? (
          <ReportShell title="没有报告" subtitle="">
            <p className="py-6 text-center text-sm text-muted-foreground">{report.message}</p>
          </ReportShell>
        ) : (
          <ReportShell title={report.title} subtitle={report.subtitle}>
            <ReportBody report={report} />
          </ReportShell>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReportShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <DialogHeader className="shrink-0">
        <DialogTitle className="truncate">{title}</DialogTitle>
        {subtitle !== "" && <DialogDescription>{subtitle}</DialogDescription>}
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </>
  );
}

function ReportBody({
  report,
}: {
  report: Extract<Loaded, { kind: "job" | "integrity" }>;
}) {
  const data = report.report;
  return (
    <>
      <div className="mb-4 flex items-center gap-4 rounded-2xl bg-muted/40 p-4">
        <ScoreDial score={data.score} />
        <p className="min-w-0 flex-1 text-sm leading-relaxed text-muted-foreground">
          {data.conclusion}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {data.dimensions.map((dimension) => (
          <div key={dimension.name} className="rounded-xl border border-border/60 p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{dimension.name}</span>
              <Badge
                variant={
                  dimension.score >= 75 ? "default" : dimension.score >= 50 ? "secondary" : "outline"
                }
              >
                <span className="tabular-nums">{dimension.score}</span>
              </Badge>
            </div>
            {/* 进度条宽度是数据驱动的几何属性，用 style 表达（颜色仍是 token）。 */}
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full",
                  dimension.score >= 75
                    ? "bg-emerald-600 dark:bg-emerald-500"
                    : dimension.score >= 50
                      ? "bg-amber-500 dark:bg-amber-400"
                      : "bg-rose-500 dark:bg-rose-400",
                )}
                style={{ width: `${Math.max(0, Math.min(100, dimension.score))}%` }}
              />
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{dimension.comment}</p>
          </div>
        ))}
      </div>

      <p className="mt-4 pb-1 text-[11px] text-muted-foreground">
        {report.kind === "job"
          ? `评估于 ${formatTime(report.report.evaluatedAt)}`
          : `报告生成于 ${formatTime(report.report.createdAt)}`}
      </p>
    </>
  );
}

function ScoreDial({ score }: { score: number }) {
  const tone =
    score >= 75
      ? "text-emerald-600 dark:text-emerald-400"
      : score >= 50
        ? "text-amber-600 dark:text-amber-400"
        : "text-rose-600 dark:text-rose-400";
  return (
    <div className="flex shrink-0 flex-col items-center">
      <span className={cn("text-3xl leading-none font-semibold tabular-nums", tone)}>{score}</span>
      <span className="mt-1 text-[11px] text-muted-foreground">/ 100</span>
    </div>
  );
}
