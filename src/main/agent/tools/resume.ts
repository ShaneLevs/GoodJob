import { tool, type ToolSet } from "ai";
import { z } from "zod";

import type { AgentDeps } from "../deps";
import { jobSummaries } from "../instructions";

export function resumeTools(deps: AgentDeps): ToolSet {
  const { resumes } = deps;

  return {
    resume_read: tool({
      description: "读取当前主简历 resume.md 的完整内容。修改前务必先读最新版。",
      inputSchema: z.object({}),
      execute: () => resumes.read({ kind: "main" })?.content ?? "",
    }),
    resume_write: tool({
      description:
        "整体覆写主简历 resume.md（写入前系统会自动快照旧版）。请写入完整 Markdown，不要只写改动片段。",
      inputSchema: z.object({ content: z.string() }),
      execute: ({ content }) => {
        resumes.save({ kind: "main" }, content);
        return "已写入主简历。";
      },
    }),
    resume_tailored_list: tool({
      description: "列出已有的岗位定制简历（key 列表；现在约定 key = 岗位 jobId）。",
      inputSchema: z.object({}),
      execute: () => resumes.listTailoredNames(),
    }),
    resume_tailored_read: tool({
      description: "读取一份岗位定制简历。key 用岗位 jobId；也兼容读 P1 旧版按岗位名存的文件。",
      inputSchema: z.object({ key: z.string() }),
      execute: ({ key }) => resumes.readTailored(key) ?? "",
    }),
    resume_tailored_write: tool({
      description:
        "按岗位 jobId 写入定制简历（与岗位 1:1，整体覆写，旧版自动快照）。写入前先读主简历；迁移 P1 旧文件时用 migrateFrom 传旧文件名，系统会把它清掉。",
      inputSchema: z.object({
        jobId: z.string(),
        content: z.string(),
        migrateFrom: z.string().optional(),
      }),
      execute: ({ jobId, content, migrateFrom }) => {
        const saved = resumes.writeTailored(jobId, content, migrateFrom);
        return `已写入定制简历「${saved.key}」。`;
      },
    }),
  };
}

export function skillTools(deps: AgentDeps): ToolSet {
  const { resumes, jobs, tasks } = deps;

  return {
    script_list: tool({
      description:
        "列出当前简历的话术（含定稿状态；modifiedSinceFinal 表示定稿后改过、待重新定稿）。",
      inputSchema: z.object({}),
      execute: () => resumes.listScripts(),
    }),
    script_read: tool({
      description: "读取一个岗位的话术当前版（jobId 用 job_list 查）。",
      inputSchema: z.object({ jobId: z.string() }),
      execute: ({ jobId }) => {
        const script = resumes.readScript(jobId);
        if (script === null) throw new Error(`还没有「${jobId}」的话术，先用 script_write 生成一版。`);
        return script;
      },
    }),
    script_write: tool({
      description:
        "写入一个岗位的话术当前版（整体覆写，旧版自动快照进 scripts/history/）。结构约定：自我介绍 / 项目深挖 / 反问环节，按 JD 预判的问题给要点式回答。",
      inputSchema: z.object({ jobId: z.string(), content: z.string() }),
      execute: ({ jobId, content }) => {
        const doc = resumes.writeScript(jobId, content);
        return `已写入话术（定稿状态：${doc.final ? (doc.modifiedSinceFinal ? "已定稿但后有修改，待重新定稿" : "已定稿") : "未定稿"}）。`;
      },
    }),
    script_finalize: tool({
      description:
        "话术定稿：锁定供面试 / 投递引用的版本（当前内容进 scripts/history/）。定稿后仍可编辑，改过会提示重新定稿。",
      inputSchema: z.object({ jobId: z.string() }),
      execute: ({ jobId }) => {
        const doc = resumes.finalizeScript(jobId);
        return `已定稿「${doc.jobId}」的话术（${doc.finalizedAt ?? ""}）。`;
      },
    }),
    job_list: tool({
      description: "列出全部岗位（id / 标题 / 公司 / 薪资带 / 匹配度），用于把用户说的岗位对应到 jobId。",
      inputSchema: z.object({}),
      execute: () => jobSummaries(deps),
    }),
    resume_job_evaluate: tool({
      description:
        "发起简历评估后台任务（JD 匹配度评分）：结果写进该岗位的匹配度报告，完成后岗位表的分数会刷新（点分数看评分卡）。",
      inputSchema: z.object({ jobId: z.string() }),
      execute: ({ jobId }) => {
        if (jobs.get(jobId) === null) throw new Error(`岗位不存在：${jobId}（可用 job_list 查 id）`);
        const previous = tasks.latest("job-match", jobId);
        const task = tasks.run("job-match", jobId);
        const lastLine =
          previous !== null && previous.status === "done" && previous.result !== null
            ? `上次结果：${previous.result}\n`
            : "";
        return `${lastLine}任务已发起（${task.id}），不用等它——继续当前对话即可。`;
      },
    }),
    resume_integrity_check: tool({
      description:
        "发起主简历完整性评分后台任务：报告存进这份简历的 reports/ 目录，完成后简历页的「完整性」按钮可看。",
      inputSchema: z.object({}),
      execute: () => {
        const currentId = resumes.list().currentId;
        if (currentId === null) throw new Error("还没有简历。");
        const task = tasks.run("resume-integrity", currentId);
        return `任务已发起（${task.id}），报告会写进 resumes/${currentId}/reports/。`;
      },
    }),
  };
}
