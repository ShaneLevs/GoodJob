import DOMPurify from "dompurify";
import { Marked, type Token, type TokenizerAndRendererExtension, type Tokens } from "marked";

import { iconSvg } from "./icons";

/*
 * 文档 Markdown → HTML 的通用渲染管线（简历预览只是使用者之一）：
 * 普通 Markdown（marked，GFM，原样放行内嵌 HTML）加几个我们自己的扩展语法，
 * 最后过 DOMPurify 消毒；外观由各使用处的模板 CSS 决定（见 templates/）。
 *
 * 扩展语法（与 main/resume-format.ts 的格式说明、模板 CSS 保持一致）：
 *   - `==文字==`      行内高亮，渲染成 <mark>（章节标题 `### ==专业技能==` 也靠它）。
 *   - `#### A | B | C` 竖线分段标题，渲染成两端对齐的 .entry-head。
 *   - `左边:::右边`    普通行两端对齐；标题里也能用：`#### 标题:::日期`。
 *   - `icon:github`    行内图标；在 Markdown 与原始 HTML（顶部信息表）里都生效。
 *   - `photo: upload/x.jpg` 不是这里处理的：由 extractPhotoDirective 抽出来，
 *     交给 MarkdownPreview 的 photoUrl prop（图片读取在 main）。
 */

interface EntryHeadToken extends Tokens.Generic {
  type: "entryHead";
  depth: number;
  mode: "bars" | "split";
  /** mode = bars 时的 2~3 段。 */
  parts: Token[][];
  /** mode = split 时的左右两段。 */
  left: Token[];
  right: Token[];
}

interface SplitLineToken extends Tokens.Generic {
  type: "splitLine";
  left: Token[];
  right: Token[];
}

/** 行首不能触发 `:::` 的块：标题 / 列表 / 引用 / 原始 HTML / 表格 / 有序列表。 */
const BLOCK_PREFIX = String.raw`\s*(?:(?:#{1,6}|[-*+>]|\d+\.)\s|<|\|)`;
/** `:::` 只能出现在行首不是上述块、且不是缩进代码的行。 */
const SPLIT_LINE_START = new RegExp(String.raw`^(?!${BLOCK_PREFIX})(?! {4}|\t)[^\n]*:::[^\n]*$`, "m");
const SPLIT_LINE = new RegExp(
  String.raw`^(?!${BLOCK_PREFIX})(?! {4}|\t)([^\n]*?):::(?!:)[ \t]*([^\n]*?)[ \t]*(?=\n|$)`,
);

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
    } satisfies Tokens.Generic;
  },
  renderer(token: Tokens.Generic): string {
    return `<mark>${this.parser.parseInline((token as { tokens: Token[] }).tokens)}</mark>`;
  },
};

/**
 * 条目标题：`#### A | B | C`（竖线分段）或 `#### 标题:::日期`（左右两段）。
 * 两种都渲染成带 .doc-split 布局的标题；`:::` 优先于 `|`。
 */
const entryHead: TokenizerAndRendererExtension = {
  name: "entryHead",
  level: "block",
  start(src: string): number | undefined {
    const match = /^#{1,6}[^\n]*(?:\||:::)/m.exec(src);
    return match === null ? undefined : match.index;
  },
  tokenizer(src: string): Tokens.Generic | undefined {
    const match = /^(#{1,6})[ \t]+([^\n]*\S)[ \t]*(?=\n|$)/.exec(src);
    const text = match?.[2];
    if (match == null || text == null) return undefined;

    const splitAt = text.indexOf(":::");
    if (splitAt !== -1) {
      const left = text.slice(0, splitAt).trim();
      const right = text.slice(splitAt + 3).trim();
      if (left === "" && right === "") return undefined;
      return {
        type: "entryHead",
        raw: match[0],
        depth: match[1]?.length ?? 0,
        mode: "split",
        parts: [],
        left: this.lexer.inlineTokens(left),
        right: this.lexer.inlineTokens(right),
      } satisfies EntryHeadToken;
    }

    const parts = text.split(/[ \t]*\|[ \t]*/);
    if (parts.length < 2 || parts.some((part) => part === "")) return undefined;
    return {
      type: "entryHead",
      raw: match[0],
      depth: match[1]?.length ?? 0,
      mode: "bars",
      parts: parts.map((part) => this.lexer.inlineTokens(part)),
      left: [],
      right: [],
    } satisfies EntryHeadToken;
  },
  renderer(token: Tokens.Generic): string {
    const head = token as EntryHeadToken;
    if (head.mode === "split") {
      return `<h${head.depth} class="entry-head doc-split"><span class="doc-split-left">${this.parser.parseInline(head.left)}</span><span class="doc-split-right">${this.parser.parseInline(head.right)}</span></h${head.depth}>`;
    }
    const spans = head.parts
      .map((part) => `<span>${this.parser.parseInline(part)}</span>`)
      .join("");
    return `<h${head.depth} class="entry-head doc-split">${spans}</h${head.depth}>`;
  },
};

/** 普通行两端对齐：`左边:::右边`。一行一条，不进入列表 / 引用 / 代码块。 */
const splitLine: TokenizerAndRendererExtension = {
  name: "splitLine",
  level: "block",
  start(src: string): number | undefined {
    const match = SPLIT_LINE_START.exec(src);
    return match === null ? undefined : match.index;
  },
  tokenizer(src: string): Tokens.Generic | undefined {
    const match = SPLIT_LINE.exec(src);
    if (match == null) return undefined;
    const left = (match[1] ?? "").trim();
    const right = (match[2] ?? "").trim();
    if (left === "" && right === "") return undefined;
    return {
      type: "splitLine",
      raw: match[0],
      left: this.lexer.inlineTokens(left),
      right: this.lexer.inlineTokens(right),
    } satisfies SplitLineToken;
  },
  renderer(token: Tokens.Generic): string {
    const line = token as SplitLineToken;
    return `<div class="doc-split"><span class="doc-split-left">${this.parser.parseInline(line.left)}</span><span class="doc-split-right">${this.parser.parseInline(line.right)}</span></div>`;
  },
};

const marked = new Marked({ gfm: true, breaks: false });
marked.use({ extensions: [highlight, entryHead, splitLine] });

/**
 * 转义占位：`\:::` / `\icon:xxx` 在解析前把分隔符拆开，避免被扩展语法吃掉；
 * 渲染完成后再拼回去。占位必须是普通字母数字——私用区字符会被 DOMPurify 清掉。
 */
const SPLIT_TOKEN = "GJESCAPEDSPLIT7F3A";
const ICON_TOKEN = "GJESCAPEDICON7F3A";

function protectEscapes(source: string): string {
  // 代码块里的反斜杠是字面量，不参与转义。
  let fenced = false;
  return source
    .split("\n")
    .map((line) => {
      if (/^[ \t]*(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line
        .replace(/\\:::/g, `::${SPLIT_TOKEN}:`)
        .replace(/\\icon:/g, `icon${ICON_TOKEN}:`);
    })
    .join("\n");
}

function restoreEscapes(html: string): string {
  return html
    .replaceAll(`::${SPLIT_TOKEN}:`, ":::")
    .replaceAll(`icon${ICON_TOKEN}:`, "icon:");
}

/** `icon:name`：行内（含原始 HTML 的文本节点）替换成内联 SVG。 */
const ICON_PATTERN = /(?<![\\])icon:([a-z0-9][a-z0-9-]*)/gi;

function replaceIconsInText(node: Text): void {
  const text = node.data;
  const matches = [...text.matchAll(ICON_PATTERN)];
  if (matches.length === 0) return;

  const fragment = document.createDocumentFragment();
  let last = 0;
  for (const match of matches) {
    const name = match[1];
    const index = match.index;
    if (name === undefined || index === undefined) continue;
    const svg = iconSvg(name);
    if (svg === null) continue;

    if (index > last) fragment.append(text.slice(last, index));
    const span = document.createElement("span");
    span.className = "doc-icon";
    span.setAttribute("aria-hidden", "true");
    span.innerHTML = svg;
    fragment.append(span);
    last = index + match[0].length;
  }
  if (last === 0) return;
  if (last < text.length) fragment.append(text.slice(last));
  node.replaceWith(fragment);
}

function injectIcons(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement;
    if (parent === null) continue;
    if (parent.closest("code, pre, script, style, svg") !== null) continue;
    if (node.data.includes("icon:")) targets.push(node);
  }
  for (const node of targets) replaceIconsInText(node);
  return template.innerHTML;
}

/**
 * Markdown 正文 → 可直接注入预览纸面的 HTML。
 * 禁掉 `<style>`：文档里的样式块是 Typora 的用法，外观只由模板 CSS 决定。
 */
export function renderMarkdownHtml(markdown: string): string {
  const html = marked.parse(protectEscapes(markdown)) as string;
  const sanitized = DOMPurify.sanitize(html, { FORBID_TAGS: ["style"] });
  return restoreEscapes(injectIcons(sanitized));
}

/** 文档第一行的 `photo: upload/xxx.jpg`；返回去掉指令后的正文与照片相对路径。 */
const PHOTO_DIRECTIVE = /^(?:[ \t]*\r?\n)*[ \t]*photo:[ \t]*(.+?)[ \t]*(?:\r?\n|$)/;

export interface ParsedDocumentMarkdown {
  markdown: string;
  photoPath: string | null;
}

export function extractPhotoDirective(markdown: string): ParsedDocumentMarkdown {
  const match = PHOTO_DIRECTIVE.exec(markdown);
  if (match === null) return { markdown, photoPath: null };
  const photoPath = (match[1] ?? "").trim();
  return {
    markdown: markdown.slice(match[0].length),
    photoPath: photoPath === "" ? null : photoPath,
  };
}
