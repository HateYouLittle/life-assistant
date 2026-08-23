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

export interface LifeIndex {
  /** 指数名，如 穿衣指数 / 紫外线指数 / 洗车指数 */
  name: string;
  /** 等级表述，如 较冷 / 强 */
  category: string;
  /** 和风返回的原始等级数字（1 起），紫外线兜底无此字段 */
  level?: string;
  text?: string;
}

/** 紫外线指数等级（确定性映射，Open-Meteo 兜底用） */
export function uvIndexCategory(uvIndex: number): { category: string; text: string } {
  if (uvIndex < 3) return { category: "弱", text: "紫外线较弱，外出可适当防护。" };
  if (uvIndex < 5) return { category: "中等", text: "外出建议涂防晒霜、戴遮阳帽。" };
  if (uvIndex < 7) return { category: "强", text: "注意防晒，尽量避免午间长时间暴晒。" };
  if (uvIndex < 10) return { category: "很强", text: "紫外线很强，减少户外活动并做好防护。" };
  return { category: "极强", text: "紫外线极强，尽量避免外出，务必做好防护。" };
}

/** 和风生活指数解析（纯函数，便于测试）；type=0 返回全部指数 */
export function parseQweatherIndices(raw: unknown): LifeIndex[] {
  const body = raw as {
    code?: string | number;
    daily?: Array<{ date?: string; type?: string; name?: string; level?: string; category?: string; text?: string }>;
  };
  if (body.code !== undefined && body.code !== null && String(body.code) !== "200") {
    throw new Error(`QWeather indices error code ${body.code}`);
  }
  if (!Array.isArray(body.daily)) throw new Error("weather provider: QWeather indices response is missing daily");
  return body.daily
    .filter((entry) => typeof entry.name === "string" && entry.name.length > 0 && typeof entry.category === "string")
    .map((entry) => ({
      name: entry.name!,
      category: entry.category!,
      level: typeof entry.level === "string" && entry.level.length > 0 ? entry.level : undefined,
      text: typeof entry.text === "string" && entry.text.length > 0 ? entry.text : undefined,
    }));
}

/**
 * 生活指数：优先和风 v7 indices/1d（type=0 全部指数，需 Key）；
 * 无 Key 或失败时降级 Open-Meteo 紫外线指数（确定性等级映射），仅覆盖紫外线。
 */
export async function fetchIndices(city: string, lat: number, lon: number): Promise<{ indices: LifeIndex[]; source: string; degraded: boolean }> {
  if (config.qweatherKey) {
    try {
      // 和风 v7 location 查询参数格式为 "经度,纬度"（lon,lat）
      const raw = await httpJson<unknown>(
        `https://${config.qweatherApiHost}/v7/indices/1d?type=0&location=${lon.toFixed(2)},${lat.toFixed(2)}&key=${config.qweatherKey}`,
      );
      const indices = parseQweatherIndices(raw);
      if (indices.length > 0) return { indices, source: "和风天气", degraded: false };
      throw new Error("QWeather indices returned empty daily");
    } catch (e) {
      console.error(`[weather] QWeather indices failed, fallback to Open-Meteo UV: ${(e as Error).message}`);
    }
  }
  const r = await httpJson<{ daily?: Record<string, unknown> }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=uv_index_max&forecast_days=1&timezone=auto`,
  );
  const d = r.daily;
  if (!d || typeof d !== "object") {
    throw new Error("weather provider: Open-Meteo indices response is missing daily");
  }
  if (!Array.isArray(d.uv_index_max) || d.uv_index_max.length === 0) {
    throw new Error("weather provider: Open-Meteo indices response is missing daily.uv_index_max");
  }
  // uv_index_max 是可空字段：当天无数据时为 null，降级为空指数（degraded）而非整体失败。
  const uvRaw = d.uv_index_max[0];
  if (typeof uvRaw !== "number" || !Number.isFinite(uvRaw)) {
    return { indices: [], source: "Open-Meteo", degraded: true };
  }
  const uv = uvRaw;
  const { category, text } = uvIndexCategory(uv);
  return {
    indices: [{ name: "紫外线指数", category, text: `今日紫外线指数最大值约 ${uv}。${text}` }],
    source: "Open-Meteo",
    degraded: true,
  };
}

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

/** 轻量响应形状校验：字段必须存在且为有限数，无效则抛错交给上层降级/报错（N12）。 */
function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`weather provider: ${label} is missing or not a finite number`);
  }
  return value;
}

function requireFiniteNumberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`weather provider: ${label} is missing or empty`);
  }
  return value.map((item) => {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new Error(`weather provider: ${label} contains a non-finite number`);
    }
    return item;
  });
}

/** 可空数值数组：元素级 null（如集合预报未覆盖）降级为 undefined，字段整体缺失仍抛错。 */
function optionalFiniteNumberArray(value: unknown, label: string): Array<number | undefined> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`weather provider: ${label} is missing or empty`);
  }
  return value.map((item) => (typeof item === "number" && Number.isFinite(item) ? item : undefined));
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`weather provider: ${label} is missing or empty`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`weather provider: ${label} contains an invalid string value`);
    }
    return item;
  });
}

function isValidGeoCacheEntry(raw: unknown): raw is GeoCacheEntry {
  if (!raw || typeof raw !== "object") return false;
  const candidate = raw as Record<string, unknown>;
  return typeof candidate.id === "string" && candidate.id.length > 0
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
  if (!hit || typeof hit.id !== "string" || !hit.id) throw new Error(`和风天气未找到城市：${city}`);
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

/** 实时天气：优先和风（QWEATHER_KEY），降级 Open-Meteo */
export async function fetchCurrent(lat: number, lon: number, city?: string): Promise<CurrentWeather> {
  if (config.qweatherKey) {
    try {
      const loc = city ? await qweatherGeo(city) : null;
      // 和风 v7 location 查询参数格式为 "经度,纬度"（lon,lat），与 weatheralert 路径 /current/{lat}/{lon} 相反
      const r = await httpJson<{ code?: string; now?: { temp: string; feelsLike: string; humidity: string; windSpeed: string; text: string; icon: string } }>(
        `https://${config.qweatherApiHost}/v7/weather/now?location=${loc?.id ?? `${lon.toFixed(2)},${lat.toFixed(2)}`}&key=${config.qweatherKey}`,
      );
      // 和风业务错误：HTTP 200 + code 字段（如 401/402/403）→ 抛出后走 Open-Meteo 降级。
      // code 可能是数字或字符串，统一 String 化比较，避免数字型 code 绕过检查。
      if (r.code !== undefined && r.code !== null && String(r.code) !== "200") {
        throw new Error(`QWeather weathernow error code ${r.code}`);
      }
      if (r.now) {
        const temperature = Number(r.now.temp);
        const apparent = Number(r.now.feelsLike);
        const humidity = Number(r.now.humidity);
        const windSpeed = Number(r.now.windSpeed);
        // 数值非法（NaN/Infinity）视为失败并走 Open-Meteo 兜底（N12）
        if (!Number.isFinite(temperature) || !Number.isFinite(apparent)
          || !Number.isFinite(humidity) || !Number.isFinite(windSpeed)) {
          throw new Error("QWeather current returned invalid numeric fields");
        }
        return {
          temperature,
          apparent,
          humidity,
          windSpeed,
          windSpeedUnit: "km/h",
          weatherText: r.now.text || (QW_TEXT[r.now.icon] ?? `code ${r.now.icon}`),
        };
      }
    } catch (e) {
      console.error(`[weather] QWeather current failed, fallback to Open-Meteo: ${(e as Error).message}`);
    }
  }
  const r = await httpJson<{ current?: Record<string, unknown> }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto&windspeed_unit=ms`,
  );
  const current = r.current;
  if (!current || typeof current !== "object") {
    throw new Error("weather provider: Open-Meteo current response is missing current");
  }
  const weatherCode = requireFiniteNumber(current.weather_code, "current.weather_code");
  return {
    temperature: requireFiniteNumber(current.temperature_2m, "current.temperature_2m"),
    apparent: requireFiniteNumber(current.apparent_temperature, "current.apparent_temperature"),
    humidity: requireFiniteNumber(current.relative_humidity_2m, "current.relative_humidity_2m"),
    windSpeed: requireFiniteNumber(current.wind_speed_10m, "current.wind_speed_10m"),
    windSpeedUnit: "m/s",
    weatherText: WMO[weatherCode] ?? `code ${weatherCode}`,
  };
}

export async function fetchForecast(lat: number, lon: number, days = 3, city?: string): Promise<ForecastDay[]> {
  if (config.qweatherKey && days <= 7) {
    try {
      const loc = city ? await qweatherGeo(city) : null;
      const daysKey = days <= 3 ? "3d" : "7d";
      // 和风 v7 location 查询参数格式为 "经度,纬度"（lon,lat）
      const r = await httpJson<{ code?: string; daily?: Array<{ fxDate: string; tempMax: string; tempMin: string; textDay: string; iconDay: string; precip: string }> }>(
        `https://${config.qweatherApiHost}/v7/weather/${daysKey}?location=${loc?.id ?? `${lon.toFixed(2)},${lat.toFixed(2)}`}&key=${config.qweatherKey}`,
      );
      // 和风业务错误：HTTP 200 + code 字段（如 401/402/403）→ 抛出后走 Open-Meteo 降级
      if (r.code !== undefined && r.code !== null && String(r.code) !== "200") {
        throw new Error(`QWeather weatherforecast error code ${r.code}`);
      }
      if (r.daily !== undefined && r.daily.length === 0) {
        // 空 daily 视为失败，继续 Open-Meteo 兜底，而不是把空数组返回给上层（N12）
        throw new Error("QWeather forecast returned empty daily");
      }
      if (r.daily) {
        return r.daily.slice(0, days).map((d) => {
          const tMax = Number(d.tempMax);
          const tMin = Number(d.tempMin);
          // 温度等关键数值非法（NaN/Infinity）视为失败并走 Open-Meteo 兜底（N12）
          if (!Number.isFinite(tMax) || !Number.isFinite(tMin)) {
            throw new Error("QWeather forecast returned invalid numeric fields");
          }
          return {
            date: d.fxDate,
            tMax,
            tMin,
            weatherText: d.textDay || (QW_TEXT[d.iconDay] ?? `code ${d.iconDay}`),
            // 和风 v7 daily 的 precip 是当日累计降水量（mm），实测（2026-08，专属 API host）
            // 响应中没有 precipProb 字段：阵雨日 precip=9.5 是毫米量，按概率解释会
            // 显示"概率 9%"并漏掉带伞建议。降水量缺失时置 undefined，不带噪音。
            precipAmountMm: Number(d.precip) || undefined,
          };
        });
      }
    } catch (e) {
      console.error(`[weather] QWeather forecast failed, fallback to Open-Meteo: ${(e as Error).message}`);
    }
  }
  const r = await httpJson<{ daily?: Record<string, unknown> }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=${days}&timezone=auto`,
  );
  const d = r.daily;
  if (!d || typeof d !== "object") {
    throw new Error("weather provider: Open-Meteo forecast response is missing daily");
  }
  const time = requireStringArray(d.time, "daily.time");
  const tMax = requireFiniteNumberArray(d.temperature_2m_max, "daily.temperature_2m_max");
  const tMin = requireFiniteNumberArray(d.temperature_2m_min, "daily.temperature_2m_min");
  const weatherCodes = requireFiniteNumberArray(d.weather_code, "daily.weather_code");
  // 降水概率是可空字段：集合预报未覆盖的地区逐日返回 null，按元素降级为 undefined
  // 而不是让整条预报失败（字段整体缺失仍视为响应畸形）。
  const precipProbs = optionalFiniteNumberArray(d.precipitation_probability_max, "daily.precipitation_probability_max");
  if (tMax.length < time.length || tMin.length < time.length
    || weatherCodes.length < time.length || precipProbs.length < time.length) {
    throw new Error("weather provider: Open-Meteo forecast daily arrays are shorter than time");
  }
  return time.map((date, i) => ({
    date,
    tMax: tMax[i],
    tMin: tMin[i],
    weatherText: WMO[weatherCodes[i]] ?? `code ${weatherCodes[i]}`,
    precipProb: precipProbs[i],
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
        code?: string;
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
      // 和风业务错误：HTTP 200 + code 字段（如 401/402/403）→ 抛出后走阈值推断降级
      if (r.code !== undefined && r.code !== null && String(r.code) !== "200") {
        throw new Error(`QWeather weatheralert error code ${r.code}`);
      }
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
  // 降级：阈值推断（windspeed_unit=ms：Open-Meteo 默认 km/h，阈值 17.2 是 m/s 的 8 级风下限）
  const r = await httpJson<{ hourly?: Record<string, unknown> }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,precipitation,wind_speed_10m&forecast_days=2&timezone=auto&windspeed_unit=ms`,
  );
  const alerts: WeatherAlert[] = [];
  const h = r.hourly;
  if (!h || typeof h !== "object") {
    throw new Error("weather provider: Open-Meteo hourly response is missing hourly");
  }
  const precipitation = requireFiniteNumberArray(h.precipitation, "hourly.precipitation");
  const temperature2m = requireFiniteNumberArray(h.temperature_2m, "hourly.temperature_2m");
  const windSpeed10m = requireFiniteNumberArray(h.wind_speed_10m, "hourly.wind_speed_10m");
  const maxPrecip = Math.max(...precipitation);
  const maxTemp = Math.max(...temperature2m);
  const maxWind = Math.max(...windSpeed10m);
  if (maxPrecip >= 16) alerts.push({ kind: "inferred", title: `${city}强降雨推断提醒`, level: "inferred", description: `未来48小时小时降水峰值约 ${maxPrecip}mm，可能达暴雨量级，注意出行安全。` });
  if (maxTemp >= 35) alerts.push({ kind: "inferred", title: `${city}高温推断提醒`, level: "inferred", description: `未来48小时最高气温约 ${maxTemp}℃，注意防暑降温。` });
  if (maxWind >= 17.2) alerts.push({ kind: "inferred", title: `${city}大风推断提醒`, level: "inferred", description: `未来48小时风速峰值约 ${maxWind}m/s（约8级），注意防风。` });
  return alerts;
}
