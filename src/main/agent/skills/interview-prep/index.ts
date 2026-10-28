import skillMd from "./SKILL.md?raw";
import interviewStrategyMd from "./references/interview-strategy.md?raw";

import type { Skill } from "../types";

export const interviewPrepSkill: Skill = {
  name: "interview-prep",
  title: "面试准备",
  summary: "拿到面试后预测问题、组织答案、准备自我介绍与反问、写面试话术时用",
  scenarios: ["resume", "job"],
  files: [
    { path: "SKILL.md", content: skillMd },
    { path: "references/interview-strategy.md", content: interviewStrategyMd },
  ],
};
