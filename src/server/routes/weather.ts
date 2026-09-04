import { Hono } from "hono";
import { fetchAirQuality } from "../../modules/airquality/provider.js";
import { currentLocation } from "../../modules/location/index.js";
import {
  fetchAlerts,
  fetchCurrent,
  fetchForecast,
  fetchIndices,
} from "../../modules/weather/provider.js";

/** 天气聚合的短 TTL 缓存：避免每刷新一次看板就打一遍上游（和风/Open-Meteo/AQI），
 * 消耗第三方配额。默认 300s，无 location 或响应体异常时不缓存。 */
const WEATHER_CACHE_TTL_MS = 300_000;
const cache = new Map<string, { at: number; body: unknown }>();

export function weatherCacheKey(location: { city: string; lat: number; lon: number }): string {
  return `${location.lat.toFixed(3)},${location.lon.toFixed(3)},${location.city}`;
}

export function weatherCacheGet(key: string, ttlMs = WEATHER_CACHE_TTL_MS, now = Date.now()): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (now - entry.at > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return entry.body;
}

export function weatherCacheSet(key: string, body: unknown, at = Date.now()): void {
  // 有界清理：键数量超过 256 时整体清一次，防无界增长。
  if (cache.size >= 256) cache.clear();
  cache.set(key, { at, body });
}

export function weatherCacheClear(): void {
  cache.clear();
}

export const weatherRoute = new Hono();

weatherRoute.get("/", async (c) => {
  const location = currentLocation();
  if (!location) {
    return c.json({ error: "location_not_set", location: null });
  }

  const key = weatherCacheKey(location);
  const cached = weatherCacheGet(key);
  if (cached !== undefined) {
    return c.json(cached);
  }

  const [currentRes, forecastRes, airQualityRes, alertsRes, indicesRes] =
    await Promise.allSettled([
      fetchCurrent(location.lat, location.lon, location.city),
      fetchForecast(location.lat, location.lon, 7, location.city),
      fetchAirQuality(location.city, location.lat, location.lon),
      fetchAlerts(location.city, location.lat, location.lon),
      fetchIndices(location.city, location.lat, location.lon),
    ]);

  const current = currentRes.status === "fulfilled" ? currentRes.value : null;
  const forecast = forecastRes.status === "fulfilled" ? forecastRes.value : null;
  const airQuality = airQualityRes.status === "fulfilled" ? airQualityRes.value : null;
  const alerts = alertsRes.status === "fulfilled" ? alertsRes.value : null;
  const indices = indicesRes.status === "fulfilled" ? indicesRes.value : null;

  // 仅当至少拿到实时天气（核心数据）时才缓存，避免把「全失败」响应钉住 5 分钟。
  const body = {
    location,
    current,
    forecast,
    airQuality,
    alerts,
    indices,
  };
  if (current !== null) weatherCacheSet(key, body);

  return c.json(body);
});
