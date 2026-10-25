import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  Application,
  ApplicationPatch,
  ApplicationTimelineEntry,
  Company,
  CompanyPatch,
  Job,
  JobMatchReport,
  JobPatch,
  OfferInfo,
  PipelineConfig,
  PipelineDraft,
  PipelineStage,
} from "@shared/types";

import { ensureDir, writeJsonFile, type WorkspacePaths } from "./paths";

/*
 * 领域实体的持久化底座（P2）：一个实体一个 JSON 文件（`<集合目录>/<id>.json`，0600），
 * 全量载内存、写回即整文件覆盖，`useWorkspace()` 跟随工作区切换 —— 模式对齐
 * ResumeStore / ConversationsStore。排序 / 过滤在渲染层做，这里只保证数据可排。
 *
 * 引用存名不存内容（Job.companyId / Application.jobId）：删除不级联，岗位 / 投递
 * 被删时相关文件保留，悬空引用由渲染层提示。校验也按这个语义来——只在引用
 * 「发生变化」时检查对方是否存在，别让早已悬空的老数据卡住普通编辑。
 */

/** 实体集合目录（路径先在 paths.ts 的 WorkspacePaths 登记过；interviews 由 interviews-store 复用）。 */
type CollectionDir = "companies" | "jobs" | "applications" | "interviews";

/** ID 惯例：前缀 + 12 位 hex（对齐 resume 的 `rs_` / workspace 的 `ws_`）。 */
function newId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * JSON 集合通用底座：子类（三个薄 store）负责字段校验与默认值，
 * 这里只管「一个 id 一个文件」的读写、内存缓存与工作区切换。
 * 导出给 interviews-store（P3）复用——同样是一个实体一个 JSON 文件的集合。
 */
export class JsonCollectionStore<T extends { id: string; createdAt: string }> {
  private workspace: WorkspacePaths;
  private readonly items = new Map<string, T>();

  constructor(
    workspace: WorkspacePaths,
    private readonly dir: CollectionDir,
    private readonly idPrefix: string,
    private readonly revive: (raw: unknown, file: string) => T | null,
  ) {
    this.workspace = workspace;
    this.reload();
  }

  useWorkspace(workspace: WorkspacePaths): void {
    this.workspace = workspace;
    this.reload();
  }

  /** 创建时间稳定排序（渲染层要怎么排自己再排，这里只给一个确定性的顺序）。 */
  list(): T[] {
    return [...this.items.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  get(id: string): T | null {
    return this.items.get(id) ?? null;
  }

  /** 写入（或覆盖）一个实体：内存 + 磁盘（0600）。 */
  put(entity: T): void {
    this.items.set(entity.id, entity);
    writeJsonFile(this.fileFor(entity.id), entity);
  }

  remove(id: string): boolean {
    if (!this.items.delete(id)) return false;
    try {
      fs.rmSync(this.fileFor(id), { force: true });
    } catch {
      // 文件已被手动删掉之类：内存才是事实，忽略磁盘错误。
    }
    return true;
  }

  private fileFor(id: string): string {
    return path.join(this.workspace[this.dir], `${id}.json`);
  }

  /** 只认本集合 id 惯例的文件：applications/ 里的 pipeline.json 等同名文件不会被误读。 */
  private reload(): void {
    this.items.clear();
    const dir = this.workspace[this.dir];
    ensureDir(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const pattern = new RegExp(`^${this.idPrefix}[0-9a-f]{12}\\.json$`);
    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8"));
        const entity = this.revive(raw, entry.name);
        if (entity !== null) this.items.set(entity.id, entity);
      } catch {
        // 单个坏文件不拖垮整个集合：跳过它，其余实体照常可用。
      }
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/* ————————————————————————— 公司 ————————————————————————— */

/**
 * 公司档案（`companies/<id>.json`）。字段校验 + 默认值在这里，
 * IPC CRUD 与 Agent 的 company_* 工具走同一套入口。
 */
export class CompaniesStore {
  private readonly store: JsonCollectionStore<Company>;

  constructor(workspace: WorkspacePaths) {
    this.store = new JsonCollectionStore(workspace, "companies", "co_", reviveCompany);
  }

  useWorkspace(workspace: WorkspacePaths): void {
    this.store.useWorkspace(workspace);
  }

  list(): Company[] {
    return this.store.list();
  }

  get(id: string): Company | null {
    return this.store.get(id);
  }

  create(patch: CompanyPatch): Company {
    const name = (patch.name ?? "").trim();
    if (name === "") throw new Error("公司名称不能为空。");
    const now = nowIso();
    const company: Company = {
      id: newId("co_"),
      name,
      industry: (patch.industry ?? "").trim(),
      scale: (patch.scale ?? "").trim(),
      city: (patch.city ?? "").trim(),
      website: (patch.website ?? "").trim(),
      source: (patch.source ?? "").trim(),
      research: patch.research ?? "",
      researchedAt: patch.research !== undefined && patch.research !== "" ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.put(company);
    return company;
  }

  update(id: string, patch: CompanyPatch): Company {
    const current = this.mustGet(id);
    const next: Company = { ...current, updatedAt: nowIso() };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name === "") throw new Error("公司名称不能为空。");
      next.name = name;
    }
    if (patch.industry !== undefined) next.industry = patch.industry.trim();
    if (patch.scale !== undefined) next.scale = patch.scale.trim();
    if (patch.city !== undefined) next.city = patch.city.trim();
    if (patch.website !== undefined) next.website = patch.website.trim();
    if (patch.source !== undefined) next.source = patch.source.trim();
    if (patch.research !== undefined && patch.research !== current.research) {
      // 调研快照动了才刷新时间，改别的字段不算「重新调研」。
      next.research = patch.research;
      next.researchedAt = nowIso();
    }
    this.store.put(next);
    return next;
  }

  remove(id: string): void {
    if (!this.store.remove(id)) throw new Error(`公司不存在：${id}`);
    // 不级联：引用它的岗位保留，渲染层按悬空引用提示。
  }

  private mustGet(id: string): Company {
    const current = this.store.get(id);
    if (current === null) throw new Error(`公司不存在：${id}（可用 company_list 查 id）`);
    return current;
  }
}

function reviveCompany(raw: unknown, file: string): Company | null {
  if (!isRecord(raw)) return null;
  const id = file.slice(0, -".json".length);
  const now = nowIso();
  return {
    id,
    name: str(raw.name).trim() || "未命名公司",
    industry: str(raw.industry),
    scale: str(raw.scale),
    city: str(raw.city),
    website: str(raw.website),
    source: str(raw.source),
    research: str(raw.research),
    researchedAt: nullableStr(raw.researchedAt),
    createdAt: str(raw.createdAt) || now,
    updatedAt: str(raw.updatedAt) || now,
  };
}

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

/* ————————————————————————— 投递 + 流水线 ————————————————————————— */

/**
 * 投递状态流水线（`applications/pipeline.json`）：有序阶段 + 终态标记，工作区级。
 * 保存时校验：至少一个阶段、阶段名唯一非空、至少一个终态。
 */
export class PipelineStore {
  private workspace: WorkspacePaths;
  private doc: PipelineConfig;

  constructor(workspace: WorkspacePaths) {
    this.workspace = workspace;
    this.doc = this.read();
  }

  useWorkspace(workspace: WorkspacePaths): void {
    this.workspace = workspace;
    this.doc = this.read();
  }

  get(): PipelineConfig {
    return this.doc;
  }

  stageNames(): string[] {
    return this.doc.stages.map((stage) => stage.name);
  }

  save(draft: PipelineDraft): PipelineConfig {
    this.doc = normalizePipeline(draft);
    writeJsonFile(this.file(), this.doc);
    return this.doc;
  }

  private file(): string {
    return path.join(this.workspace.applications, "pipeline.json");
  }

  private read(): PipelineConfig {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file(), "utf8"));
      if (!isRecord(raw) || !Array.isArray(raw.stages)) return defaultPipeline();
      return normalizePipeline({ stages: raw.stages });
    } catch {
      // 文件还没有 / 坏了：给默认流水线，等用户在设置区改（不主动落盘覆盖）。
      return defaultPipeline();
    }
  }
}

function defaultPipeline(): PipelineConfig {
  return {
    stages: [
      { name: "已投递", final: false },
      { name: "简历通过", final: false },
      { name: "笔试", final: false },
      { name: "面试中", final: false },
      { name: "Offer", final: true },
      { name: "未通过", final: true },
    ],
  };
}

/** 校验 + 清洗：阶段名去空格、唯一、非空；至少一个终态。不合法直接抛错。 */
function normalizePipeline(draft: { stages?: unknown[] }): PipelineConfig {
  const stages: PipelineStage[] = [];
  const seen = new Set<string>();
  for (const raw of draft.stages ?? []) {
    if (!isRecord(raw)) continue;
    const name = str(raw.name).trim();
    if (name === "") throw new Error("阶段名不能为空。");
    if (seen.has(name)) throw new Error(`阶段名重复：「${name}」。`);
    seen.add(name);
    stages.push({ name, final: raw.final === true });
  }
  if (stages.length === 0) throw new Error("流水线至少要有一个阶段。");
  if (!stages.some((stage) => stage.final)) {
    throw new Error("流水线至少要有一个终态（如「Offer」或「未通过」）。");
  }
  return { stages };
}

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
