import fs from "node:fs";

import { safeStorage } from "electron";

import type {
  VoiceAsrSettings,
  VoiceModelDraft,
  VoiceMicrophoneAccess,
  VoiceModelConfig,
  VoiceProvider,
  VoiceSettings,
  VoiceSettingsDraft,
  VoiceTtsSettings,
} from "@shared/types";

import { writeJsonFile, type RootPaths } from "../workspace/paths";

const VERSION = 1;

/**
 * 百炼 AOQ 的默认接入域名（北京地域的试用域名）。
 *
 * 注意：AOQ 的 `/api/v1/webrtc/inference` 只在 `*.maas.aliyuncs.com` 上有接入点，
 * 公共的 `dashscope.aliyuncs.com` 对这条路径返回 404。正式业务空间换成
 * `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`（或其他地域对应域名）。
 */
const DEFAULT_ENDPOINT = "trial.cn-beijing.maas.aliyuncs.com";
const DEFAULT_TTS_MODEL = "qwen-audio-3.0-tts-flash";
const DEFAULT_TTS_VOICE = "longanlingxi";
const DEFAULT_ASR_MODEL = "qwen-audio-3.1-asr-flash-streaming";

/** 一份语音配置的落盘形态：Key 密文单独存，公开结构里只有 hasApiKey。 */
interface StoredVoiceModel extends VoiceModelConfig {
  voice: string;
  apiKeyEncrypted: string | null;
}

interface StoredVoice {
  version: number;
  tts: StoredVoiceModel;
  asr: StoredVoiceModel;
}

/** 解析后的语音配置（Key 明文只在 main 里出现，不进日志、不回渲染层）。 */
export interface ResolvedVoiceModel extends VoiceModelConfig {
  voice: string;
  apiKey: string;
}

export interface SdkStatus {
  version: string | null;
  error: string | null;
}

/**
 * 语音模型的设置存储：`~/.goodjob/voice.json`（0600）。
 *
 * 和 ModelsStore 同一套结算规则：`apiKey` 省略表示保持原值，`null` / 空串表示清除，
 * 有值就重新加密。端点只做去协议头 / 去尾斜杠，不替用户改成本地域——写错了下次
 * 调用会以百炼的鉴权错误显式暴露，而不是悄悄连到另一个域名。
 */
export class VoiceSettingsStore {
  private readonly root: RootPaths;
  private readonly sdkStatus: () => SdkStatus;
  private readonly micAccess: () => VoiceMicrophoneAccess;
  private doc: StoredVoice;

  constructor(
    root: RootPaths,
    sdkStatus: () => SdkStatus = () => ({ version: null, error: null }),
    micAccess: () => VoiceMicrophoneAccess = () => "unknown",
  ) {
    this.root = root;
    this.sdkStatus = sdkStatus;
    this.micAccess = micAccess;
    this.doc = this.read();
  }

  get canStoreKey(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  toPublic(): VoiceSettings {
    const sdk = this.sdkStatus();
    const tts = toTtsPublic(this.doc.tts);
    const asr = toAsrPublic(this.doc.asr);
    const ttsReady = tts.hasApiKey && tts.model !== "" && tts.endpoint !== "";
    const asrReady = asr.hasApiKey && asr.model !== "" && asr.endpoint !== "";
    return {
      version: this.doc.version,
      tts,
      asr,
      canStoreKey: this.canStoreKey,
      ready: { tts: ttsReady, asr: asrReady, interview: ttsReady && asrReady },
      microphone: this.micAccess(),
      sdkVersion: sdk.version,
      sdkError: sdk.error,
    };
  }

  save(draft: VoiceSettingsDraft): VoiceSettings {
    this.doc = {
      version: VERSION,
      tts: this.nextModel(this.doc.tts, draft.tts),
      asr: this.nextModel(this.doc.asr, draft.asr),
    };
    writeJsonFile(this.root.voice, this.doc);
    return this.toPublic();
  }

  /** 解析出可用的 TTS 配置；没配 Key 时返回 null（调用方给「未配置语音模型」）。 */
  resolveTts(): ResolvedVoiceModel | null {
    return this.resolve(this.doc.tts);
  }

  resolveAsr(): ResolvedVoiceModel | null {
    return this.resolve(this.doc.asr);
  }

  private resolve(model: StoredVoiceModel): ResolvedVoiceModel | null {
    if (model.endpoint === "" || model.model === "" || model.apiKeyEncrypted === null) {
      return null;
    }
    const apiKey = this.decrypt(model.apiKeyEncrypted);
    if (apiKey === null) return null;
    return {
      provider: model.provider,
      endpoint: model.endpoint,
      model: model.model,
      voice: model.voice,
      apiKey,
    };
  }

  private nextModel(
    current: StoredVoiceModel,
    draft: VoiceModelDraft | undefined,
  ): StoredVoiceModel {
    if (draft === undefined) return current;
    const voice = draft.voice?.trim();
    return {
      provider: current.provider,
      endpoint:
        draft.endpoint === undefined ? current.endpoint : normalizeEndpoint(draft.endpoint),
      model: draft.model === undefined ? current.model : normalizeText(draft.model),
      voice: voice === undefined || voice === "" ? current.voice : voice,
      apiKeyEncrypted: this.nextKey(draft.apiKey, current.apiKeyEncrypted),
    };
  }

  private nextKey(patch: string | null | undefined, previous: string | null): string | null {
    if (patch === undefined) return previous;
    if (patch === null || patch.trim() === "") return null;
    return this.encrypt(patch.trim());
  }

  private encrypt(value: string): string {
    if (!this.canStoreKey) {
      throw new Error("当前系统无法访问钥匙串，语音 API Key 不会被保存。");
    }
    return safeStorage.encryptString(value).toString("base64");
  }

  private decrypt(encrypted: string): string | null {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      // 钥匙串被重置 / 换了机器：按「没有 Key」处理，让用户重新填。
      return null;
    }
  }

  private read(): StoredVoice {
    try {
      const raw = fs.readFileSync(this.root.voice, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const record = isRecord(parsed) ? parsed : {};
      return {
        version: VERSION,
        tts: readModel(record.tts, "tts"),
        asr: readModel(record.asr, "asr"),
      };
    } catch {
      return {
        version: VERSION,
        tts: defaultModel("tts"),
        asr: defaultModel("asr"),
      };
    }
  }
}

function defaultModel(kind: "tts" | "asr"): StoredVoiceModel {
  return {
    provider: "bailian",
    endpoint: DEFAULT_ENDPOINT,
    model: kind === "tts" ? DEFAULT_TTS_MODEL : DEFAULT_ASR_MODEL,
    voice: kind === "tts" ? DEFAULT_TTS_VOICE : "",
    apiKeyEncrypted: null,
  };
}

function readModel(input: unknown, kind: "tts" | "asr"): StoredVoiceModel {
  const fallback = defaultModel(kind);
  if (!isRecord(input)) return fallback;
  const voice =
    kind !== "tts"
      ? ""
      : typeof input.voice === "string" && input.voice.trim() !== ""
        ? input.voice.trim()
        : fallback.voice;
  return {
    provider: normalizeProvider(input.provider),
    endpoint:
      typeof input.endpoint === "string" ? normalizeEndpoint(input.endpoint) : fallback.endpoint,
    model: typeof input.model === "string" ? normalizeText(input.model) : fallback.model,
    voice,
    apiKeyEncrypted:
      typeof input.apiKeyEncrypted === "string" && input.apiKeyEncrypted !== ""
        ? input.apiKeyEncrypted
        : null,
  };
}

function toTtsPublic(model: StoredVoiceModel): VoiceTtsSettings {
  return {
    provider: model.provider,
    endpoint: model.endpoint,
    model: model.model,
    voice: model.voice,
    hasApiKey: model.apiKeyEncrypted !== null,
  };
}

/** ASR 没有音色，公开结构里也不带这个字段（免得设置页误以为可以填）。 */
function toAsrPublic(model: StoredVoiceModel): VoiceAsrSettings {
  return {
    provider: model.provider,
    endpoint: model.endpoint,
    model: model.model,
    hasApiKey: model.apiKeyEncrypted !== null,
  };
}

function normalizeProvider(input: unknown): VoiceProvider {
  return input === "bailian" ? "bailian" : "bailian";
}

/** 只存域名：用户把 `https://...` 整段贴进来也能用。 */
function normalizeEndpoint(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function normalizeText(value: string): string {
  return value.trim();
}

/** 给冒烟脚本用的默认值（不在公开结构里暴露，只用来对齐断言）。 */
export const VOICE_DEFAULTS = {
  endpoint: DEFAULT_ENDPOINT,
  ttsModel: DEFAULT_TTS_MODEL,
  ttsVoice: DEFAULT_TTS_VOICE,
  asrModel: DEFAULT_ASR_MODEL,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
