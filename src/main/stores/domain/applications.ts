import type {
  Application,
  ApplicationPatch,
  ApplicationTimelineEntry,
  OfferInfo,
} from "@shared/types";

import type { WorkspacePaths } from "../../workspace/paths";
import {
  isRecord,
  JsonCollectionStore,
  newId,
  nullableStr,
  nowIso,
  str,
} from "../json-collection";
import { JobsStore } from "./jobs";
import { PipelineStore } from "./pipeline";

/**
 * 投递档案（`applications/<id>.json`）：jobId 引用校验、时间线阶段枚举校验
 * （只校验新增条目——阶段后来被改名 / 删除不应卡住旧数据的普通编辑）。
 */
export class ApplicationsStore {
  private readonly store: JsonCollectionStore<Application>;

  constructor(
    workspace: WorkspacePaths,
    private readonly jobs: JobsStore,
    private readonly pipeline: PipelineStore,
  ) {
    this.store = new JsonCollectionStore(workspace, "applications", "app_", reviveApplication);
  }

  useWorkspace(workspace: WorkspacePaths): void {
    this.store.useWorkspace(workspace);
  }

  list(): Application[] {
    return this.store.list();
  }

  get(id: string): Application | null {
    return this.store.get(id);
  }

  create(patch: ApplicationPatch): Application {
    const jobId = patch.jobId?.trim() ?? "";
    if (jobId === "") throw new Error("投递必须关联一个岗位（jobId）。");
    if (this.jobs.get(jobId) === null) {
      throw new Error(`岗位不存在：${jobId}（先用 job_list 查可用 id）`);
    }
    const now = nowIso();
    const application: Application = {
      id: newId("app_"),
      jobId,
      timeline: this.normalizeTimeline(patch.timeline ?? [], []),
      offer: normalizeOffer(patch.offer),
      note: patch.note ?? "",
      createdAt: now,
      updatedAt: now,
    };
    this.store.put(application);
    return application;
  }

  update(id: string, patch: ApplicationPatch): Application {
    const current = this.mustGet(id);
    const next: Application = { ...current, updatedAt: nowIso() };
    if (patch.jobId !== undefined) {
      const jobId = patch.jobId?.trim() ?? "";
      if (jobId === "") throw new Error("投递必须关联一个岗位（jobId）。");
      if (this.jobs.get(jobId) === null) {
        throw new Error(`岗位不存在：${jobId}（先用 job_list 查可用 id）`);
      }
      next.jobId = jobId;
    }
    if (patch.timeline !== undefined) {
      next.timeline = this.normalizeTimeline(patch.timeline, current.timeline);
    }
    if (patch.offer !== undefined) next.offer = normalizeOffer(patch.offer);
    if (patch.note !== undefined) next.note = patch.note;
    this.store.put(next);
    return next;
  }

  /** 顺流推进：追加一条时间线（阶段必须来自 pipeline，时间取当前时刻）。 */
  advance(id: string, stage: string, note = ""): Application {
    const current = this.mustGet(id);
    const name = stage.trim();
    if (!this.pipeline.stageNames().includes(name)) {
      throw new Error(`阶段「${name}」不在流水线里（可用 pipeline_list 查全部阶段）。`);
    }
    const next: Application = {
      ...current,
      timeline: [...current.timeline, { stage: name, at: nowIso(), note }],
      updatedAt: nowIso(),
    };
    this.store.put(next);
    return next;
  }

  remove(id: string): void {
    if (!this.store.remove(id)) throw new Error(`投递不存在：${id}`);
  }

  /**
   * 时间线清洗：补 at / note 默认值；阶段枚举只校验「新增」的条目
   * （下标 >= 已有条数）——老条目引用了后来被删掉的阶段属于悬空引用，
   * 由渲染层提示，不在这里拦住整条更新。
   */
  private normalizeTimeline(
    incoming: ApplicationTimelineEntry[],
    previous: ApplicationTimelineEntry[],
  ): ApplicationTimelineEntry[] {
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

  private mustGet(id: string): Application {
    const current = this.store.get(id);
    if (current === null) throw new Error(`投递不存在：${id}（可用 application_list 查 id）`);
    return current;
  }
}

function reviveApplication(raw: unknown, file: string): Application | null {
  if (!isRecord(raw)) return null;
  const id = file.slice(0, -".json".length);
  const now = nowIso();
  const timeline = Array.isArray(raw.timeline)
    ? raw.timeline.flatMap((item): ApplicationTimelineEntry[] => {
        if (!isRecord(item)) return [];
        return [{ stage: str(item.stage), at: str(item.at) || now, note: str(item.note) }];
      })
    : [];
  return {
    id,
    jobId: nullableStr(raw.jobId),
    timeline,
    offer: isRecord(raw.offer) ? normalizeOffer(raw.offer) : null,
    note: str(raw.note),
    createdAt: str(raw.createdAt) || now,
    updatedAt: str(raw.updatedAt) || now,
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
