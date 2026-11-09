/**
 * 会话场景：决定这条对话用哪套指令、工具、技能与上传目录。
 * 模块 key 在这里登记；`job:<jobId>` 是岗位二级工作台，
 * `interview:<id>` 是一场模拟面试。
 */
export type ConversationScope =
  | "orchestrator"
  | "resume"
  | "companies"
  | "jobs"
  | `job:${string}`
  | `interview:${string}`;

/**
 * 会话 key：`<scope>` 是旧版本留下 / 当前默认对话，`<scope>#<threadId>`
 * 是用户新建的独立对话。落盘文件名对 key 做 encodeURIComponent。
 * 「对话」通用页已移除（产品决策：独立聊天不在规划内）。
 */
export type ConversationKey = ConversationScope | `${ConversationScope}#${string}`;

/** key 与场景之间的分隔符。`:` 仍用于 scope 内部（job / interview）。 */
const THREAD_SEPARATOR = "#";

/** 从会话 key 取场景（去掉 `#threadId` 后缀）。 */
export function conversationScope(key: string): ConversationScope {
  const at = key.indexOf(THREAD_SEPARATOR);
  return (at < 0 ? key : key.slice(0, at)) as ConversationScope;
}

/** 从会话 key 取线程 id；旧版单会话 key 返回 null。 */
export function conversationThreadId(key: string): string | null {
  const at = key.indexOf(THREAD_SEPARATOR);
  return at < 0 ? null : key.slice(at + THREAD_SEPARATOR.length);
}

/** 拼一个带线程 id 的新会话 key。 */
export function conversationKeyFor(scope: ConversationScope, threadId: string): ConversationKey {
  return `${scope}${THREAD_SEPARATOR}${threadId}`;
}

/** IPC 入参校验：只接受登记过的场景，避免渲染层拼出任意落盘路径。 */
export function isConversationScope(value: unknown): value is ConversationScope {
  if (typeof value !== "string") return false;
  if (
    value === "orchestrator" ||
    value === "resume" ||
    value === "companies" ||
    value === "jobs"
  ) {
    return true;
  }
  return /^(job|interview):[A-Za-z0-9_-]+$/.test(value);
}

/** 从复合 key 里取岗位 id；不是 job 会话时返回 null。 */
export function jobKeyTarget(key: ConversationKey): string | null {
  const scope = conversationScope(key);
  return scope.startsWith("job:") ? scope.slice("job:".length) : null;
}

/** 从复合 key 里取面试 id；不是 interview 会话时返回 null。 */
export function interviewKeyTarget(key: ConversationKey): string | null {
  const scope = conversationScope(key);
  return scope.startsWith("interview:") ? scope.slice("interview:".length) : null;
}

/**
 * 会话消息的线上形态 —— 与 AI SDK 的 UIMessage 结构兼容。
 * shared 保持零依赖，所以 parts 用 unknown 承载，渲染层再断言回 UIMessage。
 */
export interface WireMessage {
  id: string;
  role: "system" | "user" | "assistant";
  parts: unknown[];
  /**
   * 消息元数据（AI SDK UIMessage.metadata 的线形态）。
   * 目前渲染层会在 run 结束时给助手消息写入 `{ durationMs }`（本轮耗时）。
   */
  metadata?: unknown;
}

/** 模型上下文的出厂默认值：窗口 200K，单次回复最多 64K。 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

/**
 * 思考等级（输入框里的那个选项）：映射到 AI SDK 顶层 `reasoning` 参数，
 * 由各供应商适配层翻成自己的字段（OpenAI 的 reasoning_effort、Anthropic 的预算等）。
 */
export type ReasoningEffort = "low" | "medium" | "high";

/** 默认思考等级（新建会话 / 老会话没有记录时）。 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export interface ConversationState {
  key: ConversationKey;
  messages: WireMessage[];
  title: string | null;
  updatedAt: string | null;
  /**
   * 这份会话属于哪个工作区。渲染层写回时原样带回来，main 用它挡掉「切工作区
   * 之后旧页面才把收尾消息写进来」的串区写入。
   */
  workspaceId: string;
}

/** 历史对话列表里的一项（不含消息正文）。 */
export interface ConversationThreadSummary {
  key: ConversationKey;
  /** 第一条用户消息的摘要；还没发消息时为 null。 */
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
}

/** 渲染层 → main 的一次 agent run：messages 是含新用户消息的完整 UI 历史。 */
export interface ChatSendPayload {
  key: ConversationKey;
  runId: string;
  messages: WireMessage[];
  /** 本次 run 的思考等级；不传则用默认值（medium）。只在推理模型上生效。 */
  effort?: ReasoningEffort;
}

/**
 * 上下文用量（`chat:context` 的返回）：token 数为估算值（按字符数折算），
 * 只用于展示与压缩判定，不是供应商账单上的数字。
 */
export interface ContextUsage {
  /** 模型的上下文窗口（token）。 */
  limit: number;
  /** 单次回复预留的输出上限（token）。 */
  maxOutputTokens: number;
  /** 到多少就自动压缩（约等于窗口 90%，并为输出预留空间）。 */
  threshold: number;
  /** 指令（系统提示 + 记忆 + 摘要）占用的 token。 */
  instructions: number;
  /** 会送进模型的消息里，用户 / 工具结果的 token。 */
  input: number;
  /** 助手正文的 token。 */
  output: number;
  /** 思考内容的 token。 */
  reasoning: number;
  /** 合计 = instructions + input + output + reasoning。 */
  used: number;
  /** 已被压缩进摘要的消息条数。 */
  summarizedMessages: number;
}

/** main → 渲染层的流事件：chunk 是 UIMessageChunk（可序列化线协议）；done 表示 run 结束。 */
export type ChatStreamEvent =
  | { key: ConversationKey; runId: string; type: "chunk"; chunk: unknown }
  | { key: ConversationKey; runId: string; type: "done" };

/**
 * 一次上传的回执：文件已原样复制进当前会话所属模块的 `upload/` 目录。
 * 消息里只带文件名，内容由 Agent 用工具自行读取（不再把全文塞进消息）。
 */
export interface UploadedFileMeta {
  /** 落盘后的文件名；与所选文件同名，重名时自动加 `-2` / `-3` 后缀。 */
  fileName: string;
  /** 文件大小（字节）。 */
  size: number;
}

/** 能预览缩略图、能交给视觉模型的图片扩展名。 */
const IMAGE_UPLOAD_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

/** 上传文件名是否是上面这几种图片（大小写不敏感）。 */
export function isImageUploadName(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 && IMAGE_UPLOAD_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}
