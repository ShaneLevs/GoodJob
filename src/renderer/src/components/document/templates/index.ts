import { DEFAULT_MARKDOWN_THEME_ID } from "@shared/types";

import graphiteCss from "./graphite.css?inline";
import mintCss from "./mint.css?inline";
import navyCss from "./navy.css?inline";

/** 一份文档模板 = 一段 scoped CSS + 纸面 class。DocumentPreview 的外观完全由它决定。 */
export interface DocumentTemplate {
  id: string;
  name: string;
  /** 加在预览纸面上的 class，模板 CSS 的所有选择器都挂在它下面。 */
  paperClass: string;
  /** 模板样式。由 DocumentPreview 以 <style> 注入（CSP 允许 inline style），不进 globals.css。 */
  css: string;
}

/**
 * 一个 CSS 文件 = 一套主题。`?inline` 让 Vite 正常处理 @font-face 与 url()，
 * 同时把结果作为字符串交给 DocumentPreview 按需注入；加主题就是加一份 css
 * 并在这里登记一行（id / 中文名 / paperClass）。
 */
export const DOCUMENT_TEMPLATES: readonly DocumentTemplate[] = [
  { id: "mint", name: "薄荷", paperClass: "tpl-mint", css: mintCss },
  { id: "graphite", name: "石墨", paperClass: "tpl-graphite", css: graphiteCss },
  { id: "navy", name: "藏蓝", paperClass: "tpl-navy", css: navyCss },
];

export const DEFAULT_TEMPLATE_ID = DEFAULT_MARKDOWN_THEME_ID;

/** 已下线主题的 id → 替代主题：旧偏好继续落到合适的外观，不突然回到默认。 */
const TEMPLATE_ALIASES: Record<string, string> = {
  parchment: "navy",
};

export function getDocumentTemplate(id: string): DocumentTemplate {
  const resolved = TEMPLATE_ALIASES[id] ?? id;
  return DOCUMENT_TEMPLATES.find((template) => template.id === resolved) ?? DOCUMENT_TEMPLATES[0]!;
}
