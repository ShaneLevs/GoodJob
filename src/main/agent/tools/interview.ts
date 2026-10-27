import { tool, type ToolSet } from "ai";
import { z } from "zod";

import type { AgentDeps } from "../deps";

export function interviewSessionTools(deps: AgentDeps, interviewId: string): ToolSet {
  const { resumes, jobs, companies, interviews } = deps;

  const mustInterview = () => {
    const interview = interviews.get(interviewId);
    if (interview === null) throw new Error("这条面试记录已被删除。");
    return interview;
  };

  return {
    job_info: tool({
      description: "查看当前面试岗位的档案（标题 / 薪资 / JD 原文 / 匹配度报告）与公司名。",
      inputSchema: z.object({}),
      execute: () => {
        const interview = mustInterview();
        const job = jobs.get(interview.jobId);
        if (job === null) throw new Error(`岗位不存在：${interview.jobId}（可能已被删除）`);
        const company = job.companyId === null ? null : companies.get(job.companyId);
        return { ...job, companyName: company?.name ?? null };
      },
    }),
    resume_read: tool({
      description: "读取主简历 resume.md 的完整内容（定制稿的底稿，面试口径以定制稿为准）。",
      inputSchema: z.object({}),
      execute: () => resumes.read({ kind: "main" })?.content ?? "",
    }),
    job_tailored_read: tool({
      description: "读取当前岗位的定制简历（面试提问的主要口径）；缺失时返回空字符串。",
      inputSchema: z.object({}),
      execute: () => {
        const interview = mustInterview();
        return resumes.readTailored(interview.jobId) ?? "";
      },
    }),
    job_script_read: tool({
      description: "读取当前岗位的面试话术（候选人准备过的答案，追问时用来验证深度）；缺失时返回空字符串。",
      inputSchema: z.object({}),
      execute: () => {
        const interview = mustInterview();
        return resumes.readScript(interview.jobId)?.content ?? "";
      },
    }),
    interview_round_log: tool({
      description:
        "记录已完成的一轮面试（每轮收束后必须调用，没有记录不算完成一轮）。question=本轮主问题；followUps=追问列表（0~2 条）；answer=候选人回答要点。同一轮补记（主问题相同）会整体覆盖。",
      inputSchema: z.object({
        question: z.string(),
        followUps: z.array(z.string()).max(4).optional(),
        answer: z.string().optional(),
      }),
      execute: ({ question, followUps, answer }) => {
        const next = interviews.logRound(interviewId, { question, followUps, answer });
        return `已记录第 ${next.rounds.length} 轮（设定 ${next.config.rounds} 轮）。`;
      },
    }),
    interview_submit_review: tool({
      description:
        "收束面试并保存总评：score=总评分(0-100)；overall=Markdown 总评正文（表达/深度/结构/岗位匹配四维 + 逐轮一句话小结）；strengths=亮点；weaknesses=风险与不足；suggestions=逐条可执行的改进建议；roundNotes=按轮对齐的表现小结。保存后在回复里给用户完整总评。",
      inputSchema: z.object({
        score: z.number().min(0).max(100),
        overall: z.string(),
        strengths: z.array(z.string()).optional(),
        weaknesses: z.array(z.string()).optional(),
        suggestions: z.array(z.string()).optional(),
        roundNotes: z.array(z.string()).optional(),
      }),
      execute: ({ score, overall, strengths, weaknesses, suggestions, roundNotes }) => {
        interviews.finish(
          interviewId,
          {
            score,
            overall,
            strengths: strengths ?? [],
            weaknesses: weaknesses ?? [],
            suggestions: suggestions ?? [],
          },
          roundNotes,
        );
        return "总评已保存，面试已结束。请在回复里把总评完整讲给用户。";
      },
    }),
  };
}
