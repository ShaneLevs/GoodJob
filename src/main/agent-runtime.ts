import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  ToolLoopAgent,
  convertToModelMessages,
  generateText,
  toUIMessageStream,
  tool,
  type LanguageModel,
  type ToolSet,
  type UIMessage,
} from "ai";
import { z } from "zod";

import type {
  ChatSendPayload,
  ChatStreamEvent,
  ConversationKey,
  WireMessage,
} from "@shared/types";

import type { ConversationsStore } from "./conversations-store";
import type { MemoryStore } from "./memory";
import type { ModelsStore, ResolvedModel } from "./models-store";
import type { ResumeStore } from "./resume-store";

type Emit = (event: ChatStreamEvent) => void;

/** 压缩阈值与保留条数：模型输入只送摘要 + 最近 KEEP_TAIL 条。 */
const COMPACT_THRESHOLD_CHARS = 60_000;
const COMPACT_KEEP_TAIL = 12;
/** 压缩时单条消息喂给摘要器的上限，避免把整份简历原文塞两遍。 */
const OUTLINE_CHAR_LIMIT = 4_000;

export interface AgentDeps {
  models: ModelsStore;
  conversations: ConversationsStore;
  resumes: ResumeStore;
  memory: MemoryStore;
}

/**
 * Agent 运行时：一切 LLM 环节都是工具循环（ToolLoopAgent），流式走 UIMessageChunk
 * 线协议发到渲染层。模型每次 send 动态解析（供应商/模型可随时在设置里换），
 * 指令 = 模块指令 + 长期记忆 + 滚动摘要，模型输入 = 指令 + 压缩后的尾部消息。
 */
export class AgentRuntime {
  private readonly running = new Map<ConversationKey, AbortController>();

  constructor(private readonly deps: AgentDeps) {}

  async send(payload: ChatSendPayload, emit: Emit): Promise<void> {
    const { key, runId } = payload;

    const fail = (errorText: string): void => {
      emit({ key, runId, type: "chunk", chunk: { type: "error", errorText } });
      emit({ key, runId, type: "done" });
    };

    // 一个模块一条会话，同时只跑一个 run：UI 的停止按钮本来就只有流式期间可点，
    // 这里挡的是极端竞态（上一次流还没结束就发下一条）。
    if (this.running.has(key)) {
      fail("上一条还在处理中，请先停止或等它完成。");
      return;
    }

    const target = this.deps.models.resolveActive();
    if (target === null) {
      fail("还没有可用的模型。请在设置里添加一个启用的供应商和模型。");
      return;
    }
    if (target.missingApiKey) {
      fail(`供应商「${target.providerName}」还没有填写 API Key。`);
      return;
    }

    // 以渲染层装配好的完整历史为准（含新用户消息），再做压缩与截尾。
    this.deps.conversations.updateMessages(key, payload.messages);
    await this.maybeCompact(key, target);

    const doc = this.deps.conversations.get(key);
    const tail = doc.messages.slice(doc.summarizedFrom);
    const instructions = this.buildInstructions(doc.summary, this.deps.memory.read());

    const agent = new ToolLoopAgent({
      model: createLanguageModel(target),
      instructions,
      tools: this.toolsFor(),
      // toolApproval 预留位：P3 通知外发 / P4 浏览器副作用在这里接审批策略。
    });

    const controller = new AbortController();
    this.running.set(key, controller);

    try {
      const modelMessages = await convertToModelMessages(tail as UIMessage[]);
      const result = await agent.stream({
        messages: modelMessages,
        abortSignal: controller.signal,
      });
      const stream = toUIMessageStream({ stream: result.fullStream });
      for await (const chunk of stream) {
        emit({ key, runId, type: "chunk", chunk });
      }
    } catch (error) {
      // 用户主动停止：渲染层经 abortSignal 已知情，不必再发错误块。
      if (!controller.signal.aborted) {
        emit({ key, runId, type: "chunk", chunk: { type: "error", errorText: describeError(error) } });
      }
    } finally {
      this.running.delete(key);
      emit({ key, runId, type: "done" });
    }
  }

  abort(key: ConversationKey): void {
    this.running.get(key)?.abort();
  }

  abortAll(): void {
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
  }

  /**
   * 压缩：模型输入尾部超阈值时，把更早的消息并入摘要。摘要失败只跳过本次压缩，
   * 不影响本次回复——宁可多花一次上下文，不让摘要故障挡住对话。
   */
  private async maybeCompact(key: ConversationKey, target: ResolvedModel): Promise<void> {
    const doc = this.deps.conversations.get(key);
    const tail = doc.messages.slice(doc.summarizedFrom);
    if (estimateSize(tail) < COMPACT_THRESHOLD_CHARS) return;

    const cutoff = Math.max(doc.summarizedFrom, doc.messages.length - COMPACT_KEEP_TAIL);
    if (cutoff <= doc.summarizedFrom) return;

    const covered = doc.messages.slice(doc.summarizedFrom, cutoff);
    try {
      const summary = await summarize(createLanguageModel(target), doc.summary, covered);
      this.deps.conversations.applySummary(key, summary, cutoff);
    } catch {
      // 摘要失败：保持原状，下次再试。
    }
  }

  private buildInstructions(summary: string | null, memoryText: string): string {
    const base = RESUME_INSTRUCTIONS;

    const sections = [base];
    if (summary !== null && summary.trim() !== "") {
      sections.push(
        `# 之前对话的摘要\n\n更早的消息已压缩，以下是保留的要点：\n\n${summary.trim()}`,
      );
    }
    sections.push(
      memoryText.trim() === ""
        ? "# 长期记忆\n\n（还是空的。值得跨会话保留的用户偏好、简历口径、约定，请用 memory_write 记下来。）"
        : `# 长期记忆（跨会话保留）\n\n${memoryText.trim()}`,
    );
    return sections.join("\n\n---\n\n");
  }

  /** 工具注册表：目前只有简历一个会话；后续模块按 key 分发各自的工具集。 */
  private toolsFor(): ToolSet {
    const { resumes, memory } = this.deps;

    const memoryTools = {
      memory_read: tool({
        description: "读取长期记忆（memory.md）的当前内容。",
        inputSchema: z.object({}),
        execute: () => memory.read(),
      }),
      memory_write: tool({
        description:
          "整体覆写长期记忆。先读、合并、再写完整内容；只沉淀长期有效的偏好与约定，不要写流水账。",
        inputSchema: z.object({ content: z.string() }),
        execute: ({ content }) => {
          memory.write(content);
          return "已保存。";
        },
      }),
    };

    return {
      ...memoryTools,
      resume_read: tool({
        description: "读取当前主简历 resume.md 的完整内容。修改前务必先读最新版。",
        inputSchema: z.object({}),
        execute: () => resumes.read({ kind: "main" })?.content ?? "",
      }),
      resume_write: tool({
        description:
          "整体覆写主简历 resume.md（写入前系统会自动快照旧版）。请写入完整 Markdown，不要只写改动片段。",
        inputSchema: z.object({ content: z.string() }),
        execute: ({ content }) => {
          resumes.save({ kind: "main" }, content);
          return "已写入主简历。";
        },
      }),
      resume_tailored_list: tool({
        description: "列出已有的岗位定制简历（文件名列表）。",
        inputSchema: z.object({}),
        execute: () => resumes.listTailoredNames(),
      }),
      resume_tailored_read: tool({
        description: "读取一份岗位定制简历的内容。",
        inputSchema: z.object({ name: z.string() }),
        execute: ({ name }) => resumes.readTailored(name) ?? "",
      }),
      resume_tailored_write: tool({
        description:
          "写入一份岗位定制简历（整体覆写）。name 用简短的岗位标识，如「高级后端-字节」。写入前先读主简历。",
        inputSchema: z.object({ name: z.string(), content: z.string() }),
        execute: ({ name, content }) => {
          const saved = resumes.writeTailored(name, content);
          return `已写入定制简历「${saved.name}」。`;
        },
      }),
    };
  }
}

const RESUME_INSTRUCTIONS = `你是 GoodJob 的简历协作 Agent，和用户共同维护一份 Markdown 主简历。

工作方式：
- 主简历就是 resume.md，用 resume_read 读取、resume_write 整体覆写（写入前系统会自动快照，不必担心丢内容）。
- 用户在右侧编辑器里和你共编同一份文件，你的写入会实时出现在编辑器里，他手动保存的修改也会在你下次读取时生效。所以：每次修改前先读最新内容。
- 每次写入必须是完整文件内容，不要只写改动片段；大改前用一两句话说明你打算怎么改。
- resume.md 的版式约定（预览按简历模板渲染，照下面的格式写才能正确排版）：
  - 顶部基本信息区用 HTML 的 <table> 排两列，一格一条：首行左侧放姓名（<td style="font-size: 1.8em;"><strong>姓名</strong></td>）、右侧放求职意向；后面几行依次放经验年限 / 电话 / 邮箱 / 城市 / 链接等。整张表内不要空行。
  - 章节标题用三级标题加高亮：### ==😎 专业技能==（emoji 可选，== 高亮必须保留，它是模板的章节样式）。
  - 章节之间用 <hr/> 分隔线。
  - 经历 / 项目条目用四级标题加竖线分 2~3 段：#### 一、公司名 - 部门 | 职位 | 2023.04 - 至今（预览会两端对齐；只有时间段时写成两段）。
  - 条目内容用无序列表分点；关键技能 **加粗**，最亮眼的成果可用 ==高亮==。
  - 不放图片；除顶部信息表外不要写别的 HTML。
  - 章节顺序按用户情况调整，常用：基本信息（表格）/ 专业技能 / 工作经历 / 项目经历 / 教育背景 / 获奖与其他。
- 岗位定制简历：用户给出 JD 后，先读主简历，针对 JD 取舍改写，用 resume_tailored_write 存成定制稿（name 用简短岗位标识），并在回复里说明你做了哪些取舍。
- 用户上传旧简历时，你会收到抽出的纯文本：把它整理成上面的版式写入 resume.md，信息缺失的地方留空并提醒用户补，不要编造。

回复用简体中文。不确定的经历细节先问用户，宁缺毋滥。`;

/**
 * Maps a stored provider onto its AI SDK adapter. The four protocols differ only
 * in these constructor calls, so adding a new one is a case here plus a preset entry.
 */
function createLanguageModel(target: ResolvedModel): LanguageModel {
  const { baseURL, apiKey, modelId, providerName: name } = target;

  switch (target.protocol) {
    case "anthropic-messages": {
      const provider = createAnthropic({ baseURL, apiKey, name });
      return provider(modelId);
    }
    case "google-generative-ai": {
      const provider = createGoogleGenerativeAI({ baseURL, apiKey, name });
      return provider(modelId);
    }
    case "openai-responses": {
      const provider = createOpenAI({ baseURL, apiKey, name });
      return provider.responses(modelId);
    }
    default: {
      // OpenAI-compatible Chat Completions: the broadest relay/local-model format.
      const provider = createOpenAI({ baseURL, apiKey, name });
      return provider.chat(modelId);
    }
  }
}

/** 摘要是运行时的内部机制，不走工具循环；用 generateText 一次完成。 */
async function summarize(
  model: LanguageModel,
  previous: string | null,
  covered: WireMessage[],
): Promise<string> {
  const outline = covered
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${messageOutline(message)}`)
    .join("\n\n");

  const result = await generateText({
    model,
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

function messageOutline(message: WireMessage): string {
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

function estimateSize(messages: WireMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.parts) total += JSON.stringify(part).length;
  }
  return total;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "调用模型失败（未知错误）";
}
