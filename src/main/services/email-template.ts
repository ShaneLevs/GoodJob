import { Marked, type Tokens } from "marked";

import type { DigestKind } from "@shared/types";

/**
 * 通知邮件的固定 HTML 模板（日报 / 周报 / 会话里发出的通知共用）。
 *
 * 邮件客户端兼容性优先：布局用 table + 行内 style，颜色写死（不依赖应用的
 * 浅 / 深色 token）。正文来自模型的 Markdown：先转义原始 HTML，再过 marked，
 * 所以模型输出里不会混进可执行的标签。
 */

export type NotificationKind = DigestKind | "notice";

export interface RenderedNotification {
  subject: string;
  heading: string;
  html: string;
  text: string;
}

const KIND_META: Record<NotificationKind, { eyebrow: string; heading: string; label: string }> = {
  daily: { eyebrow: "GOODJOB · 日报", heading: "你的求职日报", label: "日报" },
  weekly: { eyebrow: "GOODJOB · 周报", heading: "你的求职周报", label: "周报" },
  notice: { eyebrow: "GOODJOB · 通知", heading: "来自 GoodJob 的通知", label: "通知" },
};

const COLOR = {
  paper: "#f4f0e7",
  card: "#ffffff",
  line: "#e9e1d2",
  ink: "#211d17",
  body: "#3d372f",
  muted: "#8d8372",
  faint: "#a99e8b",
  accent: "#f4b400",
  accentInk: "#8a5a00",
  highlight: "#fdf6e3",
};

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";

export function renderNotificationEmail(input: {
  markdown: string;
  kind: NotificationKind;
  date: string;
}): RenderedNotification {
  const meta = KIND_META[input.kind];
  const body = renderMarkdown(input.markdown);
  const preheader = plainPreview(input.markdown);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light only" />
  <title>${escapeHtml(meta.heading)}</title>
  <style>
    .report table { width: 100%; border-collapse: collapse; margin: 0 0 14px; font-size: 14px; }
    .report th { text-align: left; background: ${COLOR.highlight}; color: #5a5142; font-weight: 600; padding: 8px 10px; border: 1px solid ${COLOR.line}; }
    .report td { padding: 8px 10px; border: 1px solid ${COLOR.line}; color: ${COLOR.body}; }
    .report img { max-width: 100%; height: auto; }
    .report blockquote p, .report li p { margin-bottom: 0 !important; }
    @media only screen and (max-width: 620px) {
      .wrap { padding: 16px 10px !important; }
      .card { border-radius: 12px !important; }
      .pad { padding-left: 20px !important; padding-right: 20px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${COLOR.paper};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">
    ${escapeHtml(preheader)}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.paper};">
    <tr>
      <td class="wrap" align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="max-width:600px;width:100%;background:${COLOR.card};border:1px solid ${COLOR.line};border-radius:16px;overflow:hidden;">
          <tr>
            <td style="height:6px;background:${COLOR.accent};font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td class="pad" style="padding:28px 32px 20px;">
              <div style="font-family:${FONT};font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:${COLOR.accentInk};font-weight:700;">
                ${escapeHtml(meta.eyebrow)}
              </div>
              <h1 style="margin:10px 0 0;font-family:${FONT};font-size:26px;line-height:1.3;color:${COLOR.ink};font-weight:700;">
                ${escapeHtml(meta.heading)}
              </h1>
              <div style="margin-top:8px;font-family:${FONT};font-size:13px;color:${COLOR.muted};">
                ${escapeHtml(input.date)}
              </div>
            </td>
          </tr>
          <tr>
            <td class="pad" style="padding:0 32px;">
              <div style="height:1px;background:${COLOR.line};font-size:0;line-height:0;">&nbsp;</div>
            </td>
          </tr>
          <tr>
            <td class="pad" style="padding:24px 32px 8px;">
              <div class="report" style="font-family:${FONT};font-size:15px;line-height:1.75;color:${COLOR.body};">
                ${body}
              </div>
            </td>
          </tr>
          <tr>
            <td class="pad" style="padding:8px 32px 28px;">
              <div style="height:1px;background:${COLOR.line};margin-bottom:16px;font-size:0;line-height:0;">&nbsp;</div>
              <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.7;color:${COLOR.muted};">
                这封邮件由 GoodJob 根据当前工作区的数据自动生成并发送。<br />
                想调整内容或发送时间，去「设置 → 通知」。
              </p>
            </td>
          </tr>
        </table>
        <div style="max-width:600px;margin:16px auto 0;font-family:${FONT};font-size:11px;color:${COLOR.faint};text-align:center;">
          GoodJob · 你的求职助手
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    subject: `GoodJob ${meta.label} · ${input.date}`,
    heading: meta.heading,
    html,
    text: [
      meta.heading,
      input.date,
      "",
      input.markdown.trim(),
      "",
      "——",
      "这封邮件由 GoodJob 根据当前工作区的数据自动生成并发送。",
    ].join("\n"),
  };
}

/** 模型的 Markdown → 带行内样式的 HTML；原始 HTML token 会被转义。 */
function renderMarkdown(markdown: string): string {
  const marked = new Marked({
    gfm: true,
    breaks: true,
    renderer: {
      /** 模型输出里的原始 HTML 一律当文本，避免邮件里出现可执行标签。 */
      html(token: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(token.text);
      },
      heading(token: Tokens.Heading): string {
        const size = token.depth === 1 ? 22 : token.depth === 2 ? 18 : 16;
        return `<h${token.depth} style="margin:24px 0 10px;font-family:${FONT};font-size:${size}px;line-height:1.4;color:${COLOR.ink};font-weight:650;">${this.parser.parseInline(token.tokens)}</h${token.depth}>`;
      },
      paragraph(token: Tokens.Paragraph): string {
        return `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.75;color:${COLOR.body};">${this.parser.parseInline(token.tokens)}</p>`;
      },
      strong(token: Tokens.Strong): string {
        return `<strong style="font-weight:600;color:${COLOR.ink};">${this.parser.parseInline(token.tokens)}</strong>`;
      },
      em(token: Tokens.Em): string {
        return `<em>${this.parser.parseInline(token.tokens)}</em>`;
      },
      link(token: Tokens.Link): string {
        return `<a href="${escapeAttribute(safeHref(token.href))}" target="_blank" style="color:${COLOR.accentInk};text-decoration:underline;">${this.parser.parseInline(token.tokens)}</a>`;
      },
      codespan(token: Tokens.Codespan): string {
        return `<code style="padding:2px 6px;border-radius:4px;background:${COLOR.highlight};font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:${COLOR.accentInk};">${escapeHtml(token.text)}</code>`;
      },
      code(token: Tokens.Code): string {
        return `<pre style="margin:0 0 14px;padding:12px 14px;background:${COLOR.highlight};border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.6;color:${COLOR.body};white-space:pre-wrap;word-break:break-word;">${escapeHtml(token.text)}</pre>`;
      },
      blockquote(token: Tokens.Blockquote): string {
        return `<blockquote style="margin:0 0 14px;padding:10px 14px;border-left:3px solid ${COLOR.accent};background:${COLOR.highlight};border-radius:0 8px 8px 0;color:#5a5142;">${this.parser.parse(token.tokens)}</blockquote>`;
      },
      list(token: Tokens.List): string {
        const tag = token.ordered ? "ol" : "ul";
        const start = token.ordered && token.start !== 1 ? ` start="${token.start}"` : "";
        const padding = token.ordered ? 22 : 20;
        const items = token.items
          .map((item) => `<li style="margin:0 0 6px;">${this.parser.parse(item.tokens)}</li>`)
          .join("");
        return `<${tag}${start} style="margin:0 0 14px;padding-left:${padding}px;font-family:${FONT};font-size:15px;line-height:1.75;color:${COLOR.body};">${items}</${tag}>`;
      },
      hr(): string {
        return `<hr style="border:none;border-top:1px solid ${COLOR.line};margin:20px 0;" />`;
      },
      br(): string {
        return "<br />";
      },
    },
  });

  return marked.parse(markdown.trim(), { async: false }) as string;
}

/** 只允许常见协议的链接，其余按纯文本处理。 */
function safeHref(href: string): string {
  const value = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(value) ? value : "#";
}

/** 收件箱预览：去掉 Markdown 记号后取前 90 个字符。 */
function plainPreview(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*[-*+]\s+/gm, " ")
    .replace(/[#>*_`~[\]()!|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
