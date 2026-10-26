import { useEffect, useState } from "react";

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";

/** 固定扩展只建一次：每次渲染新建数组会让 useCodeMirror 反复重新配置编辑器。 */
const EXTENSIONS = [markdown({ base: markdownLanguage, addKeymap: true }), EditorView.lineWrapping];

interface ResumeMarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}

/**
 * 简历 / 话术这类长文档的 Markdown 源码编辑器（CodeMirror 6）。
 * 文档里会夹 HTML（简历顶部信息表）和特有语法，所见即所得编辑器反而难管，
 * 所以编辑模式就是纯文本 + Markdown 高亮；排版效果切到预览模式看。
 */
export function ResumeMarkdownEditor({ value, onChange, placeholder }: ResumeMarkdownEditorProps) {
  const dark = useHtmlDark();

  return (
    <div className="h-full min-h-0 overflow-hidden [&_.cm-editor]:h-full [&_.cm-scroller]:font-mono [&_.cm-scroller]:px-5 [&_.cm-scroller]:py-4">
      {/* className 落在 CodeMirror 自己的包装层（.cm-theme-light/.cm-theme-dark）上：
          它必须是确定高度，里面的 .cm-editor 的 height:100% 才有百分比基准，
          否则编辑器会长成整篇文档的高度而不是在容器里滚动。 */}
      <CodeMirror
        className="h-full min-h-0"
        value={value}
        onChange={onChange}
        height="100%"
        theme={dark ? "dark" : "light"}
        extensions={EXTENSIONS}
        placeholder={placeholder ?? "在这里用 Markdown 编辑简历，或让左边的 Agent 帮你起草"}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: false,
          closeBrackets: false,
          bracketMatching: false,
          highlightSelectionMatches: false,
        }}
      />
    </div>
  );
}

/** 编辑器只是界面部件，要跟随界面深浅色；主题唯一真值源是 <html>.dark（见 ThemeApplier）。 */
function useHtmlDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.classList.contains("dark")));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return dark;
}
