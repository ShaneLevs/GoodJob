import { randomBytes } from "node:crypto";

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import imapflow from "imapflow";
import type { ImapFlow } from "imapflow";

import type {
  DigestKind,
  NotifyTestRequest,
  NotifyTestResult,
} from "@shared/types";

import type { NotifyStore } from "../stores/notify";
import type { ResolvedMailAccount } from "../stores/notify";
import { renderNotificationEmail, type NotificationKind } from "./email-template";

/**
 * NotifyService（P3 M3，ARCHITECTURE §6）：
 *
 * - 发送 = nodemailer（SMTP）；回信监控 = imapflow（连接空闲时自动进 IMAP IDLE，
 *   新邮件触发 `exists` 事件）；调度 = main 内分钟级 tick，不引 cron 依赖。
 * - 确认门状态机：`sent`（唯一 token 写进 Message-ID 与 Subject）→ waiting ≤10min →
 *   没回信发提醒（`reminded`）再等一轮 → 仍无回信 ⇒ `timeout`；任何时刻收到匹配
 *   回信（In-Reply-To / References / Subject 含 token，内容不限）⇒ `approved`。
 *   超时 = 未放行，由调用方（模型）走取消分支。
 * - 对模型的接口只有两个工具：`notify(summary)` 与 `requestConfirmation(subject, body)`
 *   → `"approved" | "timeout"`，都实现为长时 async 且可 abort（确认门挂 10 分钟级，
 *   用户随时可以停止整个 run）。
 * - 日报 / 周报：tick 到点发起一次 Agent 运行（AgentRuntime.runDigest，经
 *   setDigestRunner 注入避免循环依赖），由模型汇总 P2 实体数据后调 notify 工具发出；
 *   无内容时如实说。到点即记账（一天 / 一周最多自动发一次），失败靠设置里的手动
 *   触发补发。
 *
 * 密码纪律：明文只在方法参数与请求头里瞬时存在，绝不 console.log、绝不写盘。
 */

/** tick 周期：分钟级足够——确认门以 10 分钟计，日报按 HH:mm 触发。 */
const TICK_MS = 60_000;
/** 确认门单窗口：等待回信的最长时间，超时发提醒（第二轮）或判超时。 */
const CONFIRM_WINDOW_MS = 10 * 60_000;
/** 回信匹配时往前多看一点，容忍服务器 INTERNALDATE 与本地时钟的偏差。 */
const REPLY_SINCE_SLACK_MS = 5 * 60_000;

/** 确认门的结果：approved = 放行；timeout = 未放行。 */
export type ConfirmationOutcome = "approved" | "timeout";

/** 发送抽象：默认 nodemailer，smoke 测试注入假实现（真邮箱联调需要凭据）。 */
export interface NotifyMailer {
  sendMail(options: {
    to: string;
    from?: string;
    /** 回信地址：确认门靠它把回复收回被监控的邮箱。 */
    replyTo?: string;
    subject: string;
    text: string;
    /** 可选 HTML 版本；纯文本始终保留给不渲染 HTML 的客户端。 */
    html?: string;
    messageId?: string;
  }): Promise<{ messageId: string }>;
}

/** 回信条目的最小视图（来自 IMAP envelope + 头部，或测试注入）。 */
export interface IncomingMail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  subject: string | null;
}

export interface NotifyDeps {
  store: NotifyStore;
  /** 可注入时钟，smoke 测试推进确认门窗口用。 */
  now?: () => number;
  /** 可注入发信通道，smoke 测试用假 mailer 替代 nodemailer（不碰真网络）。 */
  mailer?: NotifyMailer;
  /** 日报 / 周报到点时的 Agent 运行入口（index.ts 注入 AgentRuntime.runDigest）。 */
  runDigest?: (kind: DigestKind) => Promise<void>;
}

interface PendingGate {
  token: string;
  /** 我们发出的邮件 Message-ID（含 token）集合：原始邮件 + 提醒邮件。 */
  messageIds: string[];
  to: string;
  subject: string;
  body: string;
  sentAtMs: number;
  stage: "sent" | "reminded";
  remindedAtMs: number | null;
  resolve: (outcome: ConfirmationOutcome) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

export class NotifyService {
  private readonly store: NotifyStore;
  private readonly now: () => number;
  private readonly externalMailer: NotifyMailer | null;
  private runDigest: ((kind: DigestKind) => Promise<void>) | null;
  private ticker: NodeJS.Timeout | null = null;
  private ticking = false;

  private readonly gates = new Map<string, PendingGate>();
  private mailer: Transporter | null = null;
  private mailerKey: string | null = null;

  private imapClient: ImapFlow | null = null;
  private checkingReplies = false;

  constructor(deps: NotifyDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.externalMailer = deps.mailer ?? null;
    this.runDigest = deps.runDigest ?? null;
  }

  /** 日报 / 周报的 Agent 运行入口（index.ts 在 AgentRuntime 建好后注入）。 */
  setDigestRunner(run: (kind: DigestKind) => Promise<void>): void {
    this.runDigest = run;
  }

  start(): void {
    if (this.ticker !== null) return;
    this.ticker = setInterval(() => {
      void this.tick();
    }, TICK_MS);
  }

  /** 应用退出 / 切换工作区：停调度、断 IMAP、所有等待中的确认门按取消处理。 */
  stopAll(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    this.closeImap();
    for (const gate of this.gates.values()) {
      gate.reject(new Error("通知服务已停止（应用退出或切换工作区）。"));
    }
    this.gates.clear();
  }

  // ———————————————————— 模型工具的两个入口 ————————————————————

  /**
   * notify 工具：把一段摘要发到用户配置的接收邮箱（未填时回退到已配置账户）。
   * 会话里调用时走 toolApproval 界面审批（在场审批）；日报 / 周报是用户排期过的
   * 固定动作，后台运行不再二次审批。
   */
  async sendNotification(
    summary: string,
    signal?: AbortSignal,
    kind: NotificationKind = "notice",
  ): Promise<string> {
    if (signal?.aborted) throw new Error("已取消。");
    const smtp = this.mustSmtp();
    const to = this.recipient();
    const mailer = await this.mailerFor(smtp);
    const rendered = renderNotificationEmail({
      markdown: summary,
      kind,
      date: localDate(this.now()),
    });
    const info = await mailer.sendMail({
      to,
      from: this.senderHeader(),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    return `已发送到 ${to}（Message-ID ${info.messageId}）。`;
  }

  /**
   * requestConfirmation 工具：发一封带唯一 token 的确认邮件并等待回信。
   * 长时 async：挂起 ≤20 分钟（两个窗口），abort 随时能取消；任何回信内容都算放行。
   */
  async requestConfirmation(
    subject: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<ConfirmationOutcome> {
    if (signal?.aborted) throw new Error("已取消。");
    const smtp = this.mustSmtp();
    const imap = this.store.resolveImap();
    if (imap === null || imap.host === "") {
      throw new Error(
        "邮箱确认门还需要 IMAP 收信配置（要靠它收回信）。请到设置 → 通知里补上 IMAP。",
      );
    }
    const to = this.recipient();
    const token = randomBytes(6).toString("hex").toUpperCase();
    const messageId = `<gj-confirm-${token.toLowerCase()}@goodjob.local>`;
    const subjectWithToken = `${subject.trim()}【确认码 ${token}】`;
    const text = [
      body.trim(),
      "",
      "——",
      `这是一封确认邮件：直接回复本邮件（内容随意）即代表同意上面的操作。`,
      `确认码：${token}`,
      `${CONFIRM_WINDOW_MS / 60_000} 分钟内未回复会提醒一次，再等 ${CONFIRM_WINDOW_MS / 60_000} 分钟未回复则按取消处理。`,
    ].join("\n");

    const mailer = await this.mailerFor(smtp);
    await mailer.sendMail({
      to,
      from: this.senderHeader(),
      // 显示地址可以和发信账户不同；回信必须回到 IMAP 监控的那个邮箱。
      replyTo: smtp.user === "" ? undefined : smtp.user,
      subject: subjectWithToken,
      text,
      messageId,
    });
    const sentMessageId = messageId;

    return await new Promise<ConfirmationOutcome>((resolve, reject) => {
      const gate: PendingGate = {
        token,
        messageIds: [sentMessageId],
        to,
        subject: subjectWithToken,
        body,
        sentAtMs: this.now(),
        stage: "sent",
        remindedAtMs: null,
        resolve: (outcome) => {
          gate.settled = true;
          this.gates.delete(token);
          if (this.gates.size === 0) this.closeImap();
          resolve(outcome);
        },
        reject: (error) => {
          gate.settled = true;
          this.gates.delete(token);
          reject(error);
        },
        settled: false,
      };
      this.gates.set(token, gate);

      if (signal !== undefined) {
        signal.addEventListener(
          "abort",
          () => {
            if (gate.settled) return;
            gate.reject(new Error("已取消（用户停止了本次运行）。"));
            // 取消后若已无等待中的门，收掉 IMAP 长连接。
            if (this.gates.size === 0) this.closeImap();
          },
          { once: true },
        );
      }

      // 门挂起来了：立即接上 IMAP 监控；失败不堵住状态机——tick 里的兜底轮询会重试。
      void this.ensureImap().catch((cause: unknown) => {
        console.error("[notify] IMAP monitor failed:", describeError(cause));
      });
    });
  }

  // ———————————————————— 分钟级 tick ————————————————————

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.advanceGates();
      await this.checkReplies();
      await this.digestTick();
      if (this.gates.size === 0) this.closeImap();
    } catch (cause) {
      // 调度永远不抛：一次失败下个 tick 再来。
      console.error("[notify] tick failed:", describeError(cause));
    } finally {
      this.ticking = false;
    }
  }

  /** 确认门的窗口推进：10 分钟无回信 → 提醒；提醒后再等 10 分钟无回信 → 超时。 */
  private advanceGates(): void {
    const nowMs = this.now();
    for (const gate of [...this.gates.values()]) {
      if (gate.settled) continue;
      if (gate.stage === "sent" && nowMs - gate.sentAtMs >= CONFIRM_WINDOW_MS) {
        void this.sendReminder(gate);
      } else if (
        gate.stage === "reminded" &&
        gate.remindedAtMs !== null &&
        nowMs - gate.remindedAtMs >= CONFIRM_WINDOW_MS
      ) {
        gate.resolve("timeout");
      }
    }
  }

  private async sendReminder(gate: PendingGate): Promise<void> {
    try {
      const smtp = this.mustSmtp();
      const mailer = await this.mailerFor(smtp);
      const reminderId = `<gj-confirm-${gate.token.toLowerCase()}-r2@goodjob.local>`;
      await mailer.sendMail({
        to: gate.to,
        from: this.senderHeader(),
        replyTo: smtp.user === "" ? undefined : smtp.user,
        subject: `【提醒】${gate.subject}`,
        text: [gate.body.trim(), "", "——", "刚才的确认还没有收到回复：直接回复本邮件（内容随意）即代表同意。", `确认码：${gate.token}`].join("\n"),
        messageId: reminderId,
      });
      gate.messageIds.push(reminderId);
      gate.stage = "reminded";
      gate.remindedAtMs = this.now();
    } catch (cause) {
      // 提醒发不出去不再堵状态机：按窗口继续计时，到点照常判超时。
      console.error("[notify] reminder failed:", describeError(cause));
      gate.stage = "reminded";
      gate.remindedAtMs = this.now();
    }
  }

  // ———————————————————— 日报 / 周报调度 ————————————————————

  private async digestTick(): Promise<void> {
    const { digest } = this.store.toPublic();
    const nowMs = this.now();
    const today = localDate(nowMs);
    for (const kind of ["daily", "weekly"] as const) {
      const schedule = digest[kind];
      if (!schedule.enabled) continue;
      if (this.store.digestLastRun(kind) === today) continue;
      if (!isDigestDue(schedule, kind, nowMs)) continue;
      // 到点即记账：自动调度一天最多一次，失败用设置里的手动触发补发。
      this.store.markDigestRun(kind, today);
      if (this.runDigest === null) continue;
      try {
        await this.runDigest(kind);
      } catch (cause) {
        console.error(`[notify] ${kind} digest failed:`, describeError(cause));
      }
    }
  }

  // ———————————————————— IMAP 回信监控 ————————————————————

  /**
   * 确认门等待期间维护一条 IMAP 长连接：imapflow 在连接空闲时自动进 IDLE，
   * 新邮件到达触发 `exists` 事件 → 立即检查回信；tick 里再兜底轮询一次
   * （各家服务器 IDLE 行为不一，见 ARCHITECTURE §9）。
   */
  private async ensureImap(): Promise<ImapFlow> {
    if (this.imapClient !== null) return this.imapClient;
    const imap = this.store.resolveImap();
    if (imap === null || imap.host === "") {
      throw new Error("还没有配置 IMAP 收信邮箱。请到设置 → 通知里补上。");
    }
    const client = new imapflow.ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: imap.password === null ? undefined : { user: imap.user, pass: imap.password },
      logger: false,
    });
    client.on("exists", () => {
      void this.checkReplies();
    });
    client.on("close", () => {
      if (this.imapClient === client) this.imapClient = null;
    });
    client.on("error", (cause: unknown) => {
      // IDLE 长连接的瞬断在这里冒出来：记日志即可，'close' 会把客户端清掉，
      // 下次 tick 需要时重建。
      console.error("[notify] IMAP connection error:", describeError(cause));
    });
    await client.connect();
    await client.mailboxOpen("INBOX");
    this.imapClient = client;
    return client;
  }

  private closeImap(): void {
    const client = this.imapClient;
    this.imapClient = null;
    if (client === null) return;
    // logout 会顺手结束 IDLE；连接早断了也没关系，close 兜底。
    void client.logout().catch(() => client.close());
  }

  /** 拉取确认邮件之后的新邮件，按 token 匹配；任何内容都算放行。 */
  private async checkReplies(): Promise<void> {
    if (this.gates.size === 0 || this.checkingReplies) return;
    const client = this.imapClient;
    if (client === null) return;
    this.checkingReplies = true;
    try {
      const earliest = Math.min(...[...this.gates.values()].map((gate) => gate.sentAtMs));
      const since = new Date(earliest - REPLY_SINCE_SLACK_MS);
      const seen: IncomingMail[] = [];
      for await (const message of client.fetch({ since }, { envelope: true, headers: true })) {
        const headerText = message.headers?.toString("utf8") ?? "";
        seen.push({
          messageId: message.envelope?.messageId ?? null,
          inReplyTo: message.envelope?.inReplyTo ?? headerValue(headerText, "in-reply-to"),
          references: headerValue(headerText, "references"),
          subject: message.envelope?.subject ?? headerValue(headerText, "subject"),
        });
      }
      for (const mail of seen) this.matchReplies(mail);
    } catch (cause) {
      console.error("[notify] reply check failed:", describeError(cause));
      // 连接已坏就收掉，下个 tick 重建。
      if (this.imapClient !== null && this.imapClient.usable !== true) this.closeImap();
    } finally {
      this.checkingReplies = false;
    }
  }

  /** 一封回信命中任一等待中的门（token / In-Reply-To / References）即放行。 */
  private matchReplies(mail: IncomingMail): void {
    // 收件人就是用户自己的邮箱，我们发出的确认邮件会先落进 INBOX——
    // 它们自带我们的 Message-ID，必须先排除，不能把「寄出的原信」当成「回信」。
    const ownMessageId = (mail.messageId ?? "").trim().toLowerCase();
    if (ownMessageId !== "") {
      const ours = [...this.gates.values()].some((gate) =>
        gate.messageIds.some((id) => id.toLowerCase() === ownMessageId),
      );
      if (ours) return;
    }
    const haystack = [
      mail.messageId ?? "",
      mail.inReplyTo ?? "",
      mail.references ?? "",
      mail.subject ?? "",
    ]
      .join("\n")
      .toLowerCase();
    if (haystack.trim() === "") return;
    for (const gate of [...this.gates.values()]) {
      if (gate.settled) continue;
      const hit =
        haystack.includes(gate.token.toLowerCase()) ||
        gate.messageIds.some((id) => id !== "" && haystack.includes(id.toLowerCase()));
      if (hit) gate.resolve("approved");
    }
  }

  // ———————————————————— 连接测试（设置页） ————————————————————

  async testConnection(request: NotifyTestRequest): Promise<NotifyTestResult> {
    const account = this.store.resolveTestAccount(request.kind, request.account);
    if (account === null) {
      return { ok: false, message: "还没有填服务器地址。" };
    }
    try {
      if (request.kind === "smtp") {
        const transporter = createTransport(account);
        await transporter.verify();
        void transporter.close();
        return {
          ok: true,
          message: `SMTP 连接成功（${account.host}:${account.port}，${account.secure ? "TLS" : "STARTTLS"}）。`,
        };
      }
      const client = new imapflow.ImapFlow({
        host: account.host,
        port: account.port,
        secure: account.secure,
        auth: account.password === null ? undefined : { user: account.user, pass: account.password },
        logger: false,
        // verifyOnly：认证成功后自动登出，专为连通性测试准备。
        verifyOnly: true,
      });
      await client.connect();
      return {
        ok: true,
        message: `IMAP 连接成功（${account.host}:${account.port}），IDLE 回信监控可用。`,
      };
    } catch (cause) {
      return { ok: false, message: describeError(cause) };
    }
  }

  // ———————————————————— 内部 ————————————————————

  private mustSmtp(): ResolvedMailAccount {
    const smtp = this.store.resolveSmtp();
    if (smtp === null) {
      throw new Error("还没有配置发信邮箱（SMTP）。请到设置 → 通知里填写。");
    }
    return smtp;
  }

  /**
   * 收件人 = 设置里的接收邮箱（用户自己日常收信、回信的地址）。
   * 没填时回退到已配置账户：优先 IMAP（回信落在那里），再退 SMTP。
   */
  private recipient(): string {
    const configured = this.store.configuredRecipient();
    if (configured !== "") return configured;
    const imap = this.store.resolveImap();
    if (imap !== null && imap.user !== "") return imap.user;
    const smtp = this.store.resolveSmtp();
    if (smtp !== null && smtp.user !== "") return smtp.user;
    throw new Error("还没有配置邮箱账户，不知道该发给谁。请到设置 → 通知里填写。");
  }

  /**
   * 发件人：留空时不给，由 SMTP 服务器用认证账户补。
   * 只填了显示名（没有 @）时拼成 `"名字" <发信账户>`；完整地址原样使用。
   */
  private senderHeader(): string | undefined {
    const from = this.store.configuredFrom().trim();
    if (from === "") return undefined;
    if (from.includes("@")) return from;
    const user = this.store.resolveSmtp()?.user ?? "";
    if (user === "") return undefined;
    return `"${from.replace(/["\\]/g, "")}" <${user}>`;
  }

  /** transporter 按配置缓存：配置没变就复用，省去每封邮件一次握手。 */
  private async mailerFor(smtp: ResolvedMailAccount): Promise<NotifyMailer> {
    if (this.externalMailer !== null) return this.externalMailer;
    const key = JSON.stringify(smtp);
    if (this.mailer !== null && this.mailerKey === key) return this.mailer;
    const previous = this.mailer;
    const transporter = createTransport(smtp);
    this.mailer = transporter;
    this.mailerKey = key;
    // close 只在真实 transporter 上存在（NotifyMailer 接口不含它），防御式调用。
    previous?.close?.();
    return transporter;
  }
}

function createTransport(account: ResolvedMailAccount): Transporter {
  return nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: account.password === null || account.user === ""
      ? undefined
      : { user: account.user, pass: account.password },
  });
}

/** 日报 / 周报是否到点：开关关闭直接否掉；daily 看 HH:mm 已过；weekly 还要求今天是指定的星期。 */
export function isDigestDue(schedule: { enabled: boolean; time: string; weekday?: number }, kind: DigestKind, nowMs: number): boolean {
  if (schedule.enabled !== true) return false;
  const [hourRaw, minuteRaw] = schedule.time.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  const now = new Date(nowMs);
  const dueAt = new Date(now);
  dueAt.setHours(hour, minute, 0, 0);
  if (now.getTime() < dueAt.getTime()) return false;
  if (kind === "weekly") {
    if (schedule.weekday === undefined) return false;
    if (now.getDay() !== schedule.weekday) return false;
  }
  return true;
}

/** 本地日期（YYYY-MM-DD）：日报 / 周报的「一天一次」以本地日历为准。 */
function localDate(nowMs: number): string {
  const now = new Date(nowMs);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function headerValue(headers: string, name: string): string | null {
  const lines = headers.split(/\r?\n/);
  const prefix = `${name.toLowerCase()}:`;
  for (const line of lines) {
    if (line.toLowerCase().startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "通知服务出错（未知错误）";
}
