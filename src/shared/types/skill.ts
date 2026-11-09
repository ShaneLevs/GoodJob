/** 技能适用的会话场景（与 ConversationKey 的模块对应，外加岗位工作台）。 */
export type SkillScenario = "resume" | "job" | "companies" | "jobs" | "interview";

export interface SkillFileInfo {
  /** 相对技能目录的路径，例如 `SKILL.md` / `references/workflow.md`。 */
  path: string;
  content: string;
}

/** 设置 → Skill 管理里的只读视图：内置技能的元数据与全部文件正文。 */
export interface SkillInfo {
  /** 稳定标识，例如 `resume-writing`。 */
  name: string;
  /** 中文名。 */
  title: string;
  /** 一句话说明什么时候用。 */
  summary: string;
  scenarios: readonly SkillScenario[];
  files: readonly SkillFileInfo[];
}
