import { APICallError } from "ai";

/** 把异常转成可以直接展示给用户的文本。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "调用模型失败（未知错误）";
}

/**
 * 流内错误（AI SDK 默认拿 `An error occurred.` 遮掉）的可见说法。
 *
 * 接中转站时真正的理由只写在响应体里（例如 `Invalid schema for function
 * 'browser_read': ...`），只报一句 `An error occurred.` 等于把线索全丢了。
 * 这里带上 HTTP 状态与响应体片段（响应体不包含 Key，Key 只在请求头）。
 */
export function describeStreamError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    const status = error.statusCode === undefined ? "" : `HTTP ${error.statusCode} `;
    const body = (error.responseBody ?? "").replace(/\s+/g, " ").trim();
    return `${status}${error.message}${body === "" ? "" : `：${body.slice(0, 400)}`}`;
  }
  return describeError(error);
}

/** baseURL 进日志前去掉 userinfo / query：有些中转服务会把 Key 拼在 URL 里。 */
export function sanitizeBaseURL(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "(无法解析的 baseURL)";
  }
}
