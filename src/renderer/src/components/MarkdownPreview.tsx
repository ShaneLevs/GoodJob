import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { renderMarkdownHtml } from "@/markdown/render";
import { DEFAULT_TEMPLATE_ID, getDocumentTemplate } from "@/markdown/templates";

interface MarkdownPreviewProps {
  markdown: string;
  /** 模板 id，缺省用默认模板。 */
  templateId?: string;
  /** 内容为空时纸面位置的提示文案（各使用处自己给，别在这里塞业务话术）。 */
  emptyText?: string;
}

/**
 * 通用的文档预览：Markdown（含我们的特有语法）→ HTML → 模板 CSS 排版的白纸。
 * 纸面永远是白底——它是「文档」，不跟随界面深浅色；四周的衬托色随主题。
 * 模板样式用 <style> 注入且全部 scoped 在纸面 class 下，不进 globals.css；
 * 简历、定制稿、JD 之类的展示都复用这个组件，换外观 = 换模板。
 */
export function MarkdownPreview({ markdown, templateId = DEFAULT_TEMPLATE_ID, emptyText }: MarkdownPreviewProps) {
  const template = getDocumentTemplate(templateId);
  const html = useMemo(() => renderMarkdownHtml(markdown), [markdown]);

  if (markdown.trim() === "") {
    return (
      <div className="flex h-full items-center justify-center bg-muted/40 px-8 text-center text-sm text-muted-foreground">
        {emptyText ?? "暂无内容"}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-muted/40">
      <style>{template.css}</style>
      <div
        className={cn("doc-paper mx-auto min-h-full bg-white shadow-sm ring-1 ring-black/5", template.paperClass)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
