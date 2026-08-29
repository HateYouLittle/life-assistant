import path from "node:path";
import { DateTime } from "luxon";
import type { NotificationRenderTarget } from "./core/notification.js";

function nonBlankOrDefault(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

export interface ProfilePushRoute {
  route: string;
  url: string;
  secret: string;
  /** 平台专属渲染目标；缺省/未知值时按 plain 兜底（运行时 resolveRenderTarget 解析）。 */
  renderTarget?: NotificationRenderTarget;
}

const VALID_RENDER_TARGETS: readonly NotificationRenderTarget[] = [
  "plain",
  "qq-markdown",
  "feishu-markdown",
  "wechat-markdown",
];

/** 解析 Profile 的渲染目标：缺省/未知值恒返回 "plain" 兜底。 */
export function resolveRenderTarget(route?: ProfilePushRoute): NotificationRenderTarget {
  if (route?.renderTarget && VALID_RENDER_TARGETS.includes(route.renderTarget)) {
    return route.renderTarget;
  }
  return "plain";
}

function isStrongWebhookSecret(secret: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(secret)) return false;
  const counts = new Map<string, number>();
  for (const char of secret) counts.set(char, (counts.get(char) ?? 0) + 1);
  const entropy = [...counts.values()].reduce((sum, count) => {
    const probability = count / secret.length;
    return sum - probability * Math.log2(probability);
  }, 0);
  if (entropy < 3.5) return false;
  for (let period = 1; period <= secret.length / 2; period += 1) {
    if ([...secret].every((char, index) => char === secret[index % period])) return false;
  }
  return true;
}

export function parseProfilePushRoutes(raw: string | undefined): Record<string, ProfilePushRoute> {
  const routes = Object.create(null) as Record<string, ProfilePushRoute>;
  if (!raw) return routes;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ProfilePushRoute>>;
    for (const [profileId, route] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileId)) continue;
      if (!route || typeof route.route !== "string" || typeof route.url !== "string" || typeof route.secret !== "string") continue;
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(route.route) || !isStrongWebhookSecret(route.secret)) continue;
      try {
        const url = new URL(route.url);
        const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
        if ((url.protocol !== "http:" && url.protocol !== "https:")
          || !loopbackHosts.has(url.hostname)
          || url.username
          || url.password) continue;
      } catch {
        continue;
      }
      const normalized: ProfilePushRoute = { route: route.route, url: route.url, secret: route.secret };
      if (route.renderTarget && VALID_RENDER_TARGETS.includes(route.renderTarget)) {
        normalized.renderTarget = route.renderTarget;
      }
      routes[profileId] = normalized;
    }
    return routes;
  } catch {
    return routes;
  }
}

/** 全局配置：全部来自环境变量，密钥不落代码库 */
const profilePushRoutesRaw = process.env.PROFILE_PUSH_ROUTES_JSON;
const profilePushRoutes = parseProfilePushRoutes(profilePushRoutesRaw);
if (profilePushRoutesRaw && Object.keys(profilePushRoutes).length === 0) {
  console.warn("PROFILE_PUSH_ROUTES_JSON is set but produced no valid routes");
}

/** 解析 Profile 显示名映射（通知「记录人」等场景用友好名替代 profile id）。
 * PROFILE_DISPLAY_NAMES 是可选 JSON，形如 {"default":"我","bestie":"对象"}。
 * 非法 JSON / 非字符串值一律丢弃该字段，profile id 仍会回落显示。 */
export function parseProfileDisplayNames(raw: string | undefined): Record<string, string> {
  const names = Object.create(null) as Record<string, string>;
  if (!raw) return names;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [profileId, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim() !== "") {
        names[profileId] = value.trim();
      }
    }
    return names;
  } catch {
    return names;
  }
}
const profileDisplayNames = parseProfileDisplayNames(process.env.PROFILE_DISPLAY_NAMES);

// M8：时区必须加载期校验——非法 IANA 时区会让所有 DateTime 计算静默失真，直接拒绝启动。
const rawTimezone = nonBlankOrDefault(process.env.LIFE_ASSISTANT_TIMEZONE, Intl.DateTimeFormat().resolvedOptions().timeZone);
if (!DateTime.now().setZone(rawTimezone).isValid) {
  throw new Error(`LIFE_ASSISTANT_TIMEZONE="${rawTimezone}" is not a valid IANA timezone; refusing to start with an unusable clock`);
}

// M8：DATA_DIR 必须为绝对路径（README 语义）；未设置/空白时落到绝对默认值。
function resolveDataDir(): string {
  const raw = process.env.DATA_DIR;
  if (raw === undefined || raw.trim() === "") return path.resolve("./data");
  if (!path.isAbsolute(raw)) {
    throw new Error(`DATA_DIR="${raw}" must be an absolute path (got a relative path); DATA_DIR defines the directory for all runtime data and cannot be resolved against the process cwd`);
  }
  return raw;
}
const dataDir = resolveDataDir();

// L6：坐标必须有限、在合法范围内且成对；非法或不成对视为未配置并告警（读取侧 location/index.ts 另有 isFinite 兜底）。
const rawLat = process.env.LOCATION_LAT;
const rawLon = process.env.LOCATION_LON;
const location = {
  city: process.env.LOCATION_CITY ?? "",
  lat: rawLat !== undefined && rawLat.trim() !== "" ? Number(rawLat) : undefined,
  lon: rawLon !== undefined && rawLon.trim() !== "" ? Number(rawLon) : undefined,
};
if (location.lat !== undefined && !(Number.isFinite(location.lat) && location.lat >= -90 && location.lat <= 90)) {
  console.warn(`LOCATION_LAT="${rawLat}" is not a valid latitude (finite, -90..90); location treated as unset`);
  location.lat = undefined;
}
if (location.lon !== undefined && !(Number.isFinite(location.lon) && location.lon >= -180 && location.lon <= 180)) {
  console.warn(`LOCATION_LON="${rawLon}" is not a valid longitude (finite, -180..180); location treated as unset`);
  location.lon = undefined;
}
if ((location.lat === undefined) !== (location.lon === undefined)) {
  console.warn("LOCATION_LAT and LOCATION_LON must be provided as a pair; location treated as unset");
  location.lat = undefined;
  location.lon = undefined;
}

export const config = {
  dataDir,
  profilePushRoutes,
  profileDisplayNames,
  timezone: rawTimezone,

  location,

  qweatherKey: process.env.QWEATHER_KEY ?? "",
  qweatherApiHost: process.env.QWEATHER_API_HOST ?? "devapi.qweather.com",
  juheKey: process.env.JUHE_KEY ?? "",
  tianapiKey: process.env.TIANAPI_KEY ?? "",

  kuaidi100: {
    customer: process.env.KUAIDI100_CUSTOMER ?? "",
    key: process.env.KUAIDI100_KEY ?? "",
  },

  /** 调度周期（cron 表达式），可在模块注册时覆盖 */
  cron: {
    weatherAlerts: nonBlankOrDefault(process.env.WEATHER_ALERTS_CRON, "*/15 * * * *"),
    dailyWeatherBrief: nonBlankOrDefault(process.env.DAILY_WEATHER_BRIEF_CRON, "0 7 * * *"),
    oilWatch: nonBlankOrDefault(process.env.OIL_WATCH_CRON, "0 9 * * *"),
    holidayRefresh: nonBlankOrDefault(process.env.HOLIDAY_REFRESH_CRON, "0 2 * * *"),
    automationScan: nonBlankOrDefault(process.env.AUTOMATION_SCAN_CRON, "*/10 * * * *"),
    // 每月 1 号推送上月记账月度账单（bookkeeping.monthly_report）。
    bookkeepingReport: nonBlankOrDefault(process.env.BOOKKEEPING_REPORT_CRON, "0 9 1 * *"),
    // expressPoll 随快递模块封存一并移除；如恢复快递追踪，在模块侧自带默认 cron。
  },
};
