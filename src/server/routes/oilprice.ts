import { Hono } from "hono";
import { currentLocation } from "../../modules/location/index.js";
import { currentOilPriceResult, nextAdjustmentSummary } from "../../modules/oilprice/index.js";
import { fetchOilPrice } from "../../modules/oilprice/provider.js";

/** 油价的 1 小时内存 TTL 缓存：避免每次刷新看板频繁消耗 TianAPI/JUHE 商业配额。 */
const OILPRICE_CACHE_TTL_MS = 3600_000;
const cache = new Map<string, { at: number; body: unknown }>();

export function oilPriceCacheGet(city: string, ttlMs = OILPRICE_CACHE_TTL_MS, now = Date.now()): unknown | undefined {
  const entry = cache.get(city);
  if (!entry) return undefined;
  if (now - entry.at > ttlMs) {
    cache.delete(city);
    return undefined;
  }
  return entry.body;
}

export function oilPriceCacheSet(city: string, body: unknown, at = Date.now()): void {
  if (cache.size >= 128) cache.clear();
  cache.set(city, { at, body });
}

export function oilPriceCacheClear(): void {
  cache.clear();
}

export const oilpriceRoute = new Hono();

oilpriceRoute.get("/", async (c) => {
  const location = currentLocation();
  let current = null;
  if (location) {
    const cached = oilPriceCacheGet(location.city) as any;
    if (cached) {
      current = cached;
    } else {
      try {
        const obs = await fetchOilPrice(location.city);
        current = currentOilPriceResult(obs);
        if (current) oilPriceCacheSet(location.city, current);
      } catch {
        current = null;
      }
    }
  }

  let nextAdjustment = null;
  try {
    nextAdjustment = nextAdjustmentSummary();
  } catch {
    nextAdjustment = null;
  }

  return c.json({
    location,
    current,
    nextAdjustment,
  });
});
