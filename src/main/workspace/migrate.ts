import fs from "node:fs";
import path from "node:path";

import { ensureDir, writeJsonFile, type WorkspacePaths } from "./paths";

/**
 * 旧版把投递单独存成 `applications/<id>.json`，与岗位 1:1。现在投递字段并进了
 * `jobs/<id>.json`（timeline / offer / note），启动时把旧记录合并过去：
 * - 只在岗位还没有时间线时合并，重复运行不会覆盖已经推进过的状态；
 * - 流水线与 upload/ 迁到新位置；
 * - 整个旧目录改名成 `applications.migrated` 留档，不删除用户数据。
 */
export function migrateApplicationsToJobs(workspace: WorkspacePaths): void {
  const legacyDir = path.join(workspace.dir, "applications");
  if (!fs.existsSync(legacyDir)) return;

  migratePipeline(workspace, legacyDir);
  migrateRecords(workspace, legacyDir);
  migrateUploads(workspace, legacyDir);
  archiveLegacyDir(legacyDir);
}

function migratePipeline(workspace: WorkspacePaths, legacyDir: string): void {
  const source = path.join(legacyDir, "pipeline.json");
  if (!fs.existsSync(source) || fs.existsSync(workspace.pipeline)) return;
  try {
    fs.copyFileSync(source, workspace.pipeline);
    fs.chmodSync(workspace.pipeline, 0o600);
  } catch {
    // 迁移失败时 PipelineStore 会回落到默认流水线，旧文件仍在备份目录里。
  }
}

function migrateRecords(workspace: WorkspacePaths, legacyDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(legacyDir);
  } catch {
    return;
  }

  for (const name of names) {
    if (!/^app_[0-9a-f]{12}\.json$/.test(name)) continue;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(legacyDir, name), "utf8"));
      if (!isRecord(raw)) continue;
      const jobId = typeof raw.jobId === "string" ? raw.jobId.trim() : "";
      if (jobId === "") continue;

      const jobFile = path.join(workspace.jobs, `${jobId}.json`);
      if (!fs.existsSync(jobFile)) continue; // 岗位已被删除：旧投递没有可挂靠的记录。
      const job: unknown = JSON.parse(fs.readFileSync(jobFile, "utf8"));
      if (!isRecord(job)) continue;

      // 已经有时间线的岗位视为已合并 / 已在新版里推进过，不再覆盖。
      if (Array.isArray(job.timeline) && job.timeline.length > 0) continue;

      job.timeline = reviveTimeline(raw.timeline);
      if (job.offer === null || job.offer === undefined) {
        job.offer = isRecord(raw.offer) ? normalizeOffer(raw.offer) : null;
      }
      if (typeof job.note !== "string" || job.note === "") {
        job.note = typeof raw.note === "string" ? raw.note : "";
      }
      const appUpdatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : "";
      const jobUpdatedAt = typeof job.updatedAt === "string" ? job.updatedAt : "";
      if (appUpdatedAt > jobUpdatedAt) job.updatedAt = appUpdatedAt;

      writeJsonFile(jobFile, job);
    } catch {
      // 单条坏记录不拖垮迁移：留在备份目录里。
    }
  }
}

function migrateUploads(workspace: WorkspacePaths, legacyDir: string): void {
  const sourceDir = path.join(legacyDir, "upload");
  if (!fs.existsSync(sourceDir)) return;
  try {
    ensureDir(workspace.jobsUpload);
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const target = dedupeFileName(workspace.jobsUpload, entry.name);
      fs.renameSync(path.join(sourceDir, entry.name), path.join(workspace.jobsUpload, target));
      fs.chmodSync(path.join(workspace.jobsUpload, target), 0o600);
    }
  } catch {
    // 上传文件不是核心数据：迁移失败就留在备份目录，不影响岗位与投递记录。
  }
}

function archiveLegacyDir(legacyDir: string): void {
  const archive = `${legacyDir}.migrated`;
  if (fs.existsSync(archive)) return;
  try {
    fs.renameSync(legacyDir, archive);
  } catch {
    // 改名失败也不影响已合并的数据，下次启动会再试。
  }
}

function reviveTimeline(raw: unknown): Array<{ stage: string; at: string; note: string }> {
  if (!Array.isArray(raw)) return [];
  const now = new Date().toISOString();
  return raw.flatMap((item) => {
    if (!isRecord(item)) return [];
    return [
      {
        stage: typeof item.stage === "string" ? item.stage : "",
        at: typeof item.at === "string" ? item.at : now,
        note: typeof item.note === "string" ? item.note : "",
      },
    ];
  });
}

function normalizeOffer(raw: Record<string, unknown>): { salary: string; equity: string; note: string } | null {
  const salary = typeof raw.salary === "string" ? raw.salary.trim() : "";
  const equity = typeof raw.equity === "string" ? raw.equity.trim() : "";
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (salary === "" && equity === "" && note === "") return null;
  return { salary, equity, note };
}

/** 同名不覆盖：目录里已有 a.pdf 时，第二次落盘变成 a-2.pdf。 */
function dedupeFileName(dir: string, fileName: string): string {
  if (!fs.existsSync(path.join(dir, fileName))) return fileName;
  const ext = path.extname(fileName);
  const base = ext === "" ? fileName : fileName.slice(0, -ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
