import { generateText, type LanguageModel } from "ai";

import type { WireMessage } from "@shared/types";

import type { ResolvedModel } from "../stores/models";

/**
 * 上下文预算：一切按模型的 contextWindow 算，不再按「保留最近 N 条」截尾。
 * 输出上限要从窗口里预留出来，否则「窗口 200K + 输出 64K」的请求会被供应商直接拒。
 */
export function contextBudget(target: ResolvedModel): {
  limit: number;
  maxOutputTokens: number;
  threshold: number;
  keep: number;
} {
  const limit = Math.max(1, Math.floor(target.contextWindow));
  const reserve = Math.min(Math.max(0, Math.floor(target.maxOutputTokens)), Math.floor(limit * 0.5));
  // 输入可用量：给回复让出它的输出上限，但不允许低于窗口的一半（输出上限填得离谱时兜底）。
  const usableInput = Math.max(limit - reserve, Math.floor(limit * 0.5));
  // 用户要的「到 90% 自动压缩」：既看比例，也看是不是已经挤进输出预留区。
  const threshold = Math.min(Math.floor(limit * 0.9), usableInput);
  // 压完保留的尾部预算：阈值的一半不到，压一次能撑一阵，不会下一条消息又超。
  const keep = Math.max(1, Math.floor(threshold * 0.45));
  return { limit, maxOutputTokens: reserve, threshold, keep };
}
/** 压缩时单条消息喂给摘要器的上限，避免把整份简历原文塞两遍。 */
const OUTLINE_CHAR_LIMIT = 4_000;
export async function summarize(
  model: LanguageModel,
  previous: string | null,
  covered: WireMessage[],
  abortSignal?: AbortSignal,
): Promise<string> {
  const outline = covered
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${messageOutline(message)}`)
    .join("\n\n");

  const result = await generateText({
    model,
    abortSignal,
    prompt: [
      "把下面这段求职助手的对话历史压缩成一份要点摘要，供后续对话作为上下文。",
      "要求保留：用户的关键事实与偏好（经历、技能、目标岗位、城市等）、已完成的操作（如写入/修改了简历的哪些部分）、尚未解决的事项。",
      "忽略寒暄与重复。用简体中文，纯文本要点，不超过 800 字。",
      previous !== null && previous.trim() !== "" ? `已有摘要（在此基础上合并）：\n${previous}` : "",
      `对话历史：\n${outline}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  return result.text;
}

export function messageOutline(message: WireMessage): string {
  const bits: string[] = [];
  for (const raw of message.parts as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const part = raw as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      bits.push(part.text);
    } else if (typeof part.type === "string" && part.type.startsWith("tool-")) {
      bits.push(`（调用了工具 ${part.type.slice("tool-".length)}）`);
    }
  }
  const text = bits.join("\n");
  return text.length > OUTLINE_CHAR_LIMIT ? `${text.slice(0, OUTLINE_CHAR_LIMIT)}…` : text || "（无文本内容）";
}

export function estimateSize(messages: WireMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.parts) total += JSON.stringify(part).length;
  }
  return total;
}

/**
 * token 估算：CJK 逐字按 1 token，其余按 3.5 字符 1 token。
 * 宁可估高一点：估高只是早一点压缩，估低会把请求顶到供应商的上下文上限而报错。
 */
export function estimateTokens(text: string): number {
  if (text === "") return 0;
  let wide = 0;
  let narrow = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x2e80) wide += 1;
    else narrow += 1;
  }
  return wide + Math.ceil(narrow / 3.5);
}

/** 按角色/部件拆开用量：界面上分 Input / Output / Reasoning 三行展示。 */
export function measureMessages(messages: WireMessage[]): {
  input: number;
  output: number;
  reasoning: number;
  total: number;
} {
  let input = 0;
  let output = 0;
  let reasoning = 0;
  for (const message of messages) {
    for (const part of message.parts as Array<{ type?: string }>) {
      const tokens = estimateTokens(JSON.stringify(part));
      if (part.type === "reasoning") reasoning += tokens;
      else if (message.role === "assistant" && part.type === "text") output += tokens;
      else input += tokens;
    }
  }
  return { input, output, reasoning, total: input + output + reasoning };
}

/**
 * 压缩切点（返回 messages 里第一个保留的下标）：从尾部往前累加，
 * 取「装进 keepTokens 预算的最早一轮 user 消息」。至少要留下最后一轮，
 * 否则压完历史全空，模型不知道用户刚说了什么。
 */
export function chooseCutoff(messages: WireMessage[], keepTokens: number): number {
  let accumulated = 0;
  let cutoff = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    accumulated += estimateTokens(JSON.stringify(messages[i]));
    if (accumulated > keepTokens) break;
    if (messages[i]?.role === "user") cutoff = i;
  }
  if (cutoff === messages.length) {
    // 一轮都装不下：退化成「只留最后一轮」。
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "user") return i;
    }
    return messages.length;
  }
  return cutoff;
}

/** 可中断的等待（提交限速用）：run 被停止时立刻抛错，不挂着干等。 */
