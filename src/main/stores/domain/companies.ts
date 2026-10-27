import type { Company, CompanyPatch } from "@shared/types";

import type { WorkspacePaths } from "../../workspace/paths";
import {
  isRecord,
  JsonCollectionStore,
  newId,
  nullableStr,
  nowIso,
  str,
} from "../json-collection";

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
