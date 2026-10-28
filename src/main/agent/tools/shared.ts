import { asSchema, jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import { z } from "zod";

import type { ConversationKey } from "@shared/types";

import {
  browserActActionSchema,
  browserReadActionSchema,
  browserSubmitActionSchema,
  describeSubmitAction,
  tabActionSchema,
} from "../../browser/automation/actions";
import { listUploadFiles, readUploadFile } from "../../workspace/uploads";
import type { AgentDeps } from "../deps";

/** 离场模式的空闲门槛：用户 10 分钟内有操作就不允许走邮件确认门。 */
const OFFLINE_GATE_IDLE_MS = 10 * 60_000;
/** 提交限速的随机抖动上限。 */
const SUBMIT_JITTER_MAX_MS = 30_000;

/**
 * 工具入参 schema：根级必须是 `type: "object"`。
 *
 * `z.discriminatedUnion` 转出来的 JSON Schema 只有根级 `oneOf`、没有 `type`。
 * OpenAI 那套 strict 工具校验（官方与多数兼容网关都会跑）见到这种形状直接 400：
 * `Invalid schema for function 'browser_read': schema must be a JSON Schema of
 * 'type: "object"'` / `"" is not valid under any of the schemas listed in the
 * 'anyOf' keyword`。工具入参本来就该是对象，这里把 `type` 补上，校验仍走 zod——
 * 不补的话浏览器那四个工具一进模型上下文，整个会话在第一次请求就失败。
 */
function objectInputSchema<T>(schema: z.ZodType<T>) {
  const json = asSchema(schema).jsonSchema as JSONSchema7;
  return jsonSchema<T>(
    { ...json, type: "object" },
    {
      validate: (value) => {
        const parsed = schema.safeParse(value);
        return parsed.success
          ? { success: true as const, value: parsed.data }
          : { success: false as const, error: parsed.error };
      },
    },
  );
}

export function uploadTools(deps: AgentDeps, key: ConversationKey): ToolSet {
  return {
    upload_list: tool({
      description:
        "列出用户上传到当前模块 upload/ 目录里的参考文件（旧简历、JD 文档、公司资料等）。",
      inputSchema: z.object({}),
      execute: () => listUploadFiles(deps.uploadDir(key)),
    }),
    upload_read: tool({
      description:
        "读取一份上传文件的文本：PDF / DOCX 自动抽成纯文本，Markdown / 文本文件返回原文。fileName 用 upload_list 里的名字。图片没有可抽取的文字：支持视觉的模型会直接看到用户消息里随附的图片，不要用本工具读图片。",
      inputSchema: z.object({ fileName: z.string() }),
      execute: ({ fileName }) => readUploadFile(deps.uploadDir(key), fileName),
    }),
  };
}

export function browserTools(deps: AgentDeps, key: ConversationKey, lastActivityAt: () => number): ToolSet {
  if (!deps.browser.isEnabled()) return {};
  return {
    browser_read: tool({
      description:
        "在内嵌浏览器面板上执行一条只读动作（导航 / snapshot / get / is / wait / 滚动）。先 snapshot 拿到 @ref 才能操作元素；open 之后旧 ref 全部失效，必须重新 snapshot。",
      inputSchema: objectInputSchema(browserReadActionSchema),
      execute: async (action, { abortSignal }) =>
        deps.browser.execute({ tool: "browser_read", action, key, signal: abortSignal }),
    }),
    browser_act: tool({
      description:
        "在内嵌浏览器面板上执行一条写动作（点击 / 填写 / 勾选等）。每一步都会弹界面审批，等用户批准才执行。动作前元素要在视口内：视口外先 scrollintoview 再重新 snapshot。想把链接开到新标签就用 click 的 newTab=true（读 href 后建一个用户看得见的标签）。",
      inputSchema: objectInputSchema(browserActActionSchema),
      execute: async (action, { abortSignal }) =>
        deps.browser.execute({ tool: "browser_act", action, key, signal: abortSignal }),
    }),
    browser_tab: tool({
      description:
        "管理浏览器标签（多标签）：list 列出全部标签（id / url / 标题 / 哪个当前）；new 新建一个标签并在其中打开 url（可省）；switch 切换当前操作的标签（target 用 tab list 返回的 id）；close 关闭一个标签（不能关当前那个）。新 / 切标签后旧的 @ref 全部失效，必须重新 snapshot。运行多个网站的长时间任务时，一个网站一个标签。",
      inputSchema: objectInputSchema(tabActionSchema),
      execute: async (action, { abortSignal }) =>
        deps.browser.execute({ tool: "browser_tab", action, key, signal: abortSignal }),
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
        if (mode === "offline" && Date.now() - lastActivityAt() < OFFLINE_GATE_IDLE_MS) {
          throw new Error(
            '用户 10 分钟内有操作，离场模式不可用。请改用 mode="interactive"（界面审批），或等用户真的离开。',
          );
        }
        // 限速按「当前页面的站」记账，模型指定不了 host。
        const host = deps.browser.currentHost();
        if (host === "") {
          throw new Error("读不到当前页面的网址，无法按站限速。请先在浏览器面板里打开目标页面。");
        }
        const rate = deps.browserSettings.checkSubmitRate(host, Date.now());
        if (!rate.allowed) throw new Error(rate.reason ?? "已达提交限速，无法提交。");
        if (mode === "offline") {
          const outcome = await deps.notify.requestConfirmation(
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
        deps.browserSettings.recordSubmit(host, Date.now());
        const result = await deps.browser.execute({
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

export function notifyTools(deps: AgentDeps): ToolSet {
  return {
    notify: tool({
      description:
        "把一段摘要发到用户自己配置的邮箱（设置 → 通知）。会弹界面审批，用户批准后才会真正发出。",
      inputSchema: z.object({
        summary: z.string().describe("要发送的正文（Markdown）"),
      }),
      execute: async ({ summary }, { abortSignal }) => {
        if (summary.trim() === "") throw new Error("summary 是空的，没有什么可发。");
        return deps.notify.sendNotification(summary, abortSignal);
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
        deps.notify.requestConfirmation(subject, body, abortSignal),
    }),
  };
}

export function memoryTools(deps: AgentDeps): ToolSet {
  const { memory } = deps;
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

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
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
