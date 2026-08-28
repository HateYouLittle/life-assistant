import { config } from "../../config.js";
import { httpJson } from "../../core/http.js";
import { store } from "../../core/store.js";

/**
 * 和风 GeoAPI 城市查询（中文区县支持好）与缓存。属于位置域的公共能力：
 * location.detect、resolveLocation 及天气 current/forecast 的 city→ID 路径共用。
 */

/**
 * 和风城市 ID 缓存：GeoAPI 查询结果落 store，避免每次重复消耗额度。
 * key: qweather:geo:{city}，缓存 7 天（城市 ID 极少变动）。
 */
const GEO_CACHE_PREFIX = "qweather:geo:";
const GEO_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * 和风 location ID 白名单：字母数字（如 101010100、101060109）。weather/provider.ts
 * 会把该 ID 原样拼进请求 URL（location=...查询参数），非白名单字符（/、;、= 等）
 * 会污染 URL；读取侧与写入侧共用同一校验，脏缓存同样被拒（L8）。
 */
const QWEATHER_ID_PATTERN = /^[A-Za-z0-9]+$/;

function isWellFormedLocationId(value: unknown): value is string {
  return typeof value === "string" && QWEATHER_ID_PATTERN.test(value);
}

interface GeoCacheEntry {
  id: string;
  lat: number;
  lon: number;
  ts: number;
}

/** 坐标校验（有限数且 ±90/±180 范围内），写入与读取共用同一口径（N2）。 */
function isValidCoordinatePair(lat: unknown, lon: unknown): boolean {
  return typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90
    && typeof lon === "number" && Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

function isValidGeoCacheEntry(raw: unknown): raw is GeoCacheEntry {
  if (!raw || typeof raw !== "object") return false;
  const candidate = raw as Record<string, unknown>;
  return isWellFormedLocationId(candidate.id)
    && isValidCoordinatePair(candidate.lat, candidate.lon)
    && typeof candidate.ts === "number" && Number.isFinite(candidate.ts);
}

function cachedGeo(city: string): { id: string; lat: number; lon: number } | null {
  try {
    const key = GEO_CACHE_PREFIX + city;
    const raw = store.get<GeoCacheEntry>(key);
    if (!isValidGeoCacheEntry(raw)) {
      // N2：升级前写入的脏缓存（空 id/非有限或越界坐标）立即清除并强制重新查询
      if (raw !== undefined) store.del(key);
      return null;
    }
    if (Date.now() - raw.ts < GEO_CACHE_TTL_MS) return { id: raw.id, lat: raw.lat, lon: raw.lon };
  } catch { /* 忽略缓存读取错误 */ }
  return null;
}

/** 和风 GeoAPI 城市查询（中文区县支持好），带缓存 */
export async function qweatherGeo(city: string): Promise<{ id: string; lat: number; lon: number }> {
  const cached = cachedGeo(city);
  if (cached) return cached;
  const geo = await httpJson<{ location?: Array<{ id: string; lat: string; lon: string }> }>(
    `https://${config.qweatherApiHost}/geo/v2/city/lookup?location=${encodeURIComponent(city)}&key=${config.qweatherKey}`,
  );
  const hit = geo.location?.[0];
  // L8：id 必须为字母数字（和风 location ID 白名单）；非白名单字符会污染下游请求 URL
  if (!hit || !isWellFormedLocationId(hit.id)) throw new Error(`和风天气未找到城市：${city}`);
  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  // 坐标非有限数或越界：拒绝并避免把垃圾坐标写入 7 天缓存（与缓存读取侧同一口径）
  if (!isValidCoordinatePair(lat, lon)) {
    throw new Error(`和风天气返回无效坐标：${city}`);
  }
  const result = { id: hit.id, lat, lon };
  store.set(GEO_CACHE_PREFIX + city, { ...result, ts: Date.now() });
  return result;
}
