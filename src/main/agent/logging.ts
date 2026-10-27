/** 把异常转成可以直接展示给用户的文本。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "调用模型失败（未知错误）";
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
