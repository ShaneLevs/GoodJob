import { tool, type ToolSet } from "ai";
import { z } from "zod";

import type { AgentDeps } from "../deps";

export function jobWorkbenchTools(deps: AgentDeps, jobId: string): ToolSet {
  const { resumes, jobs, companies } = deps;

  return {
    job_info: tool({
      description: "查看当前岗位的档案（标题 / 薪资 / JD 原文 / 匹配度报告）与公司名。",
      inputSchema: z.object({}),
      execute: () => {
        const job = jobs.get(jobId);
        if (job === null) throw new Error(`岗位不存在：${jobId}（可能已被删除）`);
        const company = job.companyId === null ? null : companies.get(job.companyId);
        return { ...job, companyName: company?.name ?? null };
      },
    }),
    resume_read: tool({
      description: "读取当前主简历 resume.md 的完整内容（定制稿的底稿）。",
      inputSchema: z.object({}),
      execute: () => resumes.read({ kind: "main" })?.content ?? "",
    }),
    job_tailored_read: tool({
      description: "读取当前岗位的定制简历；还没有定制稿时返回空字符串。",
      inputSchema: z.object({}),
      execute: () => resumes.readTailored(jobId) ?? "",
    }),
    job_tailored_write: tool({
      description: "整体覆写当前岗位的定制简历（写入前系统自动快照旧版）。必须写完整 Markdown。",
      inputSchema: z.object({ content: z.string() }),
      execute: ({ content }) => {
        resumes.writeTailored(jobId, content);
        return "已写入定制简历。";
      },
    }),
    job_script_read: tool({
      description: "读取当前岗位的面试话术；还没有时返回空字符串。",
      inputSchema: z.object({}),
      execute: () => resumes.readScript(jobId)?.content ?? "",
    }),
    job_script_write: tool({
      description:
        "写入当前岗位的面试话术（整体覆写，旧版自动快照）。结构：自我介绍 / 项目深挖 / 反问环节。",
      inputSchema: z.object({ content: z.string() }),
      execute: ({ content }) => {
        resumes.writeScript(jobId, content);
        return "已写入话术。";
      },
    }),
    job_script_finalize: tool({
      description:
        "把当前岗位的话术标记定稿（锁定供引用的版本；之后仍可继续编辑，改过会提示重新定稿）。",
      inputSchema: z.object({}),
      execute: () => {
        const doc = resumes.finalizeScript(jobId);
        return `已定稿（${doc.finalizedAt ?? ""}）。`;
      },
    }),
  };
}
