import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

import type { ModelsStore, ResolvedModel } from "./models-store";

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
      // OpenAI-compatible Chat Completions: the broadest relay/local-model format.
      const provider = createOpenAI({ baseURL, apiKey, name });
      return provider.chat(modelId);
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
