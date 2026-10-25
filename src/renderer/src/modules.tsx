import type { ReactNode } from "react";

import {
  Briefcase,
  Building2,
  FileText,
  Send,
  Users,
} from "lucide-react";

/** 左栏模块菜单的 key；开滚动会话的模块与 ConversationKey 对齐（简历 / 岗位 / 投递 / 面试 / 公司）。 */
export type ModuleKey = "resume" | "jobs" | "applications" | "interview" | "companies";

export interface ModuleMeta {
  key: ModuleKey;
  label: string;
  icon: ReactNode;
  /** 以后才有的模块在占位页里说明（当前五个模块都已启用）。 */
  planned?: string;
}

export const MODULES: ModuleMeta[] = [
  { key: "resume", label: "简历", icon: <FileText /> },
  { key: "jobs", label: "岗位", icon: <Briefcase /> },
  { key: "applications", label: "投递", icon: <Send /> },
  { key: "interview", label: "面试", icon: <Users /> },
  { key: "companies", label: "公司", icon: <Building2 /> },
];

export const MODULE_BY_KEY: Record<ModuleKey, ModuleMeta> = Object.fromEntries(
  MODULES.map((module) => [module.key, module]),
) as Record<ModuleKey, ModuleMeta>;
