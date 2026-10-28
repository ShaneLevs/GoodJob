import skillMd from "./SKILL.md?raw";
import sectionChecklistMd from "./references/section-checklist.md?raw";
import workflowMd from "./references/workflow.md?raw";

import type { Skill } from "../types";

export const resumeWritingSkill: Skill = {
  name: "resume-writing",
  title: "简历写作",
  summary: "从零写简历、把零散经历整理成初稿、应届 / 转行不知道写什么时用",
  scenarios: ["resume", "job"],
  files: [
    { path: "SKILL.md", content: skillMd },
    { path: "references/workflow.md", content: workflowMd },
    { path: "references/section-checklist.md", content: sectionChecklistMd },
  ],
};
