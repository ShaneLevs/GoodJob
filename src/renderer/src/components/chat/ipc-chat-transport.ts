import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

import type {
  ChatStreamEvent,
  ConversationKey,
  ReasoningEffort,
  WireMessage,
} from "@shared/types";

/**
 * 把 AI SDK 的 ChatTransport 桥到 Electron IPC：
 * `sendMessages` → invoke `chat:send`，main 侧 agent 的 UIMessageChunk 流经
 * `chat:chunk` 事件回来，这里拼成 ReadableStream 交给 useChat 消费。
 * Agent 永远跑在 main（Key 不出 main），渲染层只拿 chunk。
 *
 * 思考等级用 getter 传：它可以在输入框里随时改，但 transport 一旦重建，
 * useChat 的流就会断——所以只在每次发送时取一次当前值。
 */
export function createIpcChatTransport(
  key: ConversationKey,
  getEffort?: () => ReasoningEffort,
): ChatTransport<UIMessage> {
  return {
    async sendMessages({ messages, abortSignal }) {
      const runId = crypto.randomUUID();

      let controller: ReadableStreamDefaultController<UIMessageChunk> | null = null;
      let closed = false;
      const buffer: UIMessageChunk[] = [];

      const drain = (): void => {
        if (controller === null) return;
        for (const chunk of buffer.splice(0)) controller.enqueue(chunk);
      };

      const unsubscribe = window.goodjob.chat.onChunk((event: ChatStreamEvent) => {
        if (event.key !== key || event.runId !== runId) return;
        if (event.type === "done") {
          unsubscribe();
          closed = true;
          if (controller !== null) {
            drain();
            try {
              controller.close();
            } catch {
              // 消费端已 cancel：忽略。
            }
          }
          return;
        }
        if (controller !== null) controller.enqueue(event.chunk as UIMessageChunk);
        else buffer.push(event.chunk as UIMessageChunk);
      });

      // 只取消本轮：AbortSignal 与流的 cancel 都会走到这里，按 key 停的话
      // 这两次取消中只要有一次晚于下一轮请求，就会把下一轮误杀。
      const cancelRun = (): void => window.goodjob.chat.abort(key, runId);

      abortSignal?.addEventListener("abort", cancelRun, { once: true });

      // main 在 send 返回前就可能开始推 chunk，所以订阅必须先于 invoke；
      // invoke 之后再把缓冲灌进刚创建的流。
      await window.goodjob.chat.send({
        key,
        runId,
        messages: messages as unknown as WireMessage[],
        effort: getEffort?.(),
      });

      return new ReadableStream<UIMessageChunk>({
        start(queued) {
          controller = queued;
          drain();
          if (closed) {
            try {
              queued.close();
            } catch {
              // 同上。
            }
          }
        },
        cancel() {
          unsubscribe();
          cancelRun();
        },
      });
    },

    async reconnectToStream() {
      // 没有可重连的持久流：断线重连由用户重发消息解决。
      return null;
    },
  };
}
