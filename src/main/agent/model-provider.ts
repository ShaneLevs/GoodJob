import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import type { ModelsStore, ResolvedModel } from "../stores/models";

/**
 * ModelsStore → AI SDK 模型实例的小工厂。会话流式（AgentRuntime）与后台任务
 * （TaskManager）都从这里拿模型，供应商支持只维护这一处。
 *
 * Maps a stored provider onto its AI SDK adapter. The four protocols differ only
 * in these constructor calls, so adding a new one is a case here plus a preset entry.
 */
export function createLanguageModel(target: ResolvedModel): LanguageModel {
  const { baseURL, apiKey, modelId, providerName: name } = target;

  switch (target.protocol) {
    case "anthropic-messages": {
      const provider = createAnthropic({ baseURL, apiKey, name });
      return provider(modelId);
    }
    case "google-generative-ai": {
      const provider = createGoogleGenerativeAI({ baseURL, apiKey, name });
      return provider(modelId);
    }
    case "openai-responses": {
      const provider = createOpenAI({ baseURL, apiKey, name });
      return provider.responses(modelId);
    }
    default: {
      // OpenAI-compatible Chat Completions：最通用的中转 / 本地模型格式。
      // 这里刻意用 openai-compatible 而不是 @ai-sdk/openai 的 .chat()：后者只解析
      // delta.content / tool_calls / annotations，把中转站塞在同一条 delta 里的
      // reasoning_content（DeepSeek 系、各家 thinking 模型都这么发）整段丢掉，
      // 界面上就永远看不到「思考内容」。openai-compatible 会把它转成 reasoning part。
      const provider = createOpenAICompatible({ baseURL, apiKey, name });
      return provider.chatModel(modelId);
    }
  }
}

/** 解析当前要用的模型；未配置 / 缺 Key 时抛出的错误信息直接面向用户。 */
export function requireActiveModel(models: ModelsStore): ResolvedModel {
  const target = models.resolveActive();
  if (target === null) {
    throw new Error("还没有可用的模型（llm_not_configured）。请先在设置里添加并启用一个供应商和模型。");
  }
  if (target.missingApiKey) {
    throw new Error(`供应商「${target.providerName}」还没有填写 API Key，请先到设置里补上。`);
  }
  return target;
}
