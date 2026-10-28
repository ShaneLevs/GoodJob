/** pdf:export 的入参。 */
export interface PdfExportPayload {
  /** 要排版的 Markdown 源文。 */
  markdown: string;
  /** 文档模板 id（渲染层 components/document/templates 登记过的），缺省用默认模板。 */
  templateId?: string;
  /** 保存对话框预填的文件名（不含扩展名）。 */
  fileName?: string;
  /**
   * 正文里 upload/ 图片路径 → data URL。由渲染层扫描当前 Markdown、经 main 读成小图后
   * 随导出请求一起送进来，导出窗不需要再访问文件系统；图片位置由 Markdown 决定。
   */
  imageUrls?: Record<string, string>;
}

/** pdf:export 的回执：用户取消返回 null。 */
export interface PdfExportResult {
  savedTo: string;
}
