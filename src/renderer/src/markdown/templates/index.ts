import { mint } from "./mint";

/** 一份文档模板 = 一段 scoped CSS + 纸面 class。MarkdownPreview 的外观完全由它决定。 */
export interface DocumentTemplate {
  id: string;
  name: string;
  /** 加在预览纸面上的 class，模板 CSS 的所有选择器都挂在它下面。 */
  paperClass: string;
  /** 模板样式。由 MarkdownPreview 以 <style> 注入（CSP 允许 inline style），不进 globals.css。 */
  css: string;
}

/** 目前只有一份模板；后续加模板就是往这里加一个模块（必要时再配选择 UI）。 */
export const DOCUMENT_TEMPLATES: readonly DocumentTemplate[] = [mint];

export const DEFAULT_TEMPLATE_ID = mint.id;

export function getDocumentTemplate(id: string): DocumentTemplate {
  return DOCUMENT_TEMPLATES.find((template) => template.id === id) ?? mint;
}
