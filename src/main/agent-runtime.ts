import fs from "node:fs";

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

import {
  DEFAULT_REASONING_EFFORT,
  interviewKeyTarget,
  jobKeyTarget,
  type ChatSendPayload,
  type ChatStreamEvent,
  type ContextUsage,
  type ConversationKey,
  type DigestKind,
  type ReasoningEffort,
  type WireMessage,
} from "@shared/types";

import { browserActActionSchema, browserReadActionSchema, browserSubmitActionSchema, describeSubmitAction, tabActionSchema } from "./agent/actions";
import type { BrowserAgentService } from "./agent/runner";
import type { BrowserAgentSettingsStore } from "./agent/settings-store";
import type {
  ApplicationsStore,
  CompaniesStore,
  JobsStore,
  PipelineStore,
} from "./domain-store";
import type { ConversationsStore } from "./conversations-store";
import type { InterviewsStore } from "./interviews-store";
import type { MemoryStore } from "./memory";
import { createLanguageModel } from "./model-provider";
import type { ModelsStore, ResolvedModel } from "./models-store";
import type { NotifyService } from "./notify-service";
import { RESUME_FORMAT } from "./resume-format";
import type { ResumeStore } from "./resume-store";
import type { TaskManager } from "./tasks";
import { listUploadFiles, readUploadFile } from "./uploads";

type Emit = (event: ChatStreamEvent) => void;

/**
 * 上下文预算：一切按模型的 contextWindow 算，不再按「保留最近 N 条」截尾。
 * 输出上限要从窗口里预留出来，否则「窗口 200K + 输出 64K」的请求会被供应商直接拒。
 */
function contextBudget(target: ResolvedModel): {
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
/**
 * 离场模式的空闲门槛（开放决策 2 的采纳值）：用户 10 分钟内有操作（发消息 /
 * 点停止都算在场）就不允许 browser_submit 走邮件确认门，必须走界面审批。
 */
const OFFLINE_GATE_IDLE_MS = 10 * 60_000;
/** 提交限速的随机抖动上限：在最小间隔之外再加 0–30s，避免机械等间隔。 */
const SUBMIT_JITTER_MAX_MS = 30_000;
/**
 * 首字节 / 空闲看门狗：流式期间超过这么久没有任何 chunk 就判定网关卡死并中断。
 * 没有它的时候，中转网关（如 CCConfig 自动网关）不回数据就等于 UI 永远停在
 * 「正在思考…」——用户只能靠猜，日志里也留不下任何痕迹。
 */
const STREAM_IDLE_TIMEOUT_MS = 90_000;
/** 平台适配模板注入指令的上限（模板是用户手编文件，失控时别拖垮上下文）。 */
const PLAYBOOKS_INSTRUCTION_LIMIT = 4_000;

export interface AgentDeps {
  models: ModelsStore;
  conversations: ConversationsStore;
  resumes: ResumeStore;
  memory: MemoryStore;
  companies: CompaniesStore;
  jobs: JobsStore;
  applications: ApplicationsStore;
  pipeline: PipelineStore;
  interviews: InterviewsStore;
  tasks: TaskManager;
  /** 通知服务（P3 M3）：notify / request_confirmation 两个工具的后端。 */
  notify: NotifyService;
  /** 浏览器自动化（P4）：受控动作执行 + tab 锁定 + 审计。 */
  browser: BrowserAgentService;
  /** 浏览器自动化设置（P4）：启用开关与提交限速。 */
  browserSettings: BrowserAgentSettingsStore;
  /** 诊断日志目录（`<workspace>/logs`）：每次 run 的收发痕迹写 chat.log。 */
  logsDir: () => string;
  /** 会话对应的上传目录（按 key 落到各自模块的 upload/，见 main/uploads.ts）。 */
  uploadDir: (key: ConversationKey) => string;
}

/**
 * Agent 运行时：一切 LLM 环节都是工具循环（ToolLoopAgent），流式走 UIMessageChunk
 * 线协议发到渲染层。模型每次 send 动态解析（供应商/模型可随时在设置里换），
 * 指令 = 模块指令（按会话 key 分发）+ 长期记忆 + 滚动摘要，模型输入 = 指令 + 压缩后的尾部消息。
 */
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
      const instructions = this.buildInstructions(key, doc.summary, this.deps.memory.read());

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
        toolApproval: ({ toolCall }) => {
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

      const modelMessages = await convertToModelMessages(tail as UIMessage[]);
      armIdleWatchdog();
      const result = await agent.stream({
        messages: modelMessages,
        abortSignal: controller.signal,
      });
      const stream = toUIMessageStream({ stream: result.fullStream });
      for await (const chunk of stream) {
        if (firstChunkMs === null) {
          firstChunkMs = Date.now() - startedAt;
          this.logChat({ event: "run:first-chunk", key, runId, ms: firstChunkMs, chunk: chunk.type });
        }
        chunkTypes.set(chunk.type, (chunkTypes.get(chunk.type) ?? 0) + 1);
        armIdleWatchdog();
        emit({ key, runId, type: "chunk", chunk });
      }
      this.logChat({
        event: "run:finish",
        key,
        runId,
        status: "ok",
        ms: Date.now() - startedAt,
        firstChunkMs,
        chunkTypes: Object.fromEntries(chunkTypes),
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
      const instructionsText = this.buildInstructions(key, doc.summary, this.deps.memory.read());
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
    const instructionsText = this.buildInstructions(key, doc.summary, this.deps.memory.read());
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

  private buildInstructions(key: ConversationKey, summary: string | null, memoryText: string): string {
    const interviewKey = interviewKeyTarget(key);
    const sections: string[] =
      interviewKey !== null
        ? // 面试会话：persona + 每次 send 重算的实时轮次进度（runtime 侧硬约束的一半，
          // 另一半在 interviews-store 的写入口校验里）。
          [this.interviewInstructions(interviewKey)]
        : [moduleInstructions(key)];

    // 投递会话追加平台适配模板（用户手编的 browser-playbooks.md，P4）：
    // 没启用浏览器自动化就不注入，省上下文。
    if (key === "applications" && this.deps.browser.isEnabled()) {
      sections.push(this.playbooksSection());
    }

    if (summary !== null && summary.trim() !== "") {
      sections.push(
        `# 之前对话的摘要\n\n更早的消息已压缩，以下是保留的要点：\n\n${summary.trim()}`,
      );
    }
    // 面试会话不挂长期记忆：面试官只对材料与本场面试负责，也没有 memory 工具。
    if (interviewKey === null) {
      sections.push(
        memoryText.trim() === ""
          ? "# 长期记忆\n\n（还是空的。值得跨会话保留的用户偏好、简历口径、约定，请用 memory_write 记下来。）"
          : `# 长期记忆（跨会话保留）\n\n${memoryText.trim()}`,
      );
    }
    return sections.join("\n\n---\n\n");
  }

  /**
   * 平台适配模板（P4）：首次用到时落默认模板，之后原样读用户改过的版本。
   * 内容截断注入（上限 PLAYBOOKS_INSTRUCTION_LIMIT），模板坏了只跳过不挡对话。
   */
  private playbooksSection(): string {
    try {
      const content = this.deps.browserSettings.ensurePlaybooks().trim();
      if (content === "") return "";
      const body =
        content.length > PLAYBOOKS_INSTRUCTION_LIMIT
          ? `${content.slice(0, PLAYBOOKS_INSTRUCTION_LIMIT)}\n…（模板过长已截断，请精简 browser-playbooks.md）`
          : content;
      return `# 投递平台适配指令（用户可编辑 browser-playbooks.md）\n\n${body}`;
    } catch {
      return "";
    }
  }

  /** 面试官指令 = persona + 实时进度。进度来自面试记录（轮次由工具落账，模型改不了）。 */
  private interviewInstructions(interviewId: string): string {
    const interview = this.deps.interviews.get(interviewId);
    if (interview === null) {
      return "这场面试的记录已经不存在（可能已被删除）。直接告诉用户记录已被删除，不要再调用任何工具。";
    }
    const asked =
      interview.rounds.length === 0
        ? "（还没有记录）"
        : interview.rounds
            .map((round) => `${round.no}. ${round.question}`)
            .join("\n");
    const progress =
      interview.status === "finished"
        ? [
            `面试状态：已结束${interview.review !== null ? `（总评 ${interview.review.score}/100）` : ""}。`,
            "不要再提问，也不要再调用 interview_round_log / interview_submit_review（会失败）；",
            "用户想继续聊时，基于已记录的轮次与总评谈改进即可。",
          ].join("\n")
        : [
            `面试进度：已完整记录 ${interview.rounds.length} / 设定 ${interview.config.rounds} 轮。`,
            `已记录的轮次（主问题）：\n${asked}`,
            interview.rounds.length >= interview.config.rounds
              ? "设定轮次已记满：确认用户没有继续追问的意愿后，收束面试并调用 interview_submit_review 出总评。"
              : "未记满设定轮次前不要收束面试。",
          ].join("\n");
    return `${INTERVIEW_PERSONA}\n\n${progress}`;
  }

  /**
   * 工具注册表：按会话 key 分发（模块会话 + `job:<jobId>` 岗位工作台 +
   * `interview:<id>` 模拟面试）。写操作的枚举 / 引用校验在 store 里做，
   * 抛出的错误会作为 tool-error 带回模型自行纠正。memory 工具所有会话都有
   * （面试会话除外——面试官是限定角色，不给写记忆的能力）。
   */
  private toolsFor(key: ConversationKey): ToolSet {
    const memoryTools = this.memoryTools();
    // 上传的参考文件：每个会话都有（落各自模块的 upload/），面试官是限定角色所以不给。
    const uploadTools = this.uploadTools(key);

    const jobKey = jobKeyTarget(key);
    if (jobKey !== null) return { ...memoryTools, ...uploadTools, ...this.jobWorkbenchTools(jobKey) };

    const interviewKey = interviewKeyTarget(key);
    if (interviewKey !== null) return this.interviewSessionTools(interviewKey);

    switch (key) {
      case "companies":
        // 公司调研（P4）：浏览器只读动作辅助调研，快照整理进 research。
        return { ...memoryTools, ...uploadTools, ...this.companyTools(), ...this.browserTools(key) };
      case "jobs":
        // 链接抓 JD / 自动搜索（P4）：只读浏览，回填岗位档案。
        return { ...memoryTools, ...uploadTools, ...this.jobTools(), ...this.browserTools(key) };
      case "applications":
        // 投递会话拿通知工具（P3 M3）：外发 / 邮件确认门都以「用户自己的邮箱」为准。
        // 填表投递（P4 M4）：browser_act / browser_submit 双重门 + 限速也在这里。
        return {
          ...memoryTools,
          ...uploadTools,
          ...this.applicationTools(),
          ...this.notifyTools(),
          ...this.browserTools(key),
        };
      default:
        // resume：简历协作工具（P1）+ 话术 + 评分技能（后台任务）。
        return { ...memoryTools, ...uploadTools, ...this.resumeTools(), ...this.skillTools() };
    }
  }

  /**
   * 上传的参考文件（全模块通用）：用户在对话里「+」上传的文件原样落进当前模块的
   * upload/ 目录，正文靠这两个工具按需读——对话里只出现文件名，不塞全文。
   * 目录按会话 key 解析（见 main/uploads.ts 的 uploadDirFor），所以同一对工具在
   * 简历 / 公司 / 岗位 / 投递 / 面试里读的是各自的目录，互不串。
   */
  private uploadTools(key: ConversationKey): ToolSet {
    return {
      upload_list: tool({
        description:
          "列出用户上传到当前模块 upload/ 目录里的参考文件（旧简历、JD 文档、公司资料等）。",
        inputSchema: z.object({}),
        execute: () => listUploadFiles(this.deps.uploadDir(key)),
      }),
      upload_read: tool({
        description:
          "读取一份上传文件的文本：PDF / DOCX 自动抽成纯文本，Markdown / 文本文件返回原文。fileName 用 upload_list 里的名字。",
        inputSchema: z.object({ fileName: z.string() }),
        execute: ({ fileName }) => readUploadFile(this.deps.uploadDir(key), fileName),
      }),
    };
  }

  /**
   * 浏览器工具（P4）： companies / jobs / applications 三个会话的工具面。
   * 设置里关掉就不注册（模型看不见），执行时再校验一次防中途关闭。
   * inputSchema 只收受控枚举与 ref / 文本参数——argv 由 actions.buildArgv 组装，
   * 模型拼不了 CLI；白名单外的东西在类型层就不存在。
   */
  private browserTools(key: ConversationKey): ToolSet {
    if (!this.deps.browser.isEnabled()) return {};
    return {
      browser_read: tool({
        description:
          "在内嵌浏览器面板上执行一条只读动作（导航 / snapshot / get / is / wait / 滚动）。先 snapshot 拿到 @ref 才能操作元素；open 之后旧 ref 全部失效，必须重新 snapshot。",
        inputSchema: browserReadActionSchema,
        execute: async (action, { abortSignal }) =>
          this.deps.browser.execute({ tool: "browser_read", action, key, signal: abortSignal }),
      }),
      browser_act: tool({
        description:
          "在内嵌浏览器面板上执行一条写动作（点击 / 填写 / 勾选等）。每一步都会弹界面审批，等用户批准才执行。动作前元素要在视口内：视口外先 scrollintoview 再重新 snapshot。想把链接开到新标签就用 click 的 newTab=true（读 href 后建一个用户看得见的标签）。",
        inputSchema: browserActActionSchema,
        execute: async (action, { abortSignal }) =>
          this.deps.browser.execute({ tool: "browser_act", action, key, signal: abortSignal }),
      }),
      browser_tab: tool({
        description:
          "管理浏览器标签（多标签）：list 列出全部标签（id / url / 标题 / 哪个当前）；new 新建一个标签并在其中打开 url（可省）；switch 切换当前操作的标签（target 用 tab list 返回的 id）；close 关闭一个标签（不能关当前那个）。新 / 切标签后旧的 @ref 全部失效，必须重新 snapshot。运行多个网站的长时间任务时，一个网站一个标签。",
        inputSchema: tabActionSchema,
        execute: async (action, { abortSignal }) =>
          this.deps.browser.execute({ tool: "browser_tab", action, key, signal: abortSignal }),
      }),
      browser_submit: tool({
        description:
          "提交浏览器面板里的表单 / 发送消息（投递、主动沟通这类对外副作用）。必须先在回复里展示「将要提交的内容摘要」再调用。双重门：用户在场（默认）用 mode=\"interactive\" 走界面审批；只有用户明确说会离开、或已 10 分钟没有操作才可用 mode=\"offline\" 走邮件确认门——它返回超时就取消并在会话里说明，不要重试。提交受单站每日上限与最小间隔限速。",
        inputSchema: z.object({
          summary: z.string().min(1).max(2000).describe("将要提交的内容摘要：填了什么、提交到哪个页面（会展示给用户审批）"),
          mode: z.enum(["interactive", "offline"]).describe('interactive=用户在场走界面审批（默认）；offline=用户已离场走邮件确认门'),
          action: browserSubmitActionSchema.describe("提交动作：点击提交按钮（@ref）或按回车"),
        }),
        execute: async (input, { abortSignal }) => {
          const { summary, mode, action } = input;
          // 在场判定（开放决策 2）：刚有操作就不许绕过界面审批。
          if (mode === "offline" && Date.now() - this.lastActivityAt < OFFLINE_GATE_IDLE_MS) {
            throw new Error(
              '用户 10 分钟内有操作，离场模式不可用。请改用 mode="interactive"（界面审批），或等用户真的离开。',
            );
          }
          // 限速按「当前页面的站」记账，模型指定不了 host。
          const host = this.deps.browser.currentHost();
          if (host === "") {
            throw new Error("读不到当前页面的网址，无法按站限速。请先在浏览器面板里打开目标页面。");
          }
          const rate = this.deps.browserSettings.checkSubmitRate(host, Date.now());
          if (!rate.allowed) throw new Error(rate.reason ?? "已达提交限速，无法提交。");
          if (mode === "offline") {
            const outcome = await this.deps.notify.requestConfirmation(
              `确认浏览器提交（${host}）`,
              `${summary}\n\n放行后将执行：${describeSubmitAction(action)}。`,
              abortSignal,
            );
            if (outcome === "timeout") {
              return "邮件确认门超时（一直没收到回信），已按取消处理：没有执行提交。请在会话里告诉用户本次提交已取消。";
            }
          }
          if (rate.waitMs > 0) {
            // 最小间隔之外再加 0–30s 随机抖动，避免机械等间隔的机器人特征。
            const waitMs = rate.waitMs + Math.floor(Math.random() * SUBMIT_JITTER_MAX_MS);
            await sleepWithAbort(waitMs, abortSignal);
          }
          // 记账在执行前：无论成功与否，这次接触都算对平台的一次提交尝试。
          this.deps.browserSettings.recordSubmit(host, Date.now());
          const result = await this.deps.browser.execute({
            tool: "browser_submit",
            action,
            key,
            signal: abortSignal,
          });
          return [
            `已执行提交动作（${describeSubmitAction(action)}）。`,
            "请立刻 snapshot 确认提交结果（成功页 / 报错提示），把结果如实告诉用户；失败就停下说明，不要盲目重试。",
            `返回：${JSON.stringify(result).slice(0, 400)}`,
          ].join("\n");
        },
      }),
    };
  }

  /** 通知工具（P3 M3）：对模型只有两个入口，后端都在 NotifyService。 */
  private notifyTools(): ToolSet {
    return {
      notify: tool({
        description:
          "把一段摘要发到用户自己配置的邮箱（设置 → 通知）。会弹界面审批，用户批准后才会真正发出。",
        inputSchema: z.object({
          summary: z.string().describe("要发送的正文（Markdown）"),
        }),
        execute: async ({ summary }, { abortSignal }) => {
          if (summary.trim() === "") throw new Error("summary 是空的，没有什么可发。");
          return this.deps.notify.sendNotification(summary, abortSignal);
        },
      }),
      request_confirmation: tool({
        description:
          "发起邮件确认门（用户不在场时的审批通道）：给用户发一封带确认码的邮件并等待回信，返回 \"approved\"（放行）或 \"timeout\"（未放行，立即走取消分支，不要重试、不要换别的方式执行）。任何回信内容都代表同意。只在用户明确说会离开 / 让你稍后再确认时使用。",
        inputSchema: z.object({
          subject: z.string().describe("确认邮件主题：说清楚要让用户确认什么"),
          body: z.string().describe("确认邮件正文：待放行的具体操作与影响"),
        }),
        execute: async ({ subject, body }, { abortSignal }) =>
          this.deps.notify.requestConfirmation(subject, body, abortSignal),
      }),
    };
  }

  private memoryTools(): ToolSet {
    const { memory } = this.deps;
    return {
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
  }

  /* ————————— resume 会话：简历协作（P1）+ 话术 + 评分技能 ————————— */

  private resumeTools(): ToolSet {
    const { resumes } = this.deps;

    return {
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
        description: "列出已有的岗位定制简历（key 列表；现在约定 key = 岗位 jobId）。",
        inputSchema: z.object({}),
        execute: () => resumes.listTailoredNames(),
      }),
      resume_tailored_read: tool({
        description: "读取一份岗位定制简历。key 用岗位 jobId；也兼容读 P1 旧版按岗位名存的文件。",
        inputSchema: z.object({ key: z.string() }),
        execute: ({ key }) => resumes.readTailored(key) ?? "",
      }),
      resume_tailored_write: tool({
        description:
          "按岗位 jobId 写入定制简历（与岗位 1:1，整体覆写，旧版自动快照）。写入前先读主简历；迁移 P1 旧文件时用 migrateFrom 传旧文件名，系统会把它清掉。",
        inputSchema: z.object({
          jobId: z.string(),
          content: z.string(),
          migrateFrom: z.string().optional(),
        }),
        execute: ({ jobId, content, migrateFrom }) => {
          const saved = resumes.writeTailored(jobId, content, migrateFrom);
          return `已写入定制简历「${saved.key}」。`;
        },
      }),
    };
  }

  /** 话术（scripts/<jobId>.md）+ 评分技能（后台任务）。 */
  private skillTools(): ToolSet {
    const { resumes, jobs, tasks } = this.deps;

    return {
      script_list: tool({
        description:
          "列出当前简历的话术（含定稿状态；modifiedSinceFinal 表示定稿后改过、待重新定稿）。",
        inputSchema: z.object({}),
        execute: () => resumes.listScripts(),
      }),
      script_read: tool({
        description: "读取一个岗位的话术当前版（jobId 用 job_list 查）。",
        inputSchema: z.object({ jobId: z.string() }),
        execute: ({ jobId }) => {
          const script = resumes.readScript(jobId);
          if (script === null) throw new Error(`还没有「${jobId}」的话术，先用 script_write 生成一版。`);
          return script;
        },
      }),
      script_write: tool({
        description:
          "写入一个岗位的话术当前版（整体覆写，旧版自动快照进 scripts/history/）。结构约定：自我介绍 / 项目深挖 / 反问环节，按 JD 预判的问题给要点式回答。",
        inputSchema: z.object({ jobId: z.string(), content: z.string() }),
        execute: ({ jobId, content }) => {
          const doc = resumes.writeScript(jobId, content);
          return `已写入话术（定稿状态：${doc.final ? (doc.modifiedSinceFinal ? "已定稿但后有修改，待重新定稿" : "已定稿") : "未定稿"}）。`;
        },
      }),
      script_finalize: tool({
        description:
          "话术定稿：锁定供面试 / 投递引用的版本（当前内容进 scripts/history/）。定稿后仍可编辑，改过会提示重新定稿。",
        inputSchema: z.object({ jobId: z.string() }),
        execute: ({ jobId }) => {
          const doc = resumes.finalizeScript(jobId);
          return `已定稿「${doc.jobId}」的话术（${doc.finalizedAt ?? ""}）。`;
        },
      }),
      job_list: tool({
        description: "列出全部岗位（id / 标题 / 公司 / 薪资带 / 匹配度），用于把用户说的岗位对应到 jobId。",
        inputSchema: z.object({}),
        execute: () => jobSummaries(this.deps),
      }),
      resume_job_evaluate: tool({
        description:
          "发起简历评估后台任务（JD 匹配度评分）：结果写进该岗位的匹配度报告，完成后岗位表的分数会刷新（点分数看评分卡）。",
        inputSchema: z.object({ jobId: z.string() }),
        execute: ({ jobId }) => {
          if (jobs.get(jobId) === null) throw new Error(`岗位不存在：${jobId}（可用 job_list 查 id）`);
          const previous = tasks.latest("job-match", jobId);
          const task = tasks.run("job-match", jobId);
          const lastLine =
            previous !== null && previous.status === "done" && previous.result !== null
              ? `上次结果：${previous.result}\n`
              : "";
          return `${lastLine}任务已发起（${task.id}），不用等它——继续当前对话即可。`;
        },
      }),
      resume_integrity_check: tool({
        description:
          "发起主简历完整性评分后台任务：报告存进这份简历的 reports/ 目录，完成后简历页的「完整性」按钮可看。",
        inputSchema: z.object({}),
        execute: () => {
          const currentId = resumes.list().currentId;
          if (currentId === null) throw new Error("还没有简历。");
          const task = tasks.run("resume-integrity", currentId);
          return `任务已发起（${task.id}），报告会写进 resumes/${currentId}/reports/。`;
        },
      }),
    };
  }

  /* ————————— companies 会话 ————————— */

  private companyTools(): ToolSet {
    const { companies } = this.deps;

    return {
      company_list: tool({
        description: "列出全部公司（id / 名称 / 行业 / 城市 / 更新时间）。引用或新增前先查。",
        inputSchema: z.object({}),
        execute: () =>
          companies.list().map(({ id, name, industry, city, updatedAt }) => ({
            id,
            name,
            industry,
            city,
            updatedAt,
          })),
      }),
      company_get: tool({
        description: "读取一个公司的完整档案（含调研快照 research）。",
        inputSchema: z.object({ id: z.string() }),
        execute: ({ id }) => {
          const company = companies.get(id);
          if (company === null) throw new Error(`公司不存在：${id}（可用 company_list 查 id）`);
          return company;
        },
      }),
      company_create: tool({
        description: "新建公司（名称必填）。",
        inputSchema: z.object({
          name: z.string(),
          industry: z.string().optional(),
          scale: z.string().optional(),
          city: z.string().optional(),
          website: z.string().optional(),
          source: z.string().optional(),
        }),
        execute: (patch) => companies.create(patch),
      }),
      company_update: tool({
        description: "更新公司资料；research 写调研快照（Markdown，标注来源）。只传要改的字段。",
        inputSchema: z.object({
          id: z.string(),
          name: z.string().optional(),
          industry: z.string().optional(),
          scale: z.string().optional(),
          city: z.string().optional(),
          website: z.string().optional(),
          source: z.string().optional(),
          research: z.string().optional(),
        }),
        execute: ({ id, ...patch }) => {
          const company = companies.update(id, patch);
          return company;
        },
      }),
      company_delete: tool({
        description: "删除公司。不会级联：引用它的岗位会变成悬空引用，删前先和用户确认。",
        inputSchema: z.object({ id: z.string() }),
        execute: ({ id }) => {
          companies.remove(id);
          return "已删除。引用它的岗位会显示为悬空引用。";
        },
      }),
    };
  }

  /* ————————— jobs 会话 ————————— */

  private jobTools(): ToolSet {
    const { jobs } = this.deps;

    return {
      job_list: tool({
        description: "列出全部岗位（id / 标题 / 公司 / 薪资带 / 匹配度 / 更新时间）。",
        inputSchema: z.object({}),
        execute: () => jobSummaries(this.deps),
      }),
      job_get: tool({
        description: "读取一个岗位的完整档案（JD 原文 + 匹配度报告）。",
        inputSchema: z.object({ id: z.string() }),
        execute: ({ id }) => {
          const job = jobs.get(id);
          if (job === null) throw new Error(`岗位不存在：${id}（可用 job_list 查 id）`);
          return job;
        },
      }),
      job_create: tool({
        description:
          "新建岗位（标题必填）。用户粘贴的 JD 整理成 Markdown 存 jd；companyId 必须是 company_list 里的真实 id。",
        inputSchema: z.object({
          title: z.string(),
          companyId: z.string().optional(),
          url: z.string().optional(),
          salaryBand: z.string().optional(),
          jd: z.string().optional(),
        }),
        execute: (patch) => {
          const job = jobs.create(patch);
          return job;
        },
      }),
      job_update: tool({
        description: "更新岗位资料，只传要改的字段。匹配度报告由评估任务写入，不在这里改。",
        inputSchema: z.object({
          id: z.string(),
          companyId: z.string().nullable().optional(),
          title: z.string().optional(),
          url: z.string().optional(),
          salaryBand: z.string().optional(),
          jd: z.string().optional(),
        }),
        execute: ({ id, ...patch }) => {
          const job = jobs.update(id, patch);
          return job;
        },
      }),
      job_delete: tool({
        description: "删除岗位。不会级联：定制简历、话术、投递记录保留为悬空引用，删前先和用户确认。",
        inputSchema: z.object({ id: z.string() }),
        execute: ({ id }) => {
          jobs.remove(id);
          return "已删除。相关的定制简历 / 话术 / 投递会显示为悬空引用。";
        },
      }),
    };
  }

  /* ————————— applications 会话 ————————— */

  private applicationTools(): ToolSet {
    const { applications, pipeline } = this.deps;

    return {
      application_list: tool({
        description: "列出全部投递（含状态时间线与 Offer 字段）。",
        inputSchema: z.object({}),
        execute: () => applications.list(),
      }),
      application_create: tool({
        description: "新建投递（jobId 必须来自 job_list 的真实 id）。",
        inputSchema: z.object({ jobId: z.string(), note: z.string().optional() }),
        execute: (patch) => applications.create(patch),
      }),
      application_advance: tool({
        description:
          "推进一条投递的状态：追加一条时间线（stage 必须是流水线里的名字，先用 pipeline_list 查；时间自动取当前时刻）。",
        inputSchema: z.object({ id: z.string(), stage: z.string(), note: z.string().optional() }),
        execute: ({ id, stage, note }) => applications.advance(id, stage, note ?? ""),
      }),
      application_update: tool({
        description:
          "更新投递：补 Offer 字段（salary / equity / note）、改备注或修正时间线。只传要改的字段。",
        inputSchema: z.object({
          id: z.string(),
          jobId: z.string().nullable().optional(),
          timeline: z
            .array(z.object({ stage: z.string(), at: z.string(), note: z.string() }))
            .optional(),
          offer: z
            .object({ salary: z.string(), equity: z.string(), note: z.string() })
            .nullable()
            .optional(),
          note: z.string().optional(),
        }),
        execute: ({ id, ...patch }) => applications.update(id, patch),
      }),
      application_delete: tool({
        description: "删除投递。删前先和用户确认。",
        inputSchema: z.object({ id: z.string() }),
        execute: ({ id }) => {
          applications.remove(id);
          return "已删除。";
        },
      }),
      pipeline_list: tool({
        description: "查看这个工作区的状态流水线（有序阶段 + 终态标记）。推进状态前先查这里。",
        inputSchema: z.object({}),
        execute: () => pipeline.get(),
      }),
    };
  }

  /* —————— job:<jobId> 岗位二级工作台：工具全部锁定该岗位 —————— */

  private jobWorkbenchTools(jobId: string): ToolSet {
    const { resumes, jobs, companies } = this.deps;

    return {
      job_info: tool({
        description: "查看当前岗位的档案（标题 / 薪资 / JD 原文 / 匹配度报告）与公司名。",
        inputSchema: z.object({}),
        execute: () => {
          const job = jobs.get(jobId);
          if (job === null) throw new Error(`岗位不存在：${jobId}（可能已被删除）`);
          const company = job.companyId === null ? null : companies.get(job.companyId);
          return { ...job, companyName: company?.name ?? null };
        },
      }),
      resume_read: tool({
        description: "读取当前主简历 resume.md 的完整内容（定制稿的底稿）。",
        inputSchema: z.object({}),
        execute: () => resumes.read({ kind: "main" })?.content ?? "",
      }),
      job_tailored_read: tool({
        description: "读取当前岗位的定制简历；还没有定制稿时返回空字符串。",
        inputSchema: z.object({}),
        execute: () => resumes.readTailored(jobId) ?? "",
      }),
      job_tailored_write: tool({
        description: "整体覆写当前岗位的定制简历（写入前系统自动快照旧版）。必须写完整 Markdown。",
        inputSchema: z.object({ content: z.string() }),
        execute: ({ content }) => {
          resumes.writeTailored(jobId, content);
          return "已写入定制简历。";
        },
      }),
      job_script_read: tool({
        description: "读取当前岗位的面试话术；还没有时返回空字符串。",
        inputSchema: z.object({}),
        execute: () => resumes.readScript(jobId)?.content ?? "",
      }),
      job_script_write: tool({
        description:
          "写入当前岗位的面试话术（整体覆写，旧版自动快照）。结构：自我介绍 / 项目深挖 / 反问环节。",
        inputSchema: z.object({ content: z.string() }),
        execute: ({ content }) => {
          resumes.writeScript(jobId, content);
          return "已写入话术。";
        },
      }),
      job_script_finalize: tool({
        description:
          "把当前岗位的话术标记定稿（锁定供引用的版本；之后仍可继续编辑，改过会提示重新定稿）。",
        inputSchema: z.object({}),
        execute: () => {
          const doc = resumes.finalizeScript(jobId);
          return `已定稿（${doc.finalizedAt ?? ""}）。`;
        },
      }),
    };
  }

  /* —————— interview:<id> 模拟面试：材料只读 + 面试记录的两个写入口 —————— */

  /**
   * 面试会话的工具集：材料（主简历 / 该岗位定制稿 / 话术 / JD）全部只读，
   * 简历、定制稿、话术、岗位数据的写工具一律不给；唯一的写入口是面试记录
   * 本身（轮次落账与总评收束），且都锁在当前面试 id 上。
   */
  private interviewSessionTools(interviewId: string): ToolSet {
    const { resumes, jobs, companies, interviews } = this.deps;

    const mustInterview = () => {
      const interview = interviews.get(interviewId);
      if (interview === null) throw new Error("这条面试记录已被删除。");
      return interview;
    };

    return {
      job_info: tool({
        description: "查看当前面试岗位的档案（标题 / 薪资 / JD 原文 / 匹配度报告）与公司名。",
        inputSchema: z.object({}),
        execute: () => {
          const interview = mustInterview();
          const job = jobs.get(interview.jobId);
          if (job === null) throw new Error(`岗位不存在：${interview.jobId}（可能已被删除）`);
          const company = job.companyId === null ? null : companies.get(job.companyId);
          return { ...job, companyName: company?.name ?? null };
        },
      }),
      resume_read: tool({
        description: "读取主简历 resume.md 的完整内容（定制稿的底稿，面试口径以定制稿为准）。",
        inputSchema: z.object({}),
        execute: () => resumes.read({ kind: "main" })?.content ?? "",
      }),
      job_tailored_read: tool({
        description: "读取当前岗位的定制简历（面试提问的主要口径）；缺失时返回空字符串。",
        inputSchema: z.object({}),
        execute: () => {
          const interview = mustInterview();
          return resumes.readTailored(interview.jobId) ?? "";
        },
      }),
      job_script_read: tool({
        description: "读取当前岗位的面试话术（候选人准备过的答案，追问时用来验证深度）；缺失时返回空字符串。",
        inputSchema: z.object({}),
        execute: () => {
          const interview = mustInterview();
          return resumes.readScript(interview.jobId)?.content ?? "";
        },
      }),
      interview_round_log: tool({
        description:
          "记录已完成的一轮面试（每轮收束后必须调用，没有记录不算完成一轮）。question=本轮主问题；followUps=追问列表（0~2 条）；answer=候选人回答要点。同一轮补记（主问题相同）会整体覆盖。",
        inputSchema: z.object({
          question: z.string(),
          followUps: z.array(z.string()).max(4).optional(),
          answer: z.string().optional(),
        }),
        execute: ({ question, followUps, answer }) => {
          const next = interviews.logRound(interviewId, { question, followUps, answer });
          return `已记录第 ${next.rounds.length} 轮（设定 ${next.config.rounds} 轮）。`;
        },
      }),
      interview_submit_review: tool({
        description:
          "收束面试并保存总评：score=总评分(0-100)；overall=Markdown 总评正文（表达/深度/结构/岗位匹配四维 + 逐轮一句话小结）；strengths=亮点；weaknesses=风险与不足；suggestions=逐条可执行的改进建议；roundNotes=按轮对齐的表现小结。保存后在回复里给用户完整总评。",
        inputSchema: z.object({
          score: z.number().min(0).max(100),
          overall: z.string(),
          strengths: z.array(z.string()).optional(),
          weaknesses: z.array(z.string()).optional(),
          suggestions: z.array(z.string()).optional(),
          roundNotes: z.array(z.string()).optional(),
        }),
        execute: ({ score, overall, strengths, weaknesses, suggestions, roundNotes }) => {
          interviews.finish(
            interviewId,
            {
              score,
              overall,
              strengths: strengths ?? [],
              weaknesses: weaknesses ?? [],
              suggestions: suggestions ?? [],
            },
            roundNotes,
          );
          return "总评已保存，面试已结束。请在回复里把总评完整讲给用户。";
        },
      }),
    };
  }
}

/** 岗位摘要（job_list 与 resume 会话共用）：带公司名与匹配度，不带 JD 全文。 */
function jobSummaries(deps: AgentDeps) {
  return deps.jobs.list().map((job) => ({
    id: job.id,
    title: job.title,
    companyId: job.companyId,
    companyName: job.companyId === null ? null : deps.companies.get(job.companyId)?.name ?? null,
    salaryBand: job.salaryBand,
    matchScore: job.matchReport?.score ?? null,
    matchEvaluatedAt: job.matchReport?.evaluatedAt ?? null,
    updatedAt: job.updatedAt,
  }));
}

/** 日报 / 周报的模型指令：汇总要如实、必须走 notify 工具发出。 */
function digestInstructions(label: string): string {
  return `你是 GoodJob 的求职进展汇总助手。请基于用户给定的数据快照，写一段简短的求职${label}并调用 notify 工具发到用户的邮箱。

要求：
- 汇总岗位与匹配度、投递与状态推进、公司调研、简历与定制稿的当前情况；周报可以分小节，日报一气呵成。
- 没有内容的部分如实说「还没有记录」，不要编造、不要客套凑数；快照全空时如实说明这个工作区还没有任何记录，然后照常调用 notify 发出。
- 正文 300 字以内（Markdown），结尾基于真实数据给 1-2 条下一步建议。
- 写完必须调用 notify 工具发送；notify 报错就把错误如实转告（没有 UI，这个错误是最终结果）。`;
}

/** P2 实体的当前快照：日报 / 周报的全部素材（无内容 → 空数组，模型如实说）。 */
function digestSnapshot(deps: AgentDeps): string {
  const resumes = deps.resumes.list();
  const companies = deps.companies.list().map((company) => ({
    name: company.name,
    industry: company.industry,
    city: company.city,
    researched: company.research.trim() !== "",
    updatedAt: company.updatedAt,
  }));
  const jobs = deps.jobs.list().map((job) => ({
    title: job.title,
    companyName: job.companyId === null ? null : deps.companies.get(job.companyId)?.name ?? null,
    salaryBand: job.salaryBand,
    matchScore: job.matchReport?.score ?? null,
    updatedAt: job.updatedAt,
  }));
  const applications = deps.applications.list().map((application) => {
    const job = application.jobId === null ? null : deps.jobs.get(application.jobId);
    const latest = application.timeline.at(-1) ?? null;
    return {
      jobTitle: job?.title ?? null,
      stage: latest?.stage ?? null,
      at: latest?.at ?? null,
      hasOffer: application.offer !== null,
      updatedAt: application.updatedAt,
    };
  });
  return [
    `数据快照（${new Date().toISOString()}）：`,
    JSON.stringify(
      {
        resumes: {
          count: resumes.items.length,
          current: resumes.items.find((item) => item.id === resumes.currentId)?.name ?? null,
          tailoredCount: deps.resumes.listTailoredNames().length,
        },
        companies,
        jobs,
        applications,
      },
      null,
      2,
    ),
  ].join("\n");
}

/** 指令按会话 key 分发：三个领域模块 + 简历 + 岗位二级工作台。 */
function moduleInstructions(key: ConversationKey): string {
  const jobKey = jobKeyTarget(key);
  if (jobKey !== null) return JOB_WORKBENCH_INSTRUCTIONS;
  switch (key) {
    case "companies":
      return COMPANIES_INSTRUCTIONS;
    case "jobs":
      return JOBS_INSTRUCTIONS;
    case "applications":
      return APPLICATIONS_INSTRUCTIONS;
    default:
      return RESUME_INSTRUCTIONS;
  }
}

const RESUME_INSTRUCTIONS = `你是 GoodJob 的简历协作 Agent，和用户共同维护一份 Markdown 主简历。

工作方式：
- 主简历就是 resume.md，用 resume_read 读取、resume_write 整体覆写（写入前系统会自动快照，不必担心丢内容）。
- 用户在右侧编辑器里和你共编同一份文件，你的写入会实时出现在编辑器里，他手动保存的修改也会在你下次读取时生效。所以：每次修改前先读最新内容。
- 每次写入必须是完整文件内容，不要只写改动片段；大改前用一两句话说明你打算怎么改。
- resume.md 的格式规则（渲染器只认这些语法，外观由主题决定，不要在正文里写样式）：
${RESUME_FORMAT}
- 岗位定制简历：与岗位 1:1，文件名就是岗位的 jobId（用 job_list 把用户说的岗位对应到 id）。先读主简历，针对 JD 取舍改写，用 resume_tailored_write 按 jobId 存；遇到 P1 旧版按岗位名存的文件，读取后用 migrateFrom 一次性迁移成 jobId 键。改完说明你做了哪些取舍。
- 面试话术也按 jobId 存（script_write / script_finalize）：结构按「自我介绍 / 项目深挖（预判 JD 相关的问题给要点式回答）/ 反问环节」组织；定稿锁定的是供引用的版本，之后仍可继续改。
- 评分技能是后台任务：resume_job_evaluate（JD 匹配度）与 resume_integrity_check（主简历完整性）发起后不用等待，结果分别写进岗位的匹配度报告和简历的 reports/ 目录，告诉用户去哪看即可。
- 用户上传的旧简历和参考文件都存放在当前简历文件夹的 upload/ 里（对话里只会提到文件名，不会有全文）。需要内容时用 upload_list 查看、upload_read 读取（PDF / Word 会自动抽成纯文本），再把旧简历整理成上面的版式写入 resume.md；信息缺失的地方留空并提醒用户补，不要编造。

回复用简体中文。不确定的经历细节先问用户，宁缺毋滥。`;

const COMPANIES_INSTRUCTIONS = `你是 GoodJob 的公司档案助手，帮用户维护求职的公司库（公司页表格背后的数据）。

工作方式：
- company_list 查全部公司（id 是唯一键），company_get 看完整档案（含调研快照）。
- 新公司用 company_create（名称必填）；改资料或写调研结论用 company_update，只传要改的字段。
- 调研快照 research 是 Markdown：把公开信息（业务、产品、规模、融资、面试评价等）整理成要点写进去，标注来源与时间；查不到的直说「待核实」，不要编造。
- company_delete 不级联：引用它的岗位会变成悬空引用，删除前先和用户确认。

浏览器调研（设置 → 浏览器里启用后可用）：
- browser_read 打开公司官网 / 公开页，snapshot 后提炼要点，用 company_update 写进 research（标注来源 URL 与时间）。调研是只读的：不点登录、不提交任何表单、不点「投递 / 沟通 / 收藏」这类改变平台状态的按钮。
- 坑清单：先 snapshot 拿到 @ref 再动作；元素在视口外时先 scrollintoview 再重新 snapshot（ref 可能变）；open 导航之后旧 ref 全部失效，必须重新 snapshot；一次只做一步，看完结果再决定下一步。
- 页面要求登录 / 验证码 / 人机校验时立即停下，把情况告诉用户，交回人工。
- 用户在这个会话里上传的参考资料落在本模块的 upload/ 目录（对话里只出现文件名）：upload_list 看清单、upload_read 读正文（PDF / Word 自动抽纯文本）。原文没说的信息不要替用户编造。

回复用简体中文。`;

const JOBS_INSTRUCTIONS = `你是 GoodJob 的岗位档案助手，帮用户维护岗位库；岗位表是整个求职流程的操作枢纽。

工作方式：
- job_list 查全部岗位，job_get 看完整 JD 与匹配度报告。
- 新岗位用 job_create（标题必填；companyId 必须来自 company_list 的真实 id，公司不存在就先建公司）。
- 用户粘贴的 JD 整理成 Markdown 存进 jd 字段：保留要求的原文表述，不要只存摘要；顺手补 url / salaryBand。
- 匹配度报告（matchReport）由「简历评估」后台任务写入，不要尝试手改；用户要评估时让他去岗位表点「简历评估」。
- job_delete 不级联：该岗位的定制简历、话术、投递记录会保留为悬空引用，删除前先和用户确认。

浏览器抓取（设置 → 浏览器里启用后可用）：
- 抓 JD：browser_read open 岗位链接 → snapshot（JD 长就分段 scroll + snapshot）→ 整理成 Markdown，用 job_update 存进 jd，补上来源 url。抓取是只读的：不点投递 / 沟通 / 收藏，不提交任何表单。
- 自动搜索：在招聘站按用户给的条件搜索（填搜索框 / 点搜索是读的过程），snapshot 结果列表回填候选岗位（job_create）；每个候选标注来源 URL。只读列表页，绝不点进投递流程。
- 坑清单：先 snapshot 拿到 @ref 再动作；元素在视口外先 scrollintoview 再重新 snapshot（ref 可能变）；open 导航后旧 ref 全部失效，必须重新 snapshot；一次一步，看完结果再动。
- 结果去重：job_list 里已有的岗位不要重复建档；页面要求登录 / 验证码时立即停下交回用户。
- 用户在这个会话里上传的参考资料落在本模块的 upload/ 目录（对话里只出现文件名）：upload_list 看清单、upload_read 读正文（PDF / Word 自动抽纯文本）。原文没说的信息不要替用户编造。

回复用简体中文。`;

const APPLICATIONS_INSTRUCTIONS = `你是 GoodJob 的投递管理助手，帮用户记录和推进投递状态。

工作方式：
- application_list 查全部投递（含状态时间线与 Offer 字段）；pipeline_list 查这个工作区的状态流水线（有序阶段 + 终态）。
- 新投递用 application_create（jobId 必须来自 job_list 的真实 id）。
- 状态推进用 application_advance：stage 必须是流水线里的名字（先查 pipeline_list），时间自动取当前时刻，note 写渠道 / 面试官 / 结果等上下文。只顺流推进，不改写历史条目；阶段不够用（比如「四面」）让用户在设置里加，不要自造。
- 补 Offer 信息（salary / equity / note）或修正备注用 application_update。
- application_delete 前先和用户确认；删除不级联。
- 通知工具（要先在设置 → 通知里配好邮箱）：notify 把一段摘要发到用户自己的邮箱，发出前会弹界面审批，等用户批准；用户不在场、明确说稍后再确认时用 request_confirmation 走邮件确认门——它返回 "approved" 才继续，返回 "timeout" 就取消，不要重试、不要换别的方式执行。

浏览器填表投递（设置 → 浏览器里启用后可用，M4 通用循环）：
- 流程：browser_read open 岗位页 → snapshot 找到入口 → browser_act 逐步填表（每步都弹界面审批）→ 在回复里展示「将要提交的内容摘要」（填了什么、提交到哪、用哪份简历口径）→ 用户确认后才调 browser_submit。
- browser_submit 双重门：默认 mode="interactive" 走界面审批；只有用户明确说会离开、或已 10 分钟没有操作才允许 mode="offline" 走邮件确认门，返回超时就取消并告诉用户没有提交。提交受单站每日上限与最小间隔限速，被限速就如实转告，不要绕路。
- 提交后立刻 snapshot 确认结果（成功页 / 报错），失败就停下说明，不要盲目重试。遇到验证码 / 扫码 / 人机校验立即停下交回用户。
- 各平台的适配口径（入口、字段、禁忌）以「投递平台适配指令」一节为准；模板没写的平台按通用规则保守执行，拿不准的先问用户。
- 坑清单：先 snapshot 拿到 @ref 再动作；元素在视口外先 scrollintoview 再重新 snapshot（ref 可能变）；open 导航后旧 ref 全部失效，必须重新 snapshot。
- 用户在这个会话里上传的参考资料落在本模块的 upload/ 目录（对话里只出现文件名）：upload_list 看清单、upload_read 读正文（PDF / Word 自动抽纯文本）。原文没说的信息不要替用户编造。

回复用简体中文。不确定的状态先问用户，宁缺毋滥。`;

const JOB_WORKBENCH_INSTRUCTIONS = `你是 GoodJob 的岗位定制简历协作 Agent，正在为某一个岗位工作（本会话的工具都锁定在这个岗位上）。

工作方式：
- 动手前先用 job_info 看岗位 JD 与匹配度报告，用 resume_read 看主简历；已有定制稿时用 job_tailored_read 看当前版。
- 定制简历与岗位 1:1：用 job_tailored_write 整体覆写（写入前系统自动快照旧版），必须写完整 Markdown，不要只写改动片段。
- 定制稿与主简历使用同一套格式规则：
${RESUME_FORMAT}
- 针对 JD 取舍：最匹配的经历放前面、成果量化、技能表述贴近 JD 关键词；JD 没要求的内容果断砍，不编造经历。
- 面试话术也属于这个岗位：job_script_read / job_script_write（Markdown，结构按「自我介绍 / 项目深挖 / 反问环节」），定稿用 job_script_finalize——锁定的是供引用的版本，之后仍可继续编辑，改过会提示重新定稿。
- 重新评估匹配度：让用户在岗位表点「简历评估」（后台任务会读你写好的定制稿），本会话没有评估工具。
- 用户在这个会话里上传的参考资料落在该岗位的 upload/ 目录（对话里只出现文件名）：upload_list 看清单、upload_read 读正文（PDF / Word 自动抽纯文本）。原文没说的信息不要替用户编造。

回复用简体中文。不确定的经历细节先问用户，宁缺毋滥。`;

const INTERVIEW_PERSONA = `你是 GoodJob 的模拟面试官，正在对候选人做一场一对一的模拟面试。这是一场认真的练习：你的提问口径必须贴着这个岗位的 JD 与为它定制的简历，像真实面试官一样考察候选人。

开场：先用 job_info 读 JD，用 job_tailored_read 读定制简历（需要时 resume_read 看主简历、job_script_read 看候选人准备的话术），然后直接开始第 1 轮提问。不要寒暄，不要复述材料，不要解释你要考什么。

每一轮的规则（追问式面试）：
- 一轮 = 1 个主问题 + 0~2 个追问。主问题围绕一个考察点（JD 的关键要求，或定制简历里最相关的经历）。
- 候选人回答后必须追问至少一层：挖细节、要证据、追问边界与取舍。追问要贴着他上一句回答走。
- 一次回复只做一件事：提问、追问或收束。不要一次把问题排山倒海问完，也不要替候选人总结答案。
- 问题要具体到候选人的经历（引用定制简历里的项目与成果），不问放之四海皆准的八股题；候选人答不上来就换角度问一次，然后放过，记下来留到总评里说。

轮次与记录（硬性要求）：
- 候选人每答完一轮（含追问收束），立即调用 interview_round_log 落账本轮：question=主问题，followUps=追问列表，answer=候选人回答要点。没有落账不算完成一轮。
- 记满设定轮次、且候选人没有继续追问的意愿时：收束面试（明确说面试结束），调用 interview_submit_review 出总评。
- 候选人明确要求提前结束时：立即调用 interview_submit_review 出总评，不用等轮次记满。
- 总评里 overall 用 Markdown 写：表达 / 深度 / 结构 / 岗位匹配四个维度各给 0-100 分与两三句评语，再按轮给一句话小结；strengths 写亮点；weaknesses 写风险与不足；suggestions 写逐条可执行的改进建议（每条一个具体动作：改简历的哪一处、下次怎么答）；roundNotes 按已记录轮次顺序各给一句话表现小结。

面试官口吻：专业、克制、有压迫感但不刻薄；总评之外只提问和追问，不做答题辅导、不剧透考察点。回复用简体中文。`;
async function summarize(
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

/**
 * token 估算：CJK 逐字按 1 token，其余按 3.5 字符 1 token。
 * 宁可估高一点：估高只是早一点压缩，估低会把请求顶到供应商的上下文上限而报错。
 */
function estimateTokens(text: string): number {
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
function measureMessages(messages: WireMessage[]): {
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
function chooseCutoff(messages: WireMessage[], keepTokens: number): number {
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
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("已取消（用户停止了本次运行或中止了浏览器任务）。"));
    };
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "调用模型失败（未知错误）";
}

/** baseURL 进日志前去掉 userinfo / query：有些中转服务会把 Key 拼在 URL 里。 */
function sanitizeBaseURL(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "(无法解析的 baseURL)";
  }
}
