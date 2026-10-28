import { APICallError, generateText } from "ai";

import type {
  ModelProbeResult,
  ProviderProtocol,
  RemoteModelInfo,
} from "@shared/types";

import { createLanguageModel } from "../agent/model-provider";
import type { ResolvedModel, ResolvedProvider } from "../stores/models";

/**
 * 设置页的两个「试一下」：拉模型列表、测连通性。
 *
 * 两者都必须跑在 main：API Key 只在 main 解密，渲染层永远拿不到明文。
 * - 测连通性走 AI SDK 的 `generateText`（同一套 provider 适配层，能真实验证
 *   「这个模型 + 这个 Key + 这个端点」），只发一句最短的话，回执只留结论与耗时。
 * - 拉列表没有 AI SDK 对应物（`LanguageModel` 只有推理能力，没有「列出模型」），
 *   所以这里按协议读各家 `/models`，是最薄的一层 HTTP，不涉及请求构造与解析。
 */

/** 列模型的超时：中转站慢的时候很慢，但用户不会等太久。 */
const LIST_TIMEOUT_MS = 15_000;

/** 测试请求的超时：思考型模型的首字节可能要十几秒。 */
const TEST_TIMEOUT_MS = 45_000;

/** 测试请求的输出上限：只要证明有回复，不要它写作文。 */
const TEST_MAX_OUTPUT_TOKENS = 32;

/** 「列出这家供应商有哪些模型」——只依赖端点 + 凭证。 */
export async function fetchModelList(provider: ResolvedProvider): Promise<RemoteModelInfo[]> {
  const baseURL = provider.baseURL.trim().replace(/\/+$/, "");
  if (baseURL === "") {
    throw new Error("还没填 Base URL，先填上再获取模型列表。");
  }

  const { url, headers } = listEndpoint(baseURL, provider.protocol, provider.apiKey);
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  } catch (caught) {
    // fetch 层错误（连不上 / 超时）：不把 "fetch failed" 直接丢给用户。
    throw new Error(`请求 ${url} 失败：${describeFailure(caught, LIST_TIMEOUT_MS)}`);
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(httpFailure("获取模型列表", response.status, body));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // 200 却给了非 JSON：多半是 Base URL 指到了网页而不是 API。
    throw new Error(`端点返回的不是 JSON，检查 Base URL 是否指向 API（${url}）。`);
  }

  const models = readModelList(parsed);
  if (models.length === 0) {
    throw new Error("接口没有返回任何模型，可能不支持 /models，手动填模型 ID 即可。");
  }
  return models;
}

/** 「这个模型现在能用吗」——真发一次最小请求，成功即连通。 */
export async function testModel(target: ResolvedModel): Promise<ModelProbeResult> {
  if (target.missingApiKey) {
    return { ok: false, message: `供应商「${target.providerName}」还没有填写 API Key。` };
  }
  if (target.baseURL.trim() === "") {
    return { ok: false, message: "还没填 Base URL。" };
  }

  const startedAt = Date.now();
  try {
    const result = await generateText({
      model: createLanguageModel(target),
      prompt: "回复两个字：可用",
      maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
      // 测连通性不要重试：连不上就是连不上，退避重试只会让用户多等十几秒。
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    const reply = result.text.trim().replace(/\s+/g, " ");
    return {
      ok: true,
      latencyMs,
      message:
        reply === ""
          ? `已连通 ${latencyMs}ms`
          : `已连通 ${latencyMs}ms · 回复「${clip(reply, 40)}」`,
    };
  } catch (caught) {
    return { ok: false, message: describeFailure(caught) };
  }
}

function listEndpoint(
  baseURL: string,
  protocol: ProviderProtocol,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  switch (protocol) {
    case "anthropic-messages":
      // Anthropic 的 /v1/models 用 x-api-key（不是 Bearer），且必须带版本头。
      return {
        url: `${baseURL}/models`,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          accept: "application/json",
        },
      };
    case "google-generative-ai":
      // Gemini 原生接口：Key 走请求头，模型名带 `models/` 前缀。
      return {
        url: `${baseURL}/models?pageSize=200`,
        headers: { "x-goog-api-key": apiKey, accept: "application/json" },
      };
    default:
      // OpenAI 兼容（含 /v1/responses）：标准 Bearer + GET /models。
      return {
        url: `${baseURL}/models`,
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      };
  }
}

/**
 * 各家的返回形状：OpenAI `{data:[{id}]}`、Anthropic `{data:[{id,display_name}]}`、
 * Gemini `{models:[{name:"models/x",displayName,inputTokenLimit}]}`，个别中转站直接给数组。
 */
function readModelList(parsed: unknown): RemoteModelInfo[] {
  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.data)
      ? parsed.data
      : isRecord(parsed) && Array.isArray(parsed.models)
        ? parsed.models
        : [];

  const seen = new Set<string>();
  const models: RemoteModelInfo[] = [];
  for (const row of rows) {
    const entry = readModelRow(row);
    if (entry === null || seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push(entry);
  }
  return models.sort((left, right) => left.id.localeCompare(right.id));
}

function readModelRow(row: unknown): RemoteModelInfo | null {
  if (typeof row === "string") {
    const id = row.trim();
    return id === "" ? null : { id, name: id };
  }
  if (!isRecord(row)) return null;

  // Gemini 用 `name`（"models/gemini-2.5-pro"），OpenAI / Anthropic 用 `id`。
  const rawId =
    typeof row.id === "string" && row.id.trim() !== ""
      ? row.id
      : typeof row.name === "string"
        ? row.name.replace(/^models\//, "")
        : "";
  const id = rawId.trim();
  if (id === "") return null;

  // Gemini 有些模型（embedding / 图像）不能做对话，列出来只会误导。
  if (Array.isArray(row.supportedGenerationMethods)) {
    const methods = row.supportedGenerationMethods.filter(
      (item): item is string => typeof item === "string",
    );
    if (!methods.includes("generateContent")) return null;
  }

  const display =
    typeof row.display_name === "string" && row.display_name.trim() !== ""
      ? row.display_name.trim()
      : typeof row.displayName === "string" && row.displayName.trim() !== ""
        ? row.displayName.trim()
        : id;

  const contextWindow = readContextWindow(row);
  return contextWindow === undefined ? { id, name: display } : { id, name: display, contextWindow };
}

function readContextWindow(row: Record<string, unknown>): number | undefined {
  for (const key of ["inputTokenLimit", "context_window", "context_length", "max_context_length"]) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
  }
  return undefined;
}

/** 把 HTTP 失败翻成一句人话；错误体里通常有供应商自己写的 message。 */
function httpFailure(action: string, status: number, body: string): string {
  const detail = errorDetail(body);
  const head = `${action}失败（HTTP ${status}）`;
  return detail === "" ? head : `${head}：${detail}`;
}

function errorDetail(body: string): string {
  const text = body.trim();
  if (text === "") return "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const inner = parsed.error;
      if (isRecord(inner) && typeof inner.message === "string") return clip(inner.message, 300);
      if (typeof inner === "string") return clip(inner, 300);
      if (typeof parsed.message === "string") return clip(parsed.message, 300);
    }
  } catch {
    // 不是 JSON：直接给正文片段（去掉尖括号噪音，避免一整页 HTML 糊到界面上）。
  }
  return clip(text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(), 300);
}

function describeFailure(caught: unknown, timeoutMs: number = TEST_TIMEOUT_MS): string {
  if (caught instanceof Error && (caught.name === "TimeoutError" || caught.name === "AbortError")) {
    return `请求超时（${Math.round(timeoutMs / 1000)} 秒没有响应）。`;
  }

  const raw =
    caught instanceof Error
      ? caught.message === ""
        ? caught.name
        : caught.message
      : String(caught);
  // fetch 层的字面值是 "fetch failed" / "Cannot connect to API: …"，后面补上该查哪里。
  const network = /fetch failed|cannot connect to api|ECONNREFUSED|ENOTFOUND|getaddrinfo/i.test(raw);
  const withHint = (value: string): string => clip(network ? `${value}（检查 Base URL 与网络）` : value, 300);

  if (APICallError.isInstance(caught)) {
    // 供应商的错文通常写在响应体里（"invalid api key" / "model not found"），
    // 比 AI SDK 的通用描述有用得多，优先把它接上——AI SDK 已经把它拼进 message 时不重复。
    const head = caught.statusCode === undefined ? raw : `HTTP ${caught.statusCode} — ${raw}`;
    const detail = caught.responseBody === undefined ? "" : errorDetail(caught.responseBody);
    const repeated = detail === "" || raw.includes(detail);
    return withHint(repeated ? head : `${head}：${detail}`);
  }
  return withHint(raw);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
