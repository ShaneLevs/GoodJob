/**
 * P5 语音协议冒烟（jiti 直跑 src/main TS 源码，不启动 Electron、不发网络）：
 *
 * - 凭证请求：URL（`/api/v1/webrtc/inference?model=`）、`Authorization: Bearer`、
 *   `x-dashscope-rtc-transport: moq`、`clientIp` 可选；
 * - 网关响应 → AOQ 连接参数（`route_index` → `routeIndex`、`workspaceIdHash`）；
 * - 三类任务事件：ASR / TTS 的 `run-task` 字段、`continue-task`、`finish-task`；
 * - 服务端事件：心跳跳过、同一 `sentence_id` 覆盖、`sentence_end=true` 定稿、
 *   `task-failed` 转可读错误；
 * - 语音会话状态机：连接中 → 朗读 / 聆听 → 识别 → 结束，错误态带 code；
 * - 真实的原生 SDK 加载器（`createRequire`）能加载 `aoq-electron-sdk` 并读到版本号。
 *
 * 运行：node scripts/p5-voice-protocol-smoke.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { createJiti } from "../node_modules/.pnpm/jiti@2.7.0/node_modules/jiti/lib/jiti.mjs";

const here = new URL(".", import.meta.url).pathname;
const jiti = createJiti(here, {
  alias: {
    electron: path.join(here, "p3-smoke-electron-stub.mjs"),
    "@shared": path.join(here, "..", "src", "shared"),
  },
});

const protocol = await jiti.import("../src/main/services/voice/protocol.ts");
const { loadAoqSdk } = await jiti.import("../src/main/services/voice/sdk.ts");
const { createIdleVoiceState } = await jiti.import("../src/shared/types/voice.ts");

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

console.log("语音协议冒烟");

// —— 1. 连接凭证请求 ——

check("凭证请求：URL / 头 / 空 body", () => {
  const request = protocol.buildCredentialRequest({
    endpoint: "https://dashscope.aliyuncs.com/",
    model: "qwen-audio-3.1-asr-flash-streaming",
    apiKey: "sk-test-123",
  });
  assert.equal(
    request.url,
    "https://dashscope.aliyuncs.com/api/v1/webrtc/inference?model=qwen-audio-3.1-asr-flash-streaming",
  );
  assert.equal(request.method, "POST");
  assert.equal(request.headers.Authorization, "Bearer sk-test-123");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(request.headers["x-dashscope-rtc-transport"], "moq");
  assert.deepEqual(request.body, {});
  assert.equal(JSON.stringify(request).includes("sk-test-123"), true); // 只在 Authorization 头里
});

check("凭证请求：clientIp 进 body", () => {
  const request = protocol.buildCredentialRequest({
    endpoint: "ws-x.cn-beijing.maas.aliyuncs.com",
    model: "qwen-audio-3.0-tts-flash",
    apiKey: "sk-a",
    clientIp: " 203.0.113.7 ",
  });
  assert.deepEqual(request.body, { clientIp: "203.0.113.7" });
  assert.match(request.url, /^https:\/\/ws-x\.cn-beijing\.maas\.aliyuncs\.com\/api\/v1\/webrtc\/inference\?model=/);
});

check("凭证请求：缺 Key / 缺域名是显式错误", () => {
  for (const input of [
    { endpoint: "", model: "m", apiKey: "k" },
    { endpoint: "dashscope.aliyuncs.com", model: "", apiKey: "k" },
    { endpoint: "dashscope.aliyuncs.com", model: "m", apiKey: "  " },
  ]) {
    assert.throws(
      () => protocol.buildCredentialRequest(input),
      (error) => error instanceof protocol.VoiceError && error.code === "voice_not_configured",
    );
  }
});

check("凭证响应：网关字段映射到 AoqConnectConfig", () => {
  const credential = protocol.parseCredentialResponse({
    aoqTokenForClient: "aoq-token",
    sid: "sess-1",
    clientRelayCertFingerprint: "fp-1",
    clientRelayEndpoints: [
      { endpoint: "relay-a.example.com", port: 443, route_index: 0 },
      { endpoint: "relay-b.example.com", port: 8443, route_index: 1 },
      { endpoint: "", port: 0, route_index: 2 },
    ],
    extraInfo: { workspaceIdHash: "wsh" },
    sidExpiresInSecs: 3600,
  });
  assert.equal(credential.token, "aoq-token");
  assert.equal(credential.sid, "sess-1");
  assert.equal(credential.certFingerprint, "fp-1");
  assert.equal(credential.workspaceIdHash, "wsh");
  assert.equal(credential.expiresInSecs, 3600);
  assert.deepEqual(credential.relayEndpoints, [
    { endpoint: "relay-a.example.com", port: 443, routeIndex: 0 },
    { endpoint: "relay-b.example.com", port: 8443, routeIndex: 1 },
  ]);
});

check("凭证响应：缺 token 给鉴权错误（带网关原文）", () => {
  assert.throws(
    () => protocol.parseCredentialResponse({ code: "InvalidApiKey", message: "Invalid API-key provided." }),
    (error) =>
      error instanceof protocol.VoiceError &&
      error.code === "voice_auth_failed" &&
      error.message.includes("Invalid API-key provided."),
  );
  assert.throws(
    () => protocol.parseCredentialResponse({ aoqTokenForClient: "t", sid: "s", clientRelayEndpoints: [] }),
    (error) => error instanceof protocol.VoiceError && error.code === "voice_auth_failed",
  );
});

check("HTTP 失败映射：401 / 404 → voice_auth_failed 且给可操作提示", () => {
  const error = protocol.credentialHttpError(
    401,
    '{"code":"InvalidApiKey","message":"Invalid API-key provided."}',
  );
  assert.equal(error.code, "voice_auth_failed");
  assert.match(error.message, /HTTP 401/);
  assert.match(error.message, /InvalidApiKey/);
  assert.match(error.message, /Invalid API-key provided/);

  const notFound = protocol.credentialHttpError(404, "");
  assert.equal(notFound.code, "voice_auth_failed");
  assert.match(notFound.message, /AOQ 接入点/);
  assert.match(notFound.message, /maas\.aliyuncs\.com/);
});

// —— 2. 任务事件 ——

check("ASR run-task：task_group/task/function/parameters 与文档一致", () => {
  const event = protocol.buildRunTask({
    taskId: "task-1",
    kind: "asr",
    model: "qwen-audio-3.1-asr-flash-streaming",
  });
  assert.deepEqual(event.header, { action: "run-task", task_id: "task-1", streaming: "duplex" });
  assert.equal(event.payload.task_group, "audio");
  assert.equal(event.payload.task, "asr");
  assert.equal(event.payload.function, "recognition");
  assert.equal(event.payload.model, "qwen-audio-3.1-asr-flash-streaming");
  assert.deepEqual(event.payload.parameters, { format: "pcm", sample_rate: 16000 });
  assert.deepEqual(event.payload.input, {});
});

check("TTS run-task：SpeechSynthesizer + 音色 + 24k", () => {
  const event = protocol.buildRunTask({
    taskId: "task-2",
    kind: "tts",
    model: "qwen-audio-3.0-tts-flash",
    voice: "longanlingxi",
  });
  assert.equal(event.payload.task, "tts");
  assert.equal(event.payload.function, "SpeechSynthesizer");
  assert.deepEqual(event.payload.parameters, {
    text_type: "PlainText",
    voice: "longanlingxi",
    format: "pcm",
    sample_rate: 24000,
  });
  assert.throws(
    () => protocol.buildRunTask({ taskId: "t", kind: "tts", model: "m", voice: "" }),
    (error) => error.code === "voice_not_configured",
  );
});

check("continue-task / finish-task", () => {
  const cont = protocol.buildContinueTask("task-1", "  欢迎使用阿里云。  ");
  assert.deepEqual(cont.header, { action: "continue-task", task_id: "task-1", streaming: "duplex" });
  assert.deepEqual(cont.payload, { input: { text: "欢迎使用阿里云。" } });
  const finish = protocol.buildFinishTask("task-1");
  assert.deepEqual(finish.header, { action: "finish-task", task_id: "task-1", streaming: "duplex" });
  assert.deepEqual(finish.payload, { input: {} });
});

check("长文本按句切块，单块不超过上限", () => {
  const chunks = protocol.chunkText("第一句。第二句！第三句？".repeat(300));
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 1800, `chunk too long: ${chunk.length}`);
  assert.ok(chunks.join("").includes("第三句？"));
  assert.deepEqual(protocol.chunkText("   "), []);
});

// —— 3. 服务端事件与句子合并 ——

check("task-started / task-finished 解析", () => {
  assert.deepEqual(
    protocol.parseServerEvent(
      JSON.stringify({ header: { task_id: "t", event: "task-started" }, payload: {} }),
    ),
    { type: "task-started", taskId: "t" },
  );
  assert.equal(
    protocol.parseServerEvent(
      Buffer.from(JSON.stringify({ header: { task_id: "t", event: "task-finished" }, payload: {} })),
    ).type,
    "task-finished",
  );
  assert.equal(protocol.parseServerEvent("not json"), null);
  assert.equal(protocol.parseServerEvent("{}"), null);
});

check("task-failed 转成可读错误（含 error_code）", () => {
  const event = protocol.parseServerEvent(
    JSON.stringify({
      header: {
        task_id: "t",
        event: "task-failed",
        error_code: "CLIENT_ERROR",
        error_message: "request timeout after 23 seconds.",
      },
      payload: {},
    }),
  );
  assert.equal(event.type, "task-failed");
  assert.equal(event.code, "CLIENT_ERROR");
  assert.match(event.message, /request timeout/);
});

check("result-generated：心跳包被识别，普通结果取 sentence", () => {
  const heartbeat = protocol.parseServerEvent(
    JSON.stringify({
      header: { task_id: "t", event: "result-generated" },
      payload: { output: { sentence: { sentence_id: 0, text: "", heartbeat: true } } },
    }),
  );
  assert.equal(heartbeat.sentence.heartbeat, true);

  const update = protocol.parseServerEvent(
    JSON.stringify({
      header: { task_id: "t", event: "result-generated" },
      payload: {
        output: {
          sentence: {
            sentence_id: 1,
            text: "欢迎使用阿里云。",
            sentence_begin: true,
            sentence_end: true,
          },
        },
      },
    }),
  );
  assert.deepEqual(update.sentence, {
    sentenceId: 1,
    text: "欢迎使用阿里云。",
    begin: true,
    end: true,
    heartbeat: false,
  });
});

check("result-generated：兼容 payload.output.output.sentence", () => {
  const event = protocol.parseServerEvent(
    JSON.stringify({
      header: { task_id: "t", event: "result-generated" },
      payload: { output: { output: { sentence: { sentence_id: 2, text: "第二句", sentence_end: false } } } },
    }),
  );
  assert.equal(event.sentence.sentenceId, 2);
  assert.equal(event.sentence.text, "第二句");
});

check("句子合并：中间态覆盖同一句，定稿后进 transcript，心跳不动", () => {
  const accumulator = new protocol.SentenceAccumulator();
  let update = accumulator.apply({
    sentenceId: 1,
    text: "欢迎",
    begin: true,
    end: false,
    heartbeat: false,
  });
  assert.deepEqual([update.interim, update.transcript], ["欢迎", ""]);

  update = accumulator.apply({
    sentenceId: 1,
    text: "欢迎使用阿里云",
    begin: false,
    end: false,
    heartbeat: false,
  });
  assert.deepEqual([update.interim, update.transcript], ["欢迎使用阿里云", ""]);

  const heartbeat = accumulator.apply({
    sentenceId: 0,
    text: "",
    begin: false,
    end: false,
    heartbeat: true,
  });
  assert.equal(heartbeat.heartbeat, true);
  assert.equal(heartbeat.interim, "欢迎使用阿里云");

  update = accumulator.apply({
    sentenceId: 1,
    text: "欢迎使用阿里云。",
    begin: false,
    end: true,
    heartbeat: false,
  });
  assert.deepEqual([update.interim, update.transcript, update.final], ["欢迎使用阿里云。", "欢迎使用阿里云。", true]);
  assert.equal(accumulator.transcript, "欢迎使用阿里云。");

  update = accumulator.apply({
    sentenceId: 2,
    text: "今天聊点什么",
    begin: true,
    end: false,
    heartbeat: false,
  });
  assert.equal(update.interim, "欢迎使用阿里云。今天聊点什么");
  assert.equal(update.transcript, "欢迎使用阿里云。");

  accumulator.reset();
  assert.equal(accumulator.transcript, "");
});

check("TTS 文本清洗：Markdown 不进朗读（标题 / 强调 / 链接 / 列表 / 代码围栏）", () => {
  const spoken = protocol.toSpeechText(
    "## 第 1 轮\n\n**主问题：** 你的[企业知识库](https://example.com/a) 怎么做的？\n\n- 指标是什么\n- `QPS` 多少\n\n```js\nconst x = 1;\n```\n> 备注：注意 project_id 这个字段",
  );
  assert.equal(spoken.includes("#"), false);
  assert.equal(spoken.includes("**"), false);
  assert.equal(spoken.includes("https://example.com"), false);
  assert.equal(spoken.includes("`"), false);
  assert.equal(spoken.includes("```"), false);
  assert.match(spoken, /企业知识库/);
  assert.match(spoken, /指标是什么/);
  assert.match(spoken, /QPS/);
  assert.match(spoken, /const x = 1;/);
  assert.match(spoken, /project_id/, "下划线不能被当成强调吃掉");
  assert.equal(protocol.toSpeechText("   "), "");
});

check("句子合并：finalizeAll 把没等到 sentence_end 的半句也算定稿", () => {
  const accumulator = new protocol.SentenceAccumulator();
  accumulator.apply({ sentenceId: 1, text: "第一句。", begin: true, end: true, heartbeat: false });
  accumulator.apply({ sentenceId: 2, text: "第二句还没说完", begin: true, end: false, heartbeat: false });
  assert.equal(accumulator.transcript, "第一句。");
  accumulator.finalizeAll();
  assert.equal(accumulator.transcript, "第一句。第二句还没说完");
});

// —— 4. 状态机 ——

check("状态机：连接中 → 朗读 → 空闲，speech 只在朗读时保留", () => {
  let state = createIdleVoiceState();
  assert.equal(state.phase, "idle");

  state = protocol.reduceVoiceState(state, { type: "phase", phase: "connecting" });
  assert.equal(state.phase, "connecting");

  state = protocol.reduceVoiceState(state, {
    type: "phase",
    phase: "speaking",
    speech: "请先做个自我介绍。",
  });
  assert.equal(state.phase, "speaking");
  assert.equal(state.speech, "请先做个自我介绍。");

  state = protocol.reduceVoiceState(state, { type: "phase", phase: "idle" });
  assert.equal(state.phase, "idle");
  assert.equal(state.speech, null);
  assert.equal(protocol.isVoiceActive(state), false);
});

check("状态机：聆听 → 识别（transcript 更新）→ 空闲", () => {
  let state = protocol.reduceVoiceState(createIdleVoiceState(), { type: "phase", phase: "listening" });
  assert.equal(protocol.isVoiceActive(state), true);
  state = protocol.reduceVoiceState(state, {
    type: "transcript",
    interim: "我做过三年",
    transcript: "",
  });
  assert.equal(state.interim, "我做过三年");
  state = protocol.reduceVoiceState(state, { type: "phase", phase: "recognizing" });
  state = protocol.reduceVoiceState(state, {
    type: "transcript",
    interim: "我做过三年增长。",
    transcript: "我做过三年增长。",
  });
  state = protocol.reduceVoiceState(state, { type: "phase", phase: "idle" });
  assert.equal(state.transcript, "我做过三年增长。");
  assert.equal(protocol.isVoiceActive(state), false);
});

check("状态机：错误态带 code，reset 清空", () => {
  let state = protocol.reduceVoiceState(createIdleVoiceState(), { type: "phase", phase: "connecting" });
  state = protocol.reduceVoiceState(state, {
    type: "error",
    code: "voice_microphone_failed",
    message: "麦克风启动失败（错误码 5）。",
  });
  assert.equal(state.phase, "error");
  assert.equal(state.errorCode, "voice_microphone_failed");
  assert.match(state.error, /麦克风/);

  state = protocol.reduceVoiceState(state, { type: "reset" });
  assert.equal(state.phase, "idle");
  assert.equal(state.error, null);
  assert.equal(state.errorCode, null);
});

// —— 5. 真实 SDK 加载器 ——

check("原生 SDK：createRequire 能加载 aoq-electron-sdk 并读到版本号", () => {
  const sdk = loadAoqSdk();
  assert.equal(typeof sdk.createAoqClientEngine, "function");
  const version = sdk.createAoqClientEngine().getVersion();
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.equal(sdk.AoqTrackType.AoqTrackTypeAudio, 0);
  assert.equal(sdk.AoqTrackType.AoqTrackTypeData, 2);
  assert.equal(sdk.AoqEncoderType.AoqEncoderTypeAudioOpus, 2);
  assert.equal(sdk.AoqConnectionStatus.AoqConnectionStatusConnected, 2);
});

console.log(`\n通过：${checks} 项检查。`);
