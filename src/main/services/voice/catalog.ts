import type {
  VoiceKind,
  VoiceModelOption,
  VoiceVoiceCatalog,
  VoiceVoiceOption,
} from "@shared/types";

import { VoiceError } from "./protocol";

/*
 * 语音模型 / 音色的官方清单。
 *
 * - 模型：百炼「查询模型列表」接口 `GET https://{WorkspaceId}.…maas.aliyuncs.com/api/v1/models`，
 *   按能力筛选。TTS 取 `TTS` 里的 qwen-audio 文生音模型（3.1 起只标 `TTS`，不再标
 *   `Realtime-Text-to-Speech`；Audiogen 的 3.1-tts-next 另走一套协议，排除），
 *   ASR 取 `Realtime-ASR` 里 `qwen-audio-*` 的实时流式模型。Key 只在 main 里用，不出进程。
 * - 音色：官方「Qwen-Audio-TTS音色列表」页面（Markdown 版）。百炼没有列音色的 REST 接口，
 *   所以这里读文档页；取不到时回落到内置快照，设置页会注明。
 *
 * 纯解析函数（`parseModelList` / `parseVoiceDoc`）单独导出，冒烟脚本直接喂样例。
 */

const MODELS_PATH = "/api/v1/models";
const PAGE_SIZE = 100;
const TIMEOUT_MS = 15_000;
const USER_AGENT = "GoodJob/0.1 (+https://github.com/)";

export const VOICE_DOC_URL =
  "https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list.md";

/** 去掉用户可能粘进来的协议头与尾部斜杠。 */
function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/** 官方模型列表接口；筛选条件与 AOQ 能跑的两类模型对齐。 */
export function buildModelsUrl(endpoint: string, kind: VoiceKind): string {
  const params = new URLSearchParams({
    page_no: "1",
    page_size: String(PAGE_SIZE),
  });
  if (kind === "tts") {
    params.set("capabilities", "TTS");
    params.set("name", "qwen-audio");
  } else {
    params.set("capabilities", "Realtime-ASR");
    // 同一能力下还有 paraformer / fun-asr 等 WebSocket 模型，AOQ 只接 qwen-audio 这一支。
    params.set("name", "qwen-audio");
  }
  return `https://${normalizeEndpoint(endpoint)}${MODELS_PATH}?${params.toString()}`;
}

/** 解析 `GET /api/v1/models` 的响应；结构不认识时抛 `voice_task_failed`。 */
export function parseModelList(input: unknown, kind: VoiceKind): VoiceModelOption[] {
  const models = readModelObjects(input);
  if (models === null) {
    throw new VoiceError("voice_task_failed", "百炼返回的模型列表格式变了，暂时读不出来。");
  }
  const seen = new Set<string>();
  const options: VoiceModelOption[] = [];
  for (const item of models) {
    const id = typeof item.model === "string" ? item.model.trim() : "";
    if (id === "" || seen.has(id)) continue;
    if (kind === "asr" && !id.startsWith("qwen-audio-")) continue;
    if (kind === "tts" && !isAoqTtsModel(item, id)) continue;
    seen.add(id);
    options.push({
      id,
      name:
        typeof item.name === "string" && item.name.trim() !== ""
          ? item.name.trim()
          : id,
      description: typeof item.description === "string" ? item.description.trim() : "",
    });
  }
  return options;
}

/**
 * AOQ 的 Qwen-Audio-TTS 任务只发文本。`qwen-audio-3.1-tts-next` 是 Audiogen
 * （还能输入参考音频，输出整段声景），协议和任务参数都不同，不能列进来。
 */
function isAoqTtsModel(item: Record<string, unknown>, id: string): boolean {
  if (!id.startsWith("qwen-audio-")) return false;
  const meta = isRecord(item.inference_metadata) ? item.inference_metadata : null;
  if (meta === null) return true;
  const inputs = Array.isArray(meta.request_modality) ? meta.request_modality : [];
  const outputs = Array.isArray(meta.response_modality) ? meta.response_modality : [];
  // 老版本接口不带模态信息时只按模型 ID 判断，别把整个列表过滤空。
  if (inputs.length === 0 && outputs.length === 0) return true;
  return outputs.includes("Audio") && !inputs.includes("Audio");
}

function readModelObjects(input: unknown): Record<string, unknown>[] | null {
  if (!isRecord(input) || !isRecord(input.output)) return null;
  const models = input.output.models;
  if (!Array.isArray(models)) return null;
  return models.filter(isRecord);
}

/** 拉模型列表。错误都换成能直接显示在设置页的中文说明。 */
export async function fetchVoiceModels(
  endpoint: string,
  apiKey: string,
  kind: VoiceKind,
): Promise<VoiceModelOption[]> {
  const url = buildModelsUrl(endpoint, kind);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw new VoiceError(
      "voice_connect_failed",
      `连不上百炼的模型列表接口（${describe(cause)}）。检查网络和接入域名，例如 trial.cn-beijing.maas.aliyuncs.com。`,
    );
  }

  const body = await response.text();
  if (!response.ok) {
    throw new VoiceError(
      response.status === 401 || response.status === 403 ? "voice_auth_failed" : "voice_connect_failed",
      httpMessage(response.status, body),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new VoiceError("voice_task_failed", "百炼返回的模型列表不是 JSON，可能被网关拦截了。");
  }
  return parseModelList(parsed, kind);
}

/**
 * 从官方音色列表页里取某个模型的系统音色；读不到时用内置快照并带上原因。
 */
export async function fetchVoiceCatalog(model: string): Promise<VoiceVoiceCatalog> {
  let warning: string | null = null;
  try {
    const response = await fetch(VOICE_DOC_URL, {
      headers: { accept: "text/markdown, text/plain", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const voices = parseVoiceDoc(await response.text(), model);
    if (voices.length > 0) {
      return { model, voices, source: "official", warning: null };
    }
    warning = `官方音色列表里没有 ${model} 的音色。`;
  } catch (cause) {
    warning = `读取官方音色列表失败（${describe(cause)}），先用内置列表。`;
  }
  return { model, voices: BUILTIN_VOICES[model] ?? [], source: "builtin", warning };
}

/**
 * 解析官方音色文档：找到 `### {model}` 这一节，按表格行提取 `名称` / `voice参数` /
 * `性别` / `特质`。文档里两种写法（`<strong>` 与 Markdown 粗体）都兼容。
 */
export function parseVoiceDoc(markdown: string, model: string): VoiceVoiceOption[] {
  const heading = new RegExp(`^###\\s+${escapeRegExp(model)}\\b.*$`, "m").exec(markdown);
  if (heading === null) return [];
  const rest = markdown.slice(heading.index + heading[0].length);
  const next = /^#{2,3}\s/m.exec(rest);
  const section = next === null ? rest : rest.slice(0, next.index);

  const seen = new Set<string>();
  const voices: VoiceVoiceOption[] = [];
  for (const row of section.split(/<tr\b[^>]*>/).slice(1)) {
    const id = readVoiceId(row);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    const brand = readField(row, "名称");
    const gender = readField(row, "性别");
    const trait = readField(row, "特质");
    voices.push({
      id,
      name: brand === "" ? id : brand,
      description: [gender, trait].filter((part) => part !== "").join(" · "),
    });
  }
  return voices;
}

function readVoiceId(row: string): string {
  const patterns = [
    /<strong>\s*voice\s*参数\s*<\/strong>\s*[:：]\s*(?:<code>)?([A-Za-z0-9_.\\-]+)/i,
    /\*\*\s*voice\s*参数\s*\*\*\s*[:：]\s*(?:<code>)?([A-Za-z0-9_.\\-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(row);
    if (match !== null) return (match[1] ?? "").replace(/\\_/g, "_").trim();
  }
  return "";
}

/** 取表格单元格里 `名称` / `性别` / `特质` 这类字段的值。 */
function readField(row: string, label: string): string {
  const patterns = [
    new RegExp(`<strong>\\s*${label}\\s*</strong>\\s*[:：]\\s*([^<\\n]+)`),
    new RegExp(`\\*\\*\\s*${label}\\s*\\*\\*\\s*[:：]\\s*([^<\\n]+)`),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(row);
    if (match !== null) {
      return (match[1] ?? "").replace(/[\\*]/g, "").trim();
    }
  }
  return "";
}

function httpMessage(status: number, body: string): string {
  const detail = readApiMessage(body);
  if (status === 401 || status === 403) {
    return `百炼没有接受这个 API Key（HTTP ${status}）${detail === "" ? "" : `：${detail}`}。确认 Key 属于当前业务空间。`;
  }
  if (status === 404) {
    return "这个接入域名上没有模型列表接口（HTTP 404）：填业务空间域名，例如 {WorkspaceId}.cn-beijing.maas.aliyuncs.com，或试用域名 trial.cn-beijing.maas.aliyuncs.com。";
  }
  return `百炼的模型列表接口返回 HTTP ${status}${detail === "" ? "" : `：${detail}`}。`;
}

function readApiMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      if (typeof parsed.message === "string" && parsed.message.trim() !== "") return parsed.message.trim();
      if (isRecord(parsed.error) && typeof parsed.error.message === "string") {
        return parsed.error.message.trim();
      }
    }
  } catch {
    // 网关可能直接回一段 HTML，交给下面截断。
  }
  const text = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 160);
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") return "请求超时";
    return cause.message;
  }
  return String(cause);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 内置音色快照：官方文档页取不到时的兜底。只覆盖 AOQ 能用的两个模型，
 * 取值来自 2026-07 的官方音色列表。
 */
export const BUILTIN_VOICES: Record<string, VoiceVoiceOption[]> = {
  "qwen-audio-3.0-tts-flash": [
    { id: "longanfengyue", name: "龙安风悦", description: "女 · 自然亲切音" },
    { id: "longanyuanfei", name: "龙安元妃", description: "女 · 高傲妃子音" },
    { id: "longanlingxi", name: "龙安灵希", description: "女 · 可爱甜美音" },
    { id: "longanxiaoxin", name: "龙安小昕", description: "女 · 亲切活泼音" },
    { id: "longanhuan_v3.6", name: "龙安欢", description: "女" },
    { id: "longjielidou_v3.6", name: "龙杰力豆", description: "男 · 天真男童" },
    { id: "longpaopao_v3.6", name: "龙泡泡", description: "女 · 软糯可爱音" },
    { id: "longhuohuo_v3.6", name: "龙火火", description: "男 · 顽皮少年音" },
    { id: "longchuanshu_v3.6", name: "龙川叔", description: "男 · 川普大叔音" },
    { id: "loongmary", name: "loongmary", description: "女 · 温暖英音" },
    { id: "loongeva_v3.6", name: "loongeva", description: "女 · 高智美音" },
    { id: "loongjohn", name: "loongJohn", description: "男 · 沉稳亲切美音" },
  ],
  "qwen-audio-3.0-tts-plus": [
    { id: "longanlingxin", name: "龙安灵心", description: "女 · 知心温暖音" },
    { id: "longanlufeng", name: "龙安鲁风", description: "男 · 明亮开朗音" },
  ],
};
