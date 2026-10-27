import mintCss from "./mint.css?inline";

/** 一份文档模板 = 一段 scoped CSS + 纸面 class。MarkdownPreview 的外观完全由它决定。 */
export interface DocumentTemplate {
  id: string;
  name: string;
  /** 加在预览纸面上的 class，模板 CSS 的所有选择器都挂在它下面。 */
  paperClass: string;
  /** 模板样式。由 MarkdownPreview 以 <style> 注入（CSP 允许 inline style），不进 globals.css。 */
  css: string;
}

/**
 * 一个 CSS 文件 = 一套主题。`?inline` 让 Vite 正常处理 @font-face 与 url()，
 * 同时把结果作为字符串交给 MarkdownPreview 按需注入；加主题就是加一份 css
 * 并在这里登记一行（id / 中文名 / paperClass）。
 */
export const DOCUMENT_TEMPLATES: readonly DocumentTemplate[] = [
  { id: "mint", name: "薄荷", paperClass: "tpl-mint", css: mintCss },
];

export const DEFAULT_TEMPLATE_ID = "mint";

export function getDocumentTemplate(id: string): DocumentTemplate {
  return DOCUMENT_TEMPLATES.find((template) => template.id === id) ?? DOCUMENT_TEMPLATES[0]!;
}
