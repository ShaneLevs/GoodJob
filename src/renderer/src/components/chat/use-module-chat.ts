import { useEffect, useMemo, useRef, useState } from "react";

import { useChat } from "@ai-sdk/react";
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type ChatStatus,
  type UIMessage,
} from "ai";

import type {
  ConversationKey,
  ReasoningEffort,
  UploadedFileMeta,
  WireMessage,
} from "@shared/types";
import { DEFAULT_REASONING_EFFORT } from "@shared/types";

import { createIpcChatTransport } from "./ipc-chat-transport";

/**
 * 浏览器面板工具条「让 Agent 接管」的落点（P4）：BrowserPanel 广播
 * `goodjob:agent-takeover`，挂了这个 hook 的会话（companies / jobs / applications）
 * 用自己的 chat 发一条起手指令——等于在当前会话发起 browser 工具调用。
 */
const AGENT_TAKEOVER_EVENT = "goodjob:agent-takeover";
const AGENT_TAKEOVER_PROMPT =
  "请接管内嵌浏览器面板：先 snapshot 看看当前打开的页面，简要告诉我这是什么页面，然后等我下一步指示。";

/** 挂载后监听接管事件，触发时向本会话发送起手指令（组件卸载即注销）。 */
export function useBrowserTakeover(send: (text: string, uploads: UploadedFileMeta[]) => void): void {
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const handler = (): void => sendRef.current(AGENT_TAKEOVER_PROMPT, []);
    window.addEventListener(AGENT_TAKEOVER_EVENT, handler);
    return () => window.removeEventListener(AGENT_TAKEOVER_EVENT, handler);
  }, []);
}

/**
 * 挂载（或 key 变化）时从 main 取回该模块的滚动会话。
 * 返回 null 表示还在加载——父组件等它就绪再渲染会用到 useChat 的子树，
 * 这样 useChat 的初始 messages 一次性给准，避免"先空后补"的闪变。
 */
export function useConversationInitial(key: ConversationKey): UIMessage[] | null {
  const [messages, setMessages] = useState<UIMessage[] | null>(null);

  useEffect(() => {
    let alive = true;
    setMessages(null);
    void window.goodjob.conversations.get(key).then((state) => {
      if (alive) setMessages(state.messages as unknown as UIMessage[]);
    });
    return () => {
      alive = false;
    };
  }, [key]);

  return messages;
}

export interface ModuleChat {
  messages: UIMessage[];
  status: ChatStatus;
  errorText: string | null;
  /**
   * 发一条带附件的用户消息。附件以 `data-upload` part 附带（UI 展示用，
   * convertToModelMessages 默认不把 data part 送进模型），模型只看到 text 部分。
   * effort 是输入框里选的思考等级，只在推理模型上生效。
   */
  send: (text: string, uploads: UploadedFileMeta[], effort?: ReasoningEffort) => void;
  stop: () => void;
  /**
   * 工具审批（P3 M3）：批准 / 拒绝一个「等待批准」的工具调用。
   * 回填 tool-approval-response part 后，满足 sendAutomaticallyWhen 会自动续跑
   * （完整历史经 IPC transport 再发一次 main，工具在第二个 run 里真正执行）。
   */
  respondApproval: (approvalId: string, approved: boolean) => void;
}

/**
 * 模块滚动会话的运行时装配：IPC transport + useChat。
 * run 结束（ready/error）后把装配好的完整历史 sync 回 main 落盘——
 * 消息装配以 AI SDK 的 reducer 为准，main 只做持久化。
 * sendAutomaticallyWhen 兑现 toolApproval 界面审批（P1 预留位）：批准 / 拒绝后自动续跑。
 */
export function useModuleChat(key: ConversationKey, initialMessages: UIMessage[]): ModuleChat {
  // 当前思考等级：随发送带出去，不在会话里持久化（重启回落默认值）。
  const effortRef = useRef<ReasoningEffort>(DEFAULT_REASONING_EFFORT);
  const transport = useMemo(() => createIpcChatTransport(key, () => effortRef.current), [key]);
  // 本轮 run 的起点（performance.now）：结束时刻算进耗时，写进助手消息 metadata。
  const runStartedAtRef = useRef<number | null>(null);

  const {
    messages,
    sendMessage,
    stop,
    status,
    error,
    setMessages,
    addToolApprovalResponse,
  } = useChat({
    id: key,
    transport,
    messages: initialMessages,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: ({ message }) => {
      const startedAt = runStartedAtRef.current;
      runStartedAtRef.current = null;
      if (startedAt === null) return;
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      setMessages((prev) =>
        prev.map((item) =>
          item.id === message.id
            ? {
                ...item,
                metadata: {
                  ...(typeof item.metadata === "object" && item.metadata !== null
                    ? item.metadata
                    : {}),
                  durationMs,
                },
              }
            : item,
        ),
      );
    },
  });

  useEffect(() => {
    if (status !== "ready" && status !== "error") return;
    void window.goodjob.conversations.sync(key, messages as unknown as WireMessage[]);
  }, [key, status, messages]);

  return {
    messages,
    status,
    errorText: error?.message ?? null,
    send: (text: string, uploads: UploadedFileMeta[], effort?: ReasoningEffort) => {
      const trimmed = text.trim();
      if (trimmed === "" && uploads.length === 0) return;

      effortRef.current = effort ?? DEFAULT_REASONING_EFFORT;

      const parts: UIMessage["parts"] = [];
      if (trimmed !== "") parts.push({ type: "text", text: trimmed });
      for (const upload of uploads) {
        parts.push({ type: "data-upload", data: upload });
      }

      runStartedAtRef.current = performance.now();
      void sendMessage({ parts });
    },
    stop,
    respondApproval: (approvalId: string, approved: boolean) => {
      void addToolApprovalResponse({ id: approvalId, approved });
    },
  };
}
