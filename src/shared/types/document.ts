/**
 * 文档预览 / PDF 导出的 Markdown 主题（模板）。
 * 和界面外观一样属于「这台机器上的这个人」的偏好，所以存在配置根目录的
 * `preferences.json`，切工作区不跟着变。
 */
export interface MarkdownSettings {
  /** 渲染层 `components/document/templates` 登记的主题 id；未知值回退到默认主题。 */
  themeId: string;
}

/** 默认主题：与渲染层模板注册表的第一项（薄荷）一致。 */
export const DEFAULT_MARKDOWN_THEME_ID = "mint";
