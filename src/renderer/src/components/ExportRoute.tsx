import { useEffect, useState } from "react";

import { MarkdownPreview } from "@/components/MarkdownPreview";
import { DEFAULT_TEMPLATE_ID } from "@/markdown/templates";

declare global {
  interface Window {
    /** PDF 导出路由的调用约定；由 main 的 executeJavaScript 调（见 src/main/pdf-export.ts）。 */
    __goodjobRenderExport?: (
      markdown: string,
      templateId: string | null,
      photoUrl: string | null,
    ) => Promise<void>;
  }
}

/**
 * PDF 导出路由（渲染层，契约见 src/main/pdf-export.ts 文件头）：
 * main 起隐藏窗口加载 `#export`，调用 window.__goodjobRenderExport(markdown,
 * templateId, photoUrl) 排版（就是 MarkdownPreview + 模板 CSS），等两帧 paint、
 * 字体与图片就绪后 resolve，main 再 printToPDF。
 * 这个路由不挂 App、不碰 window.goodjob（导出窗口故意不给 preload）。
 */
export function ExportRoute() {
  const [markdown, setMarkdown] = useState("");
  const [templateId, setTemplateId] = useState<string>(DEFAULT_TEMPLATE_ID);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  useEffect(() => {
    const render = async (
      source: string,
      template: string | null,
      photo: string | null,
    ): Promise<void> => {
      setMarkdown(source);
      setTemplateId(template ?? DEFAULT_TEMPLATE_ID);
      setPhotoUrl(photo);
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
      <MarkdownPreview
        markdown={markdown}
        templateId={templateId}
        photoUrl={photoUrl}
        emptyText="（空文档）"
      />
    </div>
  );
}
