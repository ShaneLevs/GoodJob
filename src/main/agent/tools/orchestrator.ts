import { tool, type ToolSet } from "ai";
import { z } from "zod";

import {
  MAX_WORKFLOW_TASKS,
  type ConversationKey,
  type SubagentRole,
} from "@shared/types";

import type { AgentDeps } from "../deps";
import { jobSummaries } from "../instructions";

const roleSchema = z.enum(["resume", "companies", "jobs", "job"]);

const subagentTaskSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/)
    .describe("任务 id：短英文 / 数字 / 连字符，dependsOn 用它引用"),
  agent: roleSchema.describe(
    "执行角色：resume=简历，companies=公司档案，jobs=岗位档案与投递状态，job=某个岗位的定制简历 / 话术",
  ),
  title: z.string().min(1).max(80).describe("给用户看的短标题"),
  instruction: z
    .string()
    .min(1)
    .max(6000)
    .describe("完整任务说明。子 agent 看不到 GoodJob 对话，必须自带目标、对象 id、范围和交付物要求；要用上传文件就写清文件名，子 agent 能只读工作区 uploads/"),
  dependsOn: z
    .array(z.string())
    .max(8)
    .optional()
    .describe("前置任务 id 列表；没有先后关系就省略或传空数组"),
  targetId: z
    .string()
    .optional()
    .describe("仅 job 角色需要：要操作的岗位 id（先用 workspace_overview 查真实 id）"),
});

/**
 * GoodJob 工具：
 * - workspace_overview 只读盘点当前工作区，帮 GoodJob 决定拆不拆、拆给谁；
 * - subagent_run 单角色任务，不建工作流；
 * - workflow_run 多任务 + 依赖，建工作流并实时推右侧流程图。
 */
export function orchestratorTools(
  deps: AgentDeps,
  key: ConversationKey,
  touch: () => void,
): ToolSet {
  return {
    workspace_overview: tool({
      description:
        "只读盘点当前工作区：主简历、公司、岗位（含匹配度）、投递、模拟面试。派发任务前先查真实 id 和现状。",
      inputSchema: z.object({}),
      execute: () => {
        const resume = deps.resumes.list();
        return {
          resumes: {
            current:
              resume.items.find((item) => item.id === resume.currentId)?.name ?? null,
            count: resume.items.length,
            tailored: deps.resumes.listTailoredNames(),
          },
          companies: deps.companies.list().map(({ id, name, industry, city, updatedAt }) => ({
            id,
            name,
            industry,
            city,
            updatedAt,
          })),
          jobs: jobSummaries(deps),
          interviews: deps.interviews.list().map(({ id, jobId, status, review, createdAt }) => ({
            id,
            jobId,
            status,
            score: review?.score ?? null,
            createdAt,
          })),
        };
      },
    }),

    subagent_run: tool({
      description:
        "把一个只涉及单一角色的任务派给子 agent，等它完成并拿回结果。只处理一个角色能独立完成的事；不要为它建工作流。",
      inputSchema: z.object({
        agent: roleSchema.describe("执行角色"),
        title: z.string().min(1).max(80).describe("给用户看的短标题"),
        instruction: z
          .string()
          .min(1)
          .max(6000)
          .describe("完整任务说明。子 agent 看不到当前对话，必须自带目标、对象 id、范围和交付物；要用上传文件就写清文件名"),
        targetId: z.string().optional().describe("仅 job 角色需要：岗位 id"),
      }),
      execute: async ({ agent, title, instruction, targetId }, { abortSignal }) =>
        deps.workflow.runSubagent({
          agent: agent as SubagentRole,
          title,
          instruction,
          targetId: targetId ?? null,
          signal: abortSignal,
          touch,
        }),
    }),

    workflow_run: tool({
      description:
        "把需要多个角色协作、或任务之间有先后依赖的事拆成工作流并立即执行。会创建右侧流程图并实时更新每个子 agent 的状态；阻塞到全部任务结束，返回逐任务结果。只有一个任务时请改用 subagent_run。",
      inputSchema: z.object({
        title: z.string().min(1).max(100).describe("工作流标题（给用户看）"),
        tasks: z
          .array(subagentTaskSchema)
          .min(2)
          .max(MAX_WORKFLOW_TASKS)
          .describe("任务列表；用 dependsOn 表达先后关系，没有依赖的任务会并行执行"),
      }),
      execute: async ({ title, tasks }, { abortSignal }) =>
        deps.workflow.runWorkflow({
          key,
          title,
          tasks: tasks.map((task) => ({
            id: task.id,
            agent: task.agent as SubagentRole,
            title: task.title,
            instruction: task.instruction,
            dependsOn: task.dependsOn ?? [],
            targetId: task.targetId ?? null,
          })),
          signal: abortSignal,
          touch,
        }),
    }),
  };
}
