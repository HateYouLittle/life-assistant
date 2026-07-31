import { z } from "zod";
import { config } from "../../config.js";
import { currentLocation } from "../../core/location.js";
import { registerModule, ok, fail, type AssistantModule } from "../../core/registry.js";
import { fetchCurrent, fetchForecast, fetchAlerts } from "./provider.js";

function requireLocation() {
  const loc = currentLocation();
  if (!loc) throw new Error("位置未确认，请先调用 location.get 完成位置确认流程");
  return loc;
}

const weatherModule: AssistantModule = {
  name: "weather",
  tools: [
    {
      name: "current",
      description: "查询用户所在地实时天气（温度、体感、湿度、风力、天气现象）。",
      schema: {},
      handler: async () => {
        try {
          const loc = requireLocation();
          const w = await fetchCurrent(loc.lat, loc.lon);
          return ok({ city: loc.city, ...w, unit: { temperature: "℃", windSpeed: "m/s" } });
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    },
    {
      name: "forecast",
      description: "查询用户所在地未来 N 天天气预报。",
      schema: { days: z.number().min(1).max(7).default(3).describe("预报天数 1-7") },
      handler: async (args) => {
        try {
          const loc = requireLocation();
          const { days } = z.object({ days: z.number().min(1).max(7).default(3) }).parse(args);
          return ok({ city: loc.city, forecast: await fetchForecast(loc.lat, loc.lon, days) });
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    },
    {
      name: "alerts",
      description: "查询用户所在地当前生效的气象预警（暴雨/台风/高温/大风等）。",
      schema: {},
      handler: async () => {
        try {
          const loc = requireLocation();
          const alerts = await fetchAlerts(loc.city, loc.lat, loc.lon);
          return ok({ city: loc.city, count: alerts.length, alerts });
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    },
  ],
  jobs: [
    {
      name: "alerts_check",
      cron: config.cron.weatherAlerts,
      handler: async ({ notify }) => {
        const loc = currentLocation();
        if (!loc) return;
        const alerts = await fetchAlerts(loc.city, loc.lat, loc.lon);
        for (const a of alerts) {
          // dedupeKey 含标题与日期：同一天同一预警只推一次
          const key = `weather:alert:${a.title}:${new Date().toISOString().slice(0, 10)}`;
          await notify(`⛈ ${a.title}`, a.description, key);
        }
      },
    },
  ],
};

registerModule(weatherModule);
