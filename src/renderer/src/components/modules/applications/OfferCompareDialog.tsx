import { useMemo } from "react";

import type { Application, Company, Job, PipelineConfig } from "@shared/types";

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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Offer 对比：勾选的多条含 Offer 投递 → 一行一个维度的对比表。 */
export function OfferCompareDialog({
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
