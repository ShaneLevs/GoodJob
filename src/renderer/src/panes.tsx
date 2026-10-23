import type { ReactNode } from "react";

import {
  FileText,
  Globe,
  History,
  PencilLine,
} from "lucide-react";

export type PaneKey = "browser" | "markdown" | "editor" | "log";

export interface PaneMeta {
  key: PaneKey;
  label: string;
  icon: ReactNode;
  /** Shown in the idle hint so the user knows what the agent may show here. */
  hint: string;
}

export const PANES: PaneMeta[] = [
  {
    key: "browser",
    label: "浏览器",
    icon: <Globe />,
    hint: "Agent 检索、填写招聘站点时会在这里显示页面",
  },
  {
    key: "markdown",
    label: "文档预览",
    icon: <FileText />,
    hint: "AI 生成的简历、岗位对比、面试清单的 Markdown 预览",
  },
  {
    key: "editor",
    label: "编辑",
    icon: <PencilLine />,
    hint: "需要你调整的文档会在这里打开，改完存到本地工作区",
  },
  {
    key: "log",
    label: "工作日志",
    icon: <History />,
    hint: "Agent 每一步做了什么都会记录在这里",
  },
];

export const PANE_BY_KEY: Record<PaneKey, PaneMeta> = Object.fromEntries(
  PANES.map((pane) => [pane.key, pane]),
) as Record<PaneKey, PaneMeta>;
