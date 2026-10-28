import { tool, type ToolSet } from "ai";
import { z } from "zod";

import type { ConversationKey, WireMessage } from "@shared/types";

import type { AgentDeps } from "../deps";

/**
 * 会话历史回查（只读）：压缩只影响模型输入，`ConversationDoc.messages` 里的原文始终保留。
 * 这两个工具让 Agent 在摘要不够用时按当前会话 key 回查被压缩的部分，不跨会话。
 */

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 10;
/** 单条消息写进工具结果的上限。 */
const MESSAGE_OUTPUT_CHARS = 3_000;
/** 搜索命中时返回的片段窗口。 */
const SNIPPET_CHARS = 700;
/** 一次工具回执的总字符上限，避免刚压完又被历史撑满。 */
const TOTAL_OUTPUT_CHARS = 12_000;
/** 工具调用参数 / 结果参与检索时的单项上限。 */
const TOOL_PART_CHARS = 4_000;

const pageSchema = z.object({
  before: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("只读取这个下标之前的消息（翻页用）；省略时从最新一条已压缩消息开始"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`返回条数，默认 ${DEFAULT_LIMIT}，最多 ${MAX_LIMIT}`),
});

const searchSchema = pageSchema.extend({
  query: z.string().trim().min(1).describe("关键词；多个词用空格分隔，表示需要同时包含"),
});

interface HistoryMatch {
  index: number;
  role: WireMessage["role"];
  text: string;
}

function roleLabel(role: WireMessage["role"]): string {
  if (role === "user") return "用户";
  if (role === "assistant") return "助手";
  return "系统";
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** 一条消息里可供检索 / 阅读的文本：正文、上传文件、工具调用与结果；思考过程不展开。 */
function messageText(message: WireMessage): string {
  const bits: string[] = [];
  for (const raw of message.parts) {
    if (typeof raw !== "object" || raw === null) continue;
    const part = raw as Record<string, unknown>;
    const type = typeof part.type === "string" ? part.type : "";

    if (type === "text" && typeof part.text === "string") {
      const text = part.text.trim();
      if (text !== "") bits.push(text);
      continue;
    }
    if (type === "data-upload") {
      const data =
        typeof part.data === "object" && part.data !== null
          ? (part.data as Record<string, unknown>)
          : null;
      const fileName = typeof data?.fileName === "string" ? data.fileName : "未知文件";
      bits.push(`[上传文件：${fileName}]`);
      continue;
    }
    if (type === "file") {
      const name =
        typeof part.filename === "string"
          ? part.filename
          : typeof part.name === "string"
            ? part.name
            : "附件";
      bits.push(`[附件：${name}]`);
      continue;
    }
    if (type.startsWith("tool-")) {
      const name = type.slice("tool-".length);
      const input =
        part.input === undefined
          ? ""
          : ` 参数 ${clip(stringifyValue(part.input), TOOL_PART_CHARS)}`;
      const output =
        part.output === undefined
          ? ""
          : ` 结果 ${clip(stringifyValue(part.output), TOOL_PART_CHARS)}`;
      bits.push(`（工具 ${name}${input}${output}）`);
    }
  }
  return bits.join("\n");
}

function statusText(compacted: number): string {
  if (compacted === 0) return "当前会话还没有被压缩的历史消息。";
  return `已压缩历史共 ${compacted} 条（下标 0–${compacted - 1}）；当前模型上下文从下标 ${compacted} 开始。`;
}

function pageEnd(compacted: number, before: number | undefined): number {
  return Math.min(compacted, Math.max(0, before ?? compacted));
}

function messageBlock(index: number, message: WireMessage): string {
  const text = messageText(message);
  return `[#${index}] ${roleLabel(message.role)}\n${clip(text === "" ? "（无文本内容）" : text, MESSAGE_OUTPUT_CHARS)}`;
}

/** 从新到旧装入预算，再按时间顺序输出；这样截断时丢掉的是更早的部分，翻页不会断档。 */
function renderPage(
  messages: WireMessage[],
  start: number,
  end: number,
): { text: string; first: number; last: number } {
  const blocks: string[] = [];
  let used = 0;
  for (let index = end - 1; index >= start; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const block = messageBlock(index, message);
    if (blocks.length > 0 && used + block.length + 2 > TOTAL_OUTPUT_CHARS) break;
    blocks.push(block);
    used += block.length + 2;
  }
  blocks.reverse();
  return {
    text: blocks.join("\n\n---\n\n"),
    first: end - blocks.length,
    last: end - 1,
  };
}

function snippetAround(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const positions = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0);
  const at = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS * 0.3));
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function conversationTools(deps: AgentDeps, key: ConversationKey): ToolSet {
  return {
    conversation_search: tool({
      description:
        "在当前会话已压缩的历史原文里按关键词搜索。多个词用空格分隔表示同时包含；返回消息下标与片段。摘要缺细节时先用它，再用 conversation_read 读下标附近的完整上下文。",
      inputSchema: searchSchema,
      execute: ({ query, before, limit }) => {
        const doc = deps.conversations.get(key);
        const compacted = doc.summarizedFrom;
        const end = pageEnd(compacted, before);
        if (end === 0) return `${statusText(compacted)}\n\n没有可搜索的更早消息。`;

        const max = limit ?? DEFAULT_LIMIT;
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches: HistoryMatch[] = [];
        let hasMore = false;
        for (let index = end - 1; index >= 0; index -= 1) {
          const message = doc.messages[index];
          if (message === undefined) continue;
          const text = messageText(message);
          const lower = text.toLowerCase();
          if (!terms.every((term) => lower.includes(term))) continue;
          if (matches.length >= max) {
            hasMore = true;
            break;
          }
          matches.push({
            index,
            role: message.role,
            text: snippetAround(text, terms),
          });
        }

        if (matches.length === 0) {
          return `${statusText(compacted)}\n\n没有找到包含「${query}」的已压缩消息。`;
        }

        const oldest = matches[matches.length - 1]?.index ?? 0;
        return [
          statusText(compacted),
          `关键词「${query}」命中 ${matches.length} 条${hasMore ? "（还有更早的命中）" : ""}，按时间从新到旧：`,
          matches
            .map((match) => `[#${match.index}] ${roleLabel(match.role)}\n${match.text}`)
            .join("\n\n---\n\n"),
          hasMore
            ? `继续搜索更早的命中：conversation_search({ query: ${JSON.stringify(query)}, before: ${oldest} })`
            : "",
          "查看某条附近的完整上下文：conversation_read({ before: 下标 + 1 })。",
        ]
          .filter((part) => part !== "")
          .join("\n\n");
      },
    }),

    conversation_read: tool({
      description:
        "按时间顺序读取当前会话已压缩的历史原文（摘要之前、当前上下文里已经没有的消息）。before 是只读取该下标之前的消息，翻页用；返回条数与总字数有上限。",
      inputSchema: pageSchema,
      execute: ({ before, limit }) => {
        const doc = deps.conversations.get(key);
        const compacted = doc.summarizedFrom;
        if (compacted === 0) return statusText(compacted);

        const end = pageEnd(compacted, before);
        if (end === 0) return `${statusText(compacted)}\n\n没有更早的消息了。`;

        const start = Math.max(0, end - (limit ?? DEFAULT_LIMIT));
        const page = renderPage(doc.messages, start, end);
        return [
          statusText(compacted),
          `本次返回下标 ${page.first}–${page.last}（${page.last - page.first + 1} 条，按时间顺序）：`,
          page.text,
          page.first > 0
            ? `还有更早的消息：conversation_read({ before: ${page.first} })`
            : "已经到最早的已压缩消息。",
        ].join("\n\n");
      },
    }),
  };
}
