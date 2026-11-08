import type { MarkdownSettings as MarkdownSettingsValue } from "@shared/types";

import { DocumentPreview } from "@/components/document/DocumentPreview";
import { DOCUMENT_TEMPLATES, getDocumentTemplate } from "@/components/document/templates";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface MarkdownSettingsProps {
  settings: MarkdownSettingsValue;
  onChange: (patch: Partial<MarkdownSettingsValue>) => void;
}

/** 预览示例：覆盖标题、列表、引用、表格，换主题时能一眼看出差别。 */
const SAMPLE = `# 张三

## 工作经历

#### 高级前端工程师 | 某某公司 | 2022 – 至今

- 负责桌面端编辑器与内嵌浏览器
- 主导 3 个核心模块的重构
  - 建立组件库与主题 token

1. 梳理需求与验收标准

> 一句话概述这段经历的价值。

| 项目 | 结果 |
| --- | --- |
| 性能优化 | 首屏耗时下降 40% |
`;

export function MarkdownSettings({ settings, onChange }: MarkdownSettingsProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <h1 className="text-lg font-semibold tracking-tight">简历主题</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        简历、话术、调研快照等文档的预览与 PDF 导出排版。
      </p>

      <div className="mt-6 divide-y rounded-xl border">
        <div className="flex items-center justify-between gap-6 p-4">
          <div className="min-w-0">
            <Label className="text-sm font-medium">主题</Label>
            <p className="mt-1 text-xs text-muted-foreground">预览与 PDF 导出共用同一套主题。</p>
          </div>
          <Select
            value={getDocumentTemplate(settings.themeId).id}
            onValueChange={(themeId) => onChange({ themeId })}
          >
            <SelectTrigger className="w-44" aria-label="简历主题">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DOCUMENT_TEMPLATES.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-6">
        <p className="text-sm font-medium">预览</p>
        <p className="mt-1 text-xs text-muted-foreground">示例文档，切换主题后立即生效。</p>
        {/* 高度随内容走：示例完整展示，不在预览框里再套一层滚动。 */}
        <div className="mt-3 overflow-hidden rounded-xl border">
          <DocumentPreview
            markdown={SAMPLE}
            templateId={settings.themeId}
            emptyText="（空文档）"
          />
        </div>
      </div>
    </div>
  );
}
