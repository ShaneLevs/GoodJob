/*
 * —— 通知（P3 M3）——
 *
 * notifications.json 全局一份：所有工作区共用同一个发信邮箱与接收邮箱。
 * SMTP / IMAP 密码是 safeStorage 密文，只在 main 侧解密——渲染层只看得到
 * 「有没有已存密码」，密码本身不进渲染层、不进日志。
 */

/** SMTP / IMAP 账户的连接字段（不含密码）。 */
export interface NotifyMailAccount {
  host: string;
  port: number;
  /** true = 直连 TLS（465/993），false = STARTTLS（587 等）。 */
  secure: boolean;
  user: string;
}

/** 渲染层看到的通知账户：只给「有没有已存密码」，不给密码本身。 */
export interface PublicNotifyMailAccount extends NotifyMailAccount {
  hasPassword: boolean;
}

/** 保存时的账户字段：password 省略 = 保持已存，null = 清除，字符串 = 替换。 */
export interface NotifyMailAccountDraft extends NotifyMailAccount {
  password?: string | null;
}

/** 日报 / 周报调度：time 为本地时间 HH:mm；周报 weekday 0=周日。 */
export interface DigestSchedule {
  enabled: boolean;
  time: string;
  /** 周报用；日报忽略。 */
  weekday?: number;
}

/** 通知设置（notifications.json 的公开投影）。 */
export interface NotificationSettings {
  /** 接收邮箱：通知 / 报告 / 确认邮件发到这里，用户在这里回信。 */
  recipient: string;
  /** 发件人：显示名或完整地址；为空时用 SMTP 账户。 */
  fromAddress: string;
  smtp: PublicNotifyMailAccount;
  imap: PublicNotifyMailAccount;
  digest: {
    daily: DigestSchedule;
    weekly: DigestSchedule;
  };
  /** False when the OS keychain is unavailable, so passwords cannot be encrypted. */
  canStorePassword: boolean;
}

/** 保存通知设置：只传要改的部分。 */
export interface NotificationDraft {
  recipient?: string;
  fromAddress?: string;
  smtp?: NotifyMailAccountDraft;
  imap?: NotifyMailAccountDraft;
  digest?: {
    daily?: Partial<DigestSchedule>;
    weekly?: Partial<DigestSchedule>;
  };
}

/** 「测试连接」：SMTP = 发送通道，IMAP = 收信通道（IDLE 依赖它）。 */
export type NotifyTestKind = "smtp" | "imap";

/** 测试入参带表单当前值：密码省略时用已存的，测的是「填完之后能不能通」。 */
export interface NotifyTestRequest {
  kind: NotifyTestKind;
  account: NotifyMailAccountDraft;
}

export interface NotifyTestResult {
  ok: boolean;
  /** 成功 / 失败的具体原因，直接给人看；永不包含密码。 */
  message: string;
}

export type DigestKind = "daily" | "weekly";

/** 手动生成日报 / 周报的回执（自动调度没有回执，出错只记日志）。 */
export interface DigestRunResult {
  ok: boolean;
  message: string;
}
