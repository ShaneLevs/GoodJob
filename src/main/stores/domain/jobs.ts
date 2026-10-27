import type { Job, JobMatchReport, JobPatch } from "@shared/types";

import type { WorkspacePaths } from "../../workspace/paths";
import { isRecord, JsonCollectionStore, newId, nullableStr, nowIso, str } from "../json-collection";
import { CompaniesStore } from "./companies";

/* ————————————————————————— 岗位 ————————————————————————— */

/**
 * 岗位档案（`jobs/<id>.json`）。companyId 只在变化时校验；匹配度报告由
 * 后台任务（tasks.ts）经 setMatchReport 写入，不走通用 patch。
 */
export class JobsStore {
  private readonly store: JsonCollectionStore<Job>;

  constructor(
    workspace: WorkspacePaths,
    private readonly companies: CompaniesStore,
  ) {
    this.store = new JsonCollectionStore(workspace, "jobs", "job_", reviveJob);
  }

  useWorkspace(workspace: WorkspacePaths): void {
    this.store.useWorkspace(workspace);
  }

  list(): Job[] {
    return this.store.list();
  }

  get(id: string): Job | null {
    return this.store.get(id);
  }

  create(patch: JobPatch): Job {
    const title = (patch.title ?? "").trim();
    if (title === "") throw new Error("岗位名称不能为空。");
    const companyId = this.normalizeRef(patch.companyId, "company_list");
    const now = nowIso();
    const job: Job = {
      id: newId("job_"),
      companyId,
      title,
      jd: patch.jd ?? "",
      url: (patch.url ?? "").trim(),
      salaryBand: (patch.salaryBand ?? "").trim(),
      matchReport: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.put(job);
    return job;
  }

  update(id: string, patch: JobPatch): Job {
    const current = this.mustGet(id);
    const next: Job = { ...current, updatedAt: nowIso() };
    if (patch.companyId !== undefined) {
      next.companyId = this.normalizeRef(patch.companyId, "company_list");
    }
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title === "") throw new Error("岗位名称不能为空。");
      next.title = title;
    }
    if (patch.jd !== undefined) next.jd = patch.jd;
    if (patch.url !== undefined) next.url = patch.url.trim();
    if (patch.salaryBand !== undefined) next.salaryBand = patch.salaryBand.trim();
    this.store.put(next);
    return next;
  }

  remove(id: string): void {
    if (!this.store.remove(id)) throw new Error(`岗位不存在：${id}`);
    // 不级联：定制稿 / 话术 / 投递引用保留，渲染层按悬空引用提示。
  }

  /** 后台任务专用：整体替换匹配度报告（评分 / 维度 / 结论 / 评分时间）。 */
  setMatchReport(id: string, report: JobMatchReport): Job {
    const current = this.mustGet(id);
    const next: Job = { ...current, matchReport: report, updatedAt: nowIso() };
    this.store.put(next);
    return next;
  }

  /** 引用校验：空 = 无引用；非空必须指向存在的公司（错误信息带回模型）。 */
  private normalizeRef(companyId: string | null | undefined, hint: string): string | null {
    if (companyId === undefined || companyId === null) return null;
    const trimmed = companyId.trim();
    if (trimmed === "" || trimmed === "null") return null;
    if (this.companies.get(trimmed) === null) {
      throw new Error(`公司不存在：${trimmed}（先用 ${hint} 查可用 id）`);
    }
    return trimmed;
  }

  private mustGet(id: string): Job {
    const current = this.store.get(id);
    if (current === null) throw new Error(`岗位不存在：${id}（可用 job_list 查 id）`);
    return current;
  }
}

function reviveJob(raw: unknown, file: string): Job | null {
  if (!isRecord(raw)) return null;
  const id = file.slice(0, -".json".length);
  const now = nowIso();
  const report = isRecord(raw.matchReport) ? reviveMatchReport(raw.matchReport) : null;
  return {
    id,
    companyId: nullableStr(raw.companyId),
    title: str(raw.title).trim() || "未命名岗位",
    jd: str(raw.jd),
    url: str(raw.url),
    salaryBand: str(raw.salaryBand),
    matchReport: report,
    createdAt: str(raw.createdAt) || now,
    updatedAt: str(raw.updatedAt) || now,
  };
}

function reviveMatchReport(raw: Record<string, unknown>): JobMatchReport | null {
  const score = typeof raw.score === "number" ? raw.score : null;
  if (score === null) return null;
  const dimensions = Array.isArray(raw.dimensions)
    ? raw.dimensions.flatMap((item): JobMatchReport["dimensions"] => {
        if (!isRecord(item)) return [];
        return [
          {
            name: str(item.name) || "维度",
            score: typeof item.score === "number" ? item.score : 0,
            comment: str(item.comment),
          },
        ];
      })
    : [];
  return {
    score,
    dimensions,
    conclusion: str(raw.conclusion),
    evaluatedAt: str(raw.evaluatedAt) || nowIso(),
  };
}
