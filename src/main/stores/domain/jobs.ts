import type {
  Job,
  JobMatchReport,
  JobPatch,
  JobTimelineEntry,
  OfferInfo,
} from "@shared/types";

import type { WorkspacePaths } from "../../workspace/paths";
import { isRecord, JsonCollectionStore, newId, nullableStr, nowIso, str } from "../json-collection";
import { CompaniesStore } from "./companies";
import { PipelineStore } from "./pipeline";

/* ————————————————————————— 岗位 + 投递 ————————————————————————— */

/**
 * 岗位档案（`jobs/<id>.json`）：JD、匹配度与投递过程（状态时间线 / Offer / 备注）
 * 同一条记录。companyId 只在变化时校验；匹配度报告由后台任务（tasks.ts）经
 * setMatchReport 写入，不走通用 patch。
 */
export class JobsStore {
  private readonly store: JsonCollectionStore<Job>;

  constructor(
    workspace: WorkspacePaths,
    private readonly companies: CompaniesStore,
    private readonly pipeline: PipelineStore,
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
      timeline: this.normalizeTimeline(patch.timeline ?? [], []),
      offer: normalizeOffer(patch.offer),
      note: patch.note ?? "",
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
    if (patch.timeline !== undefined) {
      next.timeline = this.normalizeTimeline(patch.timeline, current.timeline);
    }
    if (patch.offer !== undefined) next.offer = normalizeOffer(patch.offer);
    if (patch.note !== undefined) next.note = patch.note;
    this.store.put(next);
    return next;
  }

  /** 顺流推进：追加一条时间线（阶段必须来自 pipeline，时间取当前时刻）。 */
  advance(id: string, stage: string, note = ""): Job {
    const current = this.mustGet(id);
    const name = stage.trim();
    if (!this.pipeline.stageNames().includes(name)) {
      throw new Error(`阶段「${name}」不在流水线里（可用 pipeline_list 查全部阶段）。`);
    }
    const now = nowIso();
    const next: Job = {
      ...current,
      timeline: [...current.timeline, { stage: name, at: now, note }],
      updatedAt: now,
    };
    this.store.put(next);
    return next;
  }

  remove(id: string): void {
    if (!this.store.remove(id)) throw new Error(`岗位不存在：${id}`);
    // 不级联：定制稿 / 话术 / 模拟面试引用保留，渲染层按悬空引用提示。
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

  /**
   * 时间线清洗：补 at / note 默认值；阶段枚举只校验「新增」的条目
   * （下标 >= 已有条数）——老条目引用了后来被删掉的阶段属于悬空引用，
   * 由渲染层提示，不在这里拦住整条更新。
   */
  private normalizeTimeline(
    incoming: JobTimelineEntry[],
    previous: JobTimelineEntry[],
  ): JobTimelineEntry[] {
    const valid = this.pipeline.stageNames();
    return incoming.map((entry, index) => {
      const stage = str(entry?.stage).trim();
      if (index >= previous.length && !valid.includes(stage)) {
        throw new Error(
          `阶段「${stage || "（空）"}」不在流水线里。可用阶段：${valid.join("、")}（用 pipeline_list 可随时查）。`,
        );
      }
      return {
        stage,
        at: str(entry?.at) || nowIso(),
        note: str(entry?.note),
      };
    });
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
    timeline: reviveTimeline(raw.timeline),
    offer: isRecord(raw.offer) ? normalizeOffer(raw.offer) : null,
    note: str(raw.note),
    createdAt: str(raw.createdAt) || now,
    updatedAt: str(raw.updatedAt) || now,
  };
}

function reviveTimeline(raw: unknown): JobTimelineEntry[] {
  if (!Array.isArray(raw)) return [];
  const now = nowIso();
  return raw.flatMap((item): JobTimelineEntry[] => {
    if (!isRecord(item)) return [];
    return [{ stage: str(item.stage), at: str(item.at) || now, note: str(item.note) }];
  });
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

function normalizeOffer(value: OfferInfo | Record<string, unknown> | null | undefined): OfferInfo | null {
  if (value === null || value === undefined || !isRecord(value)) return null;
  const salary = str(value.salary).trim();
  const equity = str(value.equity).trim();
  const note = str(value.note).trim();
  if (salary === "" && equity === "" && note === "") return null;
  return { salary, equity, note };
}
