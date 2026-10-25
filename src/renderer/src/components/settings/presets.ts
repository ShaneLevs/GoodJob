import type { ProviderProtocol } from "@shared/types";

export interface PresetModel {
  id: string;
  name?: string;
  contextWindow?: number;
  /** 单次回复上限；不填就用出厂默认（64K）。 */
  maxOutputTokens?: number;
  vision?: boolean;
  reasoning?: boolean;
}

export interface ProviderPreset {
  key: string;
  label: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  models: PresetModel[];
}

/**
 * Starting points for "添加供应商". Everything here is just a prefilled form:
 * the user can rename the provider, change the endpoint and edit the model list.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "openai",
    label: "OpenAI",
    name: "OpenAI",
    protocol: "openai-chat",
    baseURL: "https://api.openai.com/v1",
    models: [
      { id: "gpt-4o", contextWindow: 128000, vision: true },
      { id: "gpt-4o-mini", contextWindow: 128000, vision: true },
    ],
  },
  {
    key: "anthropic",
    label: "Anthropic",
    name: "Anthropic",
    protocol: "anthropic-messages",
    baseURL: "https://api.anthropic.com/v1",
    models: [
      { id: "claude-sonnet-4-5", contextWindow: 200000, vision: true, reasoning: true },
      { id: "claude-haiku-4-5", contextWindow: 200000, vision: true },
    ],
  },
  {
    key: "google",
    label: "Google",
    name: "Google",
    protocol: "google-generative-ai",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    models: [
      {
        id: "gemini-2.5-pro",
        contextWindow: 1048576,
        vision: true,
        reasoning: true,
      },
      { id: "gemini-2.5-flash", contextWindow: 1048576, vision: true, reasoning: true },
    ],
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    name: "DeepSeek",
    protocol: "openai-chat",
    baseURL: "https://api.deepseek.com/v1",
    models: [
      { id: "deepseek-chat", contextWindow: 128000 },
      { id: "deepseek-reasoner", contextWindow: 128000, reasoning: true },
    ],
  },
  {
    key: "custom",
    label: "自定义（OpenAI 兼容）",
    name: "自定义供应商",
    protocol: "openai-chat",
    baseURL: "",
    models: [],
  },
];

export const PROTOCOL_OPTIONS: { value: ProviderProtocol; label: string; hint: string }[] = [
  {
    value: "openai-chat",
    label: "OpenAI 兼容 (Chat Completions)",
    hint: "大多数中转站、Ollama、vLLM 都用这个",
  },
  {
    value: "openai-responses",
    label: "OpenAI Responses (/v1/responses)",
    hint: "OpenAI 官方新接口，部分中转不支持",
  },
  {
    value: "anthropic-messages",
    label: "Anthropic Messages (/v1/messages)",
    hint: "Claude 及兼容 /v1/messages 的服务",
  },
  {
    value: "google-generative-ai",
    label: "Google Generative AI",
    hint: "Gemini 原生接口",
  },
];
