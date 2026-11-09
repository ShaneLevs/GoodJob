/**
 * P5 语音清单冒烟（jiti 直跑 src/main TS 源码，不发网络请求）：
 *
 * - 模型列表 URL 的筛选条件：TTS 用 TTS + name=qwen-audio，ASR 用
 *   Realtime-ASR + name=qwen-audio；
 * - `parseModelList` 只留下 AOQ 能用的模型，结构不认识时抛中文错误；
 * - `parseVoiceDoc` 同时兼容官方文档里的 `<strong>` 与 Markdown 粗体两种写法；
 * - 内置音色快照与官方列表的默认音色一致。
 *
 * 运行：node scripts/p5-voice-catalog-smoke.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { createJiti } from "../node_modules/.pnpm/jiti@2.7.0/node_modules/jiti/lib/jiti.mjs";

const here = new URL(".", import.meta.url).pathname;
const jiti = createJiti(here, {
  alias: {
    "@shared": path.join(here, "..", "src", "shared"),
  },
});

const { buildModelsUrl, parseModelList, parseVoiceDoc, BUILTIN_VOICES, VOICE_DOC_URL } =
  await jiti.import("../src/main/services/voice/catalog.ts");

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

console.log("语音清单冒烟");

check("模型列表 URL：补协议、去尾斜杠、带能力筛选", () => {
  const tts = new URL(buildModelsUrl("https://llm-test.cn-beijing.maas.aliyuncs.com/", "tts"));
  assert.equal(tts.protocol, "https:");
  assert.equal(tts.hostname, "llm-test.cn-beijing.maas.aliyuncs.com");
  assert.equal(tts.pathname, "/api/v1/models");
  assert.equal(tts.searchParams.get("capabilities"), "TTS");
  assert.equal(tts.searchParams.get("name"), "qwen-audio");
  assert.equal(tts.searchParams.get("page_size"), "100");

  const asr = new URL(buildModelsUrl("trial.cn-beijing.maas.aliyuncs.com", "asr"));
  assert.equal(asr.searchParams.get("capabilities"), "Realtime-ASR");
  assert.equal(asr.searchParams.get("name"), "qwen-audio");
});

check("解析模型列表：保留顺序、去重，ASR/TTS 各按协议过滤", () => {
  const payload = {
    success: true,
    output: {
      total: 4,
      models: [
        { model: "qwen-audio-3.0-asr-flash-streaming", name: "3.0 Streaming", description: "实时" },
        { model: "paraformer-realtime-v2", name: "Paraformer", description: "WebSocket" },
        { model: "qwen-audio-3.1-asr-flash-streaming", name: "3.1 Streaming", description: "" },
        { model: "qwen-audio-3.1-asr-flash-streaming", name: "重复项", description: "" },
      ],
    },
  };
  const asr = parseModelList(payload, "asr");
  assert.deepEqual(
    asr.map((item) => item.id),
    ["qwen-audio-3.0-asr-flash-streaming", "qwen-audio-3.1-asr-flash-streaming"],
  );
  assert.equal(asr[0].name, "3.0 Streaming");

  const textToAudio = {
    request_modality: ["Text"],
    response_modality: ["Audio"],
  };
  const tts = parseModelList(
    {
      output: {
        models: [
          { model: "qwen-audio-3.1-tts-plus", name: "3.1 Plus", inference_metadata: textToAudio },
          {
            model: "qwen-audio-3.1-tts-next",
            name: "3.1 Next",
            // Audiogen：还能输入参考音频，AOQ 的 TTS 任务跑不了。
            inference_metadata: { request_modality: ["Text", "Audio"], response_modality: ["Audio"] },
          },
          { model: "qwen-audio-3.1-tts-flash", name: "3.1 Flash", inference_metadata: textToAudio },
          // 同为 TTS 能力，但不是 qwen-audio 这一支。
          { model: "qwen3-tts-flash", name: "Qwen3 TTS", inference_metadata: textToAudio },
          { model: "qwen-audio-3.0-tts-plus", name: "", inference_metadata: textToAudio },
          { model: "qwen-audio-3.0-tts-flash", name: "Flash", inference_metadata: textToAudio },
        ],
      },
    },
    "tts",
  );
  assert.deepEqual(
    tts.map((item) => item.id),
    [
      "qwen-audio-3.1-tts-plus",
      "qwen-audio-3.1-tts-flash",
      "qwen-audio-3.0-tts-plus",
      "qwen-audio-3.0-tts-flash",
    ],
  );
  assert.equal(tts[2].name, "qwen-audio-3.0-tts-plus", "没有展示名时用 ID");
});

check("模型列表格式不对时给出可显示的错误", () => {
  assert.throws(
    () => parseModelList({ output: { models: "nope" } }, "tts"),
    (error) => error.code === "voice_task_failed" && /格式/.test(error.message),
  );
});

check("解析官方音色文档：两种写法都能读，且按模型分节", () => {
  const markdown = `# 音色列表

### qwen-audio-3.0-tts-flash <span id="flash" />

<table>
<tr>
<td>
<strong>名称</strong>：龙安风悦

<strong>voice参数</strong>：longanfengyue

<strong>特质</strong>：自然亲切音

<strong>性别</strong>：女
</td>
</tr>
<tr>
<td>
**名称**: 龙安灵希\\_test

**voice 参数**: <code>longanlingxi\\_test</code>

**性别**: 女
</td>
</tr>
</table>

### qwen-audio-3.0-tts-plus <span id="plus" />

<table>
<tr>
<td>
<strong>名称</strong>：龙安灵心

<strong>voice参数</strong>：longanlingxin

<strong>特质</strong>：知心温暖音
</td>
</tr>
</table>
`;
  const flash = parseVoiceDoc(markdown, "qwen-audio-3.0-tts-flash");
  assert.equal(flash.length, 2);
  assert.deepEqual(flash[0], {
    id: "longanfengyue",
    name: "龙安风悦",
    description: "女 · 自然亲切音",
  });
  assert.equal(flash[1].id, "longanlingxi_test");
  assert.equal(flash[1].name, "龙安灵希_test");

  const plus = parseVoiceDoc(markdown, "qwen-audio-3.0-tts-plus");
  assert.deepEqual(
    plus.map((voice) => voice.id),
    ["longanlingxin"],
  );

  assert.deepEqual(parseVoiceDoc(markdown, "qwen-audio-3.1-tts-flash"), []);
});

check("内置音色快照覆盖两个 AOQ 模型，默认音色都在里面", () => {
  for (const model of ["qwen-audio-3.0-tts-flash", "qwen-audio-3.0-tts-plus"]) {
    assert.ok(BUILTIN_VOICES[model].length > 0, model);
  }
  assert.ok(
    BUILTIN_VOICES["qwen-audio-3.0-tts-flash"].some((voice) => voice.id === "longanlingxi"),
  );
  assert.ok(
    BUILTIN_VOICES["qwen-audio-3.0-tts-plus"].some((voice) => voice.id === "longanlingxin"),
  );
  assert.equal(new URL(VOICE_DOC_URL).hostname, "docs.bailian.console.aliyun.com");
});

console.log(`\n通过：${checks} 项检查。`);
