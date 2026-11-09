import { tool, type ToolSet } from "ai";
import { z } from "zod";

import type { AgentDeps } from "../deps";
import { jobSummaries } from "../instructions";

export function companyTools(deps: AgentDeps): ToolSet {
  const { companies } = deps;

  return {
    company_list: tool({
      description: "列出全部公司（id / 名称 / 行业 / 城市 / 更新时间）。引用或新增前先查。",
      inputSchema: z.object({}),
      execute: () =>
        companies.list().map(({ id, name, industry, city, updatedAt }) => ({
          id,
          name,
          industry,
          city,
          updatedAt,
        })),
    }),
    company_get: tool({
      description: "读取一个公司的完整档案（含调研快照 research）。",
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => {
        const company = companies.get(id);
        if (company === null) throw new Error(`公司不存在：${id}（可用 company_list 查 id）`);
        return company;
      },
    }),
    company_create: tool({
      description:
        "新建公司（名称必填）。同名公司（忽略大小写 / 空格 / 「有限公司」这类后缀）已存在时直接返回它，不重复建档。",
      inputSchema: z.object({
        name: z.string(),
        industry: z.string().optional(),
        scale: z.string().optional(),
        city: z.string().optional(),
        website: z.string().optional(),
        source: z.string().optional(),
      }),
      execute: (patch) => companies.ensure(patch),
    }),
    company_update: tool({
      description: "更新公司资料；research 写调研快照（Markdown，标注来源）。只传要改的字段。",
      inputSchema: z.object({
        id: z.string(),
        name: z.string().optional(),
        industry: z.string().optional(),
        scale: z.string().optional(),
        city: z.string().optional(),
        website: z.string().optional(),
        source: z.string().optional(),
        research: z.string().optional(),
      }),
      execute: ({ id, ...patch }) => {
        const company = companies.update(id, patch);
        return company;
      },
    }),
    company_delete: tool({
      description: "删除公司。不会级联：引用它的岗位会变成悬空引用，删前先和用户确认。",
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => {
        companies.remove(id);
        return "已删除。引用它的岗位会显示为悬空引用。";
      },
    }),
  };
}

export function jobTools(deps: AgentDeps): ToolSet {
  const { jobs, pipeline } = deps;

  return {
    job_list: tool({
      description:
        "列出全部岗位（id / 标题 / 公司 / 薪资带 / 匹配度 / 当前投递状态 / Offer / 更新时间）。" +
        "岗位与投递是同一条记录：timeline 为空表示还没投。",
      inputSchema: z.object({}),
      execute: () => jobSummaries(deps),
    }),
    job_get: tool({
      description: "读取一个岗位的完整档案（JD 原文、匹配度报告、投递时间线、Offer、备注）。",
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => {
        const job = jobs.get(id);
        if (job === null) throw new Error(`岗位不存在：${id}（可用 job_list 查 id）`);
        return job;
      },
    }),
    job_create: tool({
      description:
        "新建岗位（标题必填）。用户粘贴的 JD 整理成 Markdown 存 jd。" +
        "公司优先用 companyName 传你从 JD / 页面识别出的公司名：main 会按名字去重关联，" +
        "公司库里没有就自动建一条（返回里会说明是新建还是关联）。companyId 只在已经确定要关联哪条档案时用。" +
        "建完要记录投递时，接着用 job_advance 追加第一个阶段。",
      inputSchema: z.object({
        title: z.string(),
        companyName: z.string().optional(),
        companyId: z.string().optional(),
        url: z.string().optional(),
        salaryBand: z.string().optional(),
        jd: z.string().optional(),
        note: z.string().optional(),
      }),
      execute: ({ companyName, ...patch }) => {
        const company = ensureCompanyByName(deps, companyName);
        const job = jobs.create(company === null ? patch : { ...patch, companyId: company.id });
        return company === null ? { job } : { job, company };
      },
    }),
    job_update: tool({
      description:
        "更新岗位资料，只传要改的字段。匹配度报告由评估任务写入，不在这里改。" +
        "给没关联公司的岗位补关联时传 companyName（同名去重，没有就建）。" +
        "补 Offer 用 offer（salary / equity / note；传 null 清空），投递备注用 note；" +
        "修正历史时间线用 timeline（只建议在用户明确要求时改）。",
      inputSchema: z.object({
        id: z.string(),
        companyName: z.string().optional(),
        companyId: z.string().nullable().optional(),
        title: z.string().optional(),
        url: z.string().optional(),
        salaryBand: z.string().optional(),
        jd: z.string().optional(),
        note: z.string().optional(),
        offer: z
          .object({ salary: z.string(), equity: z.string(), note: z.string() })
          .nullable()
          .optional(),
        timeline: z
          .array(z.object({ stage: z.string(), at: z.string(), note: z.string() }))
          .optional(),
      }),
      execute: ({ id, companyName, ...patch }) => {
        const company = ensureCompanyByName(deps, companyName);
        const job = jobs.update(id, company === null ? patch : { ...patch, companyId: company.id });
        return company === null ? { job } : { job, company };
      },
    }),
    job_advance: tool({
      description:
        "推进一个岗位的投递状态：追加一条时间线（stage 必须是流水线里的名字，先用 pipeline_list 查；" +
        "时间自动取当前时刻，note 写渠道 / 面试官 / 结果等上下文）。只顺流推进，不改写历史条目。",
      inputSchema: z.object({ id: z.string(), stage: z.string(), note: z.string().optional() }),
      execute: ({ id, stage, note }) => jobs.advance(id, stage, note ?? ""),
    }),
    job_delete: tool({
      description:
        "删除岗位（连同它的投递时间线与 Offer）。定制简历、话术、模拟面试会保留为悬空引用；删前先和用户确认。",
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => {
        jobs.remove(id);
        return "已删除。相关的定制简历 / 话术 / 模拟面试会显示为悬空引用。";
      },
    }),
    pipeline_list: tool({
      description: "查看这个工作区的状态流水线（有序阶段 + 终态标记）。推进状态前先查这里。",
      inputSchema: z.object({}),
      execute: () => pipeline.get(),
    }),
  };
}

/**
 * 岗位建档时的「公司自动入库」：模型识别出的公司名优先于它给的 id。
 * 返回 null 表示这次没交公司名，让调用方沿用原来的 companyId 语义。
 */
function ensureCompanyByName(
  deps: AgentDeps,
  name: string | undefined,
): { id: string; name: string; created: boolean } | null {
  const trimmed = (name ?? "").trim();
  if (trimmed === "") return null;
  const { company, created } = deps.companies.ensure({ name: trimmed });
  return { id: company.id, name: company.name, created };
}
