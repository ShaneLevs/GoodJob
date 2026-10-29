import {
  conversationScope,
  interviewKeyTarget,
  jobKeyTarget,
  type ConversationKey,
} from "@shared/types";
import type { ToolSet } from "ai";

import type { AgentDeps } from "../deps";
import { conversationTools } from "./conversation";
import { applicationTools, companyTools, jobTools } from "./domain";
import { interviewSessionTools } from "./interview";
import { jobWorkbenchTools } from "./job";
import { resumeTools, skillTools } from "./resume";
import { browserTools, memoryTools, notifyTools, uploadTools } from "./shared";
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
): ToolSet {
  // 场景决定工具集；key 里的线程后缀只影响会话落盘 / 浏览器任务绑定。
  const scope = conversationScope(key);
  const memory = memoryTools(deps);
  // 上传的参考文件：每个会话都有（落各自模块的 upload/），面试官是限定角色所以不给。
  const upload = uploadTools(deps, key);
  // 压缩后的旧上下文回查：只读当前会话，所有角色都可用。
  const conversation = conversationTools(deps, key);
  // 技能库：按会话场景过滤，没有适用技能的会话拿到空对象。
  const skills = skillLibraryTools(key);

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
    return { ...conversation, ...skills, ...interviewSessionTools(deps, interviewKey) };
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
