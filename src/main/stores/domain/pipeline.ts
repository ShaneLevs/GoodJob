import fs from "node:fs";

import type { PipelineConfig, PipelineDraft, PipelineStage } from "@shared/types";

import { writeJsonFile, type WorkspacePaths } from "../../workspace/paths";
import { isRecord, str } from "../json-collection";

/* ————————————————————————— 投递状态流水线 ————————————————————————— */

/**
 * 投递状态流水线（`pipeline.json`）：有序阶段 + 终态标记，工作区级。
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
    return this.workspace.pipeline;
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
