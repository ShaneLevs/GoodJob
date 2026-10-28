import {
  interviewKeyTarget,
  jobKeyTarget,
  type ConversationKey,
  type SkillInfo,
} from "@shared/types";

import { interviewPrepSkill } from "./interview-prep";
import { resumeReviewSkill } from "./resume-review";
import { resumeWritingSkill } from "./resume-writing";
import type { Skill, SkillScenario } from "./types";

export type { Skill, SkillFileInfo, SkillScenario } from "./types";

/**
 * 内置技能库。技能是「按需加载的方法论」：系统提示只放一行索引，
 * 正文与 references 由 `skill_read` 在用户的需求真的落到某个场景时读取。
 * 新增技能 = 一个目录（SKILL.md + references/）+ 这里登记一行。
 */
const SKILLS: readonly Skill[] = [resumeWritingSkill, resumeReviewSkill, interviewPrepSkill];

/** 会话 key → 技能场景。岗位工作台与模拟面试是复合 key，单独判断。 */
export function scenarioOf(key: ConversationKey): SkillScenario {
  if (jobKeyTarget(key) !== null) return "job";
  if (interviewKeyTarget(key) !== null) return "interview";
  switch (key) {
    case "companies":
      return "companies";
    case "jobs":
      return "jobs";
    case "applications":
      return "applications";
    default:
      return "resume";
  }
}

export function skillsFor(scenario: SkillScenario): readonly Skill[] {
  return SKILLS.filter((skill) => skill.scenarios.includes(scenario));
}

/** 设置 → Skill 管理：把内置技能连同正文交给渲染层（只读视图）。 */
export function listSkillInfos(): SkillInfo[] {
  return SKILLS.map((skill) => ({
    name: skill.name,
    title: skill.title,
    summary: skill.summary,
    scenarios: [...skill.scenarios],
    files: skill.files.map((file) => ({ path: file.path, content: file.content })),
  }));
}

/**
 * 系统提示里的技能索引：只列当前会话可用的技能与一句话触发条件。
 * 没有适用技能时返回空串，调用方直接跳过。
 */
export function skillIndexSection(key: ConversationKey): string {
  const skills = skillsFor(scenarioOf(key));
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => `- ${skill.name}（${skill.title}）：${skill.summary}`);
  return [
    "# 技能库（按需加载）",
    "",
    "用户的需求落到下面某个场景时，先用 skill_read 读取对应技能的 SKILL.md，再按里面的流程做；需要细节时读它列出的 references/ 文件。技能只是方法论，不改变工具权限，也不覆盖本会话的硬规则。",
    "",
    ...lines,
  ].join("\n");
}
