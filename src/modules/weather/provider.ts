import { config } from "../../config.js";
import { httpJson } from "../../core/http.js";
import { store } from "../../core/store.js";

export interface CurrentWeather {
  temperature: number;
  apparent: number;
  humidity: number;
  windSpeed: number;
  windSpeedUnit: "km/h" | "m/s";
  weatherText: string;
}

export interface ForecastDay {
  date: string;
  tMax: number;
  tMin: number;
  weatherText: string;
  precipProb?: number;
  precipAmountMm?: number;
}

export interface OfficialWeatherAlert {
  kind: "official";
  id?: string;
  publisher?: string;
  issuedAt?: string;
  eventType: string;
  eventCode?: string;
  level?: string;
  severity?: string;
  effectiveAt?: string;
  onsetAt?: string;
  expiresAt?: string;
  headline: string;
  description: string;
  criteria?: string;
  instruction?: string;
  attributions: string[];
}

export interface InferredWeatherRisk {
  kind: "inferred";
  title: string;
  level: "inferred";
  description: string;
}

export type WeatherAlert = OfficialWeatherAlert | InferredWeatherRisk;

export const WMO: Record<number, string> = {
  0: "晴", 1: "大部晴朗", 2: "多云", 3: "阴",
  45: "雾", 48: "雾凇",
  51: "毛毛雨", 53: "毛毛雨", 55: "密集毛毛雨",
  56: "冻毛毛雨（轻微）", 57: "冻毛毛雨（密集）",
  61: "小雨", 63: "中雨", 65: "大雨",
  66: "冻雨（轻微）", 67: "冻雨（密集）",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
  80: "阵雨", 81: "强阵雨", 82: "暴雨",
  85: "阵雪（轻微）", 86: "阵雪（强烈）",
  95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷阵雨伴冰雹",
};

/** 和风天气现象 code → 中文（v7 接口 text 字段直接给中文，这里做兜底映射） */
const QW_TEXT: Record<string, string> = {
  "100": "晴", "101": "多云", "102": "少云", "103": "晴间多云", "104": "阴",
  "300": "阵雨", "301": "强阵雨", "302": "雷阵雨", "303": "强雷阵雨",
  "304": "雷阵雨伴有冰雹", "305": "小雨", "306": "中雨", "307": "大雨",
  "308": "极端降雨", "309": "毛毛雨", "310": "暴雨", "311": "大暴雨",
  "312": "特大暴雨", "313": "冻雨", "314": "小到中雨", "315": "中到大雨",
  "316": "大到暴雨", "317": "暴雨到大暴雨", "318": "大暴雨到特大暴雨",
  "399": "雨", "400": "小雪", "401": "中雪", "402": "大雪", "403": "暴雪",
  "404": "雨夹雪", "405": "雨雪天气", "406": "阵雨夹雪", "407": "阵雪",
  "408": "小到中雪", "409": "中到大雪", "410": "大到暴雪", "499": "雪",
  "500": "薄雾", "501": "雾", "502": "霾", "503": "扬沙", "504": "浮尘",
  "507": "沙尘暴", "508": "强沙尘暴", "509": "浓雾", "510": "强浓雾",
  "511": "中度霾", "512": "重度霾", "513": "严重霾", "514": "大雾",
  "515": "特强浓雾", "900": "热", "901": "冷", "999": "未知",
};

const QW_ALERT_LEVEL: Record<string, string> = {
  blue: "蓝色",
  yellow: "黄色",
  orange: "橙色",
  red: "红色",
};

/**
 * 和风城市 ID 缓存：GeoAPI 查询结果落 store，避免每次重复消耗额度。
 * key: qweather:geo:{city}，缓存 7 天（城市 ID 极少变动）。
 */
const GEO_CACHE_PREFIX = "qweather:geo:";
const GEO_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

function cachedGeo(city: string): { id: string; lat: number; lon: number } | null {
  try {
    const raw = store.get<{ id: string; lat: number; lon: number; ts: number }>(GEO_CACHE_PREFIX + city);
    if (raw && Date.now() - raw.ts < GEO_CACHE_TTL_MS) return raw;
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
  if (!hit) throw new Error(`和风天气未找到城市：${city}`);
  const result = { id: hit.id, lat: Number(hit.lat), lon: Number(hit.lon) };
  store.set(GEO_CACHE_PREFIX + city, { ...result, ts: Date.now() });
  return result;
}

/** 实时天气：优先和风（QWEATHER_KEY），降级 Open-Meteo */
export async function fetchCurrent(lat: number, lon: number, city?: string): Promise<CurrentWeather> {
  if (config.qweatherKey) {
    try {
      const loc = city ? await qweatherGeo(city) : null;
      const r = await httpJson<{ now?: { temp: string; feelsLike: string; humidity: string; windSpeed: string; text: string; icon: string } }>(
        `https://${config.qweatherApiHost}/v7/weather/now?location=${loc?.id ?? `${lat.toFixed(2)},${lon.toFixed(2)}`}&key=${config.qweatherKey}`,
      );
      if (r.now) {
        return {
          temperature: Number(r.now.temp),
          apparent: Number(r.now.feelsLike),
          humidity: Number(r.now.humidity),
          windSpeed: Number(r.now.windSpeed),
          windSpeedUnit: "km/h",
          weatherText: r.now.text || (QW_TEXT[r.now.icon] ?? `code ${r.now.icon}`),
        };
      }
    } catch (e) {
      console.error(`[weather] QWeather current failed, fallback to Open-Meteo: ${(e as Error).message}`);
    }
  }
  const r = await httpJson<{ current: Record<string, number> }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`,
  );
  return {
    temperature: r.current.temperature_2m,
    apparent: r.current.apparent_temperature,
    humidity: r.current.relative_humidity_2m,
    windSpeed: r.current.wind_speed_10m,
    windSpeedUnit: "m/s",
    weatherText: WMO[r.current.weather_code] ?? `code ${r.current.weather_code}`,
  };
}

export async function fetchForecast(lat: number, lon: number, days = 3, city?: string): Promise<ForecastDay[]> {
  if (config.qweatherKey && days <= 7) {
    try {
      const loc = city ? await qweatherGeo(city) : null;
      const daysKey = days <= 3 ? "3d" : "7d";
      const r = await httpJson<{ daily?: Array<{ fxDate: string; tempMax: string; tempMin: string; textDay: string; iconDay: string; precip: string }> }>(
        `https://${config.qweatherApiHost}/v7/weather/${daysKey}?location=${loc?.id ?? `${lat.toFixed(2)},${lon.toFixed(2)}`}&key=${config.qweatherKey}`,
      );
      if (r.daily) {
        return r.daily.slice(0, days).map((d) => ({
          date: d.fxDate,
          tMax: Number(d.tempMax),
          tMin: Number(d.tempMin),
          weatherText: d.textDay || (QW_TEXT[d.iconDay] ?? `code ${d.iconDay}`),
          precipAmountMm: Number(d.precip),
        }));
      }
    } catch (e) {
      console.error(`[weather] QWeather forecast failed, fallback to Open-Meteo: ${(e as Error).message}`);
    }
  }
  const r = await httpJson<{ daily: Record<string, Array<number | string>> }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=${days}&timezone=auto`,
  );
  const d = r.daily;
  return (d.time as string[]).map((date, i) => ({
    date,
    tMax: d.temperature_2m_max[i] as number,
    tMin: d.temperature_2m_min[i] as number,
    weatherText: WMO[d.weather_code[i] as number] ?? `code ${d.weather_code[i]}`,
    precipProb: d.precipitation_probability_max[i] as number,
  }));
}

/**
 * 气象预警：优先和风天气官方预警 API（需免费 Key）；
 * 无 Key 时降级为 Open-Meteo 小时级数据阈值推断（暴雨/高温/大风）。
 * 替换数据源只需实现本函数签名。
 */
export async function fetchAlerts(city: string, lat: number, lon: number): Promise<WeatherAlert[]> {
  if (config.qweatherKey) {
    try {
      // 新版和风实时天气预警 API：直接按经纬度查询，无需先查城市 ID
      const r = await httpJson<{
        metadata?: { attributions?: string[] };
        alerts?: Array<{
          id?: string;
          senderName?: string;
          issuedTime?: string;
          headline?: string;
          description?: string;
          eventType?: { name?: string; code?: string };
          severity?: string | null;
          color?: { code?: string } | null;
          effectiveTime?: string;
          onsetTime?: string;
          expireTime?: string;
          criteria?: string;
          instruction?: string;
        }>;
      }>(
        `https://${config.qweatherApiHost}/weatheralert/v1/current/${lat.toFixed(2)}/${lon.toFixed(2)}?key=${config.qweatherKey}`,
      );
      const attributions = r.metadata?.attributions ?? [];
      return (r.alerts ?? []).map((w): OfficialWeatherAlert => ({
        kind: "official",
        id: w.id,
        publisher: w.senderName,
        issuedAt: w.issuedTime,
        eventType: w.eventType?.name ?? "天气预警",
        eventCode: w.eventType?.code,
        level: w.color?.code ? (QW_ALERT_LEVEL[w.color.code] ?? w.color.code) : undefined,
        severity: w.severity ?? undefined,
        effectiveAt: w.effectiveTime,
        onsetAt: w.onsetTime,
        expiresAt: w.expireTime,
        headline: w.headline ?? w.eventType?.name ?? "天气预警",
        description: w.description ?? w.headline ?? "",
        criteria: w.criteria,
        instruction: w.instruction,
        attributions,
      }));
    } catch (e) {
      // 预警接口失败（403 无权限 / 网络异常）→ 降级为阈值推断，不阻断整体功能
      console.error(`[weather] QWeather alerts failed, fallback to inference: ${(e as Error).message}`);
    }
  }
  // 降级：阈值推断
  const r = await httpJson<{ hourly: Record<string, number[]> }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,precipitation,wind_speed_10m&forecast_days=2&timezone=auto`,
  );
  const alerts: WeatherAlert[] = [];
  const h = r.hourly;
  const maxPrecip = Math.max(...h.precipitation);
  const maxTemp = Math.max(...h.temperature_2m);
  const maxWind = Math.max(...h.wind_speed_10m);
  if (maxPrecip >= 16) alerts.push({ kind: "inferred", title: `${city}强降雨推断提醒`, level: "inferred", description: `未来48小时小时降水峰值约 ${maxPrecip}mm，可能达暴雨量级，注意出行安全。` });
  if (maxTemp >= 35) alerts.push({ kind: "inferred", title: `${city}高温推断提醒`, level: "inferred", description: `未来48小时最高气温约 ${maxTemp}℃，注意防暑降温。` });
  if (maxWind >= 17.2) alerts.push({ kind: "inferred", title: `${city}大风推断提醒`, level: "inferred", description: `未来48小时风速峰值约 ${maxWind}m/s（约8级），注意防风。` });
  return alerts;
}
