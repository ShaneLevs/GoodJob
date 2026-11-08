import {
  conversationScope,
  interviewKeyTarget,
  jobKeyTarget,
  type ConversationKey,
  type SubagentRole,
} from "@shared/types";
import type { ToolSet } from "ai";

import type { AgentDeps } from "../deps";
import { conversationTools } from "./conversation";
import { applicationTools, companyTools, jobTools } from "./domain";
import { interviewSessionTools } from "./interview";
import { jobWorkbenchTools } from "./job";
import { orchestratorTools } from "./orchestrator";
import { resumeTools, skillTools } from "./resume";
import { browserTools, memoryTools, notifyTools, uploadTools, uploadToolsAt } from "./shared";
import { skillLibraryTools } from "./skills";

/**
 * 工具注册表：按会话 key 分发（模块会话 + `job:<jobId>` 岗位工作台 +
 * `interview:<id>` 模拟面试）。写操作的枚举 / 引用校验在 store 里做，
 * 抛出的错误会作为 tool-error 带回模型自行纠正。memory 工具所有会话都有
 * （面试会话除外——面试官是限定角色，不给写记忆的能力）。
 */
export function toolsFor(
  deps: AgentDeps,
  key: ConversationKey,
  lastActivityAt: () => number,
  /** 子任务运行期间重置流式看门狗；普通模块会话不需要。 */
  touch: () => void = () => {},
): ToolSet {
  // 场景决定工具集；key 里的线程后缀只影响会话落盘 / 浏览器任务绑定。
  const scope = conversationScope(key);
  const memory = memoryTools(deps);
  // 上传的参考文件：每个会话都有（落各自模块的 upload/，GoodJob 落工作区 uploads/）。
  const upload = uploadTools(deps, key);
  // 压缩后的旧上下文回查：只读当前会话，所有角色都可用。
  const conversation = conversationTools(deps, key);
  // 技能库：按会话场景过滤，没有适用技能的会话拿到空对象。
  const skills = skillLibraryTools(key);

  // GoodJob 只负责分析 / 拆分 / 派发；业务工具都在子 agent 手里。
  if (scope === "orchestrator") {
    return { ...conversation, ...upload, ...orchestratorTools(deps, key, touch) };
  }

  const jobKey = jobKeyTarget(scope);
  if (jobKey !== null) {
    return {
      ...conversation,
      ...memory,
      ...upload,
      ...skills,
      ...jobWorkbenchTools(deps, jobKey),
    };
  }

  const interviewKey = interviewKeyTarget(scope);
  if (interviewKey !== null) {
    return {
      ...conversation,
      ...upload,
      ...skills,
      ...interviewSessionTools(deps, interviewKey),
    };
  }

  switch (scope) {
    case "companies":
      // 公司调研（P4）：浏览器只读动作辅助调研，快照整理进 research。
      return {
        ...conversation,
        ...memory,
        ...upload,
        ...skills,
        ...companyTools(deps),
        ...browserTools(deps, key, lastActivityAt),
      };
    case "jobs":
      // 链接抓 JD / 自动搜索（P4）：只读浏览，回填岗位档案。
      return {
        ...conversation,
        ...memory,
        ...upload,
        ...skills,
        ...jobTools(deps),
        ...browserTools(deps, key, lastActivityAt),
      };
    case "applications":
      // 投递会话拿通知工具（P3 M3）：外发 / 邮件确认门都以「用户自己的邮箱」为准。
      // 填表投递（P4 M4）：browser_act / browser_submit 双重门 + 限速也在这里。
      return {
        ...conversation,
        ...memory,
        ...upload,
        ...skills,
        ...applicationTools(deps),
        ...notifyTools(deps),
        ...browserTools(deps, key, lastActivityAt),
      };
    default:
      // resume：简历协作工具（P1）+ 话术 + 评分技能（后台任务）+ 技能库。
      return {
        ...conversation,
        ...memory,
        ...upload,
        ...skills,
        ...resumeTools(deps),
        ...skillTools(deps),
      };
  }
}

/**
 * 子 agent 的工具集：按角色复用对应模块的业务工具。
 *
 * 不含 conversation / memory / browser / notify：
 * - 子 agent 的上下文是独立的，没有「当前对话」可查；
 * - AI SDK 的 subagent 不支持 toolApproval，浏览器写动作与邮件外发若进来会绕过
 *   现有审批门（AGENTS.md 硬约束 7 / 架构 §4）。需要这些动作时由 GoodJob 把结论
 *   交回用户，在对应模块里执行。
 *
 * 上传只给只读的一对工具（upload_list / upload_read），固定读 GoodJob 会话的
 * 工作区 uploads/：子 agent 自己开会话时看不到那边，但派发它的任务常带着附件。
 */
export function subagentToolsFor(
  deps: AgentDeps,
  role: SubagentRole,
  targetId: string | null,
): ToolSet {
  const key: ConversationKey =
    role === "job" && targetId !== null
      ? (`job:${targetId}` as ConversationKey)
      : (role as ConversationKey);
  const common = {
    ...uploadToolsAt(deps.uploadDir("orchestrator"), " GoodJob 会话的 uploads/ 目录"),
    ...skillLibraryTools(key),
  };
  switch (role) {
    case "job":
      return { ...jobWorkbenchTools(deps, targetId!), ...common };
    case "companies":
      return { ...companyTools(deps), ...common };
    case "jobs":
      return { ...jobTools(deps), ...common };
    case "applications":
      return { ...applicationTools(deps), ...common };
    case "resume":
      return { ...resumeTools(deps), ...skillTools(deps), ...common };
  }
}
