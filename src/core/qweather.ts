/**
 * 和风天气 API 的跨模块客户端公共层：weather、airquality 与位置 GeoAPI 共用
 * 同一个 QWEATHER_API_HOST / QWEATHER_KEY 配置与业务错误语义，
 * 集中在这里避免每个 provider 各写一份 code 检查。
 */

/** 和风业务错误：HTTP 200 + body.code 字段（如 401/402/403）。
 * code 可能是数字或字符串，统一 String 化比较，避免数字型 code 绕过检查。 */
export function assertQweatherOk(code: unknown, api: string): void {
  if (code !== undefined && code !== null && String(code) !== "200") {
    throw new Error(`QWeather ${api} error code ${code}`);
  }
}
