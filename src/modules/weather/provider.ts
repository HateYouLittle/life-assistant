import { config } from "../../config.js";
import { httpJson } from "../../core/http.js";

export interface CurrentWeather {
  temperature: number;
  apparent: number;
  humidity: number;
  windSpeed: number;
  weatherText: string;
}

export interface ForecastDay {
  date: string;
  tMax: number;
  tMin: number;
  weatherText: string;
  precipProb: number;
}

export interface WeatherAlert {
  title: string;
  level: string; // 红/橙/黄/蓝 或 inferred
  description: string;
}

const WMO: Record<number, string> = {
  0: "晴", 1: "大部晴朗", 2: "多云", 3: "阴",
  45: "雾", 48: "雾凇", 51: "毛毛雨", 61: "小雨", 63: "中雨", 65: "大雨",
  71: "小雪", 73: "中雪", 75: "大雪", 80: "阵雨", 81: "强阵雨", 82: "暴雨",
  95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷阵雨伴冰雹",
};

/** 实时天气：Open-Meteo，免费、无 Key、非商用 1 万次/天 */
export async function fetchCurrent(lat: number, lon: number): Promise<CurrentWeather> {
  const r = await httpJson<{ current: Record<string, number> }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`,
  );
  return {
    temperature: r.current.temperature_2m,
    apparent: r.current.apparent_temperature,
    humidity: r.current.relative_humidity_2m,
    windSpeed: r.current.wind_speed_10m,
    weatherText: WMO[r.current.weather_code] ?? `code ${r.current.weather_code}`,
  };
}

export async function fetchForecast(lat: number, lon: number, days = 3): Promise<ForecastDay[]> {
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
    const geo = await httpJson<{ location?: Array<{ id: string }> }>(
      `https://geoapi.qweather.com/v2/city/lookup?location=${encodeURIComponent(city)}&key=${config.qweatherKey}`,
    );
    const id = geo.location?.[0]?.id;
    if (id) {
      const r = await httpJson<{ warning?: Array<{ title: string; level: string; text: string }> }>(
        `https://devapi.qweather.com/v7/warning/now?location=${id}&key=${config.qweatherKey}`,
      );
      return (r.warning ?? []).map((w) => ({ title: w.title, level: w.level, description: w.text }));
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
  if (maxPrecip >= 16) alerts.push({ title: `${city}强降雨推断提醒`, level: "inferred", description: `未来48小时小时降水峰值约 ${maxPrecip}mm，可能达暴雨量级，注意出行安全。` });
  if (maxTemp >= 35) alerts.push({ title: `${city}高温推断提醒`, level: "inferred", description: `未来48小时最高气温约 ${maxTemp}℃，注意防暑降温。` });
  if (maxWind >= 17.2) alerts.push({ title: `${city}大风推断提醒`, level: "inferred", description: `未来48小时风速峰值约 ${maxWind}m/s（约8级），注意防风。` });
  return alerts;
}
