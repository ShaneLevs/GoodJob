import { Streamdown } from "streamdown";

import { cn } from "@/lib/utils";

import "streamdown/styles.css";

interface AssistantMarkdownProps {
  children: string;
  /** 还在流式输出时开启增量解析，未闭合的代码块/加粗也能正常显示。 */
  streaming?: boolean;
  className?: string;
}

/**
 * AI 回复的 AssistantMarkdown 渲染。
 *
 * Streamdown 是 AI Elements 选定的渲染器：它为流式场景做了增量解析，
 * 代码块、表格、链接都有默认样式与复制按钮，不需要我们再包一层。
 */
export function AssistantMarkdown({ children, streaming = false, className }: AssistantMarkdownProps) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      className={cn(
        "markdown text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      {children}
    </Streamdown>
  );
}
