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

  /**
   * 按名称找公司：先比归一化后的全名，再退一步比去掉法人后缀的核心名，
   * 「字节跳动」「字节跳动有限公司」「ByteDance 」都能落到同一条档案上。
   * 只做确定性匹配，不做模糊打分——宁可新建，也不要把两家不相干的公司合并。
   */
  findByName(name: string): { company: Company; match: "exact" | "core" } | null {
    const target = normalizeCompanyName(name);
    if (target === "") return null;
    const all = this.store.list();
    const exact = all.find((company) => normalizeCompanyName(company.name) === target);
    if (exact !== undefined) return { company: exact, match: "exact" };

    const targetCore = coreCompanyName(target);
    if (targetCore.length < 2) return null;
    const core = all.find((company) => coreCompanyName(normalizeCompanyName(company.name)) === targetCore);
    return core === undefined ? null : { company: core, match: "core" };
  }

  /**
   * 有同名就返回已有的，没有才新建。Agent 建档（岗位带出公司名）走这里，
   * 免得同一个公司被反复建出「字节跳动」「字节跳动有限公司」两条。
   */
  ensure(patch: CompanyPatch): { company: Company; created: boolean } {
    const found = this.findByName(patch.name ?? "");
    // 已有档案就原样返回：不拿自动识别出来的信息覆盖用户写过的内容。
    if (found !== null) return { company: found.company, created: false };
    return { company: this.create(patch), created: true };
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

/** 公司名比较用的归一化：忽略大小写、空白与常见标点。 */
function normalizeCompanyName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[·・,，.。、/\\（）()【】\[\]「」《》"']/g, "");
}

/** 去掉法人后缀的核心名：「字节跳动有限公司」与「字节跳动」视为同一家。 */
function coreCompanyName(normalized: string): string {
  return normalized.replace(/(股份有限公司|有限责任公司|有限公司|集团|公司)$/u, "");
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
