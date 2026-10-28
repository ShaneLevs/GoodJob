import type { ConversationKey } from "@shared/types";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { scenarioOf, skillsFor } from "../skills";

const MAIN_FILE = "SKILL.md";

/** 允许 `./SKILL.md`、`/SKILL.md` 这类写法，落盘路径本身是固定白名单。 */
function normalizeFile(file: string): string {
  const trimmed = file.trim().replace(/\\/g, "/");
  return trimmed.replace(/^\.?\//, "");
}

/**
 * 技能读取：只暴露当前会话适用的技能，文件名走白名单（技能目录里登记过的文件）。
 * 不读磁盘——技能随主进程一起打包，`?raw` 在构建时内联。
 */
export function skillLibraryTools(key: ConversationKey): ToolSet {
  const skills = skillsFor(scenarioOf(key));
  if (skills.length === 0) return {};

  return {
    skill_read: tool({
      description:
        "读取技能手册。省略 file 时返回 SKILL.md；需要细节时按 SKILL.md 里列出的 references/ 路径再读。只能读取当前会话可用的技能。",
      inputSchema: z.object({
        name: z.string().describe("技能名，见系统提示里的「技能库」索引"),
        file: z
          .string()
          .optional()
          .describe(`技能内文件路径，默认 ${MAIN_FILE}；例如 references/workflow.md`),
      }),
      execute: ({ name, file }) => {
        const skill = skills.find((item) => item.name === name);
        if (skill === undefined) {
          throw new Error(
            `当前会话没有「${name}」技能。可用：${skills.map((item) => item.name).join(" / ")}`,
          );
        }
        const path = normalizeFile(file ?? MAIN_FILE);
        const found = skill.files.find((item) => item.path === path);
        if (found === undefined) {
          throw new Error(
            `「${skill.name}」没有文件 ${path}。可用：${skill.files.map((item) => item.path).join(" / ")}`,
          );
        }
        return found.content;
      },
    }),
  };
}
