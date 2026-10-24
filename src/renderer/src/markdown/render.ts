import DOMPurify from "dompurify";
import { Marked, type Token, type TokenizerAndRendererExtension, type Tokens } from "marked";

/*
 * 文档 Markdown → HTML 的通用渲染管线（简历预览只是使用者之一）：
 * 普通 Markdown（marked，GFM，原样放行内嵌 HTML）加两个我们自己的扩展语法，
 * 最后过 DOMPurify 消毒；外观由各使用处的模板 CSS 决定（见 templates/）。
 *
 * 扩展语法（与 agent 指令、模板 CSS 保持一致）：
 *   - `==文字==`     行内高亮，渲染成 <mark>（章节标题 `### ==专业技能==` 也靠它）。
 *   - `#### A | B | C` 竖线分段标题，渲染成两端对齐的 .entry-head（经历条目的
 *     「公司 | 职位 | 时间」行）。2~3 段都行；不含竖线的标题走原生渲染。
 */

interface EntryHeadToken extends Tokens.Generic {
  type: "entryHead";
  depth: number;
  parts: Token[][];
}

interface HighlightToken extends Tokens.Generic {
  type: "highlight";
  tokens: Token[];
}

const highlight: TokenizerAndRendererExtension = {
  name: "highlight",
  level: "inline",
  start(src: string): number | undefined {
    const index = src.indexOf("==");
    return index === -1 ? undefined : index;
  },
  tokenizer(src: string): Tokens.Generic | undefined {
    const match = /^==(?=[^\s=])([\s\S]*?[^\s=])==/.exec(src);
    const text = match?.[1];
    if (match == null || text == null) return undefined;
    return {
      type: "highlight",
      raw: match[0],
      tokens: this.lexer.inlineTokens(text),
    } satisfies HighlightToken;
  },
  renderer(token: Tokens.Generic): string {
    return `<mark>${this.parser.parseInline((token as HighlightToken).tokens)}</mark>`;
  },
};

const entryHead: TokenizerAndRendererExtension = {
  name: "entryHead",
  level: "block",
  start(src: string): number | undefined {
    const match = /^#{1,6}[^\n]*\|/m.exec(src);
    return match === null ? undefined : match.index;
  },
  tokenizer(src: string): Tokens.Generic | undefined {
    const match = /^(#{1,6})[ \t]+([^\n]*\S)[ \t]*(?=\n|$)/.exec(src);
    const text = match?.[2];
    if (match == null || text == null) return undefined;
    const parts = text.split(/[ \t]*\|[ \t]*/);
    if (parts.length < 2 || parts.some((part) => part === "")) return undefined;
    return {
      type: "entryHead",
      raw: match[0],
      depth: match[1]?.length ?? 0,
      parts: parts.map((part) => this.lexer.inlineTokens(part)),
    } satisfies EntryHeadToken;
  },
  renderer(token: Tokens.Generic): string {
    const head = token as EntryHeadToken;
    const spans = head.parts
      .map((part) => `<span>${this.parser.parseInline(part)}</span>`)
      .join("");
    return `<h${head.depth} class="entry-head">${spans}</h${head.depth}>`;
  },
};

const marked = new Marked({ gfm: true, breaks: false });
marked.use({ extensions: [highlight, entryHead] });

/**
 * Markdown 正文 → 可直接注入预览纸面的 HTML。
 * 禁掉 `<style>`：文档里的样式块是 Typora 的用法，外观只由模板 CSS 决定。
 */
export function renderMarkdownHtml(markdown: string): string {
  const html = marked.parse(markdown) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["style"] });
}
