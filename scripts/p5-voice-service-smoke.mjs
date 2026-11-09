/**
 * P5 语音服务冒烟（jiti 直跑 src/main 的真实 VoiceService + VoiceSettingsStore）：
 *
 * 用假 AOQ 引擎与假网关驱动真实编排代码，不开麦克风、不发网络，覆盖：
 * - 未配置时 `speak` / `startListening` 抛 `voice_not_configured`，一个引擎调用都不发；
 * - ASR：换凭证 → 建连（发布 Audio+Data）→ run-task → task-started 后才开上行 →
 *   result-generated 的中间态 / 定稿进状态 → finish-task → task-finished → 返回定稿文本；
 * - TTS：解码器 / 播放器 / 订阅 Audio → run-task（SpeechSynthesizer）→ continue-task
 *   （按句切）→ finish-task → 等播放排空 → 相位回 idle；
 * - 并发保护（voice_busy）与 stopAll（destroy 引擎、状态回 idle）。
 *
 * 运行：node scripts/p5-voice-service-smoke.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "../node_modules/.pnpm/jiti@2.7.0/node_modules/jiti/lib/jiti.mjs";

const here = new URL(".", import.meta.url).pathname;
const jiti = createJiti(here, {
  alias: {
    electron: path.join(here, "p3-smoke-electron-stub.mjs"),
    "@shared": path.join(here, "..", "src", "shared"),
  },
});

const { VoiceSettingsStore } = await jiti.import("../src/main/stores/voice.ts");
const { VoiceService } = await jiti.import("../src/main/services/voice/index.ts");
const { rootPaths } = await jiti.import("../src/main/workspace/paths.ts");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goodjob-voice-service-"));
const root = rootPaths(tmp);
fs.mkdirSync(root.workspaces, { recursive: true });

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假 AOQ 引擎：记录调用，事件回调按引擎语义触发。 */
function createFakeEngine({ captureStarts = true } = {}) {
  const handlers = new Map();
  const calls = [];
  const sent = [];
  const record = (name, payload) => calls.push({ name, payload });
  let onSend = () => {};

  const engine = {
    createEngine: (config) => (record("createEngine", config), 0),
    destroy: () => (record("destroy"), 0),
    getVersion: () => "1.4.0-fake",
    connect: (config) => {
      record("connect", config);
      // 原生引擎是异步回调；微任务里上报 Connected（此时 waitConnected 已挂上）。
      queueMicrotask(() => emit("onConnectionStatusChange", 2));
      return 0;
    },
    disconnect: () => (record("disconnect"), 0),
    startAudioCapture: (config) => {
      record("startAudioCapture", config);
      if (captureStarts) {
        // 真实引擎是异步回调：采集真正起来了才报 RecordStarted（2）。
        queueMicrotask(() => emit("onAudioDeviceStateChanged", { state: 2 }));
      }
      return 0;
    },
    stopAudioCapture: () => (record("stopAudioCapture"), 0),
    muteAudioCapture: () => 0,
    startAudioPlayer: (config) => (record("startAudioPlayer", config), 0),
    stopAudioPlayer: () => (record("stopAudioPlayer"), 0),
    interruptAudioPlayer: () => 0,
    setAudioEncoderConfig: (config) => (record("setAudioEncoderConfig", config), 0),
    setAudioDecoderConfig: (config) => (record("setAudioDecoderConfig", config), 0),
    sendDataMsg: (data) => {
      const event = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString());
      sent.push(event);
      record("sendDataMsg", event);
      queueMicrotask(() => onSend(event));
      return 0;
    },
    enableSendMediaStream: (trackType, enable) =>
      (record("enableSendMediaStream", { trackType, enable }), 0),
    setAudioFrameObserver: () => 0,
    enableAudioFrameObserver: () => 0,
    on: (event, handler) => handlers.set(event, handler),
    off: (event) => handlers.delete(event),
  };

  const emit = (event, ...args) => {
    const handler = handlers.get(event);
    if (handler) handler(...args);
  };

  return {
    engine,
    calls,
    sent,
    emit,
    setSendHandler(fn) {
      onSend = fn;
    },
  };
}

function fakeSdk(fake) {
  return {
    createAoqClientEngine: () => fake.engine,
    AoqTrackType: { AoqTrackTypeAudio: 0, AoqTrackTypeVideo: 1, AoqTrackTypeData: 2 },
    AoqEncoderType: { AoqEncoderTypeAudioPCM: 1, AoqEncoderTypeAudioOpus: 2 },
    AoqConnectionStatus: {
      AoqConnectionStatusDisconnected: 0,
      AoqConnectionStatusConnecting: 1,
      AoqConnectionStatusConnected: 2,
      AoqConnectionStatusFailed: 3,
    },
    AoqAudioSource: { AoqAudioSourcePlayback: 3 },
    AoqAudioDeviceStateCode: {
      AoqAudioDeviceRecordStarted: 2,
      AoqAudioDeviceRecordFail: 5,
      AoqAudioDevicePlayFail: 10,
    },
  };
}

/** 网关桩：返回一份合法的连接凭证。 */
globalThis.fetch = async (url) => {
  const model = new URL(url).searchParams.get("model");
  return new Response(
    JSON.stringify({
      aoqTokenForClient: `token-${model}`,
      sid: "sid-smoke",
      clientRelayCertFingerprint: "fp",
      clientRelayEndpoints: [{ endpoint: "relay.smoke", port: 443, route_index: 0 }],
      sidExpiresInSecs: 60,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

const settings = new VoiceSettingsStore(root);
const states = [];
const fakes = [];
const service = new VoiceService({
  settings,
  workDir: () => path.join(tmp, "cache", "voice"),
  emit: (state) => states.push(state),
  sdk: () => {
    const fake = createFakeEngine();
    fakes.push(fake);
    return fakeSdk(fake);
  },
});

console.log("语音服务冒烟");

// —— 0. 未配置：显式错误，不建引擎 ——

await assert.rejects(
  () => service.speak("你好。"),
  (error) => error.code === "voice_not_configured" && /语音合成/.test(error.message),
);
await assert.rejects(
  () => service.startListening(),
  (error) => error.code === "voice_not_configured" && /语音识别/.test(error.message),
);
check("未配置时 speak / startListening 抛 voice_not_configured（未建引擎）", () => {
  assert.equal(fakes.length, 0);
  assert.equal(service.getState().phase, "idle");
});

settings.save({
  tts: { apiKey: "sk-tts", endpoint: "trial.cn-beijing.maas.aliyuncs.com" },
  asr: { apiKey: "sk-asr", endpoint: "trial.cn-beijing.maas.aliyuncs.com" },
});

// —— 0b. 麦克风权限：拒绝 / 未询问 ——

const micDeniedFake = createFakeEngine();
const micDeniedService = new VoiceService({
  settings,
  workDir: () => path.join(tmp, "cache", "voice"),
  emit: () => {},
  sdk: () => fakeSdk(micDeniedFake),
  micAccess: () => "denied",
  requestMic: async () => false,
});
await assert.rejects(
  () => micDeniedService.startListening(),
  (error) => error.code === "voice_microphone_failed" && /权限/.test(error.message),
);
check("麦克风被拒绝：startListening 直接给可操作错误，不建引擎", () => {
  assert.equal(micDeniedFake.calls.length, 0);
});

let micAsked = 0;
const micUndeterminedService = new VoiceService({
  settings,
  workDir: () => path.join(tmp, "cache", "voice"),
  emit: () => {},
  sdk: () => fakeSdk(createFakeEngine()),
  micAccess: () => "not-determined",
  requestMic: async () => {
    micAsked += 1;
    return false;
  },
});
await assert.rejects(
  () => micUndeterminedService.startListening(),
  (error) => error.code === "voice_microphone_failed",
);
check("麦克风未询问：先弹权限申请，被拒后报错", () => {
  assert.equal(micAsked, 1);
});

const micTimeoutService = new VoiceService({
  settings,
  workDir: () => path.join(tmp, "cache", "voice"),
  emit: () => {},
  sdk: () => fakeSdk(createFakeEngine()),
  micAccess: () => "not-determined",
  requestMic: () => new Promise(() => {}),
  micTimeoutMs: 20,
});
await assert.rejects(
  () => micTimeoutService.startListening(),
  (error) => error.code === "voice_microphone_failed" && /超时/.test(error.message),
);
check("麦克风授权框没人理：超时后报错，不会一直挂着", () => {});

// —— 1. ASR：建连 → run-task → 上行开关 → 识别 → finish ——

const fake = createFakeEngine();
// 用第一个服务实例的 sdk 注入：重建一个 service 更直观。
const asrService = new VoiceService({
  settings,
  workDir: () => path.join(tmp, "cache", "voice"),
  emit: () => {},
  sdk: () => fakeSdk(fake),
});

fake.setSendHandler((event) => {
  if (event.header.action === "run-task") {
    fake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-started" } })),
    );
    // 识别结果在聆听期间陆续回来；task-finished 只在收到 finish-task 后发。
    const sentence = (id, text, end) =>
      fake.emit(
        "onDataMsg",
        Buffer.from(
          JSON.stringify({
            header: { task_id: event.header.task_id, event: "result-generated" },
            payload: {
              output: {
                sentence: {
                  sentence_id: id,
                  text,
                  sentence_begin: id === 1 && !end,
                  sentence_end: end,
                },
              },
            },
          }),
        ),
      );
    queueMicrotask(() => {
      sentence(1, "我做", false);
      sentence(1, "我做过三年 B 端产品。", true);
      sentence(2, "负责过知识库。", true);
    });
  }
  if (event.header.action === "finish-task") {
    // 用户说到一半就点了「完成回答」：最后这句只有中间态，没有 sentence_end。
    fake.emit(
      "onDataMsg",
      Buffer.from(
        JSON.stringify({
          header: { task_id: event.header.task_id, event: "result-generated" },
          payload: {
            output: { sentence: { sentence_id: 3, text: "最后半句也要留下", sentence_end: false } },
          },
        }),
      ),
    );
    fake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-finished" } })),
    );
  }
});

await asrService.startListening();
check("ASR：建连后发布 Audio+Data、订阅 Data，并等 task-started 才开上行", () => {
  const connect = fake.calls.find((call) => call.name === "connect");
  assert.ok(connect, "connect 未被调用");
  assert.deepEqual(
    connect.payload.publishTracks.map((track) => track.trackType),
    [0, 2],
  );
  assert.deepEqual(
    connect.payload.subscribeTracks.map((track) => track.trackType),
    [2],
  );
  assert.match(connect.payload.token, /^token-qwen-audio-3\.1-asr-flash-streaming$/);
  assert.equal(connect.payload.relayEndpoints[0].routeIndex, 0);

  const runTask = fake.sent.find((event) => event.header.action === "run-task");
  assert.equal(runTask.payload.task, "asr");
  assert.equal(runTask.payload.parameters.sample_rate, 16000);

  const uploads = fake.calls.filter(
    (call) => call.name === "enableSendMediaStream" && call.payload.trackType === 0,
  );
  assert.equal(uploads[0].payload.enable, false, "建连时应先关闭上行");
  assert.equal(uploads.at(-1).payload.enable, true, "task-started 后才开上行");
  assert.equal(asrService.getState().phase, "listening");

  const capture = fake.calls.find((call) => call.name === "startAudioCapture");
  assert.equal(capture.payload.channel, 1);
});

// 识别结果已进状态（上面微任务里已经推过）。
await sleep(50);
const listeningState = asrService.getState();
check("ASR：中间态与定稿按 sentence_id 合并进状态", () => {
  assert.equal(listeningState.transcript, "我做过三年 B 端产品。负责过知识库。");
  assert.match(listeningState.interim, /我做过三年 B 端产品。/);
});

const result = await asrService.stopListening();
check("ASR：finish-task 后返回定稿文本（含没等到 sentence_end 的半句），状态回 idle", () => {
  assert.equal(result.text, "我做过三年 B 端产品。负责过知识库。最后半句也要留下");
  const finish = fake.sent.find((event) => event.header.action === "finish-task");
  assert.ok(finish, "没有发 finish-task");
  assert.equal(asrService.getState().phase, "idle");
  assert.equal(asrService.getState().transcript, "");
});

// —— 2. TTS：run-task → continue-task → finish-task → 播放排空 ——

const ttsFake = createFakeEngine();
const ttsService = new VoiceService({
  settings,
  workDir: () => path.join(tmp, "cache", "voice"),
  emit: () => {},
  sdk: () => fakeSdk(ttsFake),
});

ttsFake.setSendHandler((event) => {
  if (event.header.action === "run-task") {
    ttsFake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-started" } })),
    );
    // 模拟 100ms 音频帧：让 drainPlayback 有真实依据。
    ttsFake.emit("onPlaybackAudioFrame", { numOfSamples: 2400, samplesPerSec: 24000 });
  }
  if (event.header.action === "finish-task") {
    ttsFake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-finished" } })),
    );
  }
});

const ttsStarted = Date.now();
// 超过单条 continue-task 上限（1800 字符），验证按句切块；带 Markdown 验证朗读文本被清洗。
const longText = `## 第 1 轮\n\n**主问题：** ${"请先做个自我介绍。".repeat(260)}`;
await ttsService.speak(longText);
const ttsElapsed = Date.now() - ttsStarted;

check("TTS：解码器 / 播放器 / 订阅 Audio，continue-task 按句切，结束后回 idle", () => {
  const decoder = ttsFake.calls.find((call) => call.name === "setAudioDecoderConfig");
  assert.equal(decoder.payload.sampleRate, 24000);
  assert.equal(decoder.payload.codecType, 2);
  assert.ok(ttsFake.calls.some((call) => call.name === "startAudioPlayer"));

  const connect = ttsFake.calls.find((call) => call.name === "connect");
  assert.deepEqual(
    connect.payload.publishTracks.map((track) => track.trackType),
    [2],
  );
  assert.deepEqual(
    connect.payload.subscribeTracks.map((track) => track.trackType).sort(),
    [0, 2],
  );

  const runTask = ttsFake.sent.find((event) => event.header.action === "run-task");
  assert.equal(runTask.payload.task, "tts");
  assert.equal(runTask.payload.function, "SpeechSynthesizer");
  assert.equal(runTask.payload.parameters.voice, "longanlingxi");

  const continues = ttsFake.sent.filter((event) => event.header.action === "continue-task");
  assert.ok(continues.length >= 2, "长句应拆成多条 continue-task");
  const spoken = continues.map((event) => event.payload.input.text).join("");
  assert.ok(spoken.includes("自我介绍"));
  assert.equal(spoken.includes("**"), false, "Markdown 强调不应进 TTS");
  assert.equal(spoken.includes("##"), false, "Markdown 标题不应进 TTS");

  assert.ok(ttsFake.sent.some((event) => event.header.action === "finish-task"));
  assert.ok(ttsFake.calls.some((call) => call.name === "disconnect"));
  assert.equal(ttsService.getState().phase, "idle");
  assert.ok(ttsElapsed >= 300, `应等播放排空（实际 ${ttsElapsed}ms）`);
});

// —— 2b. 真实引擎会持续回调播放帧：音频放完后的自动静音帧不能拖到 20 秒兜底 ——

const tailFake = createFakeEngine();
const tailService = new VoiceService({
  settings,
  workDir: () => path.join(tmp, "cache", "voice"),
  emit: () => {},
  sdk: () => fakeSdk(tailFake),
});
const tailStarted = Date.now();
let tailTimer = null;
tailFake.setSendHandler((event) => {
  if (event.header.action === "run-task") {
    tailFake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-started" } })),
    );
    // 10ms 真实音频；之后引擎会一直回调 autoGenMute 静音帧（AOQ 实机行为）。
    tailFake.emit("onPlaybackAudioFrame", { numOfSamples: 240, samplesPerSec: 24000, autoGenMute: false });
    tailTimer = setInterval(() => {
      tailFake.emit("onPlaybackAudioFrame", {
        numOfSamples: 240,
        samplesPerSec: 24000,
        autoGenMute: true,
      });
    }, 10);
  }
  if (event.header.action === "finish-task") {
    tailFake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-finished" } })),
    );
  }
});
await tailService.speak("你好，我是你的面试官。");
const tailElapsed = Date.now() - tailStarted;
clearInterval(tailTimer);
check("TTS：播放帧持续回流静音帧时，音频放完就结束（不等 20 秒兜底）", () => {
  assert.ok(tailElapsed < 5000, `实际 ${tailElapsed}ms`);
  assert.equal(tailService.getState().phase, "idle");
});

// —— 3. 并发保护与 stopAll ——

const busyFake = createFakeEngine();
let holdFinish = null;
const busyService = new VoiceService({
  settings,
  workDir: () => path.join(tmp, "cache", "voice"),
  emit: () => {},
  sdk: () => fakeSdk(busyFake),
});
busyFake.setSendHandler((event) => {
  if (event.header.action === "run-task") {
    busyFake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-started" } })),
    );
  }
  if (event.header.action === "finish-task") holdFinish = event;
});
await busyService.startListening();
await assert.rejects(
  () => busyService.speak("你好。"),
  (error) => error.code === "voice_busy",
);
check("并发保护：聆听中再 speak 抛 voice_busy", () => {
  assert.equal(busyService.getState().phase, "listening");
});

await busyService.stopAll();
check("stopAll：断开连接 + 销毁引擎 + 状态回 idle", () => {
  assert.ok(busyFake.calls.some((call) => call.name === "disconnect"));
  assert.ok(busyFake.calls.some((call) => call.name === "destroy"));
  const state = busyService.getState();
  assert.equal(state.phase, "idle");
  assert.equal(state.error, null);
});

// —— 3b. TTS 没有任何音频帧：显式失败，不假装播放成功 ——

const silentFake = createFakeEngine();
const silentService = new VoiceService({
  settings,
  workDir: () => path.join(tmp, "cache", "voice"),
  emit: () => {},
  sdk: () => fakeSdk(silentFake),
});
silentFake.setSendHandler((event) => {
  if (event.header.action === "run-task") {
    silentFake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-started" } })),
    );
  }
  if (event.header.action === "finish-task") {
    silentFake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-finished" } })),
    );
  }
});
await assert.rejects(
  () => silentService.speak("你好。"),
  (error) => error.code === "voice_task_failed" && /没有返回音频数据/.test(error.message),
);
check("TTS 一帧音频都没有时显式失败（不会假装播放成功）", () => {
  assert.equal(silentService.getState().phase, "error");
  assert.match(silentService.getState().error, /音频数据/);
});

// —— 4. 采集卡在 RecordStarting（权限未答复）：stopAll 不能调 destroy ——

const stuckFake = createFakeEngine({ captureStarts: false });
const stuckService = new VoiceService({
  settings,
  workDir: () => path.join(tmp, "cache", "voice"),
  emit: () => {},
  sdk: () => fakeSdk(stuckFake),
});
stuckFake.setSendHandler((event) => {
  if (event.header.action === "run-task") {
    stuckFake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-started" } })),
    );
  }
});
await stuckService.startListening();
await stuckService.stopAll();
check("采集停在 RecordStarting 时 stopAll 跳过 destroy（原生 destroy 会卡主线程）", () => {
  assert.equal(stuckFake.calls.some((call) => call.name === "destroy"), false);
  assert.equal(stuckService.getState().phase, "idle");
});

stuckFake.setSendHandler((event) => {
  if (event.header.action === "run-task") {
    stuckFake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-started" } })),
    );
    stuckFake.emit("onPlaybackAudioFrame", { numOfSamples: 1200, samplesPerSec: 24000 });
  }
  if (event.header.action === "finish-task") {
    stuckFake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-finished" } })),
    );
  }
});
await stuckService.speak("继续。");
check("跳过 destroy 后下一次朗读复用同一个原生引擎（createEngine 只调一次）", () => {
  assert.equal(stuckFake.calls.filter((call) => call.name === "createEngine").length, 1);
});

// —— 5. dispose（关窗 / 退出）：采集正常要销毁；采集卡住不能销毁 ——

const disposeFake = createFakeEngine();
const disposeService = new VoiceService({
  settings,
  workDir: () => path.join(tmp, "cache", "voice"),
  emit: () => {},
  sdk: () => fakeSdk(disposeFake),
});
disposeFake.setSendHandler((event) => {
  if (event.header.action === "run-task") {
    disposeFake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-started" } })),
    );
  }
});
await disposeService.startListening();
disposeService.dispose();
check("dispose：采集正常时停采集并销毁引擎，状态回 idle", () => {
  assert.ok(disposeFake.calls.some((call) => call.name === "stopAudioCapture"));
  assert.ok(disposeFake.calls.some((call) => call.name === "destroy"));
  assert.equal(disposeService.getState().phase, "idle");
});

const stuckDisposeFake = createFakeEngine({ captureStarts: false });
const stuckDisposeService = new VoiceService({
  settings,
  workDir: () => path.join(tmp, "cache", "voice"),
  emit: () => {},
  sdk: () => fakeSdk(stuckDisposeFake),
});
stuckDisposeFake.setSendHandler((event) => {
  if (event.header.action === "run-task") {
    stuckDisposeFake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-started" } })),
    );
  }
});
await stuckDisposeService.startListening();
stuckDisposeService.dispose();
check("dispose：采集卡在 RecordStarting 时不销毁（避免关窗 / 退出卡死），状态回 idle", () => {
  assert.equal(stuckDisposeFake.calls.some((call) => call.name === "destroy"), false);
  assert.equal(stuckDisposeService.getState().phase, "idle");
});

// 服务实例复用同一引擎：stopAll 之后的 speak 会重新 createEngine。
const reFake = createFakeEngine();
const reService = new VoiceService({
  settings,
  workDir: () => path.join(tmp, "cache", "voice"),
  emit: () => {},
  sdk: () => fakeSdk(reFake),
});
reFake.setSendHandler((event) => {
  if (event.header.action === "run-task") {
    reFake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-started" } })),
    );
    reFake.emit("onPlaybackAudioFrame", { numOfSamples: 1200, samplesPerSec: 24000 });
  }
  if (event.header.action === "finish-task") {
    reFake.emit(
      "onDataMsg",
      Buffer.from(JSON.stringify({ header: { task_id: event.header.task_id, event: "task-finished" } })),
    );
  }
});
await reService.speak("继续。");
await reService.stopAll();
await reService.speak("再说一句。");
check("stopAll 后可重新建引擎朗读（createEngine 两次）", () => {
  const creates = reFake.calls.filter((call) => call.name === "createEngine");
  assert.equal(creates.length, 2);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过：${checks} 项检查。`);
