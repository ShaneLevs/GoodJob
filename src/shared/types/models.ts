/**
 * Wire protocol of a provider. Each one maps to a different AI SDK adapter
 * factory, which is why it is stored per provider instead of per model.
 */
export type ProviderProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export interface ModelEntry {
  /** Value sent as `model` in the request. */
  id: string;
  /** Display name; falls back to `id` when empty. */
  name: string;
  enabled: boolean;
  /**
   * 上下文窗口（token）：Agent 的对话预算由它决定——不再按「保留最近 12 条」截尾，
   * 而是用到约 90% 就把更早的消息压进摘要。缺省 200K（DEFAULT_CONTEXT_WINDOW）。
   */
  contextWindow: number;
  /** 单次回复的输出上限（token），同时从上下文里预留这么多空间。缺省 64K。 */
  maxOutputTokens: number;
  vision?: boolean;
  /** 推理模型：勾上才会把思考等级发给供应商，也才会显示思考过程。 */
  reasoning?: boolean;
}

/** One model provider as stored in `<workspace>/models.json`. */
export interface ProviderConfig {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  enabled: boolean;
  models: ModelEntry[];
}

/**
 * 对话要调用的模型。设置页不再提供这个选择（那里只管"有哪些模型可用"），
 * 将来由对话侧的模型选择器写入。
 */
export interface ModelSelection {
  providerId: string;
  modelId: string;
}

/** Provider as seen by the renderer: the API key itself never crosses the bridge. */
export interface PublicProvider extends ProviderConfig {
  hasApiKey: boolean;
}

/** The model the chat will actually call, plus whether it is usable yet. */
export interface ActiveModel {
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  /** False when the provider needs an API key that has not been stored. */
  ready: boolean;
  /** 推理模型：输入框才显示思考等级选项。 */
  reasoning: boolean;
  /** 视觉输入：图片会随用户消息交给模型，否则只保存文件。 */
  vision: boolean;
}

export interface ModelsConfig {
  version: number;
  defaultModel: ModelSelection | null;
  providers: PublicProvider[];
  activeModel: ActiveModel | null;
  /** False when the OS keychain is unavailable, so keys cannot be encrypted. */
  canStoreKey: boolean;
}

export interface ProviderDraft extends ProviderConfig {
  /** `undefined` keeps the stored key, `null` clears it, a string replaces it. */
  apiKey?: string | null;
}

export interface ModelsDraft {
  /**
   * 省略表示"保持原值"。设置页只维护供应商与模型清单，对话用哪个模型由对话侧自己决定，
   * 所以这里不再由设置页写入。
   */
  defaultModel?: ModelSelection | null;
  providers: ProviderDraft[];
}
