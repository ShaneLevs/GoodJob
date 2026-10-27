import fs from "node:fs";

import type { BrowserAgentSettings, BrowserAgentSettingsDraft } from "@shared/types";

import { ensureDir, writeJsonFile, type WorkspacePaths } from "../../workspace/paths";

/**
 * 浏览器自动化设置（P4）：`<workspace>/agent-browser.json`（0600），跟随工作区。
 * 这里只有开关与限速参数，没有凭据；单站提交的每日记账也存这里——重启应用
 * 不重置「单站每日 ≤N 单」的口径（按本地日历日重置）。
 *
 * 投递平台适配模板（browser-playbooks.md）是用户手编文件：首次用到时落一份
 * 带占位说明的默认模板，之后原样读。
 */

const VERSION = 1;

export const DEFAULT_DAILY_LIMIT_PER_SITE = 10;
export const DEFAULT_MIN_INTERVAL_SECONDS = 90;
const LIMIT_RANGE = { min: 1, max: 50 } as const;
const INTERVAL_RANGE = { min: 0, max: 3600 } as const;

/** 单站提交记账：host → 当日计数 + 上次提交时刻。 */
interface SiteUsage {
  date: string;
  count: number;
  lastAtMs: number | null;
}

interface StoredSettings {
  version: number;
  enabled: boolean;
  submit: { dailyLimitPerSite: number; minIntervalSeconds: number };
  usage: Record<string, SiteUsage>;
}

/** 限速检查的结果：allowed=false 时 reason 直接给人看。 */
export interface RateCheck {
  allowed: boolean;
  /** 需要等待的毫秒数（allowed=true 且上次提交太近时 > 0）。 */
  waitMs: number;
  reason: string | null;
}

export class BrowserAgentSettingsStore {
  private workspace: WorkspacePaths;
  private doc: StoredSettings;

  constructor(workspace: WorkspacePaths) {
    this.workspace = workspace;
    this.doc = this.read();
  }

  /** 切到另一个工作区：换文件重读（调用方负责先停掉运行中的浏览器任务）。 */
  useWorkspace(workspace: WorkspacePaths): void {
    this.workspace = workspace;
    this.doc = this.read();
  }

  toPublic(): BrowserAgentSettings {
    return {
      enabled: this.doc.enabled,
      submit: {
        dailyLimitPerSite: this.doc.submit.dailyLimitPerSite,
        minIntervalSeconds: this.doc.submit.minIntervalSeconds,
      },
      playbooksPath: this.workspace.browserPlaybooks,
    };
  }

  isEnabled(): boolean {
    return this.doc.enabled;
  }

  save(draft: BrowserAgentSettingsDraft): BrowserAgentSettings {
    if (draft.enabled !== undefined) this.doc.enabled = draft.enabled === true;
    if (draft.submit !== undefined) {
      if (draft.submit.dailyLimitPerSite !== undefined) {
        this.doc.submit.dailyLimitPerSite = clampInt(
          draft.submit.dailyLimitPerSite,
          LIMIT_RANGE,
          DEFAULT_DAILY_LIMIT_PER_SITE,
        );
      }
      if (draft.submit.minIntervalSeconds !== undefined) {
        this.doc.submit.minIntervalSeconds = clampInt(
          draft.submit.minIntervalSeconds,
          INTERVAL_RANGE,
          DEFAULT_MIN_INTERVAL_SECONDS,
        );
      }
    }
    this.persist();
    return this.toPublic();
  }

  /**
   * 提交前的限速检查（不记账）：单站每日上限 + 距上次提交的最小间隔。
   * host 取自当前页面 URL（main 侧解析，模型伪造不了）。
   */
  checkSubmitRate(host: string, nowMs: number): RateCheck {
    const usage = this.usageFor(host, nowMs);
    if (usage.count >= this.doc.submit.dailyLimitPerSite) {
      return {
        allowed: false,
        waitMs: 0,
        reason: `「${host}」今天的提交已达上限（${usage.count}/${this.doc.submit.dailyLimitPerSite}）。明天再试，或者降低该站的提交频率。`,
      };
    }
    if (usage.lastAtMs !== null) {
      const waitMs = usage.lastAtMs + this.doc.submit.minIntervalSeconds * 1000 - nowMs;
      if (waitMs > 0) {
        return {
          allowed: true,
          waitMs,
          reason: null,
        };
      }
    }
    return { allowed: true, waitMs: 0, reason: null };
  }

  /** 记一次提交尝试（成功与否都算对平台的接触）。 */
  recordSubmit(host: string, nowMs: number): void {
    const usage = this.usageFor(host, nowMs);
    usage.count += 1;
    usage.lastAtMs = nowMs;
    this.persist();
  }

  // ———————————— 平台适配模板（browser-playbooks.md） ————————————

  /** 首次调用时落一份默认模板，之后原样返回内容（用户可能已改过）。 */
  ensurePlaybooks(): string {
    try {
      const existing = fs.readFileSync(this.workspace.browserPlaybooks, "utf8");
      if (existing.trim() !== "") return existing;
    } catch {
      // 还没有文件，落默认模板。
    }
    fs.writeFileSync(this.workspace.browserPlaybooks, DEFAULT_PLAYBOOKS, { mode: 0o600 });
    return DEFAULT_PLAYBOOKS;
  }

  // ———————————————————— 内部 ————————————————————

  private usageFor(host: string, nowMs: number): SiteUsage {
    const today = localDate(nowMs);
    const existing = this.doc.usage[host];
    if (existing === undefined || existing.date !== today) {
      const fresh: SiteUsage = { date: today, count: 0, lastAtMs: null };
      this.doc.usage[host] = fresh;
      return fresh;
    }
    return existing;
  }

  private read(): StoredSettings {
    const fallback: StoredSettings = {
      version: VERSION,
      enabled: false,
      submit: {
        dailyLimitPerSite: DEFAULT_DAILY_LIMIT_PER_SITE,
        minIntervalSeconds: DEFAULT_MIN_INTERVAL_SECONDS,
      },
      usage: {},
    };
    try {
      const raw = JSON.parse(fs.readFileSync(this.workspace.agentBrowser, "utf8")) as Partial<StoredSettings>;
      return {
        version: VERSION,
        enabled: raw.enabled === true,
        submit: {
          dailyLimitPerSite: clampInt(
            raw.submit?.dailyLimitPerSite,
            LIMIT_RANGE,
            DEFAULT_DAILY_LIMIT_PER_SITE,
          ),
          minIntervalSeconds: clampInt(
            raw.submit?.minIntervalSeconds,
            INTERVAL_RANGE,
            DEFAULT_MIN_INTERVAL_SECONDS,
          ),
        },
        usage: raw.usage ?? {},
      };
    } catch {
      return fallback;
    }
  }

  private persist(): void {
    ensureDir(this.workspace.dir);
    writeJsonFile(this.workspace.agentBrowser, this.doc);
  }
}

function clampInt(value: number | undefined, range: { min: number; max: number }, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/** 本地日期（YYYY-MM-DD）：每日上限以本地日历日重置。 */
function localDate(nowMs: number): string {
  const now = new Date(nowMs);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 默认平台适配模板：只给结构与安全口径，具体站点选择器由用户按平台补。 */
const DEFAULT_PLAYBOOKS = `# 投递平台适配指令（模板）

> 这是给 Agent 看的平台适配说明，用户可以直接编辑本文件。Agent 在投递会话里
> 投递前会读取这里的内容；某个平台没写就按「通用规则」保守执行。

## 通用规则（对任何平台生效）

- 只投递用户明确指定的岗位；搜索场景绝不点击投递 / 沟通 / 收藏这类改变平台状态的按钮。
- 表单里写不准的字段（期望薪资、到岗时间）宁可留空问用户，不要替用户编。
- 遇到验证码 / 扫码登录 / 人机校验：立即停下，把页面情况告诉用户，交回人工。
- 提交前必须先展示「将要提交的内容摘要」，经确认后才调用 browser_submit。

## 平台：BOSS 直聘（示例占位，请按实际页面补充）

- 登录方式：手机验证码，Agent 不处理登录，交给用户登录后继续。
- 沟通话术入口：职位卡「立即沟通」→ 打开聊天窗（注意：这算主动触达，走 browser_submit 前必须确认）。
- 简历附件：平台只允许用站内简历，Agent 不上传文件。

## 平台：猎聘（示例占位）

- （待补充）

## 平台：LinkedIn（示例占位）

- （待补充）
`;
