import { createRequire } from "node:module";

import { VoiceError } from "./protocol";

/*
 * `aoq-electron-sdk` 是带原生 addon 的 CJS 包（`main` 字段还没有扩展名），main 产物
 * 是 ESM，所以只能经 `createRequire` 在运行时加载。原生 `.node` / `.framework`
 * 由 electron.vite 的 `externalizeDepsPlugin` 保持 external，打包时再从 asar 里解出来。
 *
 * 这里只描述我们用到的接口；enums 以包内 `types/Types.d.ts` 为准（运行时的对象直接透传）。
 */

export interface AoqRelayEndpointLike {
  endpoint: string;
  port: number;
  routeIndex: number;
}

export interface AoqConnectConfigLike {
  token: string;
  sid: string;
  certFingerprint?: string;
  workspaceIdHash?: string;
  relayEndpoints: AoqRelayEndpointLike[];
  publishTracks: { trackType: number }[];
  subscribeTracks: { trackType: number }[];
}

export interface AoqAudioFrameLike {
  numOfSamples: number;
  samplesPerSec: number;
  /** 引擎在没有真实音频时补的静音帧（播放排空看这个标记）。 */
  autoGenMute?: boolean;
}

export interface AoqEngine {
  createEngine(config: { workDir?: string; enableDumpAudio?: boolean; extras?: string }): number;
  destroy(): number;
  getVersion(): string;
  connect(config: AoqConnectConfigLike): number;
  disconnect(): number;
  startAudioCapture(config: { channel?: number; isExternal?: boolean }): number;
  stopAudioCapture(): number;
  muteAudioCapture(mute: boolean): number;
  startAudioPlayer(config: { channel?: number; isExternal?: boolean }): number;
  stopAudioPlayer(): number;
  interruptAudioPlayer(trackType: number, fadeMs: number): number;
  setAudioEncoderConfig(config: {
    trackType?: number;
    codecType?: number;
    sampleRate?: number;
    channel?: number;
    bitrate?: number;
  }): number;
  setAudioDecoderConfig(config: {
    trackType?: number;
    codecType?: number;
    sampleRate?: number;
    channel?: number;
    bitrate?: number;
  }): number;
  sendDataMsg(data: string | Uint8Array): number;
  enableSendMediaStream(trackType: number, enable: boolean): number;
  setAudioFrameObserver(enable: boolean): number;
  enableAudioFrameObserver(params: {
    enabled: boolean;
    audioSource: number;
    sampleRate?: number;
    channels?: number;
  }): number;
  // 原生事件签名按事件名各不相同；调用方按包内类型自证。
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
}

export interface AoqSdk {
  createAoqClientEngine(): AoqEngine;
  AoqTrackType: { AoqTrackTypeAudio: number; AoqTrackTypeVideo: number; AoqTrackTypeData: number };
  AoqEncoderType: { AoqEncoderTypeAudioPCM: number; AoqEncoderTypeAudioOpus: number };
  AoqConnectionStatus: {
    AoqConnectionStatusDisconnected: number;
    AoqConnectionStatusConnecting: number;
    AoqConnectionStatusConnected: number;
    AoqConnectionStatusFailed: number;
  };
  AoqAudioSource: { AoqAudioSourcePlayback: number };
  AoqAudioDeviceStateCode: {
    AoqAudioDeviceRecordStarted: number;
    AoqAudioDeviceRecordFail: number;
    AoqAudioDevicePlayFail: number;
  };
}

let cached: AoqSdk | null = null;

/** 懒加载原生 SDK；加载失败转成可读的 `voice_sdk_unavailable`（而不是进程崩溃）。 */
export function loadAoqSdk(): AoqSdk {
  if (cached !== null) return cached;
  try {
    const require = createRequire(import.meta.url);
    cached = require("aoq-electron-sdk") as AoqSdk;
    return cached;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new VoiceError(
      "voice_sdk_unavailable",
      `语音引擎加载失败（AOQ 原生模块不可用）：${detail}`,
    );
  }
}
