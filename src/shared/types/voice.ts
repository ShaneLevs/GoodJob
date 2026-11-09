/**
 * 语音模型（TTS / ASR）设置与语音会话状态。
 *
 * 设置和 `models.json` 同一套纪律：全局一份、放配置根目录、API Key 是 safeStorage 密文，
 * 渲染层只看得到 `hasApiKey`。语音会话本身不落盘——音频只在 main 里进出 AOQ 引擎。
 */

export type VoiceProvider = "bailian";

/** 两个方向：识别（ASR）与合成（TTS）。 */
export type VoiceKind = "tts" | "asr";

/** 从百炼 `GET /api/v1/models` 读到的候选模型。 */
export interface VoiceModelOption {
  /** 请求里 `model` 字段用的 ID。 */
  id: string;
  /** 展示名，例如 `Qwen-Audio-3.1-ASR-Flash-Streaming`。 */
  name: string;
  description: string;
}

/** 一个可用的音色；TTS 设置页用下拉选择，不用手填。 */
export interface VoiceVoiceOption {
  id: string;
  name: string;
  /** 性别 / 特质 / 语言拼成的一句话，列表里做副标题。 */
  description: string;
}

export interface VoiceVoiceCatalog {
  model: string;
  voices: VoiceVoiceOption[];
  /** official = 官方音色列表页面；builtin = 页面取不到时的内置快照。 */
  source: "official" | "builtin";
  /** 用了内置快照时的原因，设置页原样显示。 */
  warning: string | null;
}

/** 一份语音配置（TTS / ASR 共用形状）。 */
export interface VoiceModelConfig {
  provider: VoiceProvider;
  /** 接入域名，不带协议，例如 `dashscope.aliyuncs.com`。 */
  endpoint: string;
  model: string;
}

export interface VoiceTtsSettings extends VoiceModelConfig {
  /** 音色 id，例如 `longanlingxi`。 */
  voice: string;
  hasApiKey: boolean;
}

export interface VoiceAsrSettings extends VoiceModelConfig {
  hasApiKey: boolean;
}

/** macOS / Windows 的麦克风授权状态（Electron `getMediaAccessStatus` 的取值）。 */
export type VoiceMicrophoneAccess =
  | "granted"
  | "denied"
  | "restricted"
  | "not-determined"
  | "unknown";

export interface VoiceReadyState {
  tts: boolean;
  asr: boolean;
  /** 一场语音面试要能朗读 + 识别，两块都配好才算可用。 */
  interview: boolean;
}

export interface VoiceSettings {
  version: number;
  tts: VoiceTtsSettings;
  asr: VoiceAsrSettings;
  canStoreKey: boolean;
  ready: VoiceReadyState;
  /** 麦克风权限：语音面试开始采集前要先过这一关。 */
  microphone: VoiceMicrophoneAccess;
  /** 原生 AOQ SDK 版本；没装 / 加载失败为 null（原因在 sdkError）。 */
  sdkVersion: string | null;
  sdkError: string | null;
}

export interface VoiceModelDraft {
  endpoint?: string;
  model?: string;
  voice?: string;
  /** undefined = 保持原 Key；null / 空串 = 清除；其它 = 换成新的。 */
  apiKey?: string | null;
}

export interface VoiceSettingsDraft {
  tts?: VoiceModelDraft;
  asr?: VoiceModelDraft;
}

/** 语音会话阶段：界面上要能区分这几种状态。 */
export type VoicePhase =
  | "idle"
  | "connecting"
  | "speaking"
  | "listening"
  | "recognizing"
  | "error";

export type VoiceErrorCode =
  | "voice_not_configured"
  | "voice_sdk_unavailable"
  | "voice_auth_failed"
  | "voice_connect_failed"
  | "voice_task_failed"
  | "voice_microphone_failed"
  | "voice_busy"
  | "voice_timeout";

export interface VoiceState {
  phase: VoicePhase;
  /** 正在朗读的文本（界面提示用，截断后才推给渲染层）。 */
  speech: string | null;
  /** 当前这句还没定稿的识别文本。 */
  interim: string;
  /** 已定稿的识别文本（按句顺序拼接）。 */
  transcript: string;
  error: string | null;
  errorCode: VoiceErrorCode | null;
  updatedAt: number;
}

/** 一次聆听结束后返回的定稿文本（空串 = 没识别到）。 */
export interface VoiceListenResult {
  text: string;
}

export function createIdleVoiceState(): VoiceState {
  return {
    phase: "idle",
    speech: null,
    interim: "",
    transcript: "",
    error: null,
    errorCode: null,
    updatedAt: Date.now(),
  };
}
