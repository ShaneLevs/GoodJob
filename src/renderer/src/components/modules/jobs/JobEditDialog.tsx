import { useEffect, useState } from "react";

import type { Company, Job } from "@shared/types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export function JobEditDialog({
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
