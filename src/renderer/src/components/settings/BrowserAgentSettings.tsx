import { useCallback, useEffect, useRef, useState } from "react";

import { CircleAlert } from "lucide-react";

import type { BrowserAgentSettings } from "@shared/types";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { useAutoSave } from "./use-autosave";

/** 表单草稿：数字框留字符串，空着 / 打字中途都不算可保存的值。 */
interface AgentForm {
  enabled: boolean;
  autoApprove: boolean;
  dailyLimit: string;
  intervalSeconds: string;
}

/** 落盘快照：只有两个数字都解析成功时才会排进自动保存。 */
interface AgentSnapshot {
  enabled: boolean;
  autoApprove: boolean;
  dailyLimit: number;
  intervalSeconds: number;
}

/**
 * 浏览器自动化设置（P4）：启用开关 + 提交限速参数 + 风险告知。
 * 如实告知两件事：自动化操作招聘账号有封号风险；agent-browser 自己的状态
 * 目录在 `~/.agent-browser`（不在 `~/.goodjob` 里，会话恢复由它自己管理）。
 *
 * 没有「保存」按钮：改动停手 400ms 自动落盘（`useAutoSave`），右上角只读状态。
 */
export function BrowserAgentSettings() {
  const [settings, setSettings] = useState<BrowserAgentSettings | null>(null);
  const [form, setForm] = useState<AgentForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 保存回调里要读「当前表单」，但回调本身不稳定：统一走 ref。
  const formRef = useRef<AgentForm | null>(null);
  formRef.current = form;

  useEffect(() => {
    let alive = true;
    void window.goodjob.agent
      .getSettings()
      .then((next) => {
        if (!alive) return;
        setSettings(next);
        setForm({
          enabled: next.enabled,
          autoApprove: next.autoApprove,
          dailyLimit: String(next.submit.dailyLimitPerSite),
          intervalSeconds: String(next.submit.minIntervalSeconds),
        });
      })
      .catch((cause: unknown) => {
        if (alive) setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(async (snapshot: AgentSnapshot): Promise<void> => {
    const next = await window.goodjob.agent.saveSettings({
      enabled: snapshot.enabled,
      autoApprove: snapshot.autoApprove,
      submit: {
        dailyLimitPerSite: snapshot.dailyLimit,
        minIntervalSeconds: snapshot.intervalSeconds,
      },
    });
    setSettings(next);

    // main 会把越界的数字夹回合法区间：夹过的才回填，且只有在用户没继续改这一项时。
    const current = formRef.current;
    if (current === null) return;
    const dailyLimit = String(next.submit.dailyLimitPerSite);
    const intervalSeconds = String(next.submit.minIntervalSeconds);
    const patched: AgentForm = {
      ...current,
      dailyLimit:
        current.dailyLimit === String(snapshot.dailyLimit) ? dailyLimit : current.dailyLimit,
      intervalSeconds:
        current.intervalSeconds === String(snapshot.intervalSeconds)
          ? intervalSeconds
          : current.intervalSeconds,
    };
    if (
      patched.dailyLimit === current.dailyLimit &&
      patched.intervalSeconds === current.intervalSeconds
    ) {
      return;
    }
    formRef.current = patched;
    setForm(patched);
  }, []);

  const autosave = useAutoSave(save);

  /** 改表单并排队保存；数字不合法（空 / 非正整数）时只改显示，不落盘。 */
  const update = (apply: (prev: AgentForm) => AgentForm): void => {
    const prev = formRef.current;
    if (prev === null) return;
    const next = apply(prev);
    formRef.current = next;
    setForm(next);

    const dailyLimit = parseWholeNumber(next.dailyLimit);
    const intervalSeconds = parseWholeNumber(next.intervalSeconds);
    if (dailyLimit === null || intervalSeconds === null) return;
    autosave.schedule({
      enabled: next.enabled,
      autoApprove: next.autoApprove,
      dailyLimit,
      intervalSeconds,
    });
  };

  if (loadError !== null) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <h1 className="text-lg font-semibold tracking-tight">浏览器</h1>
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
        <h1 className="text-lg font-semibold tracking-tight">浏览器</h1>
        <p className="mt-1 text-sm text-muted-foreground">正在读取浏览器自动化设置…</p>
      </div>
    );
  }

  const error = autosave.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-6 pt-6 pb-4">
        <h1 className="text-lg font-semibold tracking-tight">浏览器</h1>
      </div>

      {error !== null && (
        <div
          className={cn(
            "mx-6 mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
            "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto border-t p-6">
        <div className="flex flex-col gap-6">
          <section className="flex items-center justify-between gap-4 rounded-xl border p-4">
            <div className="min-w-0">
              <Label className="text-sm font-medium">启用浏览器自动化</Label>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                开启后，公司 / 岗位 / 投递三个对话里会出现浏览器工具（browser_read /
                browser_act / browser_submit）。读取页面在后台静默进行，顶栏地球图标会亮成
                「agent 控制中」；写动作（点击 / 填写 / 提交）逐条弹确认卡片，批准后浏览器
                自动打开让你看见它点了哪。每一步都会记进工作区 logs/agent.log。
              </p>
            </div>
            <Switch
              checked={form.enabled}
              aria-label="启用浏览器自动化"
              onCheckedChange={(checked) => update((prev) => ({ ...prev, enabled: checked }))}
            />
          </section>

          <section className="flex items-center justify-between gap-4 rounded-xl border p-4">
            <div className="min-w-0">
              <Label className="text-sm font-medium">自动通过所有请求</Label>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                打开后，所有需要审批的动作（浏览器点击 / 填写 / 提交、外发邮件）不再弹确认
                卡片，直接执行；浏览器也不会因为批准而自动打开。适合盯着的长任务，重要账号
                不建议长期开着。
              </p>
            </div>
            <Switch
              checked={form.autoApprove}
              aria-label="自动通过所有请求"
              onCheckedChange={(checked) => update((prev) => ({ ...prev, autoApprove: checked }))}
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
                  value={form.dailyLimit}
                  onChange={(event) =>
                    update((prev) => ({ ...prev, dailyLimit: event.target.value }))
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-interval" className="text-xs text-muted-foreground">
                  两次提交最小间隔（秒）
                </Label>
                <Input
                  id="agent-interval"
                  inputMode="numeric"
                  value={form.intervalSeconds}
                  onChange={(event) =>
                    update((prev) => ({ ...prev, intervalSeconds: event.target.value }))
                  }
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

/** 正整数；空串或打字中途的乱码一律返回 null（那就先不落盘）。 */
function parseWholeNumber(raw: string): number | null {
  const text = raw.trim();
  if (text === "" || !/^\d+$/.test(text)) return null;
  return Number(text);
}
