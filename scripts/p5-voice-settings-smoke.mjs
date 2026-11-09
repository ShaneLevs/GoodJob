/**
 * P5 语音设置冒烟（jiti 直跑 src/main TS 源码 + electron 桩，不启动窗口）：
 *
 * - 默认值：阿里云百炼、默认接入域名、TTS 模型 / 音色、ASR 模型；未配 Key 时
 *   `ready.interview === false`；
 * - 写入 TTS / ASR 后返回结构只含 `hasApiKey`，不含明文 Key；
 * - `voice.json` 权限 0600、文件字节里搜不到明文 Key（safeStorage 密文落盘）；
 * - 新建第二个 store 实例读回同一份配置（重启语义）；
 * - `apiKey` 省略保持原 Key、空串清除；端点去掉 `https://` 与尾斜杠；
 * - `resolveTts` / `resolveAsr` 只在 Key 与模型齐备时返回可调用配置。
 *
 * 运行：node scripts/p5-voice-settings-smoke.mjs
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

const { VoiceSettingsStore, VOICE_DEFAULTS } = await jiti.import("../src/main/stores/voice.ts");
const { rootPaths } = await jiti.import("../src/main/workspace/paths.ts");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goodjob-voice-smoke-"));
const root = rootPaths(tmp);
fs.mkdirSync(root.workspaces, { recursive: true });

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

console.log("语音设置冒烟");

const store = new VoiceSettingsStore(root, () => ({
  version: "1.4.0-test",
  error: null,
}));

check("默认值：百炼 + 默认域名 / 模型 / 音色，未配 Key 不可用", () => {
  const settings = store.toPublic();
  assert.equal(settings.version, 1);
  assert.equal(settings.canStoreKey, true);
  assert.equal(settings.tts.provider, "bailian");
  assert.equal(settings.asr.provider, "bailian");
  assert.equal(settings.tts.endpoint, VOICE_DEFAULTS.endpoint);
  assert.equal(settings.tts.model, VOICE_DEFAULTS.ttsModel);
  assert.equal(settings.tts.voice, VOICE_DEFAULTS.ttsVoice);
  assert.equal(settings.asr.model, VOICE_DEFAULTS.asrModel);
  assert.equal(settings.tts.hasApiKey, false);
  assert.equal(settings.asr.hasApiKey, false);
  assert.deepEqual(settings.ready, { tts: false, asr: false, interview: false });
  assert.equal(settings.sdkVersion, "1.4.0-test");
  assert.equal(settings.sdkError, null);
  assert.equal("voice" in settings.asr, false, "ASR 公开结构不该带音色");
  assert.equal(store.resolveTts(), null);
  assert.equal(store.resolveAsr(), null);
});

check("保存 TTS / ASR：只回 hasApiKey，不回 Key", () => {
  const settings = store.save({
    tts: {
      endpoint: "https://dashscope.aliyuncs.com/",
      model: "qwen-audio-3.0-tts-flash",
      voice: "longanlingxi",
      apiKey: "sk-tts-plaintext-secret",
    },
    asr: {
      endpoint: "dashscope.aliyuncs.com",
      model: "qwen-audio-3.1-asr-flash-streaming",
      apiKey: "sk-asr-plaintext-secret",
    },
  });
  assert.equal(settings.tts.hasApiKey, true);
  assert.equal(settings.asr.hasApiKey, true);
  assert.equal(settings.tts.endpoint, "dashscope.aliyuncs.com");
  assert.deepEqual(settings.ready, { tts: true, asr: true, interview: true });
  const serialized = JSON.stringify(settings);
  assert.equal(serialized.includes("sk-tts-plaintext-secret"), false);
  assert.equal(serialized.includes("sk-asr-plaintext-secret"), false);
});

check("落盘：0600 + 密文（文件字节里搜不到明文）", () => {
  const stat = fs.statSync(root.voice);
  assert.equal(stat.mode & 0o777, 0o600);
  const raw = fs.readFileSync(root.voice, "utf8");
  assert.equal(raw.includes("sk-tts-plaintext-secret"), false);
  assert.equal(raw.includes("sk-asr-plaintext-secret"), false);
  const parsed = JSON.parse(raw);
  assert.equal(typeof parsed.tts.apiKeyEncrypted, "string");
  assert.equal(typeof parsed.asr.apiKeyEncrypted, "string");
  assert.equal(parsed.tts.endpoint, "dashscope.aliyuncs.com");
});

check("重启语义：新 store 实例读回同一份配置", () => {
  const reopened = new VoiceSettingsStore(root);
  const settings = reopened.toPublic();
  assert.equal(settings.tts.hasApiKey, true);
  assert.equal(settings.asr.hasApiKey, true);
  assert.equal(settings.tts.model, "qwen-audio-3.0-tts-flash");
  assert.equal(settings.asr.model, "qwen-audio-3.1-asr-flash-streaming");
  assert.equal(settings.ready.interview, true);
  assert.equal(reopened.resolveTts().apiKey, "sk-tts-plaintext-secret");
  assert.equal(reopened.resolveAsr().apiKey, "sk-asr-plaintext-secret");
});

check("apiKey 省略保持原值；空串清除", () => {
  // 省略 Key，只改音色：Key 还在。
  let settings = store.save({ tts: { voice: "longanfengyue" } });
  assert.equal(settings.tts.voice, "longanfengyue");
  assert.equal(settings.tts.hasApiKey, true);
  assert.equal(store.resolveTts().apiKey, "sk-tts-plaintext-secret");

  // 清空 TTS Key：TTS 不可用，ASR 不受影响。
  settings = store.save({ tts: { apiKey: "" } });
  assert.equal(settings.tts.hasApiKey, false);
  assert.equal(settings.asr.hasApiKey, true);
  assert.deepEqual(settings.ready, { tts: false, asr: true, interview: false });
  assert.equal(store.resolveTts(), null);
  assert.equal(store.resolveAsr().apiKey, "sk-asr-plaintext-secret");
});

check("重填 Key 后恢复可用；模型留空则不 ready", () => {
  let settings = store.save({ tts: { apiKey: "sk-tts-second" } });
  assert.equal(settings.ready.interview, true);
  assert.equal(store.resolveTts().apiKey, "sk-tts-second");

  settings = store.save({ asr: { model: "" } });
  assert.equal(settings.asr.model, "");
  assert.deepEqual(settings.ready, { tts: true, asr: false, interview: false });
  assert.equal(store.resolveAsr(), null);
});

check("麦克风权限透传：设置页看到 granted / denied / unknown", () => {
  const granted = new VoiceSettingsStore(root, undefined, () => "granted");
  assert.equal(granted.toPublic().microphone, "granted");
  const denied = new VoiceSettingsStore(root, undefined, () => "denied");
  assert.equal(denied.toPublic().microphone, "denied");
  assert.equal(store.toPublic().microphone, "unknown");
});

check("SDK 状态透传：加载失败时给出原因", () => {
  const broken = new VoiceSettingsStore(root, () => ({
    version: null,
    error: "Cannot find module 'aoq_node_ext.node'",
  }));
  const settings = broken.toPublic();
  assert.equal(settings.sdkVersion, null);
  assert.match(settings.sdkError, /aoq_node_ext/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过：${checks} 项检查。`);
