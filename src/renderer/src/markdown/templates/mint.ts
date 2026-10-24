import lexendBold from "@/assets/fonts/Lexend-Bold.ttf";
import lexendRegular from "@/assets/fonts/Lexend-Regular.ttf";

import type { DocumentTemplate } from "./index";

/*
 * 「薄荷」模板：从 Typora 简历模板项目（阿杆的 markdown-resume-template，mint 主题）
 * 移植。原始主题是给 Typora 的 #write 写的，这里收敛成两块：
 *   - mint.css 的配色 / 字号 / 间距（绿色点缀、代码块深底）；
 *   - 简历文档自带的紧凑覆盖（hr 6px、li 4px、表格去边框、链接下划线）。
 * 所有规则都 scoped 在 .tpl-mint（预览纸面的 class）下，注入方式见
 * MarkdownPreview——不进 globals.css，换模板就是换一份这样的 CSS。
 * Lexend（拉丁字形，SIL OFL 授权）随包分发；中文走系统字体，避免 17MB 的思源黑体。
 */
export const mint: DocumentTemplate = {
  id: "mint",
  name: "薄荷",
  paperClass: "tpl-mint",
  css: `
@font-face {
  font-family: "GoodJob Lexend";
  font-weight: 400;
  src: url("${lexendRegular}") format("truetype");
}
@font-face {
  font-family: "GoodJob Lexend";
  font-weight: 700;
  src: url("${lexendBold}") format("truetype");
}

.tpl-mint {
  --tpl-accent: #4eb289;
  --tpl-soft: #d9ede5;
  --tpl-muted: #777777;
  --tpl-rule: #e7e7e7;
  --tpl-code-bg: #0f111a;

  max-width: 760px;
  padding: 36px 46px 28px;
  color: #303133;
  font-family: "GoodJob Lexend", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.6;
}

/* —— 标题层级 —— */
.tpl-mint h1 {
  font-size: 1.8em;
  line-height: 1.15;
  margin: 8px 0;
  font-weight: 700;
}
.tpl-mint h2 {
  font-size: 1.4em;
  margin: 12px 0 8px;
  font-weight: 700;
}
.tpl-mint h3 {
  font-size: 1.2em;
  margin: 14px 0 8px;
  font-weight: 700;
}
.tpl-mint h4,
.tpl-mint h5,
.tpl-mint h6 {
  font-size: 1em;
  margin: 10px 0 6px;
  font-weight: 600;
}

/* ==高亮==：章节标题的底色就是它 */
.tpl-mint mark {
  background: #c7ffe8;
  color: #111111;
  border-radius: 2px;
  padding: 0 6px;
  margin: 0 2px;
}

/* 条目标题（#### A | B | C）：两端对齐的一行 */
.tpl-mint .entry-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1em;
  margin: 14px 0 6px;
  font-weight: 600;
}

/* —— 正文 —— */
.tpl-mint p {
  margin: 4px 0;
}
.tpl-mint ul,
.tpl-mint ol {
  margin: 4px 0;
  padding-left: 1.6em;
}
.tpl-mint li {
  margin: 4px 0;
}
.tpl-mint li > p {
  margin: 0;
}
.tpl-mint strong {
  font-weight: 700;
}
.tpl-mint hr {
  border: none;
  border-top: 1px solid var(--tpl-rule);
  margin: 10px 0;
}
.tpl-mint a {
  color: var(--tpl-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.tpl-mint img {
  max-width: 100%;
}

/* 引用：条目里的一句概述 */
.tpl-mint blockquote {
  margin: 6px 0;
  padding: 2px 0 2px 14px;
  border-left: 3px solid var(--tpl-soft);
  color: var(--tpl-muted);
  font-size: 0.92em;
}

/* 表格：原模板的用法是顶部信息区（无边框两列表），不给数据表格的边框样式 */
.tpl-mint table {
  width: 100%;
  border-collapse: collapse;
  margin: 4px 0;
}
.tpl-mint th,
.tpl-mint td {
  border: 0;
  padding: 4px 14px 4px 0;
  font-weight: normal;
  text-align: left;
  vertical-align: top;
}

/* —— 代码 —— */
.tpl-mint code,
.tpl-mint tt {
  padding: 1px 5px;
  border-radius: 3px;
  background: #f1f1f1;
  color: var(--tpl-code-bg);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em;
}
.tpl-mint pre {
  margin: 6px 0;
  padding: 10px 12px;
  border-radius: 4px;
  background: var(--tpl-code-bg);
  color: #a9b7c6;
  overflow-x: auto;
}
.tpl-mint pre code {
  padding: 0;
  background: none;
  color: inherit;
}
`,
};
