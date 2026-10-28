import type { SkillFileInfo, SkillScenario } from "@shared/types";

/** 技能库的公共类型：给各技能模块与工具层共用，避免互相 import。 */
export type { SkillFileInfo, SkillScenario };

export interface Skill {
  /** 工具参数里用的稳定标识，例如 `resume-writing`。 */
  name: string;
  /** 给人看的中文名。 */
  title: string;
  /** 一句话说明什么时候用（进系统提示的技能索引）。 */
  summary: string;
  scenarios: readonly SkillScenario[];
  files: readonly SkillFileInfo[];
}
