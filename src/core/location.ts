import { z } from "zod";
import { config } from "../config.js";
import { store } from "./store.js";
import { httpJson } from "./http.js";
import { registerModule, ok, fail, type AssistantModule } from "./registry.js";

export interface Location {
  city: string;
  province?: string;
  lat: number;
  lon: number;
  source: "manual" | "ip" | "env";
  confirmedAt: string;
}

const KEY = "location:current";

export const locationSetSchema = z.object({
  city: z.string().min(1).max(64),
  province: z.string().optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

/** 获取已确认位置；未确认返回 null */
export function currentLocation(): Location | null {
  const saved = store.get<Location>(KEY);
  if (saved) {
    // 旧 schema 允许脏数据（空 city、越界/Infinity 坐标）：读取侧校验，
    // 非法则视为未确认，走重新确认流程，避免天气/油价链路持续失败
    const parsed = locationSetSchema.safeParse(saved);
    if (parsed.success) {
      return { ...parsed.data, source: saved.source, confirmedAt: saved.confirmedAt };
    }
    return null;
  }
  // env 预置城市需 trim 后非空且 <=64（N14），与 location.set 的 schema 保持一致
  const envCity = config.location.city.trim();
  if (envCity && envCity.length <= 64 && config.location.lat !== undefined && config.location.lon !== undefined) {
    const { lat, lon } = config.location;
    // env 预置坐标同样校验有限性与范围，非法视为未配置
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return {
        city: config.location.city,
        lat,
        lon,
        source: "env",
        confirmedAt: new Date().toISOString(),
      };
    }
  }
  return null;
}

/** IP 自动探测（ip-api.com，免费、无 Key、45 次/分钟，仅供建议值） */
async function detectByIp(): Promise<{ city: string; lat: number; lon: number } | null> {
  try {
    const r = await httpJson<{ status: string; city: string; lat: number; lon: number }>(
      "http://ip-api.com/json/?lang=zh-CN&fields=status,city,lat,lon",
    );
    return r.status === "success" ? { city: r.city, lat: r.lat, lon: r.lon } : null;
  } catch {
    return null;
  }
}

const locationModule: AssistantModule = {
  name: "location",
  tools: [
    {
      name: "get",
      description:
        "获取用户当前位置。首次使用天气/油价功能前必须调用。若返回 need_confirm，请把 suggestion 用自然语言复述给用户并请其确认，确认后将 city、province（如有）和经纬度传给 location.set 保存。",
      schema: {},
      handler: async () => {
        const loc = currentLocation();
        if (loc) return ok({ status: "confirmed", location: loc });
        const suggestion = await detectByIp();
        return ok({
          status: "need_confirm",
          suggestion,
          hint: "请向用户确认所在地。用户确认后调用 location.set(city, province, lat, lon) 保存（province 缺失时可省略）；若 IP 建议不准确，请让用户告知城市名后再次调用 location.detect(city)，并把返回的 province 一并传回 location.set。",
        });
      },
    },
    {
      name: "detect",
      description: "按城市名解析经纬度和省级行政区（先和风 GeoAPI，再 Open-Meteo Geocoding 兜底），用于用户口述城市后补全位置；确认后请把 province 一并传给 location.set。",
      schema: { city: z.string().describe("城市名，如 北京 / 上海 / 朔城区") },
      handler: async (args) => {
        const { city } = z.object({ city: z.string() }).parse(args);
        // 优先和风 GeoAPI：对中文区县（如"朔城区"）支持好
        if (config.qweatherKey) {
          try {
            const geo = await httpJson<{ location?: Array<{ name: string; lat: string; lon: string; adm1: string }> }>(
              `https://${config.qweatherApiHost}/geo/v2/city/lookup?location=${encodeURIComponent(city)}&key=${config.qweatherKey}`,
            );
            const hit = geo.location?.[0];
            if (hit) {
              const lat = Number(hit.lat);
              const lon = Number(hit.lon);
              // 坐标非有限数或越界则跳过该命中，继续走 Open-Meteo 兜底
              if (Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                return ok({ city: hit.name, province: hit.adm1, lat, lon });
              }
            }
          } catch { /* 和风失败则走 Open-Meteo */ }
        }
        const r = await httpJson<{
          results?: Array<{ name: string; admin1?: string; latitude: number; longitude: number }>;
        }>(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`,
        );
        const hit = r.results?.[0];
        if (!hit) return fail(`未找到城市：${city}`);
        const lat = hit.latitude;
        const lon = hit.longitude;
        // 坐标非有限数或越界 → 该城市不可用，返回 fail
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          return fail(`城市坐标无效：${city}`);
        }
        return ok({ city: hit.name, province: hit.admin1, lat, lon });
      },
    },
    {
      name: "set",
      description: "保存用户确认后的位置（城市、省级行政区〔如 detect 返回〕和经纬度）。",
      schema: locationSetSchema.shape,
      handler: async (args) => {
        const p = locationSetSchema.parse(args);
        const loc: Location = { ...p, source: "manual", confirmedAt: new Date().toISOString() };
        store.set(KEY, loc);
        return ok({ status: "saved", location: loc });
      },
    },
  ],
};

registerModule(locationModule);
