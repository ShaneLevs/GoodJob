import { ipcMain } from "electron";

import { IPC, type VoiceSettingsDraft } from "@shared/types";

import { fetchVoiceCatalog, fetchVoiceModels } from "../services/voice/catalog";
import { VoiceError } from "../services/voice/protocol";
import type { IpcDeps } from "./deps";

/** 一次朗读最多这么多字（防止渲染层误把整份文档塞进合成任务）。 */
const MAX_SPEAK_CHARS = 20000;

/**
 * 语音模型（TTS / ASR）与语音会话。
 *
 * 所有动作都落到 `VoiceService`：设置读写只在 main 解密 Key，朗读 / 聆听直接驱动
 * AOQ 原生引擎；渲染层拿到的是状态事件与定稿文本，没有音频通路。
 */
export function registerVoiceIpc(deps: IpcDeps): void {
  ipcMain.handle(IPC.voiceSettingsGet, () => deps.voiceSettings.toPublic());
  ipcMain.handle(IPC.voiceSettingsSave, (_event, draft: VoiceSettingsDraft | null) =>
    deps.voiceSettings.save(draft ?? {}),
  );

  // 模型 / 音色清单：用已保存的配置去调官方接口，Key 只在 main 里解密。
  ipcMain.handle(IPC.voiceListModels, async (_event, kind: unknown) => {
    const target = kind === "tts" ? "tts" : kind === "asr" ? "asr" : null;
    if (target === null) {
      throw new VoiceError("voice_task_failed", "未知的语音模型类型。");
    }
    const resolved =
      target === "tts" ? deps.voiceSettings.resolveTts() : deps.voiceSettings.resolveAsr();
    if (resolved === null) {
      throw new VoiceError(
        "voice_not_configured",
        "先填接入域名和 API Key，再从百炼读取模型列表。",
      );
    }
    return fetchVoiceModels(resolved.endpoint, resolved.apiKey, target);
  });

  ipcMain.handle(IPC.voiceListVoices, (_event, model: unknown) => {
    const id = typeof model === "string" ? model.trim() : "";
    if (id === "") {
      throw new VoiceError("voice_task_failed", "先选一个模型，再读音色列表。");
    }
    return fetchVoiceCatalog(id);
  });

  ipcMain.handle(IPC.voiceRequestMic, async () => {
    await deps.voice.requestMicrophoneAccess();
    return deps.voiceSettings.toPublic();
  });

  ipcMain.handle(IPC.voiceGetState, () => deps.voice.getState());

  ipcMain.handle(IPC.voicePreview, (_event, text: unknown) =>
    deps.voice.preview(readText(text, "你好，我是你的面试官。")),
  );
  ipcMain.handle(IPC.voiceSpeak, (_event, text: unknown) =>
    deps.voice.speak(readText(text, "")),
  );
  ipcMain.on(IPC.voiceStopSpeaking, () => deps.voice.stopSpeaking());

  ipcMain.handle(IPC.voiceStartListening, () => deps.voice.startListening());
  ipcMain.handle(IPC.voiceStopListening, () => deps.voice.stopListening());
  ipcMain.handle(IPC.voiceStop, () => deps.voice.stopAll());
}

function readText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  const picked = text === "" ? fallback : text;
  return picked.slice(0, MAX_SPEAK_CHARS);
}
