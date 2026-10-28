import fs from "node:fs";

import {
  ToolLoopAgent,
  convertToModelMessages,
  generateText,
  toUIMessageStream,
  tool,
  type FilePart,
  type TextPart,
  type ToolSet,
  type UIMessage,
} from "ai";
import { z } from "zod";

import {
  DEFAULT_REASONING_EFFORT,
  isImageUploadName,
  type ChatSendPayload,
  type ChatStreamEvent,
  type ContextUsage,
  type ConversationKey,
  type DigestKind,
  type ReasoningEffort,
  type WireMessage,
} from "@shared/types";

import { readUploadImageDataUrl } from "../workspace/uploads";

import { createLanguageModel } from "./model-provider";
import type { ResolvedModel } from "../stores/models";
import {
  chooseCutoff,
  contextBudget,
  estimateSize,
  estimateTokens,
  measureMessages,
  summarize,
} from "./context";
import type { AgentDeps } from "./deps";
import {
  buildInstructions as buildSessionInstructions,
  digestInstructions,
  digestSnapshot,
} from "./instructions";
import { describeError, describeStreamError, sanitizeBaseURL } from "./logging";
import { toolsFor as buildTools } from "./tools";

type Emit = (event: ChatStreamEvent) => void;

/**
 * 首字节 / 空闲看门狗：流式期间超过这么久没有任何 chunk 就判定网关卡死并中断。
 * 没有它的时候，中转网关（如 CCConfig 自动网关）不回数据就等于 UI 永远停在
 * 「正在思考…」——用户只能靠猜，日志里也留不下任何痕迹。
 */
const STREAM_IDLE_TIMEOUT_MS = 90_000;
/** 视觉模型单张图片的最长边：1024px 足够读文字 / 看证件照，又不会把请求撑大。 */
const MODEL_IMAGE_WIDTH = 1024;
/** 一次请求最多附带最近这么多张图，避免整个会话的图片反复把上下文顶满。 */
const MODEL_IMAGE_LIMIT = 6;

/**
 * 从会话尾部挑出最新的图片附件。只把图片送进模型（文档仍由 upload_read 读），
 * 并按上传顺序取最后 MODEL_IMAGE_LIMIT 张；同名文件不会重复出现（落盘时去重）。
 */
function imageAttachmentsForModel(messages: WireMessage[]): Set<string> {
  const names: string[] = [];
  for (const message of messages) {
    for (const raw of message.parts as unknown[]) {
      if (typeof raw !== "object" || raw === null) continue;
      const part = raw as { type?: unknown; data?: unknown };
      if (part.type !== "data-upload") continue;
      const fileName = (part.data as { fileName?: unknown } | null | undefined)?.fileName;
      if (
        typeof fileName === "string" &&
        isImageUploadName(fileName) &&
        !names.includes(fileName)
      ) {
        names.push(fileName);
      }
    }
  }
  return new Set(names.slice(-MODEL_IMAGE_LIMIT));
}

export class AgentRuntime {
  private readonly running = new Map<ConversationKey, AbortController>();
  /** 用户最近一次在场的时刻（发消息 / 点停止都刷新）：browser_submit 离场门的依据。 */
  private lastActivityAt = Date.now();

  constructor(private readonly deps: AgentDeps) {}

  async send(payload: ChatSendPayload, emit: Emit): Promise<void> {
    const { key, runId } = payload;
    this.lastActivityAt = Date.now();

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
      fail("还没有可用的模型（llm_not_configured）。请在设置里添加一个启用的供应商和模型。");
      return;
    }
    if (target.missingApiKey) {
      fail(`供应商「${target.providerName}」还没有填写 API Key。`);
      return;
    }

    const controller = new AbortController();
    this.running.set(key, controller);

    const startedAt = Date.now();
    const chunkTypes = new Map<string, number>();
    let firstChunkMs: number | null = null;
    /** 流内错误（不像 catch 那个会抛）：网关 400 之类只以 error chunk 出现，得记下来。 */
    let streamError: string | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let idleFired = false;
    // 每次收到 chunk 就重新计时；超时直接打断本次 run（AbortError 由 catch 接手）。
    const armIdleWatchdog = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleFired = true;
        controller.abort();
      }, STREAM_IDLE_TIMEOUT_MS);
    };

    try {
      // 以渲染层装配好的完整历史为准（含新用户消息），再做压缩与截尾。
      // 这几步必须在 try 内：任何一步抛错都要走到 finally 的 done，
      // 否则渲染层的流永远关不掉，UI 就卡在「正在思考…」。
      // 看门狗从头盯到尾：压缩那一次 generateText 也会掉进同一个坑。
      armIdleWatchdog();
      this.deps.conversations.updateMessages(key, payload.messages);
      await this.maybeCompact(key, target, controller.signal);

      const doc = this.deps.conversations.get(key);
      const tail = doc.messages.slice(doc.summarizedFrom);
      const instructions = buildSessionInstructions(this.deps, key, doc.summary, this.deps.memory.read());

      this.logChat({
        event: "run:start",
        key,
        runId,
        provider: target.providerName,
        protocol: target.protocol,
        baseURL: sanitizeBaseURL(target.baseURL),
        model: target.modelId,
        contextWindow: target.contextWindow,
        maxOutputTokens: target.maxOutputTokens,
        effort: target.reasoning ? this.effortFor(payload.effort) : "none",
        messages: tail.length,
        chars: estimateSize(tail),
        inputTokens: measureMessages(tail).total,
        instructionsChars: instructions.length,
      });

      const agent = new ToolLoopAgent({
        model: createLanguageModel(target),
        instructions,
        tools: this.toolsFor(key),
        // 输出上限来自模型配置（默认 64K）：不传则供应商按自己的默认值截断。
        maxOutputTokens: target.maxOutputTokens,
        // 思考等级只发给真正的推理模型：openai-compatible 会把所有非
        // provider-default 的值当 reasoning_effort 发出去，标准模型会被严格中转 400。
        ...(target.reasoning ? { reasoning: this.effortFor(payload.effort) } : {}),
        // 审批分级（ARCHITECTURE §4）：
        // - notify（外发邮件）与 browser_act（浏览器写动作）一律界面审批；
        // - browser_submit 双重门：mode=interactive 走界面审批（附上模型给的
        //   「将要提交的内容摘要」）；mode=offline 不走界面审批，由工具内调用
        //   request_confirmation 邮件门（且仅当用户 ≥10 分钟无操作才可用）。
        // - 「自动通过所有请求」（设置 → 浏览器，默认关）打开时上面这些全部不弹。
        toolApproval: ({ toolCall }) => {
          if (this.deps.browserSettings.isAutoApprove()) return undefined;
          if (toolCall.toolName === "notify") return "user-approval";
          if (toolCall.toolName === "browser_act") return "user-approval";
          if (toolCall.toolName === "browser_submit") {
            const input = toolCall.input as { mode?: unknown; summary?: unknown };
            if (input.mode === "offline") return undefined;
            const summary = typeof input.summary === "string" && input.summary.trim() !== "" ? input.summary : undefined;
            return { type: "user-approval", reason: summary ?? "即将在浏览器面板里执行提交动作。" };
          }
          return undefined;
        },
      });

      // 图片附件：只给勾了「视觉输入」的模型；图片本体从当前会话的 upload/ 读，
      // 缩到 1024px 后作为 file part 随用户消息发送。data-upload 仍原样留在落盘消息里
      // （界面靠它显示文件名 / 缩略图），不把 base64 写进 conversations 的 JSON。
      const modelImages = target.vision ? imageAttachmentsForModel(tail) : new Set<string>();
      const modelMessages = await convertToModelMessages(tail as UIMessage[], {
        convertDataPart: (part): TextPart | FilePart | undefined => {
          if (part.type !== "data-upload") return undefined;
          const fileName = (part.data as { fileName?: unknown } | null | undefined)?.fileName;
          if (typeof fileName !== "string" || !modelImages.has(fileName)) return undefined;
          const dataUrl = readUploadImageDataUrl(
            this.deps.uploadDir(key),
            fileName,
            MODEL_IMAGE_WIDTH,
          );
          if (dataUrl === null) return undefined;
          const separator = dataUrl.indexOf(",");
          if (separator < 0) return undefined;
          return {
            type: "file",
            mediaType: dataUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg",
            filename: fileName,
            data: dataUrl.slice(separator + 1),
          };
        },
      });
      armIdleWatchdog();
      const result = await agent.stream({
        messages: modelMessages,
        abortSignal: controller.signal,
      });
      // 错误文本自己翻译：AI SDK 默认把流内错误遮成「An error occurred.」，
      // 中转站的 400 理由（例如工具 schema 不合规）就全丢了。
      const stream = toUIMessageStream({ stream: result.fullStream, onError: describeStreamError });
      for await (const chunk of stream) {
        if (firstChunkMs === null) {
          firstChunkMs = Date.now() - startedAt;
          this.logChat({ event: "run:first-chunk", key, runId, ms: firstChunkMs, chunk: chunk.type });
        }
        chunkTypes.set(chunk.type, (chunkTypes.get(chunk.type) ?? 0) + 1);
        if (chunk.type === "error") streamError = chunk.errorText;
        armIdleWatchdog();
        emit({ key, runId, type: "chunk", chunk });
      }
      this.logChat({
        event: "run:finish",
        key,
        runId,
        status: streamError === null ? "ok" : "stream-error",
        ms: Date.now() - startedAt,
        firstChunkMs,
        chunkTypes: Object.fromEntries(chunkTypes),
        ...(streamError === null ? {} : { error: streamError }),
      });
    } catch (error) {
      this.logChat({
        event: "run:finish",
        key,
        runId,
        status: idleFired ? "idle-timeout" : controller.signal.aborted ? "aborted" : "error",
        ms: Date.now() - startedAt,
        firstChunkMs,
        chunkTypes: Object.fromEntries(chunkTypes),
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        // 栈只给真实错误配：主动停止 / 看门狗超时的那份栈是 abort 的内部调用，没用。
        ...(!controller.signal.aborted && error instanceof Error ? { stack: error.stack } : {}),
      });
      // 用户主动停止：渲染层经 abortSignal 已知情，不必再发错误块。
      if (idleFired) {
        emit({
          key,
          runId,
          type: "chunk",
          chunk: {
            type: "error",
            errorText: `模型网关 ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)} 秒没有任何数据返回（供应商「${target.providerName}」/ 模型 ${target.modelName}），已中断本次请求。请求确实发出去了，卡在网关或上游：去中转服务看一眼它的日志，或换一个模型再试。`,
          },
        });
      } else if (!controller.signal.aborted) {
        emit({ key, runId, type: "chunk", chunk: { type: "error", errorText: describeError(error) } });
      }
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer);
      this.running.delete(key);
      // 浏览器任务的 tab 锁是会话级的：run 结束（正常 / 出错 / 被停）就收掉。
      this.deps.browser.endTask(key);
      emit({ key, runId, type: "done" });
    }
  }

  /**
   * 一次 run 的收发痕迹（`<workspace>/logs/chat.log`，JSONL，0600）。
   * 只记元数据：供应商 / 协议 / baseURL 的 origin / 模型 / 消息规模 / 首字节耗时 /
   * chunk 类型直方图 / 错误——不记 prompt、不记模型输出、不记 Key（Key 只在 main）。
   */
  private logChat(entry: Record<string, unknown>): void {
    try {
      const dir = this.deps.logsDir();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(`${dir}/chat.log`, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
        mode: 0o600,
      });
    } catch {
      // 日志写不进去不影响对话（UI 的 chunk 流还在），只是这次没留下痕迹。
    }
  }

  abort(key: ConversationKey): void {
    this.lastActivityAt = Date.now();
    this.running.get(key)?.abort();
  }

  /** 思考等级归一：渲染层没传或传了非法值就按默认（medium）。 */
  private effortFor(effort: ChatSendPayload["effort"]): ReasoningEffort {
    return effort === "low" || effort === "medium" || effort === "high" ? effort : DEFAULT_REASONING_EFFORT;
  }

  abortAll(): void {
    this.lastActivityAt = Date.now();
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
  }

  /**
   * 日报 / 周报（P3 M3）：NotifyService 调度到点（或设置页手动触发）时发起的一次
   * Agent 运行——没有对话、没有 UI 流，generateText + notify 工具。模型拿到 P2
   * 实体的当前快照，汇总成简短正文后调 notify 发出；notify 不走界面审批：
   * 日报是用户排期过的固定动作（ARCHITECTURE §4 的「邮件确认门 / 界面审批」之外，
   * 排期本身即同意）。
   */
  async runDigest(kind: DigestKind): Promise<{ ok: boolean; message: string }> {
    const label = kind === "daily" ? "日报" : "周报";
    const target = this.deps.models.resolveActive();
    if (target === null) {
      return { ok: false, message: `还没有可用的模型（llm_not_configured），无法生成${label}。` };
    }
    if (target.missingApiKey) {
      return {
        ok: false,
        message: `供应商「${target.providerName}」还没有填写 API Key，无法生成${label}。`,
      };
    }

    let sent = false;
    const notifyTool = tool({
      description: "把汇总好的求职进展正文发到用户自己的邮箱。",
      inputSchema: z.object({ summary: z.string() }),
      execute: async ({ summary }, { abortSignal }) => {
        const result = await this.deps.notify.sendNotification(summary, abortSignal);
        sent = true;
        return result;
      },
    });

    const result = await generateText({
      model: createLanguageModel(target),
      system: digestInstructions(label),
      prompt: digestSnapshot(this.deps),
      tools: { notify: notifyTool },
    });

    if (!sent) {
      return {
        ok: false,
        message: `模型没有调用 notify 发送${label}（回复：${result.text.trim().slice(0, 160) || "（空）"}）`,
      };
    }
    return { ok: true, message: result.text.trim() };
  }

  /** 当前会话的工具集；也公开给冒烟测试检查工具白名单。 */
  toolsFor(key: ConversationKey): ToolSet {
    return buildTools(this.deps, key, () => this.lastActivityAt);
  }

  /** 当前会话的完整指令；也公开给冒烟测试检查 persona / 轮次进度。 */
  buildInstructions(key: ConversationKey, summary: string | null, memoryText: string): string {
    return buildSessionInstructions(this.deps, key, summary, memoryText);
  }

  /**
   * 压缩：把更早的消息并入摘要，输入预算只留「摘要 + 最近若干轮」。
   * 触发条件按模型的 contextWindow 算（默认到 90% 就压），保留量也是 token 预算
   * 而不是固定条数——窗口 200K 和 1M 的模型本来就不该共用一个「保留 12 轮」。
   * 摘要失败只跳过本次压缩，不影响本次回复：宁可多花一次上下文，不让摘要故障挡住对话。
   */
  private async maybeCompact(
    key: ConversationKey,
    target: ResolvedModel,
    signal?: AbortSignal,
    force = false,
  ): Promise<void> {
    const doc = this.deps.conversations.get(key);
    const budget = contextBudget(target);
    const tail = doc.messages.slice(doc.summarizedFrom);
    if (!force) {
      const instructionsText = buildSessionInstructions(this.deps, key, doc.summary, this.deps.memory.read());
      const used = estimateTokens(instructionsText) + measureMessages(tail).total;
      if (used < budget.threshold) return;
    }

    // 切点对齐到 user 消息：把一轮问答（user + 助手回复 + 工具结果）整块吞进摘要，
    // 不要从两条消息中间切，否则模型会看到一个没有提问的答案。
    let cutoff = doc.summarizedFrom + chooseCutoff(tail, budget.keep);
    if (force && cutoff <= doc.summarizedFrom) {
      // 手动压缩且尾部本来就装得下：用户就是想现在压，那就只留最后一轮。
      let lastUser = -1;
      for (let i = tail.length - 1; i >= 0; i -= 1) {
        if (tail[i]?.role === "user") {
          lastUser = i;
          break;
        }
      }
      if (lastUser > 0) cutoff = doc.summarizedFrom + lastUser;
    }
    if (cutoff <= doc.summarizedFrom) return;

    const covered = doc.messages.slice(doc.summarizedFrom, cutoff);
    try {
      const summary = await summarize(createLanguageModel(target), doc.summary, covered, signal);
      this.deps.conversations.applySummary(key, summary, cutoff);
    } catch {
      // 摘要失败：保持原状，下次再试。
    }
  }

  /**
   * 上下文用量（渲染层的「上下文」气泡）：同一套估算器算出来的，
   * 和自动压缩用的阈值完全一致，不会出现「界面说 88%，实际上已经不压了」。
   */
  context(key: ConversationKey): ContextUsage {
    const target = this.deps.models.resolveActive();
    const doc = this.deps.conversations.get(key);
    if (target === null) {
      return {
        limit: 0,
        maxOutputTokens: 0,
        threshold: 0,
        instructions: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        used: 0,
        summarizedMessages: doc.summarizedFrom,
      };
    }
    const budget = contextBudget(target);
    const tail = doc.messages.slice(doc.summarizedFrom);
    const instructionsText = buildSessionInstructions(this.deps, key, doc.summary, this.deps.memory.read());
    const instructions = estimateTokens(instructionsText);
    const breakdown = measureMessages(tail);
    return {
      limit: budget.limit,
      maxOutputTokens: budget.maxOutputTokens,
      threshold: budget.threshold,
      instructions,
      input: breakdown.input,
      output: breakdown.output,
      reasoning: breakdown.reasoning,
      used: instructions + breakdown.total,
      summarizedMessages: doc.summarizedFrom,
    };
  }

  /**
   * 手动压缩（渲染层「压缩上下文」按钮）：和自动压缩同一条路径，只是不看阈值。
   * 返回压缩后的用量，让界面立刻反映结果。
   */
  async compact(key: ConversationKey): Promise<ContextUsage> {
    this.lastActivityAt = Date.now();
    const target = this.deps.models.resolveActive();
    if (target !== null && !this.running.has(key)) {
      await this.maybeCompact(key, target, undefined, true);
    }
    return this.context(key);
  }

}
