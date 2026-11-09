import type { VoiceErrorCode, VoicePhase, VoiceState } from "@shared/types";
import { createIdleVoiceState } from "@shared/types";

/*
 * 语音协议的纯逻辑层：凭证请求、任务事件、识别结果解析与语音会话状态机。
 *
 * 这里不碰 Electron、不碰 AOQ 实例、不发网络请求——输入输出都是普通对象，
 * 所以 `scripts/p5-voice-protocol-smoke.mjs` 能用百炼文档里的样例直接驱动它。
 * 引擎编排在 `services/voice.ts`。
 */

/** 音频轨的编解码参数：ASR 上行 16k 单声道 Opus，TTS 下行 24k 单声道 Opus。 */
export const VOICE_AUDIO = {
  asrSampleRate: 16000,
  ttsSampleRate: 24000,
  channels: 1,
  opusBitrate: 24000,
} as const;

/** 单次 `continue-task` 的文本上限（文档：20000 字符；这里留足余量按句切）。 */
export const CONTINUE_TASK_MAX_CHARS = 1800;

export class VoiceError extends Error {
  readonly code: VoiceErrorCode;

  constructor(code: VoiceErrorCode, message: string) {
    super(message);
    this.name = "VoiceError";
    this.code = code;
  }
}

export function asVoiceError(
  cause: unknown,
  fallbackCode: VoiceErrorCode = "voice_task_failed",
): VoiceError {
  if (cause instanceof VoiceError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new VoiceError(fallbackCode, message === "" ? "语音调用失败。" : message);
}

export function voiceErrorPayload(cause: unknown): { code: VoiceErrorCode; message: string } {
  const error = asVoiceError(cause);
  return { code: error.code, message: error.message };
}

// —— 1. 连接凭证 ——

export interface CredentialRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: { clientIp?: string };
}

export interface RelayEndpoint {
  endpoint: string;
  port: number;
  routeIndex: number;
}

export interface VoiceCredential {
  token: string;
  sid: string;
  certFingerprint?: string;
  relayEndpoints: RelayEndpoint[];
  workspaceIdHash?: string;
  expiresInSecs?: number;
}

/** 百炼网关的建连凭证请求（`POST https://{endpoint}/api/v1/webrtc/inference?model=...`）。 */
export function buildCredentialRequest(input: {
  endpoint: string;
  model: string;
  apiKey: string;
  clientIp?: string;
}): CredentialRequest {
  const host = normalizeHost(input.endpoint);
  const model = input.model.trim();
  const apiKey = input.apiKey.trim();
  if (host === "") throw new VoiceError("voice_not_configured", "语音模型还没有填接入域名。");
  if (model === "") throw new VoiceError("voice_not_configured", "语音模型还没有填模型名称。");
  if (apiKey === "") {
    throw new VoiceError("voice_not_configured", "语音模型还没有填 API Key。");
  }
  const clientIp = input.clientIp?.trim();
  return {
    url: `https://${host}/api/v1/webrtc/inference?model=${encodeURIComponent(model)}`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "x-dashscope-rtc-transport": "moq",
    },
    body: clientIp === undefined || clientIp === "" ? {} : { clientIp },
  };
}

/** 网关响应 → `AoqConnectConfig` 的字段（`route_index` → `routeIndex`）。 */
export function parseCredentialResponse(raw: unknown): VoiceCredential {
  if (!isRecord(raw)) {
    throw new VoiceError("voice_auth_failed", "百炼没有返回连接凭证（响应不是 JSON 对象）。");
  }
  const token = str(raw.aoqTokenForClient);
  const sid = str(raw.sid);
  if (token === "" || sid === "") {
    const detail = str(raw.message) || str(raw.error_message) || str(raw.code);
    throw new VoiceError(
      "voice_auth_failed",
      detail === ""
        ? "百炼没有返回连接凭证：检查 API Key、接入域名和模型名称。"
        : `百炼拒绝换取连接凭证：${detail}`,
    );
  }

  const endpoints = Array.isArray(raw.clientRelayEndpoints)
    ? raw.clientRelayEndpoints.flatMap((item): RelayEndpoint[] => {
        if (!isRecord(item)) return [];
        const endpoint = str(item.endpoint);
        const port = Number(item.port);
        if (endpoint === "" || !Number.isFinite(port) || port <= 0) return [];
        const routeIndex = Number(item.route_index);
        return [
          {
            endpoint,
            port: Math.round(port),
            routeIndex: Number.isFinite(routeIndex) ? Math.round(routeIndex) : 0,
          },
        ];
      })
    : [];
  if (endpoints.length === 0) {
    throw new VoiceError("voice_auth_failed", "百炼没有返回可用的 Relay 接入点。");
  }

  const extra = isRecord(raw.extraInfo) ? raw.extraInfo : {};
  const credential: VoiceCredential = { token, sid, relayEndpoints: endpoints };
  const fingerprint = str(raw.clientRelayCertFingerprint);
  if (fingerprint !== "") credential.certFingerprint = fingerprint;
  const workspaceIdHash = str(extra.workspaceIdHash);
  if (workspaceIdHash !== "") credential.workspaceIdHash = workspaceIdHash;
  const expires = Number(raw.sidExpiresInSecs);
  if (Number.isFinite(expires) && expires > 0) credential.expiresInSecs = Math.round(expires);
  return credential;
}

/** HTTP 失败时把网关的话翻成可读错误（Key 只在请求头里，错误文本不含它）。 */
export function credentialHttpError(status: number, body: string): VoiceError {
  const detail = readErrorMessage(body);
  if (status === 401 || status === 403) {
    return new VoiceError(
      "voice_auth_failed",
      `百炼拒绝了这组 API Key（HTTP ${status}）${detail === "" ? "，去设置里检查语音模型。" : `：${detail}`}`,
    );
  }
  if (status === 404) {
    return new VoiceError(
      "voice_auth_failed",
      "这个接入域名上没有 AOQ 接入点（HTTP 404）：填业务空间域名，例如 {WorkspaceId}.cn-beijing.maas.aliyuncs.com（试用可用 trial.cn-beijing.maas.aliyuncs.com）。",
    );
  }
  return new VoiceError(
    "voice_auth_failed",
    `换取语音连接凭证失败（HTTP ${status}）${detail === "" ? "。" : `：${detail}`}`,
  );
}

// —— 2. 任务事件 ——

export type VoiceTaskKind = "tts" | "asr";

export interface WireTaskEvent {
  header: {
    action: "run-task" | "continue-task" | "finish-task";
    task_id: string;
    streaming: "duplex";
  };
  payload: Record<string, unknown>;
}

export function buildRunTask(input: {
  taskId: string;
  kind: VoiceTaskKind;
  model: string;
  voice?: string;
}): WireTaskEvent {
  const model = input.model.trim();
  if (model === "") throw new VoiceError("voice_not_configured", "语音模型还没有填模型名称。");
  if (input.kind === "asr") {
    return {
      header: { action: "run-task", task_id: input.taskId, streaming: "duplex" },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model,
        parameters: { format: "pcm", sample_rate: VOICE_AUDIO.asrSampleRate },
        input: {},
      },
    };
  }
  const voice = input.voice?.trim();
  if (voice === undefined || voice === "") {
    throw new VoiceError("voice_not_configured", "语音合成还没有选音色。");
  }
  return {
    header: { action: "run-task", task_id: input.taskId, streaming: "duplex" },
    payload: {
      task_group: "audio",
      task: "tts",
      function: "SpeechSynthesizer",
      model,
      parameters: {
        text_type: "PlainText",
        voice,
        format: "pcm",
        sample_rate: VOICE_AUDIO.ttsSampleRate,
      },
      input: {},
    },
  };
}

export function buildContinueTask(taskId: string, text: string): WireTaskEvent {
  const trimmed = text.trim();
  if (trimmed === "") throw new VoiceError("voice_task_failed", "没有可合成的文本。");
  return {
    header: { action: "continue-task", task_id: taskId, streaming: "duplex" },
    payload: { input: { text: trimmed } },
  };
}

export function buildFinishTask(taskId: string): WireTaskEvent {
  return {
    header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
    payload: { input: {} },
  };
}

/**
 * 助手回复是 Markdown：直接念会把「星号」「井号」「链接地址」也读出来。
 * TTS 只念人话——去掉标题 / 强调 / 链接 / 列表 / 代码围栏 / HTML 标签。
 */
export function toSpeechText(markdown: string): string {
  let text = markdown;
  // 代码块保留内容（面试里很少出现），围栏本身不念。
  text = text.replace(/```[\w-]*\n?([\s\S]*?)```/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");
  text = text.replace(/^\s*([-*_]\s*){3,}$/gm, "");
  // 强调：不在单词中间匹配下划线（避免把 job_id 念成 jobid）。
  text = text.replace(/(?<!\w)(\*\*|__)(?=\S)([\s\S]*?\S)\1(?!\w)/g, "$2");
  text = text.replace(/(?<!\w)(\*|_)(?=\S)([^*_]+?)(?<=\S)\1(?!\w)/g, "$2");
  text = text.replace(/<[^>]+>/g, "");
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** 按句切分长文本：一条 continue-task 最多 1800 字符，句末标点优先断开。 */
export function chunkText(text: string, maxChars = CONTINUE_TASK_MAX_CHARS): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized === "") return [];
  const sentences = normalized.match(/[^。！？!?；;.\n]+[。！？!?；;.]?/g) ?? [normalized];
  const chunks: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence === "") continue;
    if (sentence.length > maxChars) {
      if (current !== "") {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < sentence.length; i += maxChars) {
        chunks.push(sentence.slice(i, i + maxChars));
      }
      continue;
    }
    if (current.length + sentence.length > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

// —— 3. 服务端事件 ——

export interface SentenceUpdate {
  sentenceId: number;
  text: string;
  begin: boolean;
  end: boolean;
  heartbeat: boolean;
}

export type VoiceServerEvent =
  | { type: "task-started"; taskId: string }
  | {
      type: "result-generated";
      taskId: string;
      sentence: SentenceUpdate | null;
      outputType: string | null;
    }
  | { type: "task-finished"; taskId: string }
  | { type: "task-failed"; taskId: string; code: string; message: string }
  | { type: "unknown"; taskId: string; event: string };

export function parseServerEvent(raw: string | Uint8Array): VoiceServerEvent | null {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  if (text.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.header)) return null;
  const event = str(parsed.header.event);
  const taskId = str(parsed.header.task_id);
  if (event === "") return null;

  switch (event) {
    case "task-started":
      return { type: "task-started", taskId };
    case "task-finished":
      return { type: "task-finished", taskId };
    case "task-failed":
      return {
        type: "task-failed",
        taskId,
        code: str(parsed.header.error_code) || "TASK_FAILED",
        message: str(parsed.header.error_message) || "语音任务失败。",
      };
    case "result-generated":
      return {
        type: "result-generated",
        taskId,
        sentence: readSentence(parsed.payload),
        outputType: readOutputType(parsed.payload),
      };
    default:
      return { type: "unknown", taskId, event };
  }
}

/** 从 `payload.output.sentence`（有时多包一层 `payload.output.output.sentence`）取识别结果。 */
export function readSentence(payload: unknown): SentenceUpdate | null {
  const output = isRecord(payload) && isRecord(payload.output) ? payload.output : null;
  if (output === null) return null;
  const nested = isRecord(output.output) && isRecord(output.output.sentence) ? output.output : null;
  const sentence = isRecord(output.sentence)
    ? output.sentence
    : nested !== null && isRecord(nested.sentence)
      ? nested.sentence
      : null;
  if (sentence === null) return null;
  const id = Number(sentence.sentence_id);
  return {
    sentenceId: Number.isFinite(id) ? Math.round(id) : 0,
    text: str(sentence.text),
    begin: sentence.sentence_begin === true,
    end: sentence.sentence_end === true,
    heartbeat: sentence.heartbeat === true,
  };
}

function readOutputType(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.output)) return null;
  const type = str(payload.output.type);
  return type === "" ? null : type;
}

/**
 * 按 `sentence_id` 合并同一句的中间结果：
 * - `sentence_end=false` 覆盖同一句的文本（长句会多次刷新）；
 * - `sentence_end=true` 定稿，之后这句不再变；
 * - 心跳包（`heartbeat=true`，`sentence_id=0`）直接跳过。
 */
export class SentenceAccumulator {
  private readonly sentences = new Map<number, { text: string; final: boolean }>();

  apply(update: SentenceUpdate): TranscriptUpdate {
    if (update.heartbeat) return { ...this.snapshot(), heartbeat: true, final: false };
    const text = update.text.trim();
    const existing = this.sentences.get(update.sentenceId);
    if (text !== "") {
      this.sentences.set(update.sentenceId, { text, final: update.end });
    } else if (update.end) {
      this.sentences.set(update.sentenceId, { text: existing?.text ?? "", final: true });
    }
    return { ...this.snapshot(), heartbeat: false, final: update.end };
  }

  get transcript(): string {
    return this.snapshot().transcript;
  }

  /** 结束一轮时把还没等到 sentence_end 的句子也算定稿，避免丢掉最后半句。 */
  finalizeAll(): void {
    for (const [id, sentence] of this.sentences) {
      if (!sentence.final) this.sentences.set(id, { ...sentence, final: true });
    }
  }

  reset(): void {
    this.sentences.clear();
  }

  private snapshot(): { interim: string; transcript: string } {
    const ordered = [...this.sentences.entries()].sort((a, b) => a[0] - b[0]);
    let interim = "";
    let transcript = "";
    for (const [, sentence] of ordered) {
      interim += sentence.text;
      if (sentence.final) transcript += sentence.text;
    }
    return { interim, transcript };
  }
}

export interface TranscriptUpdate {
  /** 含未定稿句子的实时文本（界面上的「正在听…」）。 */
  interim: string;
  /** 只含已定稿句子。 */
  transcript: string;
  final: boolean;
  heartbeat: boolean;
}

// —— 4. 语音会话状态机 ——

export type VoiceStateAction =
  | { type: "phase"; phase: VoicePhase; speech?: string | null }
  | { type: "transcript"; interim: string; transcript: string }
  | { type: "error"; code: VoiceErrorCode; message: string }
  | { type: "reset" };

export function reduceVoiceState(state: VoiceState, action: VoiceStateAction): VoiceState {
  switch (action.type) {
    case "phase":
      return {
        ...state,
        phase: action.phase,
        speech: action.speech === undefined ? (action.phase === "speaking" ? state.speech : null) : action.speech,
        error: action.phase === "error" ? state.error : null,
        errorCode: action.phase === "error" ? state.errorCode : null,
        updatedAt: Date.now(),
      };
    case "transcript":
      return {
        ...state,
        interim: action.interim,
        transcript: action.transcript,
        updatedAt: Date.now(),
      };
    case "error":
      return {
        ...state,
        phase: "error",
        speech: null,
        error: action.message,
        errorCode: action.code,
        updatedAt: Date.now(),
      };
    case "reset":
      return createIdleVoiceState();
  }
}

/** 语音会话是否正占用引擎（用于挡住并发的朗读 / 聆听）。 */
export function isVoiceActive(state: VoiceState): boolean {
  return (
    state.phase === "connecting" ||
    state.phase === "speaking" ||
    state.phase === "listening" ||
    state.phase === "recognizing"
  );
}

function normalizeHost(endpoint: string): string {
  return endpoint
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function readErrorMessage(body: string): string {
  if (body.trim() === "") return "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const message = str(parsed.message) || str(parsed.error_message) || str(parsed.error);
      const code = str(parsed.code);
      if (message !== "") return code === "" ? message : `${code}：${message}`;
      if (code !== "") return code;
    }
  } catch {
    // 不是 JSON：截一段原文即可。
  }
  return body.slice(0, 200).trim();
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
