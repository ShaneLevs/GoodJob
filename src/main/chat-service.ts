import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type LanguageModel, type ModelMessage } from "ai";

import type { ChatEvent, ChatMessage } from "@shared/types";

import type { ModelsStore, ResolvedModel } from "./models-store";

type Emit = (event: ChatEvent) => void;

/**
 * Runs the AI SDK in the main process so the API key never reaches the renderer.
 * Tokens are streamed to the UI through IPC.
 */
export class ChatService {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly store: ModelsStore) {}

  async send(id: string, messages: ChatMessage[], emit: Emit): Promise<void> {
    const target = this.store.resolveActive();
    if (target === null) {
      emit({
        id,
        type: "error",
        code: "llm_not_configured",
        message: "还没有可用的模型。请在设置里添加一个启用的供应商和模型。",
      });
      return;
    }

    if (target.missingApiKey) {
      emit({
        id,
        type: "error",
        code: "llm_not_configured",
        message: `供应商「${target.providerName}」还没有填写 API Key。`,
      });
      return;
    }

    const controller = new AbortController();
    this.running.set(id, controller);

    try {
      const result = streamText({
        model: createLanguageModel(target),
        messages: toModelMessages(messages),
        abortSignal: controller.signal,
        maxRetries: 1,
      });

      for await (const delta of result.textStream) {
        if (delta !== "") emit({ id, type: "delta", text: delta });
      }
      emit({ id, type: "done" });
    } catch (error) {
      if (controller.signal.aborted) {
        emit({ id, type: "error", code: "aborted", message: "已取消" });
      } else {
        emit({ id, type: "error", code: "provider_error", message: describeError(error) });
      }
    } finally {
      this.running.delete(id);
    }
  }

  abort(id: string): void {
    this.running.get(id)?.abort();
  }

  abortAll(): void {
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
  }
}

/**
 * Maps a stored provider onto its AI SDK adapter. The four protocols differ only
 * in these constructor calls, so adding a new one is a case here plus a preset entry.
 */
function createLanguageModel(target: ResolvedModel): LanguageModel {
  const { baseURL, apiKey, modelId, providerName } = target;

  switch (target.protocol) {
    case "anthropic-messages": {
      const provider = createAnthropic({ baseURL, apiKey, name: providerName });
      return provider(modelId);
    }
    case "google-generative-ai": {
      const provider = createGoogleGenerativeAI({ baseURL, apiKey, name: providerName });
      return provider(modelId);
    }
    case "openai-responses": {
      const provider = createOpenAI({ baseURL, apiKey, name: providerName });
      return provider.responses(modelId);
    }
    default: {
      // OpenAI-compatible Chat Completions: the broadest relay/local-model format.
      const provider = createOpenAI({ baseURL, apiKey, name: providerName });
      return provider.chat(modelId);
    }
  }
}

/** Human labels for the protocol picker live in the renderer's settings UI. */

function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "assistant":
        return { role: "assistant", content: message.content };
      default:
        return { role: "user", content: message.content };
    }
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "调用模型失败（未知错误）";
}
