import { z } from "zod";
import { config } from "../../config.js";
import { store } from "../../core/store.js";
import { httpJson } from "../../core/http.js";
import { registerModule, ok, fail, withTool, type AssistantModule } from "../../core/registry.js";
import { qweatherGeo } from "./geo.js";

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
  city: z.string().transform((v) => v.trim()).pipe(z.string().min(1).max(64)),
  province: z.string().optional().transform((v) => v?.trim() || undefined),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

/** 获取已确认位置；未确认返回 null */
export function currentLocation(): Location | null {
  const saved = store.get<Location>(KEY);
  if (saved) {
    // 旧 schema 允许脏数据（空 city、越界/Infinity 坐标）：读取侧校验，
    // 非法则清除存储键并继续走 env 预置兜底（L25：脏数据不得直接 return null，
    // 否则 env 配置的位置也会被跳过），避免天气/油价链路持续失败。
    const parsed = locationSetSchema.safeParse(saved);
    if (parsed.success) {
      return { ...parsed.data, source: saved.source, confirmedAt: saved.confirmedAt };
    }
    store.del(KEY);
  }
  // env 预置城市需 trim 后非空且 <=64（N14），与 location.set 的 schema 保持一致
  const envCity = config.location.city.trim();
  if (envCity && envCity.length <= 64 && config.location.lat !== undefined && config.location.lon !== undefined) {
    const { lat, lon } = config.location;
    // env 预置坐标同样校验有限性与范围，非法视为未配置
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return {
        city: config.location.city.trim(),
        lat,
        lon,
        source: "env",
        confirmedAt: new Date().toISOString(),
      };
    }
  }
  return null;
}

/** 导入备份时写入共享位置（覆盖式，视为用户手动确认）。 */
export function saveImportedLocation(loc: { city: string; province?: string; lat: number; lon: number }): Location {
  const parsed = locationSetSchema.parse(loc);
  const saved: Location = { ...parsed, source: "manual", confirmedAt: new Date().toISOString() };
  store.set(KEY, saved);
  return saved;
}

/** 位置未确认时的统一守卫：weather/airquality/oilprice/automation 各查询入口共用同一文案。 */
export function requireConfirmedLocation(): Location {
  const loc = currentLocation();
  if (!loc) throw new Error("位置未确认，请先调用 location.get 完成位置确认流程");
  return loc;
}

/**
 * 解析查询位置（供 airquality / automation 等模块复用的公共能力）：
 * - 无 city → 全局已确认位置（不改变）
 * - 有 city → 走和风 GeoAPI（对中文区县支持好，如"朔城区"），失败则回退 Open-Meteo；
 *   只做临时查询，绝不写入 location:current（多 profile 共享 store 时避免互相污染）
 */
export async function resolveLocation(city?: string): Promise<{ city: string; lat: number; lon: number }> {
  const normalizedCity = city?.trim();
  if (!normalizedCity) {
    const loc = requireConfirmedLocation();
    return { city: loc.city, lat: loc.lat, lon: loc.lon };
  }
  if (config.qweatherKey) {
    try {
      const geo = await qweatherGeo(normalizedCity);
      return { city: normalizedCity, lat: geo.lat, lon: geo.lon };
    } catch (e) {
      console.error(`[location] qweather geo failed for "${normalizedCity}": ${(e as Error).message}`);
    }
  }
  const r = await httpJson<{ results?: Array<{ name: string; latitude: number; longitude: number }> }>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(normalizedCity)}&count=1&language=zh`,
  );
  const hit = r.results?.[0];
  if (!hit) throw new Error(`未找到城市：${normalizedCity}`);
  // 与 location.detect 同一校验口径：坐标非有限数或越界时拒绝
  if (!Number.isFinite(hit.latitude) || !Number.isFinite(hit.longitude)
    || hit.latitude < -90 || hit.latitude > 90 || hit.longitude < -180 || hit.longitude > 180) {
    throw new Error(`城市坐标无效：${normalizedCity}`);
  }
  return { city: hit.name, lat: hit.latitude, lon: hit.longitude };
}

/**
 * IP 自动探测（ip-api.com，免费、无 Key、45 次/分钟，仅供建议值）。
 * 传输层注记：ip-api 免费档仅提供 HTTP，HTTPS 为付费功能（实测 https 端点返回 403），
 * 无法在本数据源上升级传输层；本结果只作为 need_confirm 的建议值展示给用户，
 * 绝不自动落库。若要消除明文查询，应整体替换为支持 HTTPS 的探测源。
 */
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
    withTool(
      {
        name: "get",
        description:
          "获取用户当前位置。首次使用天气/油价功能前必须调用。若返回 need_confirm，请把 suggestion 用自然语言复述给用户并请其确认，确认后将 city、province（如有）和经纬度传给 location.set 保存。",
      },
      {},
      async () => {
        const loc = currentLocation();
        if (loc) return ok({ status: "confirmed", location: loc });
        const suggestion = await detectByIp();
        return ok({
          status: "need_confirm",
          suggestion,
          hint: "请向用户确认所在地。用户确认后调用 location.set(city, province, lat, lon) 保存（province 缺失时可省略）；若 IP 建议不准确，请让用户告知城市名后再次调用 location.detect(city)，并把返回的 province 一并传回 location.set。",
        });
      },
    ),
    withTool(
      {
        name: "detect",
        description: "按城市名解析经纬度和省级行政区（先和风 GeoAPI，再 Open-Meteo Geocoding 兜底），用于用户口述城市后补全位置；确认后请把 province 一并传给 location.set。",
      },
      { city: z.string().transform((v) => v.trim()).pipe(z.string().min(1)).describe("城市名，如 北京 / 上海 / 朔城区") },
      async ({ city }) => {
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
    ),
    withTool(
      {
        name: "set",
        description: "保存用户确认后的位置（城市、省级行政区〔如 detect 返回〕和经纬度）。",
      },
      locationSetSchema.shape,
      ({ city, province, lat, lon }) => {
        const loc: Location = { city, province, lat, lon, source: "manual", confirmedAt: new Date().toISOString() };
        store.set(KEY, loc);
        return ok({ status: "saved", location: loc });
      },
    ),
  ],
};

registerModule(locationModule);
