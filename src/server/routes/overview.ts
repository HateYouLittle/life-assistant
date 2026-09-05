import { Hono } from "hono";
import { DateTime } from "luxon";
import { getQuietHours } from "../../core/notification-settings.js";
import { summarizeProfileLedgers } from "../../modules/bookkeeping/service.js";
import { dayInfo, nextHoliday } from "../../modules/holiday/calendar.js";
import { currentLocation } from "../../modules/location/index.js";
import { currentOilPriceResult, nextAdjustmentSummary } from "../../modules/oilprice/index.js";
import { fetchOilPrice } from "../../modules/oilprice/provider.js";
import { listSchedules } from "../../modules/schedule/service.js";
import { fetchCurrent, fetchForecast } from "../../modules/weather/provider.js";
import { weatherCacheGet, weatherCacheKey, weatherCacheSet } from "./weather.js";
import { oilPriceCacheGet, oilPriceCacheSet } from "./oilprice.js";
import type { AppEnv } from "../types.js";

export const overviewRoute = new Hono<AppEnv>();

overviewRoute.get("/", async (c) => {
  const profile =
    c.req.query("profile") ||
    c.get("defaultProfile") ||
    process.env.HERMES_PROFILE ||
    "default";

  const loc = currentLocation();

  const todayIso = DateTime.now().setZone("Asia/Shanghai").toISODate()!;
  const calendar = {
    today: dayInfo(todayIso),
    nextHoliday: nextHoliday(),
  };

  let weather = null;
  if (loc) {
    const key = weatherCacheKey(loc);
    const cached = weatherCacheGet(key) as { current?: unknown; forecast?: unknown[] } | undefined;
    if (cached?.current) {
      weather = { current: cached.current, forecast: cached.forecast };
    } else {
      try {
        const [current, forecast] = await Promise.all([
          fetchCurrent(loc.lat, loc.lon, loc.city),
          fetchForecast(loc.lat, loc.lon, 1, loc.city),
        ]);
        weather = { current, forecast };
      } catch {
        weather = null;
      }
    }
  }

  let oilprice = null;
  if (loc) {
    const cachedCurrent = oilPriceCacheGet(loc.city) as any;
    let current = cachedCurrent;
    if (!current) {
      try {
        const obs = await fetchOilPrice(loc.city);
        current = currentOilPriceResult(obs);
        if (current) oilPriceCacheSet(loc.city, current);
      } catch {
        current = null;
      }
    }
    const nextAdjustment = nextAdjustmentSummary();
    oilprice = { current, nextAdjustment };
  }

  const activeCount = listSchedules(profile, { status: "active" }).length;
  const summary = summarizeProfileLedgers(profile);
  const quietHours = getQuietHours(profile);

  return c.json({
    profile,
    location: loc,
    calendar,
    weather,
    oilprice,
    schedules: {
      activeCount,
    },
    bookkeeping: {
      summary,
    },
    quietHours,
  });
});
