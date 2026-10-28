import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { safeStorage } from "electron";

import type {
  ActiveModel,
  ModelEntry,
  ModelSelection,
  ModelsConfig,
  ModelsDraft,
  ProviderConfig,
  ProviderDraft,
  ProviderProtocol,
} from "@shared/types";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS } from "@shared/types";

import { writeJsonFile, type WorkspacePaths } from "../workspace/paths";

const VERSION = 1;

/** Placeholder sent to keyless OpenAI-compatible servers, which still validate the header. */
const KEYLESS_PLACEHOLDER = "not-needed";

/** Hosts that always need a key; anything else is assumed to be a local/relay endpoint. */
const HOSTS_REQUIRING_KEY = [
  /(^|\.)openai\.com$/i,
  /(^|\.)anthropic\.com$/i,
  /(^|\.)googleapis\.com$/i,
  /(^|\.)deepseek\.com$/i,
  /(^|\.)openrouter\.ai$/i,
];

const PROTOCOLS: ProviderProtocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

/** A provider plus its key ciphertext — exactly what `models.json` holds. */
interface StoredProvider extends ProviderConfig {
  /** base64 of `safeStorage.encryptString(...)`, never the plaintext key. */
  apiKeyEncrypted: string | null;
}

interface StoredModels {
  version: number;
  defaultModel: ModelSelection | null;
  providers: StoredProvider[];
}

/** Everything the chat service needs to build an AI SDK model instance. */
export interface ResolvedModel {
  providerId: string;
  providerName: string;
  protocol: ProviderProtocol;
  baseURL: string;
  apiKey: string;
  missingApiKey: boolean;
  modelId: string;
  modelName: string;
  /** Agent 的对话预算（token）：压缩阈值与保留尾部都从它算。 */
  contextWindow: number;
  /** 单次回复的输出上限，同时从窗口里预留出来。 */
  maxOutputTokens: number;
  /** 推理模型：勾上才把思考等级发给供应商。 */
  reasoning: boolean;
  /** 视觉输入：勾上才把上传的图片交给模型。 */
  vision: boolean;
}

/**
 * Persists model providers in `<workspace>/models.json` (0600). 一个文件装下
 * 该工作区的全部供应商、模型和默认选择；切换工作区只是换一个文件重读。
 */
export class ModelsStore {
  private workspace: WorkspacePaths;
  private doc: StoredModels;

  constructor(workspace: WorkspacePaths) {
    this.workspace = workspace;
    this.doc = this.read();
  }

  /** 切到另一个工作区：换文件、重读，调用方（IPC）负责广播给渲染层。 */
  useWorkspace(workspace: WorkspacePaths): void {
    this.workspace = workspace;
    this.doc = this.read();
  }

  /** 当前工作区目录 —— 该工作区的配置和数据都在这里。 */
  get dataDir(): string {
    return this.workspace.dir;
  }

  get canStoreKey(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  toPublic(): ModelsConfig {
    const active = this.pickActive();
    return {
      version: this.doc.version,
      defaultModel: this.doc.defaultModel,
      providers: this.doc.providers.map((provider) => ({
        ...toProviderConfig(provider),
        hasApiKey: provider.apiKeyEncrypted !== null,
      })),
      activeModel: active === null ? null : this.toActiveModel(active),
      canStoreKey: this.canStoreKey,
    };
  }

  save(draft: ModelsDraft): ModelsConfig {
    const existing = new Map(this.doc.providers.map((provider) => [provider.id, provider]));

    const providers = draft.providers.map((provider): StoredProvider => {
      const previous = existing.get(provider.id);
      return {
        id: provider.id.trim() === "" ? randomUUID() : provider.id,
        name: provider.name.trim(),
        protocol: normalizeProtocol(provider.protocol),
        baseURL: normalizeBaseURL(provider.baseURL),
        enabled: provider.enabled,
        models: normalizeModels(provider.models),
        apiKeyEncrypted: this.nextKey(provider, previous ?? null),
      };
    });

    const ids = new Set(providers.map((provider) => provider.id));
    // 设置页不再写 defaultModel：省略即沿用旧值，只在指向已删除的供应商时清空。
    const selection =
      draft.defaultModel === undefined ? this.doc.defaultModel : draft.defaultModel;
    const defaultModel =
      selection !== null && selection !== undefined && ids.has(selection.providerId)
        ? selection
        : null;

    this.doc = {
      version: VERSION,
      defaultModel,
      providers,
    };
    writeJsonFile(this.workspace.models, this.doc);
    return this.toPublic();
  }

  /**
   * 对话侧模型选择器写入默认模型：只改 `defaultModel`，供应商清单和 Key 原样保留。
   * 指向不存在的供应商 / 未启用的模型时不做任何修改，避免把配置写坏。
   */
  selectDefault(selection: ModelSelection | null): ModelsConfig {
    if (selection !== null) {
      const provider = this.doc.providers.find(
        (item) => item.id === selection.providerId && item.enabled,
      );
      const model = provider?.models.find(
        (item) => item.id === selection.modelId && item.enabled,
      );
      if (provider === undefined || model === undefined) return this.toPublic();
    }

    this.doc = {
      ...this.doc,
      defaultModel:
        selection === null
          ? null
          : { providerId: selection.providerId, modelId: selection.modelId },
    };
    writeJsonFile(this.workspace.models, this.doc);
    return this.toPublic();
  }

  /** Resolves the model a chat message should go to, or `null` when unconfigured. */
  resolveActive(): ResolvedModel | null {
    const active = this.pickActive();
    if (active === null) return null;

    const apiKey = this.decrypt(active.provider);
    const missingApiKey = apiKey === null && requiresApiKey(active.provider.baseURL);

    return {
      providerId: active.provider.id,
      providerName: active.provider.name,
      protocol: active.provider.protocol,
      baseURL: active.provider.baseURL,
      apiKey: apiKey ?? KEYLESS_PLACEHOLDER,
      missingApiKey,
      modelId: active.model.id,
      modelName: normalizeModelName(active.model),
      contextWindow: active.model.contextWindow,
      maxOutputTokens: active.model.maxOutputTokens,
      reasoning: active.model.reasoning === true,
      vision: active.model.vision === true,
    };
  }

  /**
   * Default selection first, then the first enabled model of the first enabled
   * provider: a user who adds a provider but never picks a default still chats.
   */
  private pickActive(): { provider: StoredProvider; model: ModelEntry } | null {
    const enabled = this.doc.providers.filter((provider) => provider.enabled);
    if (enabled.length === 0) return null;

    const selection = this.doc.defaultModel;
    if (selection !== null) {
      const provider = enabled.find((item) => item.id === selection.providerId);
      const model = provider?.models.find(
        (item) => item.id === selection.modelId && item.enabled,
      );
      if (provider !== undefined && model !== undefined) return { provider, model };
    }

    for (const provider of enabled) {
      const model = provider.models.find((item) => item.enabled);
      if (model !== undefined) return { provider, model };
    }
    return null;
  }

  private toActiveModel({
    provider,
    model,
  }: {
    provider: StoredProvider;
    model: ModelEntry;
  }): ActiveModel {
    return {
      providerId: provider.id,
      providerName: provider.name,
      modelId: model.id,
      name: normalizeModelName(model),
      ready: provider.apiKeyEncrypted !== null || !requiresApiKey(provider.baseURL),
      reasoning: model.reasoning === true,
      vision: model.vision === true,
    };
  }

  private nextKey(draft: ProviderDraft, previous: StoredProvider | null): string | null {
    const patch = draft.apiKey;
    if (patch === undefined) return previous?.apiKeyEncrypted ?? null;
    if (patch === null || patch.trim() === "") return null;
    return this.encrypt(patch.trim());
  }

  private encrypt(value: string): string {
    if (!this.canStoreKey) {
      throw new Error("当前系统无法访问钥匙串，API Key 不会被保存。");
    }
    return safeStorage.encryptString(value).toString("base64");
  }

  private decrypt(provider: StoredProvider): string | null {
    if (provider.apiKeyEncrypted === null) return null;
    try {
      return safeStorage.decryptString(Buffer.from(provider.apiKeyEncrypted, "base64"));
    } catch {
      // Keychain was reset / another machine: treat as "no key" instead of crashing.
      return null;
    }
  }

  private read(): StoredModels {
    try {
      const raw = fs.readFileSync(this.workspace.models, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const record = isRecord(parsed) ? parsed : {};

      const providers = Array.isArray(record.providers)
        ? record.providers.map(readProvider).filter((item): item is StoredProvider => item !== null)
        : [];

      const defaultModel = readSelection(record.defaultModel);
      return { version: VERSION, defaultModel, providers };
    } catch {
      return { version: VERSION, defaultModel: null, providers: [] };
    }
  }
}

function toProviderConfig(provider: StoredProvider): ProviderConfig {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseURL: provider.baseURL,
    enabled: provider.enabled,
    models: provider.models,
  };
}

function readProvider(input: unknown): StoredProvider | null {
  if (!isRecord(input)) return null;
  const id = typeof input.id === "string" && input.id.trim() !== "" ? input.id : randomUUID();
  const protocol = normalizeProtocol(input.protocol);
  return {
    id,
    name: typeof input.name === "string" ? input.name : "未命名供应商",
    protocol,
    baseURL: typeof input.baseURL === "string" ? normalizeBaseURL(input.baseURL) : "",
    enabled: input.enabled !== false,
    models: Array.isArray(input.models)
      ? normalizeModels(
          input.models.map(readModel).filter((item): item is ModelEntry => item !== null),
        )
      : [],
    apiKeyEncrypted: typeof input.apiKeyEncrypted === "string" ? input.apiKeyEncrypted : null,
  };
}

function readModel(input: unknown): ModelEntry | null {
  if (!isRecord(input) || typeof input.id !== "string" || input.id.trim() === "") return null;
  return normalizeModel({
    id: input.id,
    name: typeof input.name === "string" ? input.name : "",
    enabled: input.enabled !== false,
    contextWindow:
      typeof input.contextWindow === "number" ? input.contextWindow : DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens:
      typeof input.maxOutputTokens === "number"
        ? input.maxOutputTokens
        : DEFAULT_MAX_OUTPUT_TOKENS,
    vision: input.vision === true,
    reasoning: input.reasoning === true,
  });
}

function readSelection(input: unknown): ModelSelection | null {
  if (!isRecord(input)) return null;
  if (typeof input.providerId !== "string" || typeof input.modelId !== "string") return null;
  return { providerId: input.providerId, modelId: input.modelId };
}

function normalizeModels(models: ModelEntry[]): ModelEntry[] {
  const seen = new Set<string>();
  const result: ModelEntry[] = [];
  for (const model of models) {
    const entry = normalizeModel(model);
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

function normalizeModel(model: ModelEntry): ModelEntry {
  const id = model.id.trim();
  const entry: ModelEntry = {
    id,
    name: normalizeModelName(model),
    enabled: model.enabled !== false,
    // 老配置里没有这两个字段：按出厂默认值补齐（200K 窗口 / 64K 输出）。
    contextWindow:
      typeof model.contextWindow === "number" && model.contextWindow > 0
        ? Math.round(model.contextWindow)
        : DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens:
      typeof model.maxOutputTokens === "number" && model.maxOutputTokens > 0
        ? Math.round(model.maxOutputTokens)
        : DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (model.vision === true) entry.vision = true;
  if (model.reasoning === true) entry.reasoning = true;
  return entry;
}

function normalizeModelName(model: ModelEntry): string {
  const name = model.name.trim();
  return name === "" ? model.id : name;
}

function normalizeProtocol(input: unknown): ProviderProtocol {
  return PROTOCOLS.includes(input as ProviderProtocol)
    ? (input as ProviderProtocol)
    : "openai-chat";
}

/**
 * 只去空格和尾斜杠，不替用户补默认地址。
 *
 * 设置页是边改边存的：新增供应商时 Base URL 往往还空着，如果这里补一个默认地址，
 * 那份「半成品」就会以另一个地址落盘，用户回头看到的是自己没填过的域名。
 * 空地址的供应商在业界就是「还没配置好」，侧栏状态点会提示，不应该妨碍保存。
 */
function normalizeBaseURL(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function requiresApiKey(baseURL: string): boolean {
  let host = "";
  try {
    host = new URL(baseURL).hostname;
  } catch {
    return false;
  }
  return HOSTS_REQUIRING_KEY.some((pattern) => pattern.test(host));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
