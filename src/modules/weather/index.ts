import { z } from "zod";
import { DateTime } from "luxon";
import { config } from "../../config.js";
import { currentLocation } from "../../core/location.js";
import { httpJson } from "../../core/http.js";
import { publishGlobal } from "../../core/notifier.js";
import { registerModule, ok, fail, type AssistantModule } from "../../core/registry.js";
import { fetchOilPrice, type OilPrice } from "../oilprice/provider.js";
import {
  fetchCurrent,
  fetchForecast,
  fetchAlerts,
  qweatherGeo,
  type CurrentWeather,
  type ForecastDay,
} from "./provider.js";

export interface DailyWeatherBriefOptions {
  at?: Date;
  timezone?: string;
  getLocation?: () => { city: string; lat: number; lon: number } | null;
  getCurrent?: (lat: number, lon: number, city: string) => Promise<CurrentWeather>;
  getForecast?: (lat: number, lon: number, days: number, city: string) => Promise<ForecastDay[]>;
  getOilPrice?: (city: string) => Promise<OilPrice>;
  publish?: (source: string, title: string, body: string, dedupeKey: string) => Promise<void>;
}

function usableOilPrice(oil: OilPrice): boolean {
  return [oil.p92, oil.p95, oil.p0].every((value) => value !== "—" && !value.includes("未配置"));
}

export async function runDailyWeatherBrief(options: DailyWeatherBriefOptions = {}): Promise<void> {
  const location = (options.getLocation ?? currentLocation)();
  if (!location) return;
  const at = options.at ?? new Date();
  const timezone = options.timezone ?? config.timezone;
  const localDate = DateTime.fromJSDate(at).setZone(timezone).toISODate();
  if (!localDate) throw new Error(`invalid daily brief timezone: ${timezone}`);

  const getCurrent = options.getCurrent ?? fetchCurrent;
  const getForecast = options.getForecast ?? fetchForecast;
  const getOilPrice = options.getOilPrice ?? fetchOilPrice;
  const [current, forecast, oil] = await Promise.allSettled([
    getCurrent(location.lat, location.lon, location.city),
    getForecast(location.lat, location.lon, 1, location.city),
    getOilPrice(location.city),
  ]);
  if (current.status === "rejected" && (forecast.status === "rejected" || forecast.value.length === 0)) {
    const forecastFailure = forecast.status === "rejected"
      ? forecast.reason
      : new Error("daily weather brief forecast was empty");
    throw new AggregateError([current.reason, forecastFailure], "daily weather brief providers failed");
  }

  const lines: string[] = [];
  if (current.status === "fulfilled") {
    const value = current.value;
    lines.push(`当前${value.weatherText}，${value.temperature}℃，体感${value.apparent}℃，湿度${value.humidity}%`);
  }
  if (forecast.status === "fulfilled" && forecast.value[0]) {
    const today = forecast.value[0];
    const precipitation = today.precipProb !== undefined
      ? `，降水概率${today.precipProb}%`
      : today.precipAmountMm !== undefined
        ? `，预计降水${today.precipAmountMm}mm`
        : "";
    lines.push(`今日${today.weatherText}，${today.tMin}~${today.tMax}℃${precipitation}`);
  }
  if (oil.status === "fulfilled" && usableOilPrice(oil.value)) {
    lines.push(`${oil.value.region}油价：92# ${oil.value.p92}元/升，95# ${oil.value.p95}元/升，0# ${oil.value.p0}元/升`);
  }

  const publish = options.publish ?? publishGlobal;
  await publish(
    "weather",
    `早安，${location.city}生活简报`,
    lines.join("\n"),
    `weather:daily-brief:${localDate}`,
  );
}

function requireLocation() {
  const loc = currentLocation();
  if (!loc) throw new Error("位置未确认，请先调用 location.get 完成位置确认流程");
  return loc;
}

/**
 * 解析查询位置：
 * - 无 city → 全局已确认位置（不改变）
 * - 有 city → 走和风 GeoAPI（对中文区县支持好，如"朔城区"），失败则回退 Open-Meteo；
 *   只做临时查询，绝不写入 location:current（多 profile 共享 store 时避免互相污染）
 */
async function resolveLocation(city?: string): Promise<{ city: string; lat: number; lon: number }> {
  if (!city) {
    const loc = requireLocation();
    return { city: loc.city, lat: loc.lat, lon: loc.lon };
  }
  if (config.qweatherKey) {
    try {
      const geo = await qweatherGeo(city);
      return { city, lat: geo.lat, lon: geo.lon };
    } catch (e) {
      console.error(`[weather] qweather geo failed for "${city}": ${(e as Error).message}`);
    }
  }
  const r = await httpJson<{ results?: Array<{ name: string; latitude: number; longitude: number }> }>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`,
  );
  const hit = r.results?.[0];
  if (!hit) throw new Error(`未找到城市：${city}`);
  return { city: hit.name, lat: hit.latitude, lon: hit.longitude };
}

const weatherModule: AssistantModule = {
  name: "weather",
  tools: [
    {
      name: "current",
      description: "查询实时天气。默认查询已保存位置；也可传 city 查询任意城市（如 朔城区/北京），临时查询不改变已保存位置。",
      schema: { city: z.string().optional().describe("城市名（可选），如 朔城区/北京；不传则查已保存位置") },
      handler: async (args) => {
        try {
          const { city } = z.object({ city: z.string().optional() }).parse(args ?? {});
          const loc = await resolveLocation(city);
          const w = await fetchCurrent(loc.lat, loc.lon, loc.city);
          return ok({ city: loc.city, ...w, unit: { temperature: "℃", windSpeed: w.windSpeedUnit } });
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    },
    {
      name: "forecast",
      description: "查询未来 N 天天气预报。默认查询已保存位置；也可传 city 查询任意城市（如 朔城区/北京），临时查询不改变已保存位置。",
      schema: { days: z.number().min(1).max(7).default(3).describe("预报天数 1-7"), city: z.string().optional().describe("城市名（可选），如 朔城区/北京；不传则查已保存位置") },
      handler: async (args) => {
        try {
          const { days, city } = z.object({ days: z.number().min(1).max(7).default(3), city: z.string().optional() }).parse(args ?? {});
          const loc = await resolveLocation(city);
          return ok({ city: loc.city, forecast: await fetchForecast(loc.lat, loc.lon, days, loc.city) });
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    },
    {
      name: "alerts",
      description: "查询当前生效的气象预警（暴雨/台风/高温/大风等）。默认查询已保存位置；也可传 city 查询任意城市，临时查询不改变已保存位置。",
      schema: { city: z.string().optional().describe("城市名（可选），如 朔城区/北京；不传则查已保存位置") },
      handler: async (args) => {
        try {
          const { city } = z.object({ city: z.string().optional() }).parse(args ?? {});
          const loc = await resolveLocation(city);
          const alerts = await fetchAlerts(loc.city, loc.lat, loc.lon);
          return ok({ city: loc.city, count: alerts.length, alerts });
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    },
  ],
  jobs: [
    {
      name: "daily_brief",
      cron: config.cron.dailyWeatherBrief,
      timezone: config.timezone,
      handler: async () => runDailyWeatherBrief(),
    },
    {
      name: "alerts_check",
      cron: config.cron.weatherAlerts,
      handler: async ({ notify }) => {
        const loc = currentLocation();
        if (!loc) return;
        const alerts = await fetchAlerts(loc.city, loc.lat, loc.lon);
        for (const a of alerts) {
          // dedupeKey 含标题与日期：同一天同一预警只推一次
          const key = `weather:alert:${a.title}:${new Date().toISOString().slice(0, 10)}`;
          await notify(`⛈ ${a.title}`, a.description, key);
        }
      },
    },
  ],
};

registerModule(weatherModule);
