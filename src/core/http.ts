/** 脱敏 URL：仅保留 origin+pathname，有 query 时折叠为 "?(redacted)"，避免 API Key 等敏感参数随错误信息泄漏；解析失败返回固定占位符 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return url.origin + url.pathname + (url.search ? "?(redacted)" : "");
  } catch {
    return "(invalid-url)";
  }
}

type RetryableError = Error & { retryable?: boolean };

function isRetryableHttpError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // 超时中断（AbortError）与网络层失败（TypeError 等）重试一次；HTTP 5xx 由调用处标记 retryable。
  if (error.name === "AbortError") return true;
  if (error instanceof TypeError) return true;
  return (error as RetryableError).retryable === true;
}

/** fetch 封装：统一超时，仅网络/超时错误与 HTTP 5xx 重试一次；4xx 立即抛出；带 body 的 POST/PUT/PATCH 不自动重试 */
export async function httpJson<T = unknown>(
  url: string,
  init?: RequestInit,
  timeoutMs = 8000,
): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const bodyfulMutation = init?.body !== undefined
    && (method === "POST" || method === "PUT" || method === "PATCH");
  const attempts = bodyfulMutation ? 1 : 2;
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status} for ${redactUrl(url)}`) as RetryableError;
        error.retryable = res.status >= 500 && res.status <= 599;
        throw error;
      }
      return (await res.json()) as T;
    } catch (error) {
      lastErr = error;
      if (!isRetryableHttpError(error) || attempt >= attempts - 1) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    } finally {
      // 无论成功/失败/超时中断，timer 都必须清理，避免悬挂定时器
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
