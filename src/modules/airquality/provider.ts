import { config } from "../../config.js";
import { httpJson } from "../../core/http.js";

/** 空气质量观测：scale 标注 AQI 采用的量表（国标/美标），两种量表的数值不可直接比较。 */
export interface AirQuality {
  city: string;
  scale: "CN" | "US";
  aqi: number;
  category: string;
  /** 主要污染物（QWeather 国标口径） */
  primary?: string;
  /** 污染物浓度，单位 μg/m³ */
  pollutants: {
    pm25?: number;
    pm10?: number;
    o3?: number;
    no2?: number;
    so2?: number;
  };
  observedAt?: string;
  source: string;
}

/** 国标 AQI（HJ 633）分级 */
export function cnAqiCategory(aqi: number): string {
  if (aqi <= 50) return "优";
  if (aqi <= 100) return "良";
  if (aqi <= 150) return "轻度污染";
  if (aqi <= 200) return "中度污染";
  if (aqi <= 300) return "重度污染";
  return "严重污染";
}

/** 美标 AQI 分级（中文表述，输出时用 scale 标注量表） */
export function usAqiCategory(aqi: number): string {
  if (aqi <= 50) return "优";
  if (aqi <= 100) return "中等";
  if (aqi <= 150) return "敏感人群不健康";
  if (aqi <= 200) return "不健康";
  if (aqi <= 300) return "非常不健康";
  return "危险";
}

export function aqiCategory(aqi: number, scale: "CN" | "US"): string {
  return scale === "CN" ? cnAqiCategory(aqi) : usAqiCategory(aqi);
}

function toFiniteNumber(value: unknown, label: string): number {
  const num = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(num)) throw new Error(`airquality provider: ${label} is not a finite number`);
  return num;
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  const raw = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : undefined;
  return raw !== undefined && Number.isFinite(raw) ? raw : undefined;
}

/** 和风 v7 空气质量实况解析（纯函数，便于测试） */
export function parseQweatherAqi(city: string, raw: unknown): AirQuality {
  const body = raw as {
    code?: string | number;
    now?: {
      pubTime?: string;
      aqi?: string;
      level?: string;
      category?: string;
      primary?: string;
      pm2p5?: string;
      pm10?: string;
      o3?: string;
      no2?: string;
      so2?: string;
    };
  };
  if (body.code !== undefined && body.code !== null && String(body.code) !== "200") {
    throw new Error(`QWeather airnow error code ${body.code}`);
  }
  const now = body.now;
  if (!now) throw new Error("airquality provider: QWeather airnow response is missing now");
  const aqi = toFiniteNumber(now.aqi, "now.aqi");
  const category = (now.category ?? "").trim() || cnAqiCategory(aqi);
  const pollutants: AirQuality["pollutants"] = {
    pm25: optionalFiniteNumber(now.pm2p5, "now.pm2p5"),
    pm10: optionalFiniteNumber(now.pm10, "now.pm10"),
    o3: optionalFiniteNumber(now.o3, "now.o3"),
    no2: optionalFiniteNumber(now.no2, "now.no2"),
    so2: optionalFiniteNumber(now.so2, "now.so2"),
  };
  return {
    city,
    scale: "CN",
    aqi,
    category,
    primary: now.primary && now.primary !== "NA" ? now.primary : undefined,
    pollutants,
    observedAt: now.pubTime,
    source: "和风天气",
  };
}

/** Open-Meteo 空气质量解析（纯函数）：us_aqi 为主 AQI，污染物浓度 μg/m³ */
export function parseOpenMeteoAqi(city: string, raw: unknown): AirQuality {
  const body = raw as {
    current?: Record<string, unknown>;
  };
  const current = body.current;
  if (!current || typeof current !== "object") {
    throw new Error("airquality provider: Open-Meteo air-quality response is missing current");
  }
  const aqi = toFiniteNumber(current.us_aqi, "current.us_aqi");
  const pollutants: AirQuality["pollutants"] = {
    pm25: optionalFiniteNumber(current.pm2_5, "current.pm2_5"),
    pm10: optionalFiniteNumber(current.pm10, "current.pm10"),
    o3: optionalFiniteNumber(current.ozone, "current.ozone"),
    no2: optionalFiniteNumber(current.nitrogen_dioxide, "current.nitrogen_dioxide"),
    so2: optionalFiniteNumber(current.sulphur_dioxide, "current.sulphur_dioxide"),
  };
  return {
    city,
    scale: "US",
    aqi,
    category: usAqiCategory(aqi),
    pollutants,
    source: "Open-Meteo",
  };
}

/** 空气质量：优先和风 v7 air/now（复用 QWEATHER_KEY），失败降级 Open-Meteo air-quality（免 Key，美标 AQI）。 */
export async function fetchAirQuality(city: string, lat: number, lon: number): Promise<AirQuality> {
  if (config.qweatherKey) {
    try {
      // 和风 v7 location 查询参数格式为 "经度,纬度"（lon,lat）
      const raw = await httpJson<unknown>(
        `https://${config.qweatherApiHost}/v7/air/now?location=${lon.toFixed(2)},${lat.toFixed(2)}&key=${config.qweatherKey}`,
      );
      return parseQweatherAqi(city, raw);
    } catch (e) {
      console.error(`[airquality] QWeather air/now failed, fallback to Open-Meteo: ${(e as Error).message}`);
    }
  }
  const raw = await httpJson<unknown>(
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
      `&current=pm10,pm2_5,ozone,nitrogen_dioxide,sulphur_dioxide,us_aqi&timezone=auto`,
  );
  return parseOpenMeteoAqi(city, raw);
}
