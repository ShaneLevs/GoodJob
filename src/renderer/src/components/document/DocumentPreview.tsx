import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { useMarkdownTheme } from "@/components/document/MarkdownTheme";
import { extractPhotoDirective, renderMarkdownHtml } from "@/components/document/render";
import { getDocumentTemplate } from "@/components/document/templates";

interface DocumentPreviewProps {
  markdown: string;
  /** 模板 id，缺省用默认模板。 */
  templateId?: string;
  /**
   * 正文里 upload/ 图片路径 → data URL。图片读取在 main，渲染层只替换 src；
   * 图片放在哪由 Markdown / HTML 自己决定，模板 CSS 不再参与定位。
   */
  imageUrls?: Readonly<Record<string, string>>;
  /** 内容为空时纸面位置的提示文案（各使用处自己给，别在这里塞业务话术）。 */
  emptyText?: string;
}

/**
 * 通用的文档预览：Markdown（含我们的特有语法）→ HTML → 模板 CSS 排版的白纸。
 * 纸面永远是白底——它是「文档」，不跟随界面深浅色；四周的衬托色随主题。
 * 模板样式用 <style> 注入且全部 scoped 在纸面 class 下，不进 globals.css；
 * 简历、定制稿、JD 之类的展示都复用这个组件，换外观 = 换模板。
 */
export function DocumentPreview({
  markdown,
  templateId,
  imageUrls,
  emptyText,
}: DocumentPreviewProps) {
  const themeId = useMarkdownTheme();
  const template = getDocumentTemplate(templateId ?? themeId);
  // 旧版 `photo:` 指令只从正文里去掉，不再生成照片节点：位置由 Markdown 决定。
  const { markdown: body } = useMemo(() => extractPhotoDirective(markdown), [markdown]);
  const html = useMemo(() => renderMarkdownHtml(body, imageUrls), [body, imageUrls]);

  if (body.trim() === "") {
    return (
      <div className="flex h-full items-center justify-center bg-muted/40 px-8 text-center text-sm text-muted-foreground">
        {emptyText ?? "暂无内容"}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-muted/40 print:h-auto print:bg-transparent">
      <style>{template.css}</style>
      <div
        className={cn(
          "doc-paper mx-auto min-h-full bg-white shadow-sm ring-1 ring-black/5 print:min-h-0 print:shadow-none print:ring-0",
          template.paperClass,
        )}
      >
        <div className="doc-body" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
