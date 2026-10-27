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
      description: "新建公司（名称必填）。",
      inputSchema: z.object({
        name: z.string(),
        industry: z.string().optional(),
        scale: z.string().optional(),
        city: z.string().optional(),
        website: z.string().optional(),
        source: z.string().optional(),
      }),
      execute: (patch) => companies.create(patch),
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
  const { jobs } = deps;

  return {
    job_list: tool({
      description: "列出全部岗位（id / 标题 / 公司 / 薪资带 / 匹配度 / 更新时间）。",
      inputSchema: z.object({}),
      execute: () => jobSummaries(deps),
    }),
    job_get: tool({
      description: "读取一个岗位的完整档案（JD 原文 + 匹配度报告）。",
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => {
        const job = jobs.get(id);
        if (job === null) throw new Error(`岗位不存在：${id}（可用 job_list 查 id）`);
        return job;
      },
    }),
    job_create: tool({
      description:
        "新建岗位（标题必填）。用户粘贴的 JD 整理成 Markdown 存 jd；companyId 必须是 company_list 里的真实 id。",
      inputSchema: z.object({
        title: z.string(),
        companyId: z.string().optional(),
        url: z.string().optional(),
        salaryBand: z.string().optional(),
        jd: z.string().optional(),
      }),
      execute: (patch) => {
        const job = jobs.create(patch);
        return job;
      },
    }),
    job_update: tool({
      description: "更新岗位资料，只传要改的字段。匹配度报告由评估任务写入，不在这里改。",
      inputSchema: z.object({
        id: z.string(),
        companyId: z.string().nullable().optional(),
        title: z.string().optional(),
        url: z.string().optional(),
        salaryBand: z.string().optional(),
        jd: z.string().optional(),
      }),
      execute: ({ id, ...patch }) => {
        const job = jobs.update(id, patch);
        return job;
      },
    }),
    job_delete: tool({
      description: "删除岗位。不会级联：定制简历、话术、投递记录保留为悬空引用，删前先和用户确认。",
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => {
        jobs.remove(id);
        return "已删除。相关的定制简历 / 话术 / 投递会显示为悬空引用。";
      },
    }),
  };
}

export function applicationTools(deps: AgentDeps): ToolSet {
  const { applications, pipeline } = deps;

  return {
    application_list: tool({
      description: "列出全部投递（含状态时间线与 Offer 字段）。",
      inputSchema: z.object({}),
      execute: () => applications.list(),
    }),
    application_create: tool({
      description: "新建投递（jobId 必须来自 job_list 的真实 id）。",
      inputSchema: z.object({ jobId: z.string(), note: z.string().optional() }),
      execute: (patch) => applications.create(patch),
    }),
    application_advance: tool({
      description:
        "推进一条投递的状态：追加一条时间线（stage 必须是流水线里的名字，先用 pipeline_list 查；时间自动取当前时刻）。",
      inputSchema: z.object({ id: z.string(), stage: z.string(), note: z.string().optional() }),
      execute: ({ id, stage, note }) => applications.advance(id, stage, note ?? ""),
    }),
    application_update: tool({
      description:
        "更新投递：补 Offer 字段（salary / equity / note）、改备注或修正时间线。只传要改的字段。",
      inputSchema: z.object({
        id: z.string(),
        jobId: z.string().nullable().optional(),
        timeline: z
          .array(z.object({ stage: z.string(), at: z.string(), note: z.string() }))
          .optional(),
        offer: z
          .object({ salary: z.string(), equity: z.string(), note: z.string() })
          .nullable()
          .optional(),
        note: z.string().optional(),
      }),
      execute: ({ id, ...patch }) => applications.update(id, patch),
    }),
    application_delete: tool({
      description: "删除投递。删前先和用户确认。",
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => {
        applications.remove(id);
        return "已删除。";
      },
    }),
    pipeline_list: tool({
      description: "查看这个工作区的状态流水线（有序阶段 + 终态标记）。推进状态前先查这里。",
      inputSchema: z.object({}),
      execute: () => pipeline.get(),
    }),
  };
}
