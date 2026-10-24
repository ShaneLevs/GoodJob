import { useEffect, useMemo, useState } from "react";

import { useChat } from "@ai-sdk/react";
import type { ChatStatus, UIMessage } from "ai";

import type { ConversationKey, WireMessage } from "@shared/types";

import { createIpcChatTransport } from "./ipc-chat-transport";

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
  send: (text: string) => void;
  stop: () => void;
}

/**
 * 模块滚动会话的运行时装配：IPC transport + useChat。
 * run 结束（ready/error）后把装配好的完整历史 sync 回 main 落盘——
 * 消息装配以 AI SDK 的 reducer 为准，main 只做持久化。
 */
export function useModuleChat(key: ConversationKey, initialMessages: UIMessage[]): ModuleChat {
  const transport = useMemo(() => createIpcChatTransport(key), [key]);
  const { messages, sendMessage, stop, status, error } = useChat({
    id: key,
    transport,
    messages: initialMessages,
  });

  useEffect(() => {
    if (status !== "ready" && status !== "error") return;
    void window.goodjob.conversations.sync(key, messages as unknown as WireMessage[]);
  }, [key, status, messages]);

  return {
    messages,
    status,
    errorText: error?.message ?? null,
    send: (text: string) => {
      void sendMessage({ text });
    },
    stop,
  };
}
