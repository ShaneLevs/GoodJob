import { useEffect, useState } from "react";

import { MarkdownPreview } from "@/components/MarkdownPreview";
import { DEFAULT_TEMPLATE_ID } from "@/markdown/templates";

declare global {
  interface Window {
    /** PDF 导出路由的调用约定；由 main 的 executeJavaScript 调（见 src/main/pdf-export.ts）。 */
    __goodjobRenderExport?: (markdown: string, templateId: string | null) => Promise<void>;
  }
}

/**
 * PDF 导出路由（渲染层，契约见 src/main/pdf-export.ts 文件头）：
 * main 起隐藏窗口加载 `#export`，调用 window.__goodjobRenderExport(markdown,
 * templateId) 排版（就是 MarkdownPreview + 模板 CSS），等两帧 paint 与
 * document.fonts.ready 后 resolve，main 再 printToPDF。
 * 这个路由不挂 App、不碰 window.goodjob（导出窗口故意不给 preload）。
 */
export function ExportRoute() {
  const [markdown, setMarkdown] = useState("");
  const [templateId, setTemplateId] = useState<string>(DEFAULT_TEMPLATE_ID);

  useEffect(() => {
    const render = async (source: string, template: string | null): Promise<void> => {
      setMarkdown(source);
      setTemplateId(template ?? DEFAULT_TEMPLATE_ID);
      // 两次 rAF 保证 React 提交并 paint 后再放行；随后等字体就绪（打印要量版面）。
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      await document.fonts.ready;
    };
    window.__goodjobRenderExport = render;
    return () => {
      delete window.__goodjobRenderExport;
    };
  }, []);

  return (
    <div className="h-full">
      <MarkdownPreview markdown={markdown} templateId={templateId} emptyText="（空文档）" />
    </div>
  );
}
