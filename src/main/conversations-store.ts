import fs from "node:fs";
import path from "node:path";

import type { ConversationKey, WireMessage } from "@shared/types";

import { writeJsonFile, type WorkspacePaths } from "./paths";

/**
 * 滚动会话：一个模块一条会话，存 `<workspace>/conversations/<key>.json`。
 * 完整历史始终保留（UI 展示用）；模型输入只取 `summarizedFrom` 之后的尾部，
 * 之前的部分由 AgentRuntime 压缩成 `summary`（见 maybeCompact 调用方）。
 */
export interface ConversationDoc {
  key: string;
  messages: WireMessage[];
  /** 已被压缩进摘要的部分之前的起点（messages 数组下标）。 */
  summarizedFrom: number;
  summary: string | null;
  updatedAt: string | null;
}

export class ConversationsStore {
  private workspace: WorkspacePaths;
  private cache = new Map<string, ConversationDoc>();

  constructor(workspace: WorkspacePaths) {
    this.workspace = workspace;
  }

  useWorkspace(workspace: WorkspacePaths): void {
    this.workspace = workspace;
    this.cache.clear();
  }

  get(key: ConversationKey): ConversationDoc {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const doc = this.read(key);
    this.cache.set(key, doc);
    return doc;
  }

  /** 一次 run 开始/结束时的落盘：直接以渲染层装配好的完整历史为准。 */
  updateMessages(key: ConversationKey, messages: WireMessage[]): void {
    const doc = this.get(key);
    doc.messages = messages;
    // 历史被清空（未来功能）时不保留旧摘要。
    if (messages.length === 0) {
      doc.summary = null;
      doc.summarizedFrom = 0;
    }
    doc.updatedAt = new Date().toISOString();
    this.cache.set(key, doc);
    this.persist(doc);
  }

  /**
   * 压缩落点：把 messages[summarizedFrom..nextFrom) 并入 summary。
   * nextFrom 由调用方（AgentRuntime）按阈值和保留条数算好。
   */
  applySummary(key: ConversationKey, summary: string, nextFrom: number): void {
    const doc = this.get(key);
    doc.summary = summary;
    doc.summarizedFrom = Math.max(0, Math.min(nextFrom, doc.messages.length));
    doc.updatedAt = new Date().toISOString();
    this.persist(doc);
  }

  private persist(doc: ConversationDoc): void {
    writeJsonFile(this.file(doc.key), doc);
  }

  private file(key: string): string {
    return path.join(this.workspace.conversations, `${key}.json`);
  }

  private read(key: ConversationKey): ConversationDoc {
    try {
      const raw = fs.readFileSync(this.file(key), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) throw new Error("bad doc");

      const record = parsed as Record<string, unknown>;
      const messages = Array.isArray(record.messages)
        ? (record.messages as WireMessage[]).filter(
            (message) =>
              typeof message?.id === "string" && Array.isArray(message?.parts),
          )
        : [];

      return {
        key,
        messages,
        summarizedFrom:
          typeof record.summarizedFrom === "number"
            ? Math.max(0, Math.min(record.summarizedFrom, messages.length))
            : 0,
        summary: typeof record.summary === "string" ? record.summary : null,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
      };
    } catch {
      return { key, messages: [], summarizedFrom: 0, summary: null, updatedAt: null };
    }
  }
}
