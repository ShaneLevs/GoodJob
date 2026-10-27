import { useCallback, useEffect, useRef, useState } from "react";

import { CircleAlert, CircleCheck, LoaderCircle, Send } from "lucide-react";

import type {
  DigestKind,
  DigestSchedule,
  NotificationDraft,
  NotificationSettings,
  NotifyTestKind,
  NotifyTestResult,
  PublicNotifyMailAccount,
} from "@shared/types";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { useAutoSave } from "./use-autosave";

/** 表单快照：一次改动把整份表单排进自动保存队列（旧快照自动作废）。 */
interface NotifySnapshot {
  fromAddress: string;
  smtp: AccountDraft;
  imap: AccountDraft;
  daily: DigestSchedule;
  weekly: DigestSchedule;
}

/**
 * 通知设置（P3 M3）：SMTP / IMAP 表单 + 逐项「测试连接」+ 日报 / 周报调度。
 * 密码与模型 API Key 同一纪律：不回显（只显示有没有已存），留空即保持原值。
 *
 * 没有「保存」按钮：改动停手 400ms 自动落盘（`useAutoSave`），右上角只读状态。
 * 「测试连接」「立即生成」仍是显式动作，不随改动触发。
 */
export function NotifySettings() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [form, setForm] = useState<NotifySnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [testing, setTesting] = useState<NotifyTestKind | null>(null);
  const [testResults, setTestResults] = useState<Partial<Record<NotifyTestKind, NotifyTestResult>>>({});
  const [digestBusy, setDigestBusy] = useState<DigestKind | null>(null);
  const [digestNotice, setDigestNotice] = useState<{ tone: "ok" | "error"; message: string } | null>(null);

  // 保存回调里要读「当前表单」，但回调本身不稳定：统一走 ref。
  const formRef = useRef<NotifySnapshot | null>(null);
  formRef.current = form;

  useEffect(() => {
    let alive = true;
    void window.goodjob.notify
      .get()
      .then((next) => {
        if (!alive) return;
        setSettings(next);
        setForm(fromSettings(next));
      })
      .catch((cause: unknown) => {
        if (alive) setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(async (snapshot: NotifySnapshot): Promise<void> => {
    const next = await window.goodjob.notify.save(toDraftRequest(snapshot));
    setSettings(next);

    // 主进程会做清洗（去空格、端口/时刻校验、密文结算）。只有用户在这期间没再
    // 动过表单时才把结果回填，否则会把正在输入的框打断 —— 下次保存再收口。
    const current = formRef.current;
    if (current === null || fingerprint(current) !== fingerprint(snapshot)) return;
    const settled = fromSettings(next);
    formRef.current = settled;
    setForm(settled);
  }, []);

  const autosave = useAutoSave(save);

  /**
   * 改表单并排队保存。端口没填好（空 / 越界）时只改显示不落盘：main 会直接抛
   * 「端口不合法」，没必要为打字中途的临时值弹一次错误。
   */
  const update = (apply: (prev: NotifySnapshot) => NotifySnapshot): void => {
    const prev = formRef.current;
    if (prev === null) return;
    const next = apply(prev);
    formRef.current = next;
    setForm(next);
    if (!isPortDraftValid(next.smtp.port) || !isPortDraftValid(next.imap.port)) return;
    autosave.schedule(next);
  };

  if (loadError !== null) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <h1 className="text-lg font-semibold tracking-tight">通知</h1>
        <div className="mt-6 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      </div>
    );
  }
  if (settings === null || form === null) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <h1 className="text-lg font-semibold tracking-tight">通知</h1>
        <p className="mt-1 text-sm text-muted-foreground">正在读取通知配置…</p>
      </div>
    );
  }

  const { smtp, imap, daily, weekly } = form;

  const test = async (kind: NotifyTestKind): Promise<void> => {
    const account = toAccountDraft(kind === "smtp" ? smtp : imap);
    setTesting(kind);
    setTestResults((prev) => ({ ...prev, [kind]: undefined }));
    try {
      const result = await window.goodjob.notify.test({ kind, account });
      setTestResults((prev) => ({ ...prev, [kind]: result }));
    } catch (cause) {
      setTestResults((prev) => ({
        ...prev,
        [kind]: { ok: false, message: cause instanceof Error ? cause.message : String(cause) },
      }));
    } finally {
      setTesting(null);
    }
  };

  const runDigest = async (kind: DigestKind): Promise<void> => {
    setDigestBusy(kind);
    setDigestNotice(null);
    try {
      const result = await window.goodjob.notify.runDigest(kind);
      setDigestNotice({ tone: result.ok ? "ok" : "error", message: result.message });
    } catch (cause) {
      setDigestNotice({
        tone: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setDigestBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-6 pt-6 pb-4">
        <h1 className="text-lg font-semibold tracking-tight">通知</h1>
      </div>

      {autosave.error !== null && (
        <NoticeBar tone="error" message={autosave.error} className="mx-6 mb-3" />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto border-t p-6">
        <div className="flex flex-col gap-6">
          <p className="text-xs leading-relaxed text-muted-foreground">
            邮箱用来给<strong className="font-medium text-foreground">你自己</strong>发通知
            （日报 / 周报、操作确认），不替你对外发求职邮件。密码经钥匙串加密后存在当前
            工作区，渲染层拿不到明文；留空表示保持已存密码。
          </p>

          <section className="flex flex-col gap-1.5">
            <Label htmlFor="notify-from" className="text-xs text-muted-foreground">
              发件人地址（可选，为空时用 SMTP 账户）
            </Label>
            <Input
              id="notify-from"
              type="email"
              spellCheck={false}
              value={form.fromAddress}
              placeholder="me@example.com"
              onChange={(event) =>
                update((prev) => ({ ...prev, fromAddress: event.target.value }))
              }
            />
          </section>

          <AccountSection
            title="SMTP（发信）"
            hint="日报 / 周报与确认邮件都从这里发出。常见端口：465（TLS）、587（STARTTLS）。"
            hostPlaceholder="smtp.example.com"
            draft={smtp}
            canStorePassword={settings.canStorePassword}
            testResult={testResults.smtp}
            testing={testing === "smtp"}
            onChange={(apply) => update((prev) => ({ ...prev, smtp: apply(prev.smtp) }))}
            onTest={() => void test("smtp")}
          />

          <AccountSection
            title="IMAP（收信）"
            hint="回信监控走 IMAP（确认门的「回信即同意」靠它）。确认邮件发到这个账户并在这里等回复；各家 IDLE 行为不一，建议先点「测试连接」。"
            hostPlaceholder="imap.example.com"
            draft={imap}
            canStorePassword={settings.canStorePassword}
            testResult={testResults.imap}
            testing={testing === "imap"}
            onChange={(apply) => update((prev) => ({ ...prev, imap: apply(prev.imap) }))}
            onTest={() => void test("imap")}
          />

          <section className="flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <Label className="text-sm font-medium">每日汇总（日报）</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  到点发起一次 Agent 运行，汇总岗位 / 投递 / 公司数据发到你邮箱；没有记录会如实说。
                </p>
              </div>
              <Switch
                checked={daily.enabled}
                aria-label="启用日报"
                onCheckedChange={(checked) =>
                  update((prev) => ({ ...prev, daily: { ...prev.daily, enabled: checked } }))
                }
              />
            </div>
            {daily.enabled && (
              <div className="flex items-center gap-2">
                <Label htmlFor="daily-time" className="text-xs text-muted-foreground">
                  发送时刻
                </Label>
                <Input
                  id="daily-time"
                  type="time"
                  value={daily.time}
                  className="w-28"
                  onChange={(event) =>
                    update((prev) => ({
                      ...prev,
                      daily: { ...prev.daily, time: event.target.value || prev.daily.time },
                    }))
                  }
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  disabled={digestBusy !== null}
                  onClick={() => void runDigest("daily")}
                >
                  {digestBusy === "daily" ? <LoaderCircle className="animate-spin" /> : <Send />}
                  立即生成
                </Button>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <Label className="text-sm font-medium">每周汇总（周报）</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  选定星期与时刻，每周发一次这一周的进展汇总。
                </p>
              </div>
              <Switch
                checked={weekly.enabled}
                aria-label="启用周报"
                onCheckedChange={(checked) =>
                  update((prev) => ({ ...prev, weekly: { ...prev.weekly, enabled: checked } }))
                }
              />
            </div>
            {weekly.enabled && (
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="weekly-time" className="text-xs text-muted-foreground">
                  发送时刻
                </Label>
                <Input
                  id="weekly-time"
                  type="time"
                  value={weekly.time}
                  className="w-28"
                  onChange={(event) =>
                    update((prev) => ({
                      ...prev,
                      weekly: { ...prev.weekly, time: event.target.value || prev.weekly.time },
                    }))
                  }
                />
                <Select
                  value={String(weekly.weekday ?? 1)}
                  onValueChange={(value) =>
                    update((prev) => ({
                      ...prev,
                      weekly: { ...prev.weekly, weekday: Number(value) },
                    }))
                  }
                >
                  <SelectTrigger className="w-32" aria-label="周报发送日">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map((day) => (
                      <SelectItem key={day.value} value={String(day.value)}>
                        {day.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  disabled={digestBusy !== null}
                  onClick={() => void runDigest("weekly")}
                >
                  {digestBusy === "weekly" ? <LoaderCircle className="animate-spin" /> : <Send />}
                  立即生成
                </Button>
              </div>
            )}
          </section>

          {digestNotice !== null && (
            <NoticeBar tone={digestNotice.tone} message={digestNotice.message} />
          )}
        </div>
      </div>
    </div>
  );
}

const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: "每周一" },
  { value: 2, label: "每周二" },
  { value: 3, label: "每周三" },
  { value: 4, label: "每周四" },
  { value: 5, label: "每周五" },
  { value: 6, label: "每周六" },
  { value: 0, label: "每周日" },
];

/** 表单里的一个邮件账户：密码不回显，`undefined` = 保持已存，`null` = 清除。 */
interface AccountDraft {
  host: string;
  port: string;
  secure: boolean;
  user: string;
  password?: string | null;
  hasPassword: boolean;
}

function toDraft(account: PublicNotifyMailAccount): AccountDraft {
  return {
    host: account.host,
    port: String(account.port),
    secure: account.secure,
    user: account.user,
    password: undefined,
    hasPassword: account.hasPassword,
  };
}

/** 主进程回传的配置 → 表单快照（密码回到「保持已存」状态，刚存的不会再回显）。 */
function fromSettings(settings: NotificationSettings): NotifySnapshot {
  return {
    fromAddress: settings.fromAddress,
    smtp: toDraft(settings.smtp),
    imap: toDraft(settings.imap),
    daily: settings.digest.daily,
    weekly: settings.digest.weekly,
  };
}

function toAccountDraft(draft: AccountDraft) {
  const port = Number(draft.port);
  return {
    host: draft.host.trim(),
    port: Number.isInteger(port) && port > 0 ? port : 0,
    secure: draft.secure,
    user: draft.user.trim(),
    password: draft.password,
  };
}

function toDraftRequest(snapshot: NotifySnapshot): NotificationDraft {
  return {
    fromAddress: snapshot.fromAddress,
    smtp: toAccountDraft(snapshot.smtp),
    imap: toAccountDraft(snapshot.imap),
    digest: {
      daily: dailyDigestPatch(snapshot.daily),
      weekly: weeklyDigestPatch(snapshot.weekly),
    },
  };
}

/** 保存载荷里 digest 的清洗：空时刻用回原值，交给 main 做格式校验。 */
function dailyDigestPatch(daily: DigestSchedule) {
  return { enabled: daily.enabled, time: daily.time };
}

function weeklyDigestPatch(weekly: DigestSchedule) {
  return { enabled: weekly.enabled, time: weekly.time, weekday: weekly.weekday ?? 1 };
}

/** 端口框能不能落盘：空着 / 越界时先不打扰 main。 */
function isPortDraftValid(raw: string): boolean {
  const text = raw.trim();
  if (text === "" || !/^\d+$/.test(text)) return false;
  const port = Number(text);
  return port >= 1 && port <= 65535;
}

/** 快照的稳定指纹：用来判断「保存期间用户有没有继续改」。 */
function fingerprint(snapshot: NotifySnapshot): string {
  const account = (draft: AccountDraft): string =>
    [draft.host, draft.port, draft.secure ? "1" : "0", draft.user, draft.password ?? "k", draft.hasPassword ? "1" : "0"].join(
      "\u0000",
    );
  return JSON.stringify([
    snapshot.fromAddress,
    account(snapshot.smtp),
    account(snapshot.imap),
    snapshot.daily.enabled,
    snapshot.daily.time,
    snapshot.weekly.enabled,
    snapshot.weekly.time,
    snapshot.weekly.weekday ?? 1,
  ]);
}

function AccountSection({
  title,
  hint,
  hostPlaceholder,
  draft,
  canStorePassword,
  testResult,
  testing,
  onChange,
  onTest,
}: {
  title: string;
  hint: string;
  /** 服务器输入框的示例域名：发信卡给 smtp、收信卡给 imap，避免误导。 */
  hostPlaceholder: string;
  draft: AccountDraft;
  canStorePassword: boolean;
  testResult?: NotifyTestResult;
  testing: boolean;
  onChange: (apply: (draft: AccountDraft) => AccountDraft) => void;
  onTest: () => void;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-sm font-medium">{title}</Label>
        <Button variant="outline" size="sm" disabled={testing} onClick={onTest}>
          {testing ? <LoaderCircle className="animate-spin" /> : null}
          测试连接
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">服务器</Label>
          <Input
            spellCheck={false}
            value={draft.host}
            placeholder={hostPlaceholder}
            onChange={(event) => onChange((prev) => ({ ...prev, host: event.target.value }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">端口</Label>
          <Input
            inputMode="numeric"
            value={draft.port}
            onChange={(event) => onChange((prev) => ({ ...prev, port: event.target.value }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">账户</Label>
          <Input
            type="email"
            spellCheck={false}
            value={draft.user}
            placeholder="me@example.com"
            onChange={(event) => onChange((prev) => ({ ...prev, user: event.target.value }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">密码 / 授权码</Label>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              disabled={!canStorePassword}
              value={draft.password ?? ""}
              placeholder={
                draft.password === null
                  ? "已清除，自动保存后删除"
                  : draft.password !== undefined
                    ? "输入新密码"
                    : draft.hasPassword
                      ? "已保存，留空则不修改"
                      : "密码或服务商授权码"
              }
              onChange={(event) =>
                onChange((prev) => ({
                  ...prev,
                  password: event.target.value === "" ? undefined : event.target.value,
                }))
              }
            />
            {draft.hasPassword && draft.password === undefined && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onChange((prev) => ({ ...prev, password: null }))}
              >
                清除
              </Button>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={draft.secure}
            onCheckedChange={(checked) => onChange((prev) => ({ ...prev, secure: checked }))}
          />
          直连 TLS（465/993 勾选，587 等 STARTTLS 取消勾选）
        </label>
        {!canStorePassword && (
          <Badge variant="secondary" className="text-[10px]">
            钥匙串不可用，无法保存密码
          </Badge>
        )}
      </div>
      {testResult !== undefined && (
        <NoticeBar tone={testResult.ok ? "ok" : "error"} message={testResult.message} />
      )}
    </section>
  );
}

function NoticeBar({
  tone,
  message,
  className,
}: {
  tone: "ok" | "error";
  message: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        tone === "ok"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "border-destructive/30 bg-destructive/10 text-destructive",
        className,
      )}
    >
      {tone === "ok" ? (
        <CircleCheck className="mt-0.5 size-3.5 shrink-0" />
      ) : (
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}
