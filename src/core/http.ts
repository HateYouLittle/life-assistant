/** 脱敏 URL：仅保留 origin+pathname，有 query 时折叠为 "?(redacted)"，避免 API Key 等敏感参数随错误信息泄漏；解析失败返回原文 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return url.origin + url.pathname + (url.search ? "?(redacted)" : "");
  } catch {
    return raw;
  }
}

/** fetch 封装：统一超时与一次重试 */
export async function httpJson<T = unknown>(
  url: string,
  init?: RequestInit,
  timeoutMs = 8000,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${redactUrl(url)}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
    } finally {
      // 无论成功/失败/超时中断，timer 都必须清理，避免悬挂定时器
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
