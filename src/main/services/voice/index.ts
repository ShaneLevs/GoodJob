import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { systemPreferences } from "electron";

import type { VoiceListenResult, VoiceMicrophoneAccess, VoiceState } from "@shared/types";
import { createIdleVoiceState } from "@shared/types";

import type { ResolvedVoiceModel, SdkStatus, VoiceSettingsStore } from "../../stores/voice";
import { VoiceError, asVoiceError } from "./protocol";
import {
  SentenceAccumulator,
  VOICE_AUDIO,
  buildContinueTask,
  buildCredentialRequest,
  buildFinishTask,
  buildRunTask,
  chunkText,
  credentialHttpError,
  isVoiceActive,
  parseCredentialResponse,
  parseServerEvent,
  reduceVoiceState,
  toSpeechText,
} from "./protocol";
import { loadAoqSdk, type AoqEngine, type AoqSdk } from "./sdk";

/*
 * 语音服务（main）：把「百炼换凭证 → AOQ 建连 → 发任务事件 → 收识别/播放」编成
 * 两步对外的动作——`speak(text)` 朗读一段，`startListening()/stopListening()` 收一轮回答。
 *
 * 为什么两条连接：建连凭证是按模型签发的（TTS 与 ASR 各一次），而原生引擎的连接
 * 是单条会话；所以一轮问答里先连 TTS（订阅 Audio 播放）、断开，再连 ASR（发布 Audio
 * 采集）。这也让麦克风只在「聆听」阶段真正打开，不会在朗读时把扬声器声音录回去。
 *
 * 这里只做编排；协议构造 / 解析在 `protocol.ts`（可被冒烟脚本直接驱动）。
 */

/** 一次任务事件等待的超时（毫秒）。 */
const TIMEOUTS = {
  connect: 15000,
  taskStarted: 15000,
  ttsFinished: 90000,
  asrFinished: 12000,
  credential: 15000,
} as const;

/** 播放排空的兜底：没有帧回调时按字数估算（中文约 190ms/字）。 */
const PLAYBACK_FALLBACK_MS_PER_CHAR = 190;
const PLAYBACK_MAX_WAIT_MS = 20000;
/** 真实音频转成自动静音后再等一小段，确认不是缓冲抖动造成的空隙。 */
const PLAYBACK_TAIL_MS = 250;

interface VoiceServiceDeps {
  settings: VoiceSettingsStore;
  /** 引擎工作目录（日志 / 临时文件），随工作区 cache 走。 */
  workDir: () => string;
  /** 状态推给渲染层（main → 窗口）。 */
  emit: (state: VoiceState) => void;
  /** 原生 SDK 加载器（冒烟脚本注入假引擎；生产走 loadAoqSdk）。 */
  sdk?: () => AoqSdk;
  /** 麦克风权限读取 / 申请（冒烟脚本可注入；生产走 systemPreferences）。 */
  micAccess?: () => VoiceMicrophoneAccess;
  requestMic?: () => Promise<boolean>;
  /** 等系统授权框的超时（默认 60s；冒烟脚本可调小）。 */
  micTimeoutMs?: number;
}

type TaskEventName = "task-started" | "task-finished";

interface TaskWaiter {
  event: TaskEventName;
  /** 只认当前任务的 task_id：上一条连接迟到的 task-finished 不能收掉新任务。 */
  taskId: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 取消哨兵：stopAll / 切换面试时让在途 await 静默退出，不弹错误。 */
class VoiceCancelled extends Error {}

export class VoiceService {
  private readonly deps: VoiceServiceDeps;
  private state: VoiceState = createIdleVoiceState();
  private engine: AoqEngine | null = null;
  /** 事件只挂一次：`createAoqClientEngine()` 是 JS 单例，destroy 后包装器还活着。 */
  private listenerEngine: AoqEngine | null = null;
  private sdkCache: SdkStatus | null = null;
  private currentKind: "tts" | "asr" | null = null;
  private capturing = false;
  /** 采集是否真的进了 RecordStarted：没进说明系统权限还没答复，原生 destroy 会卡住。 */
  private captureStarted = false;
  private accumulator = new SentenceAccumulator();
  /** 当前任务的 task_id（finish-task 要用）。 */
  private taskId: string | null = null;
  private taskWaiters: TaskWaiter[] = [];
  private connectWaiter:
    | {
        resolve: () => void;
        reject: (error: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | null = null;
  /** 等 disconnect 真正落地，避免紧接着的 connect 和上一次断开抢状态。 */
  private disconnectWaiter: (() => void) | null = null;
  /** 每次 speak / listen 递增；stopAll 也递增，抵消在途操作。 */
  private token = 0;
  /**
   * 播放帧统计（判断 TTS 音频什么时候真的放完）。
   * `samples` 只算真实音频；引擎在没有音频时仍会持续回调 `autoGenMute` 静音帧，
   * 所以不能用「播放时长 ≥ 音频时长」判断排空，要看真实音频是否已经转静音。
   */
  private playout = { samples: 0, startedAt: 0, endedAt: 0, sawAudible: false };
  /** 帧回调是否真的开启成功：开启后一帧都没有 = 网关没给音频，不能假装成功。 */
  private frameObserverReady = false;

  private readonly sdkLoader: () => AoqSdk;
  private readonly micAccess: () => VoiceMicrophoneAccess;
  private readonly requestMic: () => Promise<boolean>;

  constructor(deps: VoiceServiceDeps) {
    this.deps = deps;
    this.sdkLoader = deps.sdk ?? loadAoqSdk;
    this.micAccess = deps.micAccess ?? readMicrophoneAccess;
    this.requestMic = deps.requestMic ?? requestMicrophoneAccess;
  }

  /** 当前麦克风授权状态（设置页展示；采集前也会用它做预检）。 */
  microphoneAccess(): VoiceMicrophoneAccess {
    return this.micAccess();
  }

  /** 显式请求麦克风权限（macOS 会弹系统授权框）；返回最终是否可用。 */
  async requestMicrophoneAccess(): Promise<boolean> {
    if (this.micAccess() === "granted") return true;
    return this.requestMic();
  }

  getState(): VoiceState {
    return { ...this.state };
  }

  sdkStatus(): SdkStatus {
    if (this.sdkCache !== null) return this.sdkCache;
    try {
      const version = this.sdkLoader().createAoqClientEngine().getVersion();
      this.sdkCache = { version: version === "" ? null : version, error: null };
    } catch (cause) {
      this.sdkCache = {
        version: null,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    return this.sdkCache;
  }

  /** 设置页「试听」：用已存 TTS 配置读一句。 */
  async preview(text: string): Promise<void> {
    await this.speak(text);
  }

  /** 朗读一段文本（面试官这一轮回复）。 */
  async speak(text: string): Promise<void> {
    // 只念人话：Markdown 的星号 / 井号 / 链接地址不进 TTS。
    const trimmed = toSpeechText(text);
    if (trimmed === "") return;
    if (isVoiceActive(this.state)) {
      throw new VoiceError("voice_busy", "语音通道还在用：等这一轮结束，或先点停止。");
    }
    const target = this.deps.settings.resolveTts();
    if (target === null) throw notConfigured("语音合成（TTS）");

    const token = ++this.token;
    this.setPhase("connecting");
    try {
      await this.runSpeak(target, trimmed, token);
      this.check(token);
      this.setPhase("idle");
    } catch (cause) {
      if (cause instanceof VoiceCancelled) return;
      const error = asVoiceError(cause);
      if (token === this.token) this.setError(error);
      throw error;
    } finally {
      if (token === this.token) await this.teardown(false);
    }
  }

  /** 中断朗读：停播放 + 断连，相位回 idle。 */
  stopSpeaking(): void {
    this.token += 1;
    const engine = this.engine;
    if (engine !== null) {
      try {
        engine.interruptAudioPlayer(this.sdk().AoqTrackType.AoqTrackTypeAudio, 0);
      } catch {
        // 已断开时 interrupt 会失败：忽略，teardown 仍会收尾。
      }
    }
    void this.teardown(false);
    this.setPhase("idle");
  }

  /** 打开麦克风，开始一轮流式识别。 */
  async startListening(): Promise<void> {
    if (this.state.phase === "listening") return;
    if (isVoiceActive(this.state) || this.state.phase === "connecting") {
      throw new VoiceError("voice_busy", "语音通道还在用：等这一轮结束，或先点停止。");
    }
    const target = this.deps.settings.resolveAsr();
    if (target === null) throw notConfigured("语音识别（ASR）");

    const token = ++this.token;
    this.setPhase("connecting");
    try {
      // 先过系统权限：没授权时直接给可操作的提示，不要等原生采集失败再猜。
      // 放在 connecting 之后：授权框等待期间界面能显示「等待授权」。
      await this.ensureMicrophoneAccess();
      this.check(token);
      await this.runListen(target, token);
      this.check(token);
      this.setPhase("listening");
    } catch (cause) {
      if (cause instanceof VoiceCancelled) return;
      const error = asVoiceError(cause, "voice_task_failed");
      if (token === this.token) this.setError(error);
      await this.teardown(false);
      throw error;
    }
  }

  /** 结束这一轮聆听：等最后一批识别结果回来，返回定稿文本。 */
  async stopListening(): Promise<VoiceListenResult> {
    if (this.currentKind !== "asr") {
      return { text: this.accumulator.transcript };
    }
    const token = ++this.token;
    this.setPhase("recognizing");
    const engine = this.engine;
    if (engine !== null) {
      try {
        engine.enableSendMediaStream(this.sdk().AoqTrackType.AoqTrackTypeAudio, false);
      } catch {
        // 采集可能已经停了：继续走 finish-task。
      }
    }
    try {
      if (engine !== null && this.taskId !== null) {
        this.send(buildFinishTask(this.taskId));
        await this.waitTask("task-finished", TIMEOUTS.asrFinished, this.taskId);
      }
    } catch (cause) {
      const error = asVoiceError(cause, "voice_timeout");
      const text = this.accumulator.transcript.trim();
      if (text === "") {
        this.setError(error);
        await this.teardown(false);
        throw error;
      }
      // 已有定稿文本：超时也把它交出去，别让用户白说一遍。
    } finally {
      if (token === this.token) {
        this.taskId = null;
        await this.teardown(false);
      }
    }
    // 用户可能在句子中途点「完成回答」：没等到 sentence_end 的半句也要算数。
    this.accumulator.finalizeAll();
    const text = this.accumulator.transcript.trim();
    this.accumulator.reset();
    if (token === this.token) {
      this.state = { ...this.state, interim: "", transcript: "" };
      this.setPhase("idle");
    }
    return { text };
  }

  /** 停采集 / 停朗读 / 断开连接 / 销毁引擎（切面试、结束面试、关窗）。 */
  async stopAll(): Promise<void> {
    this.token += 1;
    this.taskId = null;
    this.accumulator.reset();
    await this.teardown(true);
    this.state = createIdleVoiceState();
    this.publish();
  }

  /**
   * 退出应用时同步收尾（before-quit 不能等异步）。
   *
   * 这里**不调 destroy()**：麦克风权限没答复时采集会停在 RecordStarting，原生 destroy
   * 会一直阻塞主线程，把退出流程卡死（实测）。进程即将退出，停采集 + 断连已经足够
   * 释放设备，剩下交给操作系统回收。
   */
  dispose(): void {
    this.token += 1;
    this.taskId = null;
    const engine = this.engine;
    if (engine !== null) {
      // 采集卡在 RecordStarting（权限未答复）时 destroy 会阻塞主线程；这时保留引擎，
      // 窗口重新打开后复用同一条原生实例，不再调一次 createEngine。
      const stuckCapture = this.capturing && !this.captureStarted;
      try {
        engine.enableSendMediaStream(this.sdk().AoqTrackType.AoqTrackTypeAudio, false);
      } catch {
        // ignore
      }
      try {
        engine.stopAudioCapture();
      } catch {
        // ignore
      }
      try {
        engine.stopAudioPlayer();
      } catch {
        // ignore
      }
      try {
        engine.disconnect();
      } catch {
        // ignore
      }
      this.capturing = false;
      this.captureStarted = false;
      if (!stuckCapture) {
        // 退出流程不再等原生 destroy 的异步收尾；这里调用是安全的（采集正常）。
        try {
          engine.destroy();
        } catch {
          // ignore
        }
        this.engine = null;
      }
    }
    this.currentKind = null;
    this.accumulator.reset();
    this.state = createIdleVoiceState();
    this.publish();
    this.rejectAll(new VoiceError("voice_task_failed", "语音会话已结束。"));
  }

  // —— 编排 ——

  private async runSpeak(
    target: ResolvedVoiceModel,
    text: string,
    token: number,
  ): Promise<void> {
    const { engine, sdk } = this.ensureEngine();
    const audio = sdk.AoqTrackType.AoqTrackTypeAudio;
    const data = sdk.AoqTrackType.AoqTrackTypeData;

    // 先换凭证：Key / 域名不对时不必去动音频设备。
    const credential = await this.fetchCredential(target, token);
    this.check(token);

    const decoder = engine.setAudioDecoderConfig({
      trackType: audio,
      codecType: sdk.AoqEncoderType.AoqEncoderTypeAudioOpus,
      sampleRate: VOICE_AUDIO.ttsSampleRate,
      channel: VOICE_AUDIO.channels,
    });
    if (decoder !== 0) {
      throw new VoiceError("voice_task_failed", `音频解码器初始化失败（错误码 ${decoder}）。`);
    }
    const player = engine.startAudioPlayer({ channel: VOICE_AUDIO.channels });
    if (player !== 0) {
      throw new VoiceError("voice_task_failed", `音频播放器启动失败（错误码 ${player}）。`);
    }
    this.playout = { samples: 0, startedAt: 0, endedAt: 0, sawAudible: false };

    this.currentKind = "tts";
    this.accumulator.reset();
    const connectCode = engine.connect({
      token: credential.token,
      sid: credential.sid,
      certFingerprint: credential.certFingerprint,
      workspaceIdHash: credential.workspaceIdHash,
      relayEndpoints: credential.relayEndpoints,
      publishTracks: [{ trackType: data }],
      subscribeTracks: [{ trackType: audio }, { trackType: data }],
    });
    if (connectCode !== 0) {
      throw new VoiceError("voice_connect_failed", `语音连接失败（错误码 ${connectCode}）。`);
    }
    await this.waitConnected(token);

    const taskId = randomUUID();
    this.taskId = taskId;
    this.send(
      buildRunTask({ taskId, kind: "tts", model: target.model, voice: target.voice }),
    );
    await this.waitTask("task-started", TIMEOUTS.taskStarted, taskId);
    this.setPhase("speaking", truncate(text));
    for (const chunk of chunkText(text)) {
      this.send(buildContinueTask(taskId, chunk));
    }
    this.send(buildFinishTask(taskId));
    await this.waitTask("task-finished", TIMEOUTS.ttsFinished, taskId);
    this.taskId = null;
    // 任务结束却一帧音频都没有：网关/模型没真正合成，不能当成功返回。
    if (this.frameObserverReady && this.playout.samples === 0) {
      await sleep(900);
      this.check(token);
      if (this.playout.samples === 0) {
        throw new VoiceError(
          "voice_task_failed",
          "语音服务没有返回音频数据：确认 TTS 模型与音色匹配，或换一个音色再试。",
        );
      }
    }
    await this.drainPlayback(text.length, token);
  }

  private async ensureMicrophoneAccess(): Promise<void> {
    const access = this.micAccess();
    if (access === "granted" || access === "unknown") return;
    if (access === "not-determined") {
      // 系统授权框可能被晾着：等太久就收尾，别让界面永远停在「等待授权」。
      const granted = await withTimeout(this.requestMic(), this.deps.micTimeoutMs ?? 60000);
      if (!granted) {
        throw new VoiceError(
          "voice_microphone_failed",
          microphoneHint("没有获得麦克风权限（或等待授权超时）"),
        );
      }
      return;
    }
    throw new VoiceError("voice_microphone_failed", microphoneHint("麦克风权限被拒绝"));
  }

  private async runListen(target: ResolvedVoiceModel, token: number): Promise<void> {
    const { engine, sdk } = this.ensureEngine();
    const audio = sdk.AoqTrackType.AoqTrackTypeAudio;
    const data = sdk.AoqTrackType.AoqTrackTypeData;

    // 先换凭证：没配好 / Key 无效时不要先打开麦克风。
    const credential = await this.fetchCredential(target, token);
    this.check(token);

    const encoder = engine.setAudioEncoderConfig({
      trackType: audio,
      codecType: sdk.AoqEncoderType.AoqEncoderTypeAudioOpus,
      sampleRate: VOICE_AUDIO.asrSampleRate,
      channel: VOICE_AUDIO.channels,
      bitrate: VOICE_AUDIO.opusBitrate,
    });
    if (encoder !== 0) {
      throw new VoiceError("voice_task_failed", `音频编码器初始化失败（错误码 ${encoder}）。`);
    }

    this.captureStarted = false;
    const capture = engine.startAudioCapture({
      channel: VOICE_AUDIO.channels,
      isExternal: false,
    });
    if (capture !== 0) {
      throw new VoiceError(
        "voice_microphone_failed",
        `麦克风启动失败（错误码 ${capture}）：检查系统麦克风权限后重试。`,
      );
    }
    this.capturing = true;
    // 收到 task-started 之前不上行音频（文档要求）。
    engine.enableSendMediaStream(audio, false);

    const connectCode = engine.connect({
      token: credential.token,
      sid: credential.sid,
      certFingerprint: credential.certFingerprint,
      workspaceIdHash: credential.workspaceIdHash,
      relayEndpoints: credential.relayEndpoints,
      publishTracks: [{ trackType: audio }, { trackType: data }],
      subscribeTracks: [{ trackType: data }],
    });
    if (connectCode !== 0) {
      throw new VoiceError("voice_connect_failed", `语音连接失败（错误码 ${connectCode}）。`);
    }
    await this.waitConnected(token);

    const taskId = randomUUID();
    this.currentKind = "asr";
    this.accumulator.reset();
    this.taskId = taskId;
    this.send(buildRunTask({ taskId, kind: "asr", model: target.model }));
    await this.waitTask("task-started", TIMEOUTS.taskStarted, taskId);
    engine.enableSendMediaStream(audio, true);
  }

  // —— 引擎与事件 ——

  private ensureEngine(): { engine: AoqEngine; sdk: AoqSdk } {
    const sdk = this.sdkLoader();
    if (this.engine !== null) return { engine: this.engine, sdk };

    const dir = this.deps.workDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const engine = sdk.createAoqClientEngine();
    const code = engine.createEngine({ workDir: dir, enableDumpAudio: false });
    if (code !== 0) {
      throw new VoiceError("voice_sdk_unavailable", `语音引擎初始化失败（错误码 ${code}）。`);
    }

    if (this.listenerEngine !== engine) {
      engine.on("onConnectionStatusChange", (status: number) => this.onConnectionStatus(status));
      engine.on("onDataMsg", (data: Uint8Array) => this.onDataMsg(data));
      engine.on("onError", (code: number, message: string) =>
        this.fail(
          new VoiceError("voice_task_failed", `语音引擎错误 ${code}：${message || "未知错误"}`),
        ),
      );
      engine.on("onAudioDeviceStateChanged", (state: { state: number }) =>
        this.onAudioDeviceState(state),
      );
      engine.on("onPlaybackAudioFrame", (frame: { numOfSamples: number; autoGenMute?: boolean }) => {
        if (frame === null || typeof frame !== "object") return;
        if (frame.autoGenMute === true) {
          // 引擎补的静音帧：真实音频放完后会一直回调。记下转静音的时间点即可。
          if (this.playout.sawAudible) this.playout.endedAt ||= Date.now();
          return;
        }
        // 真实音频（或测试桩帧）：有声音就说明还没排空，清掉转静音的时间点。
        this.playout.sawAudible = true;
        this.playout.endedAt = 0;
        if (this.playout.startedAt === 0) this.playout.startedAt = Date.now();
        this.playout.samples += Math.max(0, Number(frame.numOfSamples) || 0);
      });
      this.listenerEngine = engine;
    }

    try {
      const observer = engine.setAudioFrameObserver(true);
      const enabled = engine.enableAudioFrameObserver({
        enabled: true,
        audioSource: sdk.AoqAudioSource.AoqAudioSourcePlayback,
        sampleRate: VOICE_AUDIO.ttsSampleRate,
        channels: VOICE_AUDIO.channels,
      });
      this.frameObserverReady = observer === 0 && enabled === 0;
    } catch {
      // 帧回调只用来判断播放排空：不可用时退回按字数估算。
      this.frameObserverReady = false;
    }

    this.engine = engine;
    return { engine, sdk };
  }

  private onConnectionStatus(status: number): void {
    const sdk = this.sdk();
    if (status === sdk.AoqConnectionStatus.AoqConnectionStatusConnected) {
      this.settleConnect(null);
      return;
    }
    if (status === sdk.AoqConnectionStatus.AoqConnectionStatusDisconnected) {
      this.disconnectWaiter?.();
    }
    if (
      status === sdk.AoqConnectionStatus.AoqConnectionStatusFailed ||
      status === sdk.AoqConnectionStatus.AoqConnectionStatusDisconnected
    ) {
      if (isVoiceActive(this.state)) {
        this.settleConnect(
          new VoiceError("voice_connect_failed", "语音连接被断开：检查网络后重试。"),
        );
      }
    }
  }

  private onAudioDeviceState(state: { state: number }): void {
    if (!this.capturing || state === null || typeof state !== "object") return;
    const sdk = this.sdk();
    if (state.state === sdk.AoqAudioDeviceStateCode.AoqAudioDeviceRecordStarted) {
      this.captureStarted = true;
      return;
    }
    if (state.state === sdk.AoqAudioDeviceStateCode.AoqAudioDeviceRecordFail) {
      this.fail(
        new VoiceError("voice_microphone_failed", "麦克风采集失败：检查系统麦克风权限后重试。"),
      );
    }
  }

  private onDataMsg(data: Uint8Array): void {
    const event = parseServerEvent(data);
    if (event === null) return;
    switch (event.type) {
      case "task-started":
        this.settleTask("task-started", event.taskId);
        return;
      case "task-finished":
        this.settleTask("task-finished", event.taskId);
        return;
      case "task-failed":
        this.fail(
          new VoiceError(
            "voice_task_failed",
            `语音任务失败（${event.code}）：${event.message}`,
          ),
        );
        return;
      case "result-generated": {
        if (this.currentKind !== "asr" || event.sentence === null) return;
        const update = this.accumulator.apply(event.sentence);
        if (update.heartbeat) return;
        this.state = reduceVoiceState(this.state, {
          type: "transcript",
          interim: update.interim,
          transcript: update.transcript,
        });
        this.publish();
        return;
      }
      default:
        return;
    }
  }

  private sdk(): AoqSdk {
    return this.sdkLoader();
  }

  private async fetchCredential(
    target: ResolvedVoiceModel,
    token: number,
  ): Promise<ReturnType<typeof parseCredentialResponse>> {
    const request = buildCredentialRequest({
      endpoint: target.endpoint,
      model: target.model,
      apiKey: target.apiKey,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUTS.credential);
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new VoiceError(
        "voice_auth_failed",
        `连不上百炼语音网关（${target.endpoint}）：${detail}`,
      );
    } finally {
      clearTimeout(timer);
    }
    this.check(token);
    const body = await response.text();
    if (!response.ok) throw credentialHttpError(response.status, body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new VoiceError("voice_auth_failed", "百炼返回的连接凭证不是 JSON。");
    }
    return parseCredentialResponse(parsed);
  }

  private send(event: { header: { action: string }; payload: unknown }): void {
    const engine = this.engine;
    if (engine === null) throw new VoiceError("voice_connect_failed", "语音引擎未初始化。");
    const code = engine.sendDataMsg(JSON.stringify(event));
    if (code !== 0) {
      throw new VoiceError("voice_task_failed", `发送语音任务事件失败（错误码 ${code}）。`);
    }
  }

  private waitConnected(token: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectWaiter = null;
        reject(new VoiceError("voice_connect_failed", "连接百炼语音网关超时（15 秒）。"));
      }, TIMEOUTS.connect);
      this.connectWaiter = {
        resolve: () => {
          if (token !== this.token) {
            reject(new VoiceCancelled());
            return;
          }
          resolve();
        },
        reject,
        timer,
      };
    });
  }

  private waitTask(event: TaskEventName, timeoutMs: number, taskId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: TaskWaiter = {
        event,
        taskId,
        resolve: () => resolve(),
        reject,
        timer: setTimeout(() => {
          this.taskWaiters = this.taskWaiters.filter((item) => item !== waiter);
          reject(
            new VoiceError(
              "voice_timeout",
              event === "task-started"
                ? "语音服务没有启动任务（等 task-started 超时）。"
                : "等语音服务结束任务超时。",
            ),
          );
        }, timeoutMs),
      };
      this.taskWaiters.push(waiter);
    });
  }

  private settleTask(event: TaskEventName, taskId: string): void {
    const index = this.taskWaiters.findIndex(
      (waiter) => waiter.event === event && (taskId === "" || waiter.taskId === taskId),
    );
    if (index < 0) return;
    const [waiter] = this.taskWaiters.splice(index, 1);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    waiter.resolve();
  }

  private settleConnect(error: unknown): void {
    const waiter = this.connectWaiter;
    if (waiter === null) return;
    this.connectWaiter = null;
    clearTimeout(waiter.timer);
    if (error === null) waiter.resolve();
    else waiter.reject(error);
  }

  private fail(error: VoiceError): void {
    this.rejectAll(error);
    if (isVoiceActive(this.state) || this.state.phase === "connecting") {
      this.setError(error);
    }
  }

  private rejectAll(error: unknown): void {
    this.settleConnect(error);
    const waiters = this.taskWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private async drainPlayback(charCount: number, token: number): Promise<void> {
    const fallback = Math.min(
      PLAYBACK_MAX_WAIT_MS,
      charCount * PLAYBACK_FALLBACK_MS_PER_CHAR + 500,
    );
    const startedAt = Date.now();
    while (true) {
      this.check(token);
      const elapsed = Date.now() - startedAt;
      const audioMs = (this.playout.samples / VOICE_AUDIO.ttsSampleRate) * 1000;
      const playedMs = this.playout.startedAt === 0 ? 0 : Date.now() - this.playout.startedAt;
      if (this.playout.samples > 0) {
        // 引擎会一直回调播放帧：真实音频结束后补的是 autoGenMute 静音帧，
        // 「播放时长 ≥ 音频时长」永远不成立。优先看真实音频是否已经转静音。
        if (this.playout.endedAt > 0) {
          if (Date.now() - this.playout.endedAt >= PLAYBACK_TAIL_MS) return;
        } else if (playedMs >= audioMs + 300) {
          return;
        }
      } else if (elapsed >= fallback) {
        return;
      }
      if (elapsed >= PLAYBACK_MAX_WAIT_MS) return;
      await sleep(80);
    }
  }

  private async teardown(destroy: boolean): Promise<void> {
    const engine = this.engine;
    this.rejectAll(new VoiceCancelled());
    if (engine === null) return;
    // 权限未答复（采集停在 RecordStarting）时原生 destroy 会阻塞主线程；
    // 只停采集 + 断连，保留引擎给下一次使用（连接已经断开，可以重新 connect）。
    const stuckCapture = this.capturing && !this.captureStarted;
    const sdk = this.sdkOrNull();
    if (sdk !== null) {
      try {
        engine.enableSendMediaStream(sdk.AoqTrackType.AoqTrackTypeAudio, false);
      } catch {
        // 已断开：忽略。
      }
    }
    if (this.capturing) {
      try {
        engine.stopAudioCapture();
      } catch {
        // ignore
      }
      this.capturing = false;
    }
    try {
      engine.stopAudioPlayer();
    } catch {
      // ignore
    }
    try {
      engine.disconnect();
    } catch {
      // ignore
    }
    if (!destroy) await this.waitDisconnected(400);
    this.currentKind = null;
    this.captureStarted = false;
    this.playout = { samples: 0, startedAt: 0, endedAt: 0, sawAudible: false };
    if (destroy && !stuckCapture) {
      try {
        engine.destroy();
      } catch {
        // ignore
      }
      this.engine = null;
    }
  }

  private waitDisconnected(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.disconnectWaiter = null;
        resolve();
      }, timeoutMs);
      this.disconnectWaiter = () => {
        clearTimeout(timer);
        this.disconnectWaiter = null;
        resolve();
      };
    });
  }

  private sdkOrNull(): AoqSdk | null {
    try {
      return this.sdkLoader();
    } catch {
      return null;
    }
  }

  private check(token: number): void {
    if (token !== this.token) throw new VoiceCancelled();
  }

  private setPhase(phase: VoiceState["phase"], speech?: string | null): void {
    this.state = reduceVoiceState(this.state, { type: "phase", phase, speech });
    this.publish();
  }

  private setError(error: VoiceError): void {
    this.state = reduceVoiceState(this.state, {
      type: "error",
      code: error.code,
      message: error.message,
    });
    this.publish();
  }

  private publish(): void {
    this.deps.emit({ ...this.state });
  }
}

function withTimeout(promise: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
  });
}

function microphoneHint(headline: string): string {
  const path =
    process.platform === "darwin"
      ? "系统设置 → 隐私与安全性 → 麦克风"
      : "系统设置 → 隐私 → 麦克风";
  return `${headline}：去 ${path} 打开 GoodJob，再回来重试。`;
}

function notConfigured(label: string): VoiceError {
  return new VoiceError(
    "voice_not_configured",
    `还没有配置${label}：去 设置 → Agent 设置 → 语音模型 填好接入域名、模型与 API Key。`,
  );
}

/** 界面上只显示一句提示，不把整段面试官回复塞进状态里。 */
function truncate(text: string, max = 160): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 读系统授权状态；平台不支持 / 读取失败时当作 unknown，交给采集本身报错。 */
function readMicrophoneAccess(): VoiceMicrophoneAccess {
  try {
    const status = systemPreferences.getMediaAccessStatus("microphone");
    if (
      status === "granted" ||
      status === "denied" ||
      status === "restricted" ||
      status === "not-determined"
    ) {
      return status;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function requestMicrophoneAccess(): Promise<boolean> {
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    // 非 macOS / 不支持该 API：交给原生采集自己去要权限。
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
