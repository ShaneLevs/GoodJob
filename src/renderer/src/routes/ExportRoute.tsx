import { useEffect, useState } from "react";

import { DocumentPreview } from "@/components/document/DocumentPreview";
import { DEFAULT_TEMPLATE_ID } from "@/components/document/templates";

declare global {
  interface Window {
    /** PDF 导出路由的调用约定；由 main 的 executeJavaScript 调（见 src/main/pdf-export.ts）。 */
    __goodjobRenderExport?: (
      markdown: string,
      templateId: string | null,
      imageUrls: Record<string, string> | null,
    ) => Promise<void>;
  }
}

/**
 * PDF 导出路由（渲染层，契约见 src/main/pdf-export.ts 文件头）：
 * main 起隐藏窗口加载 `#export`，调用 window.__goodjobRenderExport(markdown,
 * templateId, imageUrls) 排版（就是 DocumentPreview + 模板 CSS），等两帧 paint、
 * 字体与图片就绪后 resolve，main 再 printToPDF。
 * 这个路由不挂 App、不碰 window.goodjob（导出窗口故意不给 preload）。
 */
export function ExportRoute() {
  const [markdown, setMarkdown] = useState("");
  const [templateId, setTemplateId] = useState<string>(DEFAULT_TEMPLATE_ID);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const render = async (
      source: string,
      template: string | null,
      images: Record<string, string> | null,
    ): Promise<void> => {
      setMarkdown(source);
      setTemplateId(template ?? DEFAULT_TEMPLATE_ID);
      setImageUrls(images ?? {});
      // 两次 rAF 保证 React 提交并 paint 后再放行；随后等字体与图片就绪（打印要量版面）。
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images).map((image) => image.decode().catch(() => undefined)),
      );
      // 字体置换 / 图片解码也可能发生在下一帧，再等一次 paint 才让 printToPDF 抓版面。
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    };
    window.__goodjobRenderExport = render;
    return () => {
      delete window.__goodjobRenderExport;
    };
  }, []);

  return (
    <div className="h-full">
      <DocumentPreview
        markdown={markdown}
        templateId={templateId}
        imageUrls={imageUrls}
        emptyText="（空文档）"
      />
    </div>
  );
}
