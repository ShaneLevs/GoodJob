import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  conversationKeyFor,
  conversationScope,
  type ConversationKey,
  type ConversationScope,
  type ConversationThreadSummary,
  type WireMessage,
} from "@shared/types";

import { writeJsonFile, type WorkspacePaths } from "../workspace/paths";

/** 历史对话索引：只存列表需要的元数据，正文仍是一条对话一个文件。 */
const INDEX_FILE = "threads.json";
/** 列表标题上限（按字符数，中文不会被截半个字）。 */
const TITLE_LIMIT = 30;

/**
 * 滚动会话：一条对话一个文件，存 `<workspace>/conversations/<key>.json`。
 * key 是 `<scope>`（旧版单会话 / 默认对话）或 `<scope>#<threadId>`（新建对话）。
 * 文件名对 key 做 encodeURIComponent，`:` / `#` 等不安全字符编码掉。
 * 完整历史始终保留（UI 展示用）；模型输入只取 `summarizedFrom` 之后的尾部，
 * 之前的部分由 AgentRuntime 压缩成 `summary`。
 */
export interface ConversationDoc {
  key: ConversationKey;
  messages: WireMessage[];
  /** 已被压缩进摘要的部分之前的起点（messages 数组下标）。 */
  summarizedFrom: number;
  summary: string | null;
  /** 第一条用户消息的摘要；还没发消息时为 null。 */
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface ThreadIndex {
  version: 1;
  threads: ConversationThreadSummary[];
}

export class ConversationsStore {
  private workspace: WorkspacePaths;
  private cache = new Map<string, ConversationDoc>();
  private index: ThreadIndex | null = null;
  /**
   * 被删除的 key：删除后页面卸载 / run 收尾仍可能再发一次 sync，
   * 不挡住的话文件会原地复活。只活到应用退出，重启时文件已经不在。
   */
  private deleted = new Set<string>();

  constructor(workspace: WorkspacePaths) {
    this.workspace = workspace;
    this.migrateLegacyApplications();
  }

  useWorkspace(workspace: WorkspacePaths): void {
    this.workspace = workspace;
    this.cache.clear();
    this.index = null;
    this.deleted.clear();
    this.migrateLegacyApplications();
  }

  get(key: ConversationKey): ConversationDoc {
    if (this.deleted.has(key)) return emptyDoc(key);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const doc = this.read(key);
    this.cache.set(key, doc);
    return doc;
  }

  /** 某个场景下的历史对话，最近更新的在前。 */
  list(scope: ConversationScope): ConversationThreadSummary[] {
    this.ensureIndex();
    return this.index!.threads
      .filter((thread) => conversationScope(thread.key) === scope)
      .sort(compareThreads)
      .map((thread) => ({ ...thread }));
  }

  /** 新建一条空对话，返回它的 key 与元数据。 */
  create(scope: ConversationScope): ConversationThreadSummary {
    this.ensureIndex();
    const now = new Date().toISOString();
    const key = conversationKeyFor(scope, `thr_${crypto.randomBytes(6).toString("hex")}`);
    // 极低概率撞上旧 key 时，允许重新使用；正常情况这里只是一个空操作。
    this.deleted.delete(key);
    const doc: ConversationDoc = {
      key,
      messages: [],
      summarizedFrom: 0,
      summary: null,
      title: null,
      createdAt: now,
      updatedAt: now,
    };
    this.cache.set(key, doc);
    this.persist(doc);

    const summary = this.summaryOf(doc);
    this.index!.threads = [summary, ...this.index!.threads.filter((thread) => thread.key !== key)];
    this.persistIndex();
    return { ...summary };
  }

  /** 一次 run 开始/结束时的落盘：直接以渲染层装配好的完整历史为准。 */
  updateMessages(key: ConversationKey, messages: WireMessage[]): void {
    if (this.deleted.has(key)) return;
    const doc = this.get(key);
    doc.messages = messages;
    // 历史被清空（未来功能）时不保留旧摘要。
    if (messages.length === 0) {
      doc.summary = null;
      doc.summarizedFrom = 0;
    }
    const now = new Date().toISOString();
    doc.updatedAt = now;
    if (doc.createdAt === null) doc.createdAt = now;
    if (doc.title === null) doc.title = titleFrom(messages);
    this.cache.set(key, doc);
    this.persist(doc);
    this.upsertMeta(doc);
  }

  /**
   * 压缩落点：把 messages[summarizedFrom..nextFrom) 并入 summary。
   * nextFrom 由调用方（AgentRuntime）按阈值和保留条数算好。
   */
  applySummary(key: ConversationKey, summary: string, nextFrom: number): void {
    if (this.deleted.has(key)) return;
    const doc = this.get(key);
    doc.summary = summary;
    doc.summarizedFrom = Math.max(0, Math.min(nextFrom, doc.messages.length));
    doc.updatedAt = new Date().toISOString();
    this.persist(doc);
    this.upsertMeta(doc);
  }

  /** 删除一条会话：内存 + 磁盘一起清。 */
  remove(key: ConversationKey): void {
    this.deleted.add(key);
    this.cache.delete(key);
    try {
      fs.rmSync(this.file(key), { force: true });
    } catch {
      // 文件已被手动删掉之类：内存才是事实，忽略磁盘错误。
    }
    this.ensureIndex();
    const before = this.index!.threads.length;
    this.index!.threads = this.index!.threads.filter((thread) => thread.key !== key);
    if (this.index!.threads.length !== before) this.persistIndex();
  }

  /** 删除一个场景下的全部对话（如删除面试时连带 `interview:<id>` 的所有线程）。 */
  removeScope(scope: ConversationScope): void {
    this.ensureIndex();
    const keys = new Set<string>([scope]);
    for (const thread of this.index!.threads) {
      if (conversationScope(thread.key) === scope) keys.add(thread.key);
    }
    for (const key of keys) {
      this.deleted.add(key);
      this.cache.delete(key);
      try {
        fs.rmSync(this.file(key), { force: true });
      } catch {
        // 同上：删不掉就交给下次重建索引时自然消失。
      }
    }
    this.index!.threads = this.index!.threads.filter(
      (thread) => conversationScope(thread.key) !== scope,
    );
    this.persistIndex();
  }

  /**
   * 旧版的「投递」独立模块（scope = applications）已并入岗位模块：
   * 把它的对话文件改名到 jobs scope，历史消息继续可读。
   * 默认对话 `applications` 变成 `jobs#legacy-applications`，独立线程
   * `applications#<threadId>` 变成 `jobs#<threadId>`；撞名时加后缀。
   */
  private migrateLegacyApplications(): void {
    const dir = this.workspace.conversations;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }

    let changed = false;
    for (const name of names) {
      if (!name.endsWith(".json") || name === INDEX_FILE) continue;
      let oldKey: string;
      try {
        oldKey = decodeURIComponent(name.slice(0, -".json".length));
      } catch {
        continue;
      }
      // 旧 scope 已从联合类型里移除，这里按字符串比较做一次性迁移。
      if ((conversationScope(oldKey) as string) !== "applications") continue;

      const delimiter = oldKey.indexOf("#");
      const threadId = delimiter < 0 ? "legacy-applications" : oldKey.slice(delimiter + 1);
      const newKey = this.uniqueJobsKey(threadId);
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        if (!isRecord(raw)) continue;
        writeJsonFile(this.file(newKey as ConversationKey), { ...raw, key: newKey });
        fs.rmSync(path.join(dir, name), { force: true });
        changed = true;
      } catch {
        // 单条坏文件不拖垮迁移，留在原处。
      }
    }

    if (changed) {
      // 索引里还是旧 key：删掉让它从文件重建（标题与时间都在正文里）。
      try {
        fs.rmSync(this.indexPath(), { force: true });
      } catch {
        // 删不掉就下次重建索引时以文件为准。
      }
      this.index = null;
    }
  }

  private uniqueJobsKey(threadId: string): string {
    const base = threadId === "" ? "legacy-applications" : threadId;
    let candidate = `jobs#${base}`;
    for (let n = 2; fs.existsSync(this.file(candidate as ConversationKey)); n += 1) {
      candidate = `jobs#${base}-${n}`;
    }
    return candidate;
  }

  private persist(doc: ConversationDoc): void {
    writeJsonFile(this.file(doc.key), doc);
  }

  private file(key: string): string {
    // 复合 key 含 ':' / '#' 等文件系统不安全字符：整体 encodeURIComponent（可逆）。
    return path.join(this.workspace.conversations, `${encodeURIComponent(key)}.json`);
  }

  private indexPath(): string {
    return path.join(this.workspace.conversations, INDEX_FILE);
  }

  private ensureIndex(): void {
    if (this.index !== null) return;
    try {
      const raw = fs.readFileSync(this.indexPath(), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isThreadIndex(parsed)) {
        this.index = parsed;
        return;
      }
    } catch {
      // 没有索引 / 内容坏了：从会话文件重建。
    }
    this.index = this.rebuildIndex();
  }

  /** 首次升级或索引损坏时扫一遍会话文件；旧 key 自然成为默认对话。 */
  private rebuildIndex(): ThreadIndex {
    const threads: ConversationThreadSummary[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.workspace.conversations);
    } catch {
      // 工作区目录还没建好：当成空索引。
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name === INDEX_FILE) continue;
      try {
        const raw = fs.readFileSync(path.join(this.workspace.conversations, name), "utf8");
        const parsed: unknown = JSON.parse(raw);
        const key = readKey(parsed) ?? decodeURIComponent(name.slice(0, -".json".length));
        const doc = parseDoc(key as ConversationKey, parsed);
        threads.push(this.summaryOf(doc));
      } catch {
        // 单个文件坏了不影响其他对话。
      }
    }
    const index: ThreadIndex = { version: 1, threads };
    this.index = index;
    this.persistIndex();
    return index;
  }

  private upsertMeta(doc: ConversationDoc): void {
    this.ensureIndex();
    const summary = this.summaryOf(doc);
    const at = this.index!.threads.findIndex((thread) => thread.key === doc.key);
    if (at >= 0) this.index!.threads[at] = summary;
    else this.index!.threads.push(summary);
    this.persistIndex();
  }

  private persistIndex(): void {
    if (this.index === null) return;
    writeJsonFile(this.indexPath(), this.index);
  }

  private summaryOf(doc: ConversationDoc): ConversationThreadSummary {
    return {
      key: doc.key,
      title: doc.title ?? titleFrom(doc.messages),
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      messageCount: doc.messages.length,
    };
  }

  private read(key: ConversationKey): ConversationDoc {
    try {
      const raw = fs.readFileSync(this.file(key), "utf8");
      return parseDoc(key, JSON.parse(raw));
    } catch {
      return emptyDoc(key);
    }
  }
}

function emptyDoc(key: ConversationKey): ConversationDoc {
  return {
    key,
    messages: [],
    summarizedFrom: 0,
    summary: null,
    title: null,
    createdAt: null,
    updatedAt: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThreadIndex(value: unknown): value is ThreadIndex {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    Array.isArray(record.threads) &&
    record.threads.every(
      (thread: unknown) =>
        typeof thread === "object" &&
        thread !== null &&
        typeof (thread as Record<string, unknown>).key === "string",
    )
  );
}

function readKey(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const key = (value as Record<string, unknown>).key;
  return typeof key === "string" ? key : null;
}

function parseDoc(key: ConversationKey, value: unknown): ConversationDoc {
  if (typeof value !== "object" || value === null) throw new Error("bad doc");
  const record = value as Record<string, unknown>;
  const messages = Array.isArray(record.messages)
    ? (record.messages as WireMessage[]).filter(
        (message) => typeof message?.id === "string" && Array.isArray(message?.parts),
      )
    : [];
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : null;
  return {
    key,
    messages,
    summarizedFrom:
      typeof record.summarizedFrom === "number"
        ? Math.max(0, Math.min(record.summarizedFrom, messages.length))
        : 0,
    summary: typeof record.summary === "string" ? record.summary : null,
    title: typeof record.title === "string" ? record.title : titleFrom(messages),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : updatedAt,
    updatedAt,
  };
}

function compareThreads(a: ConversationThreadSummary, b: ConversationThreadSummary): number {
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

/** 第一条用户消息 → 列表标题：正文优先，纯附件时用文件名。 */
function titleFrom(messages: WireMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const texts: string[] = [];
    const files: string[] = [];
    for (const raw of message.parts) {
      if (typeof raw !== "object" || raw === null) continue;
      const part = raw as { type?: unknown; text?: unknown; data?: unknown };
      if (part.type === "text" && typeof part.text === "string") {
        const text = part.text.replace(/\s+/g, " ").trim();
        if (text !== "") texts.push(text);
      }
      if (part.type === "data-upload" && typeof part.data === "object" && part.data !== null) {
        const fileName = (part.data as { fileName?: unknown }).fileName;
        if (typeof fileName === "string" && fileName !== "") files.push(fileName);
      }
    }
    const text = texts.join(" ").trim();
    if (text !== "") return clipTitle(text);
    if (files.length > 0) return clipTitle(`上传：${files[0]}`);
  }
  return null;
}

function clipTitle(text: string): string {
  const chars = Array.from(text);
  return chars.length <= TITLE_LIMIT ? text : `${chars.slice(0, TITLE_LIMIT).join("")}…`;
}
