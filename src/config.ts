import path from "node:path";
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
        const loopbackHosts = new Set(["127.0.0.1", "[::1]"]);
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

export const config = {
  dataDir: path.resolve(nonBlankOrDefault(process.env.DATA_DIR, "./data")),
  profilePushRoutes,
  timezone: nonBlankOrDefault(process.env.LIFE_ASSISTANT_TIMEZONE, Intl.DateTimeFormat().resolvedOptions().timeZone),

  location: {
    city: process.env.LOCATION_CITY ?? "",
    lat: process.env.LOCATION_LAT ? Number(process.env.LOCATION_LAT) : undefined,
    lon: process.env.LOCATION_LON ? Number(process.env.LOCATION_LON) : undefined,
  },

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
    weatherAlerts: "*/15 * * * *",
    dailyWeatherBrief: nonBlankOrDefault(process.env.DAILY_WEATHER_BRIEF_CRON, "0 7 * * *"),
    oilWatch: "0 9 * * *",
    holidayRefresh: nonBlankOrDefault(process.env.HOLIDAY_REFRESH_CRON, "0 2 * * *"),
    automationScan: nonBlankOrDefault(process.env.AUTOMATION_SCAN_CRON, "*/10 * * * *"),
    // 每月 1 号推送上月记账月度账单（bookkeeping.monthly_report）。
    bookkeepingReport: nonBlankOrDefault(process.env.BOOKKEEPING_REPORT_CRON, "0 9 1 * *"),
    // expressPoll 随快递模块封存一并移除；如恢复快递追踪，在模块侧自带默认 cron。
  },
};
