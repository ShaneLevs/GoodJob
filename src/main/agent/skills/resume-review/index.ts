import skillMd from "./SKILL.md?raw";
import jdAnalysisMd from "./references/jd-analysis.md?raw";
import matchingDiagnosisMd from "./references/matching-diagnosis.md?raw";
import scoringRubricMd from "./references/scoring-rubric.md?raw";
import writingStandardsMd from "./references/writing-standards.md?raw";

import type { Skill } from "../types";

/** 后台「完整性」评测直接复用这份评分细则，保证对话与任务同一套口径。 */
export const RESUME_REVIEW_RUBRIC = scoringRubricMd;

export const resumeReviewSkill: Skill = {
  name: "resume-review",
  title: "简历优化与判断",
  summary: "判断简历质量与分数、按岗位 JD 对标改写、投递前做最后检查时用",
  scenarios: ["resume", "job"],
  files: [
    { path: "SKILL.md", content: skillMd },
    { path: "references/jd-analysis.md", content: jdAnalysisMd },
    { path: "references/matching-diagnosis.md", content: matchingDiagnosisMd },
    { path: "references/writing-standards.md", content: writingStandardsMd },
    { path: "references/scoring-rubric.md", content: scoringRubricMd },
  ],
};
