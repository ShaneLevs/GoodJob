import { useEffect, useState } from "react";

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";

interface ResumeMarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
}

/**
 * 简历的 Markdown 源码编辑器（CodeMirror 6）。
 * 简历里会夹 HTML（顶部信息表）和特有语法，所见即所得编辑器反而难管，
 * 所以编辑模式就是纯文本 + Markdown 高亮；排版效果切到预览模式看。
 */
export function ResumeMarkdownEditor({ value, onChange }: ResumeMarkdownEditorProps) {
  const dark = useHtmlDark();

  return (
    <div className="h-full [&_.cm-editor]:h-full [&_.cm-scroller]:font-mono [&_.cm-scroller]:px-5 [&_.cm-scroller]:py-4">
      <CodeMirror
        value={value}
        onChange={onChange}
        height="100%"
        theme={dark ? "dark" : "light"}
        extensions={[markdown({ base: markdownLanguage, addKeymap: true })]}
        placeholder="在这里用 Markdown 编辑简历，或让左边的 Agent 帮你起草"
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
