import { z } from "zod";
import { requireConfirmedLocation } from "../location/index.js";
import { resolveLocation } from "../location/index.js";
import { fetchCurrent, fetchForecast } from "../weather/provider.js";
import { fetchAirQuality } from "../airquality/provider.js";
import { fetchOilPrice } from "../oilprice/provider.js";

/**
 * 白名单 action：scheduler 无 LLM 执行的确定性数据源调用。
 * 新增 action = 在此注册；执行器必须复用模块 Provider，不得散落 HTTP 逻辑。
 */
export interface AutomationActionDef {
  name: string;
  description: string;
  paramsSchema: z.ZodObject<z.ZodRawShape>;
  run: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function numericOrRaw(value: string | undefined): number | string | undefined {
  if (value === undefined) return undefined;
  const num = Number(value);
  return Number.isFinite(num) && value.trim() !== "" ? num : value;
}

const cityParam = z.object({ city: z.string().min(1).max(64).optional() });

/**
 * 每个真实 action 的结果字段白名单（条件 DSL 的 condition.field 校验用，L36）。
 * 键 = dot-path 叶子字段；weather.forecast 的 days 是数组，用 {i} 通配任意下标
 * （days.{i}.precipProb 匹配 days.0.precipProb / days.1.precipProb…）。
 * 新增 action 时必须同步登记其 run() 实际返回的字段名，条件 DSL 与通知引用它们。
 */
export const actionConditionFields: Record<string, string[]> = {
  "weather.current": [
    "city", "temperature", "apparent", "humidity", "windSpeed", "windSpeedUnit", "weatherText",
  ],
  "weather.forecast": [
    "city",
    "today.date", "today.tMax", "today.tMin", "today.weatherText",
    "today.precipProb", "today.precipAmountMm",
    "days.{i}.date", "days.{i}.tMax", "days.{i}.tMin", "days.{i}.weatherText",
    "days.{i}.precipProb", "days.{i}.precipAmountMm",
  ],
  "airquality.current": ["city", "aqi", "scale", "category", "pm25", "pm10"],
  "oilprice.current": ["province", "p92", "p95", "p0"],
};

/** condition.field 是否在 action 的结果字段白名单内（数组下标用 {i} 通配）。 */
export function isConditionFieldAllowed(action: string, field: string): boolean {
  const patterns = actionConditionFields[action];
  if (!patterns) return false;
  if (patterns.includes(field)) return true;
  const arrayMatch = /^([A-Za-z]+)\.(\d+)\.(.+)$/.exec(field);
  if (!arrayMatch) return false;
  return patterns.includes(`${arrayMatch[1]}.{i}.${arrayMatch[3]}`);
}

export const automationActions: Record<string, AutomationActionDef> = {
  "weather.current": {
    name: "weather.current",
    description: "实时天气。结果字段：temperature（气温℃）、apparent（体感℃）、humidity（湿度%）、windSpeed、weatherText。",
    paramsSchema: cityParam,
    run: async (params) => {
      const { city } = cityParam.parse(params);
      const loc = await resolveLocation(city);
      const w = await fetchCurrent(loc.lat, loc.lon, loc.city);
      return { city: loc.city, ...w };
    },
  },
  "weather.forecast": {
    name: "weather.forecast",
    description: "未来 N 天预报（N 1-7，默认 1）。结果字段：days 数组与 today（首日别名）；条件可用字段如 today.precipAmountMm（当日降水量 mm，和风路径）、today.precipProb（降水概率%，仅 Open-Meteo 路径有值）、today.tMax、today.tMin。",
    paramsSchema: z.object({
      city: z.string().min(1).max(64).optional(),
      days: z.number().int().min(1).max(7).default(1),
    }),
    run: async (params) => {
      const { city, days } = z.object({
        city: z.string().min(1).max(64).optional(),
        days: z.number().int().min(1).max(7).default(1),
      }).parse(params);
      const loc = await resolveLocation(city);
      const days_ = await fetchForecast(loc.lat, loc.lon, days, loc.city);
      return { city: loc.city, days: days_, today: days_[0] };
    },
  },
  "airquality.current": {
    name: "airquality.current",
    description: "实时空气质量。结果字段：aqi、scale（CN 国标 / US 美标）、category（等级）、pm25 等。注意两种量表数值不可直接比较。",
    paramsSchema: cityParam,
    run: async (params) => {
      const { city } = cityParam.parse(params);
      const loc = await resolveLocation(city);
      const air = await fetchAirQuality(loc.city, loc.lat, loc.lon);
      return {
        city: air.city,
        aqi: air.aqi,
        scale: air.scale,
        category: air.category,
        pm25: air.pollutants.pm25,
        pm10: air.pollutants.pm10,
      };
    },
  },
  "oilprice.current": {
    name: "oilprice.current",
    description: "当前油价（使用已保存位置的省份）。结果字段：province、p92、p95、p0（数值，元/升）。",
    paramsSchema: z.object({}),
    run: async () => {
      const loc = requireConfirmedLocation();
      const observation = await fetchOilPrice(loc.city, { province: loc.province });
      return {
        province: observation.province,
        p92: numericOrRaw(observation.fuels.p92.current),
        p95: numericOrRaw(observation.fuels.p95.current),
        p0: numericOrRaw(observation.fuels.p0.current),
      };
    },
  },
};
