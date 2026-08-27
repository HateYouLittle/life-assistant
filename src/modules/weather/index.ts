import { z } from "zod";
import { DateTime } from "luxon";
import { config } from "../../config.js";
import { publishNotification } from "../../core/notification-publisher.js";
import type { DailyWeatherPayload, NotificationEnvelope } from "../../core/notification.js";
import { publishGlobal } from "../../core/notifier.js";
import { registerModule, ok, withTool, type AssistantModule } from "../../core/registry.js";
import { currentLocation, resolveLocation } from "../location/index.js";
import {
  fetchCurrent,
  fetchForecast,
  fetchAlerts,
  fetchIndices,
  type CurrentWeather,
  type ForecastDay,
  type WeatherAlert,
} from "./provider.js";
import { fetchAirQuality, type AirQuality } from "../airquality/provider.js";
import { inferredAlertNotification, legacyWeatherAlertDedupeKeys, officialAlertNotification } from "./notification.js";

export interface DailyWeatherBriefOptions {
  at?: Date;
  timezone?: string;
  getLocation?: () => { city: string; lat: number; lon: number } | null;
  getCurrent?: (lat: number, lon: number, city: string) => Promise<CurrentWeather>;
  getForecast?: (lat: number, lon: number, days: number, city: string) => Promise<ForecastDay[]>;
  getAirQuality?: (city: string, lat: number, lon: number) => Promise<AirQuality>;
  publish?: (
    source: string,
    title: string,
    body: string,
    dedupeKey: string,
    legacyDedupeKeys?: readonly string[],
  ) => Promise<void>;
}

/** 带伞建议：概率（Open-Meteo）、量级（和风，1mm 起滤掉痕量）、天气现象三信号任一命中。 */
export function umbrellaWarranted(today: ForecastDay): boolean {
  if ((today.precipProb ?? 0) >= 60) return true;
  if ((today.precipAmountMm ?? 0) >= 1) return true;
  // 天气现象文本含"雨"（阵雨/雷阵雨/毛毛雨/冻雨…）：WMO 映射的雪类不含"雨"，天然排除。
  return /雨/.test(today.weatherText);
}

export function dailyAdvice(today: ForecastDay | undefined): string | undefined {
  if (!today) return undefined;
  const advice: string[] = [];
  if (today.tMax >= 35) advice.push("减少午后长时间户外活动");
  if (umbrellaWarranted(today)) advice.push("外出记得带伞");
  return advice.length > 0 ? advice.join("，") : undefined;
}

function dailyHeadline(city: string, current: CurrentWeather | undefined, today: ForecastDay | undefined): string {
  if (today) {
    const advice = dailyAdvice(today);
    const shortAdvice = advice
      ? `，注意${advice.includes("减少午后") ? "防暑" : ""}${advice.includes("带伞") ? "带伞" : ""}`
      : "";
    return `${city}今天${today.weatherText}，${today.tMin}～${today.tMax}℃${shortAdvice}`;
  }
  return `${city}当前${current!.weatherText}，${current!.temperature}℃`;
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
  const getAirQuality = options.getAirQuality ?? fetchAirQuality;
  const [current, forecast, airQuality] = await Promise.allSettled([
    getCurrent(location.lat, location.lon, location.city),
    getForecast(location.lat, location.lon, 1, location.city),
    // 空气质量 best-effort：单源失败不阻断简报，仅在两侧天气可用时并入一行。
    getAirQuality(location.city, location.lat, location.lon),
  ]);
  if (current.status === "rejected" && (forecast.status === "rejected" || forecast.value.length === 0)) {
    const forecastFailure = forecast.status === "rejected"
      ? forecast.reason
      : new Error("daily weather brief forecast was empty");
    throw new AggregateError([current.reason, forecastFailure], "daily weather brief providers failed");
  }

  const currentValue = current.status === "fulfilled" ? current.value : undefined;
  const today = forecast.status === "fulfilled" ? forecast.value[0] : undefined;
  const aqi = airQuality.status === "fulfilled" ? airQuality.value : undefined;
  const precipitation = today?.precipProb !== undefined
    ? { probabilityPercent: today.precipProb }
    : today?.precipAmountMm !== undefined
      ? { amountMm: today.precipAmountMm }
      : undefined;
  const payload: DailyWeatherPayload = {
    city: location.city,
    current: currentValue ? {
      weather: currentValue.weatherText,
      temperatureC: currentValue.temperature,
      apparentTemperatureC: currentValue.apparent,
      humidityPercent: currentValue.humidity,
    } : undefined,
    today: today ? {
      weather: today.weatherText,
      minTemperatureC: today.tMin,
      maxTemperatureC: today.tMax,
    } : undefined,
    precipitation,
    airQuality: aqi ? {
      scale: aqi.scale,
      aqi: aqi.aqi,
      category: aqi.category,
    } : undefined,
    advice: dailyAdvice(today),
  };
  const notification: NotificationEnvelope = {
    kind: "weather.daily_brief",
    // 同日换城市不再被旧键吞掉：dedupeKey 形如 weather:daily-brief:{city}:{localDate}
    identity: `daily-brief:${location.city}:${localDate}`,
    source: "weather",
    scope: { type: "global" },
    headline: dailyHeadline(location.city, currentValue, today),
    generatedAt: at.toISOString(),
    payload,
  };
  await publishNotification(
    notification,
    options.publish ? { publishGlobal: options.publish } : {},
    // 升级兼容：旧版本键形如 weather:daily-brief:{localDate}，同日升级会与带城市的新键
    // 各产生一条通知；传入 legacy 键让既有行被改键复用，避免升级当天重复推送。
    [`weather:daily-brief:${localDate}`],
  );
}

export interface WeatherAlertsCheckOptions {
  at?: Date;
  timezone?: string;
  getLocation?: () => { city: string; lat: number; lon: number } | null;
  getAlerts?: (city: string, lat: number, lon: number) => Promise<WeatherAlert[]>;
  publish?: (
    source: string,
    title: string,
    body: string,
    dedupeKey: string,
    legacyDedupeKeys?: readonly string[],
  ) => Promise<void>;
}

export async function runWeatherAlertsCheck(options: WeatherAlertsCheckOptions = {}): Promise<void> {
  const location = (options.getLocation ?? currentLocation)();
  if (!location) return;
  const at = options.at ?? new Date();
  const timezone = options.timezone ?? config.timezone;
  const publish = options.publish ?? publishGlobal;
  const alerts = await (options.getAlerts ?? fetchAlerts)(location.city, location.lat, location.lon);
  for (const alert of alerts) {
    const legacyDedupeKeys = legacyWeatherAlertDedupeKeys(alert, at);
    if (alert.kind === "inferred") {
      try {
        const notification = inferredAlertNotification(alert, {
          generatedAt: at.toISOString(),
          timezone,
        });
        await publishNotification(notification, { publishGlobal: publish }, legacyDedupeKeys);
      } catch (error) {
        // 推断分支连发布失败也一并隔离（不阻断其余告警）；official 分支仅隔离构建错误。
        console.error(`[weather] inferred alert omitted: ${(error as Error).message}`);
      }
      continue;
    }
    let notification: ReturnType<typeof officialAlertNotification>;
    try {
      notification = officialAlertNotification(alert, {
        generatedAt: at.toISOString(),
        timezone,
      });
    } catch (error) {
      console.error(`[weather] official alert omitted: ${(error as Error).message}`);
      continue;
    }
    await publishNotification(notification, { publishGlobal: publish }, legacyDedupeKeys);
  }
}

const weatherModule: AssistantModule = {
  name: "weather",
  tools: [
    withTool(
      {
        name: "current",
        description: "查询实时天气。默认查询已保存位置；也可传 city 查询任意城市（如 朔城区/北京），临时查询不改变已保存位置。",
      },
      { city: z.string().optional().describe("城市名（可选），如 朔城区/北京；不传则查已保存位置") },
      async ({ city }) => {
        const loc = await resolveLocation(city);
        const w = await fetchCurrent(loc.lat, loc.lon, loc.city);
        return ok({ city: loc.city, ...w, unit: { temperature: "℃", windSpeed: w.windSpeedUnit } });
      },
    ),
    withTool(
      {
        name: "forecast",
        description: "查询未来 N 天天气预报。默认查询已保存位置；也可传 city 查询任意城市（如 朔城区/北京），临时查询不改变已保存位置。",
      },
      {
        days: z.number().int().min(1).max(7).default(3).describe("预报天数 1-7"),
        city: z.string().optional().describe("城市名（可选），如 朔城区/北京；不传则查已保存位置"),
      },
      async ({ days, city }) => {
        const loc = await resolveLocation(city);
        return ok({ city: loc.city, forecast: await fetchForecast(loc.lat, loc.lon, days, loc.city) });
      },
    ),
    withTool(
      {
        name: "alerts",
        description: "查询当前生效的气象预警（暴雨/台风/高温/大风等）。默认查询已保存位置；也可传 city 查询任意城市，临时查询不改变已保存位置。",
      },
      { city: z.string().optional().describe("城市名（可选），如 朔城区/北京；不传则查已保存位置") },
      async ({ city }) => {
        const loc = await resolveLocation(city);
        const alerts = await fetchAlerts(loc.city, loc.lat, loc.lon);
        return ok({ city: loc.city, count: alerts.length, alerts });
      },
    ),
    withTool(
      {
        name: "indices",
        description: "查询今日生活指数（穿衣/紫外线/洗车/运动/感冒等）。和风生活指数需 QWEATHER_KEY；未配置时降级为 Open-Meteo 紫外线指数（degraded=true 标注）。默认查询已保存位置；也可传 city 查询任意城市，临时查询不改变已保存位置。",
      },
      { city: z.string().optional().describe("城市名（可选），如 朔城区/北京；不传则查已保存位置") },
      async ({ city }) => {
        const loc = await resolveLocation(city);
        return ok({ city: loc.city, ...(await fetchIndices(loc.city, loc.lat, loc.lon)) });
      },
    ),
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
      handler: async () => runWeatherAlertsCheck(),
    },
  ],
};

registerModule(weatherModule);
