import fs from "node:fs";

import { safeStorage } from "electron";

import type {
  DigestKind,
  DigestSchedule,
  NotificationDraft,
  NotificationSettings,
  NotifyMailAccountDraft,
} from "@shared/types";

import { writeJsonFile, type WorkspacePaths } from "./paths";

const VERSION = 1;

/**
 * 通知配置（P3 M3）：`<workspace>/notifications.json`（0600），跟随工作区——
 * 不同工作区可以配不同邮箱。密码与 models.json 的 API Key 同一纪律：
 * safeStorage 加密后落盘，明文只在 main 内存里存在，不进渲染层、不进日志。
 *
 * 这里只管配置的存取；发送 / 回信监控 / 调度在 notify-service.ts。
 */

/** 一个邮件账户在磁盘上的形态：密码是 base64 密文。 */
interface StoredMailAccount {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** base64 of `safeStorage.encryptString(...)`；没有为 null。 */
  passwordEncrypted: string | null;
}

interface StoredDigest {
  daily: DigestSchedule;
  weekly: DigestSchedule;
  /** 上次触发的本地日期（YYYY-MM-DD）：到点即记账，一天最多自动发一次。 */
  lastDigest: Record<DigestKind, string | null>;
}

interface StoredNotifications {
  version: number;
  fromAddress: string;
  smtp: StoredMailAccount;
  imap: StoredMailAccount;
  digest: StoredDigest;
}

/** main 内部用的已解密账户；password 为 null 表示没存密码（不鉴权或用户没填）。 */
export interface ResolvedMailAccount {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string | null;
}

const DEFAULT_DAILY: DigestSchedule = { enabled: false, time: "09:00" };
const DEFAULT_WEEKLY: DigestSchedule = { enabled: false, time: "09:00", weekday: 1 };

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export class NotifyStore {
  private workspace: WorkspacePaths;
  private doc: StoredNotifications;

  constructor(workspace: WorkspacePaths) {
    this.workspace = workspace;
    this.doc = this.read();
  }

  /** 切到另一个工作区：换文件重读，调用方（IPC）负责停掉服务里的长连接。 */
  useWorkspace(workspace: WorkspacePaths): void {
    this.workspace = workspace;
    this.doc = this.read();
  }

  get canStorePassword(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  toPublic(): NotificationSettings {
    return {
      fromAddress: this.doc.fromAddress,
      smtp: toPublicAccount(this.doc.smtp),
      imap: toPublicAccount(this.doc.imap),
      digest: {
        daily: { ...this.doc.digest.daily },
        weekly: { ...this.doc.digest.weekly },
      },
      canStorePassword: this.canStorePassword,
    };
  }

  save(draft: NotificationDraft): NotificationSettings {
    if (draft.fromAddress !== undefined) {
      this.doc.fromAddress = draft.fromAddress.trim();
    }
    if (draft.smtp !== undefined) {
      this.doc.smtp = mergeAccount(this.doc.smtp, draft.smtp, "SMTP");
      this.encryptPassword(this.doc.smtp, draft.smtp.password);
    }
    if (draft.imap !== undefined) {
      this.doc.imap = mergeAccount(this.doc.imap, draft.imap, "IMAP");
      this.encryptPassword(this.doc.imap, draft.imap.password);
    }
    if (draft.digest?.daily !== undefined) {
      this.doc.digest.daily = mergeSchedule(this.doc.digest.daily, draft.digest.daily);
    }
    if (draft.digest?.weekly !== undefined) {
      this.doc.digest.weekly = mergeSchedule(this.doc.digest.weekly, draft.digest.weekly);
    }
    writeJsonFile(this.workspace.notifications, this.doc);
    return this.toPublic();
  }

  /** 已解密的 SMTP 配置；没配 host 时返回 null（对工具报「未配置」）。 */
  resolveSmtp(): ResolvedMailAccount | null {
    return resolveAccount(this.doc.smtp);
  }

  /** 已解密的 IMAP 配置；没配 host 时返回 null。 */
  resolveImap(): ResolvedMailAccount | null {
    return resolveAccount(this.doc.imap);
  }

  /** 「测试连接」用：表单账户 + 已存密码（password 省略时）合成一份待测配置。 */
  resolveTestAccount(which: "smtp" | "imap", draft: NotifyMailAccountDraft): ResolvedMailAccount | null {
    const stored = which === "smtp" ? this.doc.smtp : this.doc.imap;
    let password: string | null;
    if (draft.password === undefined) {
      password = this.decrypt(stored.passwordEncrypted);
    } else {
      password = draft.password === null || draft.password.trim() === "" ? null : draft.password.trim();
    }
    const host = (typeof draft.host === "string" ? draft.host : stored.host).trim();
    if (host === "") return null;
    return {
      host,
      port: normalizePort(draft.port, stored.port) ?? stored.port,
      secure: draft.secure !== undefined ? draft.secure === true : stored.secure,
      user: (typeof draft.user === "string" ? draft.user : stored.user).trim(),
      password,
    };
  }

  markDigestRun(kind: DigestKind, date: string): void {
    this.doc.digest.lastDigest[kind] = date;
    writeJsonFile(this.workspace.notifications, this.doc);
  }

  digestLastRun(kind: DigestKind): string | null {
    return this.doc.digest.lastDigest[kind];
  }

  private encryptPassword(account: StoredMailAccount, pending: string | null | undefined): void {
    if (pending === undefined) return; // 省略 = 保持已存密码
    if (pending === null || pending.trim() === "") {
      account.passwordEncrypted = null;
      return;
    }
    if (!this.canStorePassword) {
      throw new Error("当前系统无法访问钥匙串，邮箱密码不会被保存。");
    }
    account.passwordEncrypted = safeStorage.encryptString(pending.trim()).toString("base64");
  }

  private decrypt(ciphertext: string | null): string | null {
    if (ciphertext === null) return null;
    try {
      return safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
    } catch {
      // 钥匙串被重置 / 换了机器：当作没存密码，由连接测试暴露问题。
      return null;
    }
  }

  private read(): StoredNotifications {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.workspace.notifications, "utf8"));
      return revive(raw);
    } catch {
      return freshDoc();
    }
  }
}

function freshDoc(): StoredNotifications {
  return {
    version: VERSION,
    fromAddress: "",
    smtp: emptyAccount(465),
    imap: emptyAccount(993),
    digest: {
      daily: { ...DEFAULT_DAILY },
      weekly: { ...DEFAULT_WEEKLY },
      lastDigest: { daily: null, weekly: null },
    },
  };
}

function emptyAccount(port: number): StoredMailAccount {
  return { host: "", port, secure: true, user: "", passwordEncrypted: null };
}

function toPublicAccount(account: StoredMailAccount) {
  return {
    host: account.host,
    port: account.port,
    secure: account.secure,
    user: account.user,
    hasPassword: account.passwordEncrypted !== null,
  };
}

function resolveAccount(account: StoredMailAccount): ResolvedMailAccount | null {
  if (account.host.trim() === "") return null;
  let password: string | null = null;
  if (account.passwordEncrypted !== null) {
    try {
      password = safeStorage.decryptString(Buffer.from(account.passwordEncrypted, "base64"));
    } catch {
      password = null;
    }
  }
  return {
    host: account.host.trim(),
    port: account.port,
    secure: account.secure,
    user: account.user.trim(),
    password,
  };
}

function revive(raw: unknown): StoredNotifications {
  const doc = freshDoc();
  if (typeof raw !== "object" || raw === null) return doc;
  const record = raw as Record<string, unknown>;
  if (typeof record.fromAddress === "string") doc.fromAddress = record.fromAddress.trim();
  const smtp = readAccount(record.smtp, 465);
  if (smtp !== null) doc.smtp = smtp;
  const imap = readAccount(record.imap, 993);
  if (imap !== null) doc.imap = imap;
  if (typeof record.digest === "object" && record.digest !== null) {
    const digest = record.digest as Record<string, unknown>;
    const daily = readSchedule(digest.daily);
    if (daily !== null) doc.digest.daily = daily;
    const weekly = readSchedule(digest.weekly);
    if (weekly !== null) doc.digest.weekly = weekly;
    if (typeof digest.lastDigest === "object" && digest.lastDigest !== null) {
      const last = digest.lastDigest as Record<string, unknown>;
      if (typeof last.daily === "string") doc.digest.lastDigest.daily = last.daily;
      if (typeof last.weekly === "string") doc.digest.lastDigest.weekly = last.weekly;
    }
  }
  return doc;
}

function readAccount(input: unknown, fallbackPort: number): StoredMailAccount | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  return {
    host: typeof record.host === "string" ? record.host : "",
    port: normalizePort(record.port, fallbackPort) ?? fallbackPort,
    secure: record.secure !== false,
    user: typeof record.user === "string" ? record.user.trim() : "",
    passwordEncrypted: typeof record.passwordEncrypted === "string" ? record.passwordEncrypted : null,
  };
}

function mergeAccount(previous: StoredMailAccount, draft: NotifyMailAccountDraft, label: string): StoredMailAccount {
  const port = normalizePort(draft.port, previous.port);
  if (port === null) throw new Error(`${label}端口不合法（1–65535）：${String(draft.port)}`);
  return {
    host: typeof draft.host === "string" ? draft.host.trim() : previous.host,
    port,
    secure: draft.secure !== undefined ? draft.secure === true : previous.secure,
    user: typeof draft.user === "string" ? draft.user.trim() : previous.user,
    passwordEncrypted: previous.passwordEncrypted,
  };
}

function mergeSchedule(previous: DigestSchedule, patch: Partial<DigestSchedule>): DigestSchedule {
  const next: DigestSchedule = { ...previous };
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
  if (patch.time !== undefined) {
    if (!TIME_PATTERN.test(patch.time.trim())) {
      throw new Error(`时刻格式不对（应为 HH:mm）：${patch.time}`);
    }
    next.time = patch.time.trim();
  }
  if (patch.weekday !== undefined) {
    const weekday = Math.round(patch.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error(`星期不合法（0–6，0 是周日）：${String(patch.weekday)}`);
    }
    next.weekday = weekday;
  }
  return next;
}

function readSchedule(input: unknown): DigestSchedule | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const time = typeof record.time === "string" && TIME_PATTERN.test(record.time.trim())
    ? record.time.trim()
    : null;
  if (time === null) return null;
  const schedule: DigestSchedule = { enabled: record.enabled === true, time };
  const weekday = typeof record.weekday === "number" ? Math.round(record.weekday) : null;
  if (weekday !== null && weekday >= 0 && weekday <= 6) schedule.weekday = weekday;
  return schedule;
}

function normalizePort(input: unknown, fallback: number): number | null {
  if (input === undefined || input === null || input === "") return fallback;
  const port = Math.round(Number(input));
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}
