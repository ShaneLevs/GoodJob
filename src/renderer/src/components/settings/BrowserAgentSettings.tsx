import { useEffect, useState } from "react";

import { CircleAlert } from "lucide-react";

import type { BrowserAgentSettings } from "@shared/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * 浏览器自动化设置（P4）：启用开关 + 提交限速参数 + 风险告知。
 * 如实告知两件事：自动化操作招聘账号有封号风险；agent-browser 自己的状态
 * 目录在 `~/.agent-browser`（不在 `~/.goodjob` 里，会话恢复由它自己管理）。
 */
export function BrowserAgentSettings() {
  const [settings, setSettings] = useState<BrowserAgentSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [dailyLimit, setDailyLimit] = useState("10");
  const [intervalSeconds, setIntervalSeconds] = useState("90");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; message: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void window.goodjob.agent
      .getSettings()
      .then((next) => {
        if (!alive) return;
        setSettings(next);
        setEnabled(next.enabled);
        setDailyLimit(String(next.submit.dailyLimitPerSite));
        setIntervalSeconds(String(next.submit.minIntervalSeconds));
      })
      .catch((cause: unknown) => {
        if (alive) setNotice({ tone: "error", message: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      alive = false;
    };
  }, []);

  if (settings === null) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <h1 className="text-lg font-semibold tracking-tight">浏览器</h1>
        <p className="mt-1 text-sm text-muted-foreground">正在读取浏览器自动化设置…</p>
      </div>
    );
  }

  const patch = (): void => setDirty(true);

  const save = async (): Promise<void> => {
    setSaving(true);
    setNotice(null);
    try {
      const next = await window.goodjob.agent.saveSettings({
        enabled,
        submit: {
          dailyLimitPerSite: Number(dailyLimit),
          minIntervalSeconds: Number(intervalSeconds),
        },
      });
      setSettings(next);
      setEnabled(next.enabled);
      setDailyLimit(String(next.submit.dailyLimitPerSite));
      setIntervalSeconds(String(next.submit.minIntervalSeconds));
      setDirty(false);
      setNotice({ tone: "ok", message: "已保存。" });
    } catch (cause) {
      setNotice({ tone: "error", message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 px-6 pt-6 pb-4">
        <h1 className="text-lg font-semibold tracking-tight">浏览器</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {saving ? "保存中…" : dirty ? "有未保存的改动" : "已保存"}
          </span>
          <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            保存
          </Button>
        </div>
      </div>

      {notice !== null && (
        <div
          className={cn(
            "mx-6 mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
            notice.tone === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{notice.message}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto border-t p-6">
        <div className="flex flex-col gap-6">
          <section className="flex items-center justify-between gap-4 rounded-xl border p-4">
            <div className="min-w-0">
              <Label className="text-sm font-medium">启用浏览器自动化</Label>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                开启后，公司 / 岗位 / 投递三个对话里会出现浏览器工具（browser_read /
                browser_act / browser_submit），Agent 通过内嵌浏览器面板操作页面；每一步
                都会记进工作区 logs/agent.log，写动作逐条弹界面审批。
              </p>
            </div>
            <Switch
              checked={enabled}
              aria-label="启用浏览器自动化"
              onCheckedChange={(checked) => {
                setEnabled(checked);
                patch();
              }}
            />
          </section>

          <section className="flex flex-col gap-3 rounded-xl border p-4">
            <div className="min-w-0">
              <Label className="text-sm font-medium">提交限速</Label>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                只约束 browser_submit（投递 / 主动沟通这类对外提交）。间隔之外还会再加
                0–30 秒随机抖动，避免机械等间隔。
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-daily-limit" className="text-xs text-muted-foreground">
                  单站每日提交上限（次）
                </Label>
                <Input
                  id="agent-daily-limit"
                  inputMode="numeric"
                  value={dailyLimit}
                  onChange={(event) => {
                    setDailyLimit(event.target.value);
                    patch();
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-interval" className="text-xs text-muted-foreground">
                  两次提交最小间隔（秒）
                </Label>
                <Input
                  id="agent-interval"
                  inputMode="numeric"
                  value={intervalSeconds}
                  onChange={(event) => {
                    setIntervalSeconds(event.target.value);
                    patch();
                  }}
                />
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-xs leading-relaxed">
            <div className="flex items-center gap-2 font-medium text-foreground">
              <CircleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              风险与边界（请阅读）
            </div>
            <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
              <li>
                自动化操作招聘平台账号<strong className="text-foreground">可能触发风控甚至封号</strong>
                ：请把提交量压在限速之内，重要账号的关键操作建议全程在场审批。
              </li>
              <li>
                agent-browser 的会话状态目录是{" "}
                <code className="rounded bg-muted px-1 py-0.5">~/.agent-browser</code>
                （不在 ~/.goodjob 工作区里）：这是它的会话恢复机制所在，本应用不迁移也不清空它。
              </li>
              <li>
                命令白名单不含 cookies / 存储 / eval / 网络劫持等能力；每一步的完整命令都会写进工作区
                logs/agent.log（全量审计，不含页面正文）。
              </li>
              <li>
                投递平台适配指令模板在{" "}
                <code className="rounded bg-muted px-1 py-0.5 break-all">{settings.playbooksPath}</code>
                ，可直接编辑，Agent 投递前会读取。
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
