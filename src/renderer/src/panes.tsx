import type { ReactNode } from "react";

import {
  FileText,
  Gauge,
  Globe,
  History,
  PencilLine,
} from "lucide-react";

import type { PaneKey } from "@shared/types";

// PaneKey 的真值在 shared/types.ts（跨进程事件 agent:pane-open 要用到），
// 内容注册表在这里：右栏每个标签展示什么、空闲时怎么介绍自己。
export type { PaneKey };

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
    key: "scorecard",
    label: "评分卡",
    icon: <Gauge />,
    hint: "简历评估（JD 匹配度）与简历完整性的评分报告",
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
