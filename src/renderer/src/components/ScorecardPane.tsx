import { useCallback, useEffect, useState } from "react";

import { Gauge } from "lucide-react";

import type { IntegrityReport, JobMatchReport, ScorecardTarget } from "@shared/types";

import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

import { formatTime } from "./modules/table-bits";

/**
 * 右栏「评分卡」：展示后台评分类任务写回的报告。
 * 两种定位：岗位匹配度（Job.matchReport，由 job-match 任务写回）与
 * 主简历完整性（resumes/<id>/reports/，由 resume-integrity 任务写入）。
 * 任务完成时 main 会发 agent:pane-open 把这个标签带着定位打开。
 */
export function ScorecardPane({
  target,
  active,
}: {
  target: ScorecardTarget | null;
  /** 只在可见时拉数据；后台任务事件来了由 App 触发 refetch。 */
  active: boolean;
}) {
  const [report, setReport] = useState<
    | { kind: "job"; title: string; subtitle: string; report: JobMatchReport }
    | { kind: "integrity"; title: string; subtitle: string; report: IntegrityReport }
    | { kind: "missing"; message: string }
    | null
  >(null);

  const load = useCallback(async (wanted: ScorecardTarget) => {
    if (wanted.kind === "job") {
      const jobs = await window.goodjob.jobs.list();
      const job = jobs.find((item) => item.id === wanted.jobId) ?? null;
      if (job === null) {
        setReport({ kind: "missing", message: "这个岗位已被删除，报告找不到了。" });
        return;
      }
      if (job.matchReport === null) {
        setReport({ kind: "missing", message: `「${job.title}」还没有匹配度报告：在岗位表点「简历评估」。` });
        return;
      }
      const companyName =
        job.companyId === null
          ? ""
          : (await window.goodjob.companies.list()).find((item) => item.id === job.companyId)?.name ?? "";
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

  useEffect(() => {
    if (!active) return;
    setReport(null);
    if (target === null) return;
    void load(target).catch(() => setReport({ kind: "missing", message: "报告读取失败。" }));
  }, [active, target, load]);

  // 任务事件（评分完成写回）→ 可见时重拉当前定位。
  useEffect(() => {
    if (!active) return;
    return window.goodjob.tasks.onEvent((event) => {
      if (event.type !== "finish" || event.task.status !== "done") return;
      if (target === null) return;
      if (
        (target.kind === "job" && event.task.type === "job-match" && event.task.target === target.jobId) ||
        (target.kind === "integrity" && event.task.type === "resume-integrity" && event.task.target === target.resumeId)
      ) {
        void load(target).catch(() => undefined);
      }
    });
  }, [active, target, load]);

  if (target === null) {
    return (
      <PaneEmpty
        title="还没有要展示的评分"
        description="在岗位表点匹配度徽标、或发起「简历评估」后台任务；完成后会自动打开在这里。"
      />
    );
  }
  if (report === null) {
    return <PaneEmpty title="正在读取报告…" description="" />;
  }
  if (report.kind === "missing") {
    return <PaneEmpty title="没有报告" description={report.message} />;
  }

  const { title, subtitle, report: data } = report;

  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      <header className="mb-4">
        <p className="text-xs text-muted-foreground">{subtitle}</p>
        <h2 className="truncate text-base font-medium">{title}</h2>
      </header>

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
              <Badge variant={dimension.score >= 75 ? "default" : dimension.score >= 50 ? "secondary" : "outline"}>
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

      <p className="mt-4 pb-2 text-[11px] text-muted-foreground">
        {report.kind === "job"
          ? `评估于 ${formatTime(report.report.evaluatedAt)}`
          : `报告生成于 ${formatTime(report.report.createdAt)}`}
      </p>
    </div>
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

function PaneEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <Empty className="max-w-xs">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Gauge />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          {description !== "" && <EmptyDescription>{description}</EmptyDescription>}
        </EmptyHeader>
      </Empty>
    </div>
  );
}
