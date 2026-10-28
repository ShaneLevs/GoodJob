import { createContext, useContext, type ReactNode } from "react";

import { DEFAULT_MARKDOWN_THEME_ID } from "@shared/types";

/*
 * 当前 Markdown 主题（文档模板 id）。设置页改完由 App 更新 Context，
 * 所有 DocumentPreview 立即换主题；PDF 导出由 main 读同一份偏好补 templateId。
 */
const MarkdownThemeContext = createContext<string>(DEFAULT_MARKDOWN_THEME_ID);

export function MarkdownThemeProvider({
  themeId,
  children,
}: {
  themeId: string;
  children: ReactNode;
}) {
  return <MarkdownThemeContext.Provider value={themeId}>{children}</MarkdownThemeContext.Provider>;
}

export function useMarkdownTheme(): string {
  return useContext(MarkdownThemeContext);
}
